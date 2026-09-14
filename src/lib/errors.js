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

/**
 * Converte um :id de rota (string) para BIGINT valido, ou lanca 400.
 * Sem isso, um id nao numerico (ex. "abc") ia direto pro driver pg, que
 * rejeitava a query com erro cru e virava 500 ERRO_INTERNO em vez do
 * contrato { erro: { codigo } } que todo o resto da API segue.
 */
function parseId(valor, nomeCampo = 'id') {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro(400, 'ID_INVALIDO', `${nomeCampo} deve ser um numero inteiro positivo`);
  }
  return n;
}

module.exports = { HttpError, erro, parseId };
