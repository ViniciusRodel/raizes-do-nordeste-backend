/** Captura rejeicoes de handlers async e encaminha para o middleware de erro. */
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
