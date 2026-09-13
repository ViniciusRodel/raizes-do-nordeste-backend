/**
 * Maquina de estados do pedido (RF-07).
 * Cada chave lista os estados alcancaveis a partir dela.
 */
const TRANSICOES = {
  CRIADO: ['AGUARDANDO_PAGAMENTO', 'CANCELADO'],
  AGUARDANDO_PAGAMENTO: ['PAGO', 'PAGAMENTO_PENDENTE', 'PAGAMENTO_RECUSADO', 'CANCELADO'],
  PAGAMENTO_PENDENTE: ['PAGO', 'PAGAMENTO_RECUSADO', 'CANCELADO'],
  PAGO: ['EM_PREPARO', 'CANCELADO_COM_ESTORNO'],
  EM_PREPARO: ['PRONTO', 'CANCELADO_COM_ESTORNO'],
  PRONTO: ['ENTREGUE'],
  ENTREGUE: [],
  PAGAMENTO_RECUSADO: [],
  CANCELADO: [],
  CANCELADO_COM_ESTORNO: [],
};

function podeTransicionar(de, para) {
  return (TRANSICOES[de] || []).includes(para);
}

module.exports = { TRANSICOES, podeTransicionar };
