const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { requer } = require('../../auth/rbac');

const router = express.Router();

// GET /v1/auditoria?tipo=&unidadeId=  -> RF-23 / RNF-08 (somente matriz/admin)
router.get(
  '/auditoria',
  requer('ANALISTA_MATRIZ', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const { tipo, unidadeId } = req.query;
    const cond = [];
    const params = [];
    if (tipo) {
      params.push(tipo);
      cond.push(`tipo = $${params.length}`);
    }
    if (unidadeId) {
      params.push(unidadeId);
      cond.push(`unidade_id = $${params.length}`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT id, tipo, usuario_id, papel, unidade_id, entidade_afetada, entidade_id,
              valor_anterior, valor_novo, motivo, data_hora
         FROM registro_auditoria
         ${where}
        ORDER BY data_hora DESC
        LIMIT 100`,
      params,
    );
    const registros = rows.map((r) => ({
      id: r.id,
      tipo: r.tipo,
      usuarioId: r.usuario_id,
      papel: r.papel,
      unidadeId: r.unidade_id,
      entidadeAfetada: r.entidade_afetada,
      entidadeId: r.entidade_id,
      valorAnterior: r.valor_anterior,
      valorNovo: r.valor_novo,
      motivo: r.motivo,
      dataHora: r.data_hora,
    }));
    res.json({ registros });
  }),
);

module.exports = router;
