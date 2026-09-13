/** Erro de dominio com status HTTP e codigo estavel para o cliente da API. */
class HttpError extends Error {
  constructor(status, codigo, mensagem, detalhes) {
    super(mensagem);
    this.name = 'HttpError';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}

const erro = (status, codigo, mensagem, detalhes) =>
  new HttpError(status, codigo, mensagem, detalhes);

module.exports = { HttpError, erro };
