const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');

const router = express.Router();

// GET /v1/unidades/:unidadeId/cardapio?canal=APP  -> RF-04
// Retorna apenas itens habilitados na unidade, com produto ativo,
// dentro da janela sazonal e com estoque disponivel (> 0).
router.get(
  '/unidades/:unidadeId/cardapio',
  asyncHandler(async (req, res) => {
    const { unidadeId } = req.params;
    const { rows } = await db.query(
      `SELECT pb.id                       AS "produtoId",
              pb.nome,
              pb.categoria,
              icu.preco_venda             AS preco,
              pb.sazonal,
              COALESCE(MIN(ie.saldo), 0)  AS "estoqueDisponivel"
         FROM item_cardapio_unidade icu
         JOIN produto_base pb        ON pb.id = icu.produto_base_id
         LEFT JOIN composicao_consumo cc ON cc.produto_base_id = pb.id
         LEFT JOIN item_estoque ie   ON ie.id = cc.item_estoque_id
                                     AND ie.unidade_id = icu.unidade_id
        WHERE icu.unidade_id = $1
          AND icu.habilitado = true
          AND pb.ativo = true
          AND (pb.sazonal = false
               OR CURRENT_DATE BETWEEN pb.janela_ini AND pb.janela_fim)
        GROUP BY pb.id, icu.preco_venda
        HAVING COALESCE(MIN(ie.saldo), 0) > 0
        ORDER BY pb.categoria, pb.nome`,
      [unidadeId],
    );

    res.json({
      unidadeId: Number(unidadeId),
      canal: req.query.canal || 'APP',
      itens: rows,
    });
  }),
);

module.exports = router;
