const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { assinar } = require('./jwt');
const { jwtExpiraEm } = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { erro } = require('../lib/errors');

const router = express.Router();

// POST /v1/auth/login  { login, senha }  -> RF-25
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { login, senha } = req.body || {};
    if (!login || !senha) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'Informe login e senha');
    }

    const { rows } = await db.query(
      `SELECT u.id, u.nome, u.hash_senha, u.ativo, u.cliente_id, u.unidade_id,
              COALESCE(array_agg(p.nome) FILTER (WHERE p.nome IS NOT NULL), '{}') AS papeis
         FROM usuario u
         LEFT JOIN usuario_papel up ON up.usuario_id = u.id
         LEFT JOIN papel p          ON p.id = up.papel_id
        WHERE u.login = $1
        GROUP BY u.id`,
      [login],
    );

    const u = rows[0];
    if (!u || !u.ativo || !bcrypt.compareSync(senha, u.hash_senha)) {
      throw erro(401, 'CREDENCIAIS_INVALIDAS', 'Login ou senha incorretos');
    }

    const token = assinar({
      sub: u.id,
      nome: u.nome,
      papeis: u.papeis,
      clienteId: u.cliente_id,
      unidadeId: u.unidade_id,
    });

    res.json({ token, expiraEm: jwtExpiraEm, papeis: u.papeis, clienteId: u.cliente_id });
  }),
);

module.exports = router;
