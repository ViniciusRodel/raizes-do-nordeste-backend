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

/**
 * Valida um campo de texto livre contra o limite VARCHAR da coluna que vai
 * receber o valor, ou lanca 400. Achado real de uma varredura OWASP ZAP:
 * sem isso, um texto maior que a coluna (nome, login, motivo, versaoTexto)
 * ia direto pro driver pg, que rejeitava o INSERT/UPDATE com "value too long
 * for type character varying(N)" e virava 500 ERRO_INTERNO - o scanner
 * chegou a rotular o mesmo 500 como SQL Injection/Path Traversal, o que
 * levou a essa investigacao (ver test-results/security/ZAP.md).
 */
function parseTexto(valor, nomeCampo, maxLen, { obrigatorio = true } = {}) {
  const v = valor == null ? '' : String(valor).trim();
  if (!v) {
    if (obrigatorio) throw erro(400, 'PAYLOAD_INVALIDO', `${nomeCampo} e obrigatorio`);
    return null;
  }
  if (v.length > maxLen) {
    throw erro(400, 'PAYLOAD_INVALIDO', `${nomeCampo} deve ter no maximo ${maxLen} caracteres`);
  }
  return v;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida uma data (formato YYYY-MM-DD) antes de repassar a uma query com
 * cast ::date / coluna DATE, ou lanca 400. Outro achado real da mesma
 * varredura OWASP ZAP: um "fim"/"inicio" nao parseavel como data ia direto
 * pro Postgres fazer o cast e virava 500 ERRO_INTERNO (DateTimeParseError)
 * em vez de um 400 claro (ver test-results/security/ZAP.md).
 */
function parseData(valor, nomeCampo, { obrigatorio = true } = {}) {
  if (valor == null || valor === '') {
    if (obrigatorio) throw erro(400, 'PAYLOAD_INVALIDO', `${nomeCampo} e obrigatorio`);
    return null;
  }
  const v = String(valor);
  if (!DATA_ISO.test(v) || Number.isNaN(Date.parse(v))) {
    throw erro(400, 'PAYLOAD_INVALIDO', `${nomeCampo} deve estar no formato AAAA-MM-DD`);
  }
  return v;
}

module.exports = { HttpError, erro, parseId, parseTexto, parseData };
