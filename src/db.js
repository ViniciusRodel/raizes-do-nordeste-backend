const { Pool } = require('pg');
const { databaseUrl } = require('./config');

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
