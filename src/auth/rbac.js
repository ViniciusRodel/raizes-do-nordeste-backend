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

/**
 * Papeis de staff em `papeisStaff` sempre podem agir; caso contrario, so o
 * proprio cliente (token CLIENTE com clienteId batendo com idAlvo) pode.
 * Usado nas rotas de LGPD (clientes/consentimentos) e no extrato de fidelidade,
 * onde tanto o titular quanto certos papeis de staff podem consultar.
 */
function garantirDonoOuStaff(req, idAlvo, papeisStaff = []) {
  if (req.usuario.papeis.some((p) => papeisStaff.includes(p))) return;
  if (req.usuario.papeis.includes('CLIENTE') && req.usuario.clienteId === Number(idAlvo)) return;
  throw erro(403, 'ACESSO_NEGADO', 'So o proprio cliente (ou papel autorizado) pode realizar esta acao');
}

module.exports = { requer, garantirDonoOuStaff };
