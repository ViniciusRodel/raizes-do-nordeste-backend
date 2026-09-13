const { erro } = require('../lib/errors');

/**
 * Middleware de controle de acesso por papel (RNF-07).
 * requer('ANALISTA_MATRIZ', 'ADMIN') -> 403 se o token nao tiver nenhum desses papeis.
 */
const requer = (...papeisPermitidos) => (req, _res, next) => {
  const meus = req.usuario?.papeis || [];
  if (!meus.some((p) => papeisPermitidos.includes(p))) {
    return next(
      erro(403, 'ACESSO_NEGADO', `Requer papel: ${papeisPermitidos.join(' ou ')}`),
    );
  }
  next();
};

module.exports = { requer };
