const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiraEm } = require('../config');
const { erro } = require('../lib/errors');

function assinar(payload) {
  return jwt.sign(payload, jwtSecret, { expiresIn: jwtExpiraEm });
}

/** Middleware: exige `Authorization: Bearer <token>` valido. Popula req.usuario. */
function autenticar(req, _res, next) {
  const header = req.headers.authorization || '';
  const [tipo, token] = header.split(' ');
  if (tipo !== 'Bearer' || !token) {
    return next(erro(401, 'NAO_AUTENTICADO', 'Token de acesso ausente'));
  }
  try {
    const claims = jwt.verify(token, jwtSecret);
    req.usuario = {
      id: claims.sub,
      nome: claims.nome,
      papeis: claims.papeis || [],
      clienteId: claims.clienteId ?? null,
      unidadeId: claims.unidadeId ?? null,
    };
    next();
  } catch (e) {
    next(erro(401, 'TOKEN_INVALIDO', 'Token invalido ou expirado'));
  }
}

module.exports = { assinar, autenticar };
