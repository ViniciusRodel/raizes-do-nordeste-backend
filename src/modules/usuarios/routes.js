const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro, parseId, parseTexto } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');
const { registrarAuditoria } = require('../../lib/audit');
const { PAPEIS_INTERNOS } = require('../../lib/papeis');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /v1/usuarios  -> RF-24 (gerenciar usuarios/papeis)
// Operacao sensivel (cria acesso ao sistema): so ADMIN, sempre audita
// ALTERACAO_USUARIO. Senha nunca volta na resposta.
// ---------------------------------------------------------------------------
router.post(
  '/usuarios',
  requer('ADMIN'),
  asyncHandler(async (req, res) => {
    const { nome: nomeBody, login: loginBody, senha, papeis, unidadeId } = req.body || {};
    if (!nomeBody || !loginBody || !senha || !Array.isArray(papeis) || papeis.length === 0) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'Informe nome, login, senha e papeis[] nao vazio');
    }
    const nome = parseTexto(nomeBody, 'nome', 120);
    const login = parseTexto(loginBody, 'login', 60);
    const papeisInvalidos = papeis.filter((p) => !PAPEIS_INTERNOS.includes(p));
    if (papeisInvalidos.length) {
      throw erro(400, 'PAYLOAD_INVALIDO', `Papeis invalidos: ${papeisInvalidos.join(', ')}`);
    }
    if (String(senha).length < 6) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'senha deve ter ao menos 6 caracteres');
    }
    const unidadeIdFinal = unidadeId != null ? parseId(unidadeId, 'unidadeId') : null;

    const resultado = await db.withTransaction(async (client) => {
      const { rows: existente } = await client.query(
        'SELECT 1 FROM usuario WHERE login = $1',
        [login],
      );
      if (existente.length) throw erro(409, 'LOGIN_EM_USO', 'Ja existe usuario com este login');

      const hash = bcrypt.hashSync(senha, 8);
      let usuarioId;
      try {
        const { rows: us } = await client.query(
          `INSERT INTO usuario (nome, login, hash_senha, unidade_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [nome, login, hash, unidadeIdFinal],
        );
        usuarioId = us[0].id;
      } catch (e) {
        // 23505 = unique_violation: cobre a corrida entre o SELECT acima e este
        // INSERT (duas criacoes do mesmo login quase simultaneas) - achado real
        // de uma varredura OWASP ZAP, que o rotulou (errado) como SQL Injection
        // por ver um 500 onde deveria ver um 409 (ver test-results/security/ZAP.md).
        if (e.code === '23505') throw erro(409, 'LOGIN_EM_USO', 'Ja existe usuario com este login');
        throw e;
      }

      const { rows: pr } = await client.query(
        'SELECT id, nome FROM papel WHERE nome = ANY($1::text[])',
        [papeis],
      );
      for (const p of pr) {
        await client.query(
          'INSERT INTO usuario_papel (usuario_id, papel_id) VALUES ($1, $2)',
          [usuarioId, p.id],
        );
      }

      await registrarAuditoria(client, {
        tipo: 'ALTERACAO_USUARIO',
        usuarioId: req.usuario.id,
        papel: req.usuario.papeis.join(','),
        unidadeId: unidadeIdFinal,
        entidadeAfetada: 'usuario',
        entidadeId: usuarioId,
        valorNovo: { nome, login, papeis, unidadeId: unidadeIdFinal },
        motivo: 'Criacao de usuario interno',
      });

      return { id: usuarioId, nome, login, papeis: pr.map((p) => p.nome), unidadeId: unidadeIdFinal };
    });

    res.status(201).json(resultado);
  }),
);

module.exports = router;
