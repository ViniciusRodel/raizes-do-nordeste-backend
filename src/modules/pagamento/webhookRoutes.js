const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { pspWebhookSecret } = require('../../config');
const { registrarAuditoria } = require('../../lib/audit');
const { devolverEstoque } = require('../../lib/estoque');
const { creditarPontos, reverterResgate } = require('../../lib/pontos');

const router = express.Router();

function assinaturaValida(req) {
  const recebida = req.headers['x-psp-signature'];
  if (!recebida || !req.rawBody) return false;
  const esperada = crypto
    .createHmac('sha256', pspWebhookSecret)
    .update(req.rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(recebida), Buffer.from(esperada));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /v1/webhooks/pagamento  (sem JWT; autenticado por HMAC)
// RF-09, RF-10 (CT-04, CT-11, CT-12)
// ---------------------------------------------------------------------------
router.post(
  '/webhooks/pagamento',
  asyncHandler(async (req, res) => {
    if (!assinaturaValida(req)) {
      throw erro(401, 'ASSINATURA_INVALIDA', 'HMAC do webhook nao confere');
    }
    const { idEvento, idTransacao, tipo, status } = req.body || {};
    if (!idEvento || !idTransacao || !status) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'idEvento, idTransacao e status sao obrigatorios');
    }
    const payloadHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');

    await db.withTransaction(async (client) => {
      const { rows: pgs } = await client.query(
        'SELECT * FROM pagamento WHERE id_transacao_psp = $1 FOR UPDATE',
        [idTransacao],
      );
      const pagamento = pgs[0];

      // Evento orfao: registra e responde 200 para o PSP parar de reenviar.
      if (!pagamento) {
        await client.query(
          `INSERT INTO evento_pagamento_recebido
             (id_evento, pagamento_id, tipo, payload_hash, processado_em)
           VALUES ($1, NULL, $2, $3, now())
           ON CONFLICT (id_evento) DO NOTHING`,
          [idEvento, tipo || 'PAGAMENTO', payloadHash],
        );
        return;
      }

      // Idempotencia: se o idEvento ja foi processado, nao reaplica nada (CT-11).
      const jaVisto = await client.query(
        'SELECT 1 FROM evento_pagamento_recebido WHERE id_evento = $1',
        [idEvento],
      );
      if (jaVisto.rowCount > 0) return;

      await client.query(
        `INSERT INTO evento_pagamento_recebido
           (id_evento, pagamento_id, tipo, payload_hash, processado_em)
         VALUES ($1, $2, $3, $4, now())`,
        [idEvento, pagamento.id, tipo || 'PAGAMENTO', payloadHash],
      );

      const { rows: peds } = await client.query(
        'SELECT * FROM pedido WHERE id = $1 FOR UPDATE',
        [pagamento.pedido_id],
      );
      const pedido = peds[0];

      if (status === 'APROVADO') {
        if (['PAGO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE'].includes(pedido.status)) return;
        await client.query(
          "UPDATE pagamento SET status = 'APROVADO', resolvido_em = now() WHERE id = $1",
          [pagamento.id],
        );
        await client.query(
          "UPDATE pedido SET status = 'PAGO', pago_em = now() WHERE id = $1",
          [pedido.id],
        );
        await creditarPontos(client, pedido);
        await registrarAuditoria(client, {
          tipo: 'PAGAMENTO_CONFIRMADO',
          papel: 'PSP',
          unidadeId: pedido.unidade_id,
          entidadeAfetada: 'pedido',
          entidadeId: pedido.id,
          valorNovo: { status: 'PAGO', idTransacao },
        });
      } else if (status === 'RECUSADO') {
        if (!['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_PENDENTE'].includes(pedido.status)) return;
        await client.query(
          "UPDATE pagamento SET status = 'RECUSADO', resolvido_em = now() WHERE id = $1",
          [pagamento.id],
        );
        await client.query(
          "UPDATE pedido SET status = 'PAGAMENTO_RECUSADO' WHERE id = $1",
          [pedido.id],
        );
        await devolverEstoque(client, pedido);
        await reverterResgate(client, pedido);
        await registrarAuditoria(client, {
          tipo: 'PAGAMENTO_RECUSADO',
          papel: 'PSP',
          unidadeId: pedido.unidade_id,
          entidadeAfetada: 'pedido',
          entidadeId: pedido.id,
          valorNovo: { status: 'PAGAMENTO_RECUSADO', idTransacao },
        });
      }
    });

    res.json({ recebido: true });
  }),
);

module.exports = router;
