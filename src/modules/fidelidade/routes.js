const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');

const router = express.Router();

// GET /v1/clientes/:id/fidelidade  -> RF-19 (saldo e extrato de pontos)
router.get(
  '/clientes/:id/fidelidade',
  asyncHandler(async (req, res) => {
    const clienteId = Number(req.params.id);

    const ehStaff = req.usuario.papeis.some((p) =>
      ['ATENDENTE', 'GERENTE_UNIDADE', 'ADMIN'].includes(p),
    );
    if (
      req.usuario.papeis.includes('CLIENTE') &&
      !ehStaff &&
      req.usuario.clienteId !== clienteId
    ) {
      throw erro(403, 'ACESSO_NEGADO', 'Fidelidade pertence a outro cliente');
    }

    const { rows: cf } = await db.query(
      'SELECT id, saldo_pontos FROM conta_fidelidade WHERE cliente_id = $1',
      [clienteId],
    );
    if (!cf[0]) return res.json({ clienteId, saldo: 0, movimentos: [] });

    const { rows: mov } = await db.query(
      `SELECT tipo, pontos, pedido_id, data_hora
         FROM movimento_pontos
        WHERE conta_id = $1
        ORDER BY data_hora DESC
        LIMIT 50`,
      [cf[0].id],
    );
    res.json({ clienteId, saldo: cf[0].saldo_pontos, movimentos: mov });
  }),
);

module.exports = router;
