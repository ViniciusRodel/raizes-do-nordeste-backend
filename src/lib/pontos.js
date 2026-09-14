/**
 * Credita, resgata e estorna pontos de fidelidade (RF-19, RF-20).
 * O credito so acontece se houver consentimento vigente para FIDELIDADE (RF-17);
 * o estorno reverte exatamente o que foi creditado para aquele pedido (idempotente:
 * chamar de novo sem ter havido credito simplesmente nao faz nada).
 */
const { erro } = require('./errors');

const PONTOS_POR_REAL = 1;
// Regra de conversao do resgate (RF-20): simplificada para esta AP, documentada
// aqui como a fonte da verdade (mesmo espirito das estimativas numericas do PDF,
// Secao 2.2). 100 pontos = R$ 1,00 de desconto.
const VALOR_RESGATE_POR_PONTO = 0.01;

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

/**
 * Resgata pontos do cliente como desconto no pedido sendo criado (RF-20).
 * Debita imediatamente (mesmo padrao de reserva de estoque em POST /pedidos):
 * se o pedido depois for recusado/cancelado, reverterResgate devolve os pontos.
 * Retorna o valor do desconto em reais.
 */
async function resgatarPontos(client, clienteId, pedidoId, pontos) {
  const { rows: cf } = await client.query(
    'SELECT id, saldo_pontos FROM conta_fidelidade WHERE cliente_id = $1 FOR UPDATE',
    [clienteId],
  );
  const conta = cf[0];
  if (!conta || conta.saldo_pontos < pontos) {
    throw erro(422, 'SALDO_PONTOS_INSUFICIENTE', 'Saldo de pontos insuficiente para o resgate');
  }
  await client.query(
    'UPDATE conta_fidelidade SET saldo_pontos = saldo_pontos - $1 WHERE id = $2',
    [pontos, conta.id],
  );
  await client.query(
    `INSERT INTO movimento_pontos (conta_id, tipo, pontos, pedido_id)
     VALUES ($1, 'DEBITO_RESGATE', $2, $3)`,
    [conta.id, pontos, pedidoId],
  );
  return Number((pontos * VALOR_RESGATE_POR_PONTO).toFixed(2));
}

/**
 * Devolve pontos resgatados por um pedido que nao foi concluido (recusado ou
 * cancelado), simetrico a devolverEstoque. Idempotente por pedido.
 */
async function reverterResgate(client, pedido) {
  if (!pedido.cliente_id) return;
  const { rows: cf } = await client.query(
    'SELECT id FROM conta_fidelidade WHERE cliente_id = $1',
    [pedido.cliente_id],
  );
  if (!cf.length) return;

  const { rows: deb } = await client.query(
    `SELECT COALESCE(sum(pontos), 0) AS total
       FROM movimento_pontos
      WHERE conta_id = $1 AND pedido_id = $2 AND tipo = 'DEBITO_RESGATE'`,
    [cf[0].id, pedido.id],
  );
  const jaRevertido = await client.query(
    `SELECT 1 FROM movimento_pontos WHERE conta_id = $1 AND pedido_id = $2 AND tipo = 'ESTORNO_RESGATE'`,
    [cf[0].id, pedido.id],
  );
  const debitado = Number(deb[0].total);
  if (debitado <= 0 || jaRevertido.rowCount > 0) return;

  await client.query(
    'UPDATE conta_fidelidade SET saldo_pontos = saldo_pontos + $1 WHERE id = $2',
    [debitado, cf[0].id],
  );
  await client.query(
    `INSERT INTO movimento_pontos (conta_id, tipo, pontos, pedido_id)
     VALUES ($1, 'ESTORNO_RESGATE', $2, $3)`,
    [cf[0].id, debitado, pedido.id],
  );
}

module.exports = {
  creditarPontos, estornarPontos, resgatarPontos, reverterResgate, VALOR_RESGATE_POR_PONTO,
};
