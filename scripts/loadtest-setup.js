/**
 * Garante estoque alto o suficiente do produto usado no teste de carga
 * (Suco de Caju, unidade 1) para o estoque nao virar o gargalo do teste -
 * CT-19 mede latencia/erro sob carga, nao repete o teste de concorrencia
 * de estoque (isso ja e o CT-14).
 */
const { pool } = require('../src/db');

(async () => {
  const r = await pool.query(
    `UPDATE item_estoque SET saldo = 1000000
       WHERE unidade_id = 1 AND nome = 'Insumo: Suco de Caju'`,
  );
  if (r.rowCount === 0) {
    throw new Error('item de estoque "Insumo: Suco de Caju" da unidade 1 nao encontrado - rode o seed antes');
  }
  console.log('estoque ajustado para o teste de carga');
  await pool.end();
})().catch((e) => {
  console.error('falha ao preparar o teste de carga:', e.message);
  process.exit(1);
});
