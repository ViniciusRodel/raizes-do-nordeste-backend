const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');

const router = express.Router();
const STATUS_PAGOS = ['PAGO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE'];

// Agrega direto das tabelas transacionais nesta entrega; a versao com tabelas
// consolidadas (consolidado_vendas_dia) fica como proximo passo (ver README).
async function buscarVendasAgregadas(inicio, fim) {
  const { rows } = await db.query(
    `SELECT p.unidade_id,
            u.nome  AS unidade,
            r.nome  AS regiao,
            count(*)::int                    AS qtd_pedidos,
            COALESCE(sum(p.total), 0)::float AS valor_liquido
       FROM pedido p
       JOIN unidade u ON u.id = p.unidade_id
       JOIN regiao r  ON r.id = u.regiao_id
      WHERE p.status = ANY($3::text[])
        AND ($1::date IS NULL OR p.pago_em >= $1::date)
        AND ($2::date IS NULL OR p.pago_em < ($2::date + 1))
      GROUP BY p.unidade_id, u.nome, r.nome
      ORDER BY valor_liquido DESC`,
    [inicio || null, fim || null, STATUS_PAGOS],
  );
  return rows.map((r) => ({
    unidadeId: r.unidade_id,
    unidade: r.unidade,
    regiao: r.regiao,
    qtdPedidos: r.qtd_pedidos,
    valorLiquido: r.valor_liquido,
  }));
}

function paraCsv(linhas, colunas) {
  const escapa = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cabecalho = colunas.map((c) => c.rotulo).join(',');
  const corpo = linhas.map((l) => colunas.map((c) => escapa(l[c.campo])).join(','));
  return [cabecalho, ...corpo].join('\n');
}

// GET /v1/relatorios/vendas?inicio=&fim=  -> RF-22 (somente Analista da Matriz)
router.get(
  '/relatorios/vendas',
  requer('ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const { inicio, fim } = req.query;
    const series = await buscarVendasAgregadas(inicio, fim);
    res.json({ periodo: { inicio: inicio || null, fim: fim || null }, series });
  }),
);

// GET /v1/relatorios/vendas/export?formato=csv  -> RF-23
router.get(
  '/relatorios/vendas/export',
  requer('ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const { inicio, fim, formato } = req.query;
    if (formato && formato !== 'csv') {
      throw erro(400, 'FORMATO_INVALIDO', 'Somente formato=csv e suportado nesta AP');
    }
    const series = await buscarVendasAgregadas(inicio, fim);
    const csv = paraCsv(series, [
      { campo: 'unidadeId', rotulo: 'unidadeId' },
      { campo: 'unidade', rotulo: 'unidade' },
      { campo: 'regiao', rotulo: 'regiao' },
      { campo: 'qtdPedidos', rotulo: 'qtdPedidos' },
      { campo: 'valorLiquido', rotulo: 'valorLiquido' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio-vendas.csv"');
    res.send(csv);
  }),
);

// GET /v1/relatorios/produtos?inicio=&fim=  -> RF-22 (ranking de produtos)
router.get(
  '/relatorios/produtos',
  requer('ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const { inicio, fim } = req.query;
    const { rows } = await db.query(
      `SELECT ip.produto_base_id,
              pb.nome                               AS produto,
              sum(ip.quantidade)::int                AS quantidade,
              COALESCE(sum(ip.subtotal), 0)::float   AS valor
         FROM item_pedido ip
         JOIN pedido p       ON p.id = ip.pedido_id
         JOIN produto_base pb ON pb.id = ip.produto_base_id
        WHERE p.status = ANY($3::text[])
          AND ($1::date IS NULL OR p.pago_em >= $1::date)
          AND ($2::date IS NULL OR p.pago_em < ($2::date + 1))
        GROUP BY ip.produto_base_id, pb.nome
        ORDER BY valor DESC`,
      [inicio || null, fim || null, STATUS_PAGOS],
    );
    const ranking = rows.map((r) => ({
      produtoId: r.produto_base_id,
      produto: r.produto,
      quantidade: r.quantidade,
      valor: r.valor,
    }));
    res.json({ periodo: { inicio: inicio || null, fim: fim || null }, ranking });
  }),
);

module.exports = router;
