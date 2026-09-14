/**
 * Teste de carga (CT-19 / RNF-01, RNF-02, RNF-03).
 *
 * Duas cargas simultaneas, cada uma sustentando a taxa alvo com
 * `constant-arrival-rate` (o k6 dispara N iteracoes por minuto
 * independente do tempo de resposta, que e exatamente a semantica de
 * "200 pedidos/minuto"):
 *   - consultarCardapio: leitura do cardapio (RNF-02: p95 <= 500ms)
 *   - criarPedido:       criacao de pedido (RNF-02: p95 <= 1s; RNF-03: erro < 0,1%)
 *
 * Uso:
 *   npm run loadtest:setup   # garante estoque alto o suficiente pra nao virar gargalo
 *   npm run loadtest         # 2 min (rapido, para verificacao local)
 *   npx k6 run -e DURATION=15m loadtest/pedidos.js   # duracao oficial do CT-19
 *
 * Requer a API rodando (local ou via docker compose) e login valido de
 * ATENDENTE (feito uma vez, em setup()).
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const DURATION = __ENV.DURATION || '2m';
const TAXA_POR_MINUTO = Number(__ENV.RATE || 200); // RNF-03

export const options = {
  scenarios: {
    cardapio: {
      executor: 'constant-arrival-rate',
      rate: TAXA_POR_MINUTO,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
      exec: 'consultarCardapio',
    },
    criarPedido: {
      executor: 'constant-arrival-rate',
      rate: TAXA_POR_MINUTO,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 60,
      exec: 'criarPedido',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'], // RNF-03: erro < 0,1%
    'http_req_duration{scenario:cardapio}': ['p(95)<500'], // RNF-02
    'http_req_duration{scenario:criarPedido}': ['p(95)<1000'], // RNF-02
  },
};

export function setup() {
  const login = http.post(
    `${BASE_URL}/v1/auth/login`,
    JSON.stringify({ login: 'atendente', senha: 'senha123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (login.status !== 200) {
    throw new Error(`login falhou (${login.status}): ${login.body}`);
  }
  return { token: login.json('token') };
}

export function consultarCardapio(data) {
  const res = http.get(`${BASE_URL}/v1/unidades/1/cardapio?canal=APP`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  check(res, { 'cardapio 200': (r) => r.status === 200 });
}

export function criarPedido(data) {
  const res = http.post(
    `${BASE_URL}/v1/pedidos`,
    JSON.stringify({ unidadeId: 1, canal: 'APP', itens: [{ produtoId: 4, quantidade: 1 }] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` } },
  );
  check(res, { 'pedido 201': (r) => r.status === 201 });
}
