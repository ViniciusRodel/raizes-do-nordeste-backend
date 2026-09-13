/**
 * Credita e estorna pontos de fidelidade (RF-19).
 * O credito so acontece se houver consentimento vigente para FIDELIDADE (RF-17);
 * o estorno reverte exatamente o que foi creditado para aquele pedido (idempotente:
 * chamar de novo sem ter havido credito simplesmente nao faz nada).
 */
const PONTOS_POR_REAL = 1;

async function creditarPontos(client, pedido) {
  if (!pedido.cliente_id) return;
  const { rows: consentido } = await client.query(
    `SELECT 1 FROM consentimento_lgpd
      WHERE cliente_id = $1 AND finalidade = 'FIDELIDADE' AND revogado_em IS NULL`,
    [pedido.cliente_id],
  );
  if (!consentido.length) return;

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

/** Estorna o credito de pontos de um pedido especifico, se houver algum. */
async function estornarPontos(client, pedido) {
  if (!pedido.cliente_id) return;
  const { rows: cf } = await client.query(
    'SELECT id FROM conta_fidelidade WHERE cliente_id = $1',
    [pedido.cliente_id],
  );
  if (!cf.length) return;

  const { rows: creditos } = await client.query(
    `SELECT COALESCE(sum(pontos), 0) AS total
       FROM movimento_pontos
      WHERE conta_id = $1 AND pedido_id = $2 AND tipo = 'CREDITO_COMPRA'`,
    [cf[0].id, pedido.id],
  );
  const jaEstornado = await client.query(
    `SELECT 1 FROM movimento_pontos WHERE conta_id = $1 AND pedido_id = $2 AND tipo = 'ESTORNO'`,
    [cf[0].id, pedido.id],
  );
  const creditado = Number(creditos[0].total);
  if (creditado <= 0 || jaEstornado.rowCount > 0) return;

  await client.query(
    'UPDATE conta_fidelidade SET saldo_pontos = saldo_pontos - $1 WHERE id = $2',
    [creditado, cf[0].id],
  );
  await client.query(
    `INSERT INTO movimento_pontos (conta_id, tipo, pontos, pedido_id)
     VALUES ($1, 'ESTORNO', $2, $3)`,
    [cf[0].id, creditado, pedido.id],
  );
}

module.exports = { creditarPontos, estornarPontos };
