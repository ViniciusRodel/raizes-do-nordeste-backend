const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema aplicado');
  await pool.end();
})().catch((e) => {
  console.error('falha ao aplicar o schema:', e.message);
  process.exit(1);
});
