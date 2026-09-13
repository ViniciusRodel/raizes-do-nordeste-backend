const { Pool, types } = require('pg');
const { databaseUrl } = require('./config');

// O driver `pg` devolve BIGINT (OID 20) como string por padrao, porque em Postgres
// int8 excede Number.MAX_SAFE_INTEGER em tese. Nossos ids nunca chegam perto disso,
// e manter tudo como Number evita bugs de comparacao (ex.: "1" !== 1) entre valores
// vindos do banco (pedido.cliente_id) e valores vindos de JWT/JSON (Number(req.params.id)).
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const pool = new Pool({ connectionString: databaseUrl });

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),

  /** Executa fn(client) dentro de BEGIN/COMMIT; ROLLBACK em qualquer erro. */
  async withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await fn(client);
      await client.query('COMMIT');
      return resultado;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};
