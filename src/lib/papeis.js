/** Papeis internos validos (RF-24). Unica fonte de verdade — usado no
 * cadastro de usuario e no seed. CLIENTE nao entra aqui: e atribuido
 * automaticamente a um usuario vinculado a um cliente, nao cadastrado por
 * este endpoint administrativo. */
const PAPEIS_INTERNOS = ['ADMIN', 'GERENTE_UNIDADE', 'ATENDENTE', 'COZINHEIRO', 'ANALISTA_MATRIZ'];

module.exports = { PAPEIS_INTERNOS };
