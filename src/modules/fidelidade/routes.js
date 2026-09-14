const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { parseId } = require('../../lib/errors');
const { garantirDonoOuStaff } = require('../../auth/rbac');

const router = express.Router();

// GET /v1/clientes/:id/fidelidade  -> RF-19 (saldo e extrato de pontos)
router.get(
  '/clientes/:id/fidelidade',
  asyncHandler(async (req, res) => {
    const clienteId = parseId(req.params.id, 'id');
    garantirDonoOuStaff(req, clienteId, ['ATENDENTE', 'GERENTE_UNIDADE', 'ADMIN']);

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
    const movimentos = mov.map((m) => ({
      tipo: m.tipo,
      pontos: m.pontos,
      pedidoId: m.pedido_id,
      dataHora: m.data_hora,
    }));
    res.json({ clienteId, saldo: cf[0].saldo_pontos, movimentos });
  }),
);

module.exports = router;
