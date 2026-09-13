const test = require('node:test');
const assert = require('node:assert/strict');
const { podeTransicionar } = require('../src/modules/pedidos/stateMachine');

test('permite AGUARDANDO_PAGAMENTO -> PAGO', () => {
  assert.equal(podeTransicionar('AGUARDANDO_PAGAMENTO', 'PAGO'), true);
});

test('permite o caminho de producao PAGO -> EM_PREPARO -> PRONTO -> ENTREGUE', () => {
  assert.equal(podeTransicionar('PAGO', 'EM_PREPARO'), true);
  assert.equal(podeTransicionar('EM_PREPARO', 'PRONTO'), true);
  assert.equal(podeTransicionar('PRONTO', 'ENTREGUE'), true);
});

test('bloqueia pular etapas: AGUARDANDO_PAGAMENTO -> ENTREGUE', () => {
  assert.equal(podeTransicionar('AGUARDANDO_PAGAMENTO', 'ENTREGUE'), false);
});

test('bloqueia PAGO -> ENTREGUE sem passar pela cozinha', () => {
  assert.equal(podeTransicionar('PAGO', 'ENTREGUE'), false);
});

test('estados finais nao transicionam', () => {
  assert.equal(podeTransicionar('ENTREGUE', 'EM_PREPARO'), false);
  assert.equal(podeTransicionar('CANCELADO', 'PAGO'), false);
});
