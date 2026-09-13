/**
 * Devolve ao estoque os itens de um pedido (RF-15).
 * Usado tanto na recusa de pagamento (webhookRoutes) quanto no cancelamento
 * com estorno de um pedido ja pago (pedidos/routes).
 */
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

module.exports = { devolverEstoque };
