const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro, parseId } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');
const { registrarAuditoria } = require('../../lib/audit');

const router = express.Router();
const TIPOS = ['ENTRADA_COMPRA', 'AJUSTE'];

// ---------------------------------------------------------------------------
// POST /v1/unidades/:unidadeId/estoque/movimentos  -> RF-16
// Entrada de compra (soma livre) ou ajuste manual (soma ou subtrai, com
// motivo obrigatorio - operacao sensivel, gera auditoria AJUSTE_ESTOQUE).
// Gerente so mexe no estoque da propria unidade; ADMIN mexe em qualquer uma.
// ---------------------------------------------------------------------------
router.post(
  '/unidades/:unidadeId/estoque/movimentos',
  requer('GERENTE_UNIDADE', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const unidadeId = parseId(req.params.unidadeId, 'unidadeId');
    if (
      req.usuario.papeis.includes('GERENTE_UNIDADE') &&
      !req.usuario.papeis.includes('ADMIN') &&
      req.usuario.unidadeId !== unidadeId
    ) {
      throw erro(403, 'ACESSO_NEGADO', 'Gerente so movimenta o estoque da propria unidade');
    }

    const { itemEstoqueId, tipo, quantidade, motivo } = req.body || {};
    const itemId = parseId(itemEstoqueId, 'itemEstoqueId');
    if (!TIPOS.includes(tipo)) {
      throw erro(400, 'PAYLOAD_INVALIDO', `tipo deve ser um de ${TIPOS.join(', ')}`);
    }
    const qtd = Number(quantidade);
    if (!Number.isFinite(qtd) || qtd === 0) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'quantidade deve ser um numero diferente de zero');
    }
    if (tipo === 'ENTRADA_COMPRA' && qtd < 0) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'ENTRADA_COMPRA exige quantidade positiva');
    }
    if (tipo === 'AJUSTE' && (!motivo || !String(motivo).trim())) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'motivo e obrigatorio para AJUSTE de estoque');
    }

    const resultado = await db.withTransaction(async (client) => {
      const { rows: ie } = await client.query(
        'SELECT id, nome, saldo FROM item_estoque WHERE id = $1 AND unidade_id = $2 FOR UPDATE',
        [itemId, unidadeId],
      );
      if (!ie[0]) throw erro(404, 'ITEM_ESTOQUE_NAO_ENCONTRADO', 'Item de estoque inexistente nesta unidade');

      const novoSaldo = Number(ie[0].saldo) + qtd;
      if (novoSaldo < 0) {
        throw erro(422, 'SALDO_NEGATIVO', `Ajuste deixaria o saldo de "${ie[0].nome}" negativo`);
      }

      await client.query('UPDATE item_estoque SET saldo = $1 WHERE id = $2', [novoSaldo, itemId]);
      const { rows: mov } = await client.query(
        `INSERT INTO movimento_estoque (item_estoque_id, tipo, quantidade, usuario_id, motivo)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, data_hora`,
        [itemId, tipo, qtd, req.usuario.id, motivo || null],
      );

      if (tipo === 'AJUSTE') {
        await registrarAuditoria(client, {
          tipo: 'AJUSTE_ESTOQUE',
          usuarioId: req.usuario.id,
          papel: req.usuario.papeis.join(','),
          unidadeId,
          entidadeAfetada: 'item_estoque',
          entidadeId: itemId,
          valorAnterior: { saldo: Number(ie[0].saldo) },
          valorNovo: { saldo: novoSaldo },
          motivo,
        });
      }

      return {
        movimentoId: mov[0].id,
        itemEstoqueId: itemId,
        tipo,
        quantidade: qtd,
        saldoAtual: novoSaldo,
        dataHora: mov[0].data_hora,
      };
    });

    res.status(201).json(resultado);
  }),
);

module.exports = router;
