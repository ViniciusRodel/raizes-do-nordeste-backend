const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { requer } = require('../../auth/rbac');

const router = express.Router();

// GET /v1/relatorios/vendas?inicio=&fim=  -> RF-22 (somente Analista da Matriz)
// Agrega direto das tabelas transacionais nesta entrega; a versao com tabelas
// consolidadas (consolidado_vendas_dia) fica como proximo passo (ver README).
router.get(
  '/relatorios/vendas',
  requer('ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const { inicio, fim } = req.query;
    const { rows } = await db.query(
      `SELECT p.unidade_id,
              u.nome  AS unidade,
              r.nome  AS regiao,
              count(*)::int                    AS qtd_pedidos,
              COALESCE(sum(p.total), 0)::float AS valor_liquido
         FROM pedido p
         JOIN unidade u ON u.id = p.unidade_id
         JOIN regiao r  ON r.id = u.regiao_id
        WHERE p.status IN ('PAGO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE')
          AND ($1::date IS NULL OR p.pago_em >= $1::date)
          AND ($2::date IS NULL OR p.pago_em < ($2::date + 1))
        GROUP BY p.unidade_id, u.nome, r.nome
        ORDER BY valor_liquido DESC`,
      [inicio || null, fim || null],
    );
    res.json({ periodo: { inicio: inicio || null, fim: fim || null }, series: rows });
  }),
);

module.exports = router;
