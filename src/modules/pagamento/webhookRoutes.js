const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { pspWebhookSecret } = require('../../config');
const { registrarAuditoria } = require('../../lib/audit');

const router = express.Router();

const PONTOS_POR_REAL = 1;

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

async function creditarPontos(client, pedido) {
  if (!pedido.cliente_id) return;
  const { rows: consentido } = await client.query(
    `SELECT 1 FROM consentimento_lgpd
      WHERE cliente_id = $1 AND finalidade = 'FIDELIDADE' AND revogado_em IS NULL`,
    [pedido.cliente_id],
  );
  if (!consentido.length) return; // sem consentimento vigente -> nao credita (RF-17/RF-19)

  const pontos = Math.floor(Number(pedido.total) * PONTOS_POR_REAL);
  await client.query(
    `INSERT INTO conta_fidelidade (cliente_id, saldo_pontos)
     VALUES ($1, $2)
     ON CONFLICT (cliente_id)
       DO UPDATE SET saldo_pontos = conta_fidelidade.saldo_pontos + EXCLUDED.saldo_pontos`,
    [pedido.cliente_id, pontos],
  );
  const { rows: cf } = await client.query(
    'SELECT id FROM conta_fidelidade WHERE cliente_id = $1',
    [pedido.cliente_id],
  );
  await client.query(
    `INSERT INTO movimento_pontos (conta_id, tipo, pontos, pedido_id)
     VALUES ($1, 'CREDITO_COMPRA', $2, $3)`,
    [cf[0].id, pontos, pedido.id],
  );
}

async function devolverEstoque(client, pedido) {
  const { rows: itens } = await client.query(
    'SELECT produto_base_id, quantidade FROM item_pedido WHERE pedido_id = $1',
    [pedido.id],
  );
  for (const it of itens) {
    const { rows: composicao } = await client.query(
      `SELECT cc.item_estoque_id, cc.quantidade
         FROM composicao_consumo cc
         JOIN item_estoque ie ON ie.id = cc.item_estoque_id
        WHERE cc.produto_base_id = $1 AND ie.unidade_id = $2`,
      [it.produto_base_id, pedido.unidade_id],
    );
    for (const comp of composicao) {
      const devolve = Number(comp.quantidade) * it.quantidade;
      await client.query(
        'UPDATE item_estoque SET saldo = saldo + $1 WHERE id = $2',
        [devolve, comp.item_estoque_id],
      );
      await client.query(
        `INSERT INTO movimento_estoque (item_estoque_id, tipo, quantidade)
         VALUES ($1, 'ENTRADA_CANCELAMENTO', $2)`,
        [comp.item_estoque_id, devolve],
      );
    }
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
