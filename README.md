# Raízes do Nordeste — Back-end

Plataforma única de pedidos e gestão para a rede de lanchonetes **Raízes do Nordeste**.
Recorte de **back-end** do Projeto Multidisciplinar (UNINTER) — modelagem, contrato de API,
integração de pagamento e uma **implementação parcial do caminho de ouro**.

> A documentação completa (requisitos, DER, arquitetura, plano de testes) está no PDF
> entregue no AVA. Este repositório é a **entrega técnica** referenciada na Seção 4 daquele documento.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 |
| HTTP | Express 4 (sem framework de aplicação, roteamento manual por módulo) |
| Banco | PostgreSQL 16 (`pg`, SQL puro) |
| Auth | JWT (`jsonwebtoken`) + RBAC por papel; senhas com `bcryptjs` |
| Pagamento | serviço externo — aqui simulado por `psp-fake/` |
| Orquestração | Docker Compose (banco + API + PSP fake) |
| Testes | `node --test` (unitário) + coleção Postman/Newman (contrato) |

Arquitetura: **monólito modular** — cada _bounded context_ é uma pasta em `src/modules/`
com suas rotas; efeitos de negócio (pontos, auditoria) rodam na mesma transação nesta
entrega e ficam prontos para virar eventos assíncronos (ver "Próximos passos").

---

## Como rodar

Pré-requisito: Docker.

```bash
docker compose up
```

Sobe:

- **API** em `http://localhost:3000` (aplica o schema e o seed automaticamente no boot)
- **PSP fake** em `http://localhost:4000`
- **PostgreSQL** em `localhost:5432` (`raizes` / `raizes`)

Sem Docker (precisa de um PostgreSQL local): `cp .env.example .env`, ajuste `DATABASE_URL`, e então
`npm install && npm run migrate && npm run seed && npm start`. Suba o PSP à parte:
`cd psp-fake && npm install && npm start`.

### Usuários semeados (senha de todos: `senha123`)

| login | papel | observação |
|---|---|---|
| `maria` | CLIENTE | consente com FIDELIDADE — acumula pontos |
| `joao` | CLIENTE | **não** consente — não acumula pontos |
| `atendente` | ATENDENTE | unidade 1 (Recife) |
| `cozinheiro` | COZINHEIRO | unidade 1 |
| `gerente` | GERENTE_UNIDADE | unidade 1 |
| `analista` | ANALISTA_MATRIZ | acesso aos relatórios e à auditoria |
| `admin` | ADMIN | — |

`produtoId`: 1 Tapioca · 2 Cuscuz · 3 Bolo de Macaxeira · 4 Suco de Caju · 5 Canjica Junina (sazonal, só junho/2026).
Unidades: 1 Recife (COMPLETA), 2 São Paulo (REDUZIDA, não serve Canjica).

---

## Demonstração (mapeada aos casos de teste do PDF)

Importe `postman/raizes-do-nordeste.postman_collection.json` e rode as requisições **na ordem**
(elas encadeiam token, `pedido_id` e `charge_id` via scripts). Ou por linha de comando:

```bash
npx newman run postman/raizes-do-nordeste.postman_collection.json \
  -e postman/raizes-do-nordeste.postman_environment.json
```

| # | Passo | CT do PDF |
|---|---|---|
| 1–4 | Login (cliente, atendente, cozinheiro, analista) | RF-25 |
| 5 | `GET /v1/unidades/1/cardapio?canal=APP` — Canjica sazonal não aparece | RF-04 / CT-13 |
| 6 | `POST /v1/pedidos` — valida itens, reserva estoque, cria pedido, chama o PSP | **CT-01** |
| 7 | `GET /v1/pedidos/:id` — `AGUARDANDO_PAGAMENTO` | RF-12 |
| 8 | PSP fake: `POST /charges/:id/aprovar` — dispara o webhook assinado | **CT-04** |
| 9–10 | Pedido vira `PAGO`; Maria ganha 30 pontos (1 por real) | RF-09, RF-19 |
| 11–12 | PSP fake: `reenviar` o mesmo webhook — saldo **não** dobra | **CT-11** (idempotência) |
| 13 | `GET /v1/unidades/1/fila-cozinha` — o pedido pago está na fila | RF-11 |
| 14–16 | `PATCH /v1/pedidos/:id/status` → EM_PREPARO → PRONTO → ENTREGUE | **CT-05** |
| 17 | ENTREGUE → EM_PREPARO devolve **409** | **CT-20** |
| 18 | `GET /v1/relatorios/vendas` com token do cozinheiro → **403** | **CT-16** (RBAC) |
| 19 | mesmo endpoint com o Analista → 200 | CT-07 (parcial) |
| 20 | `GET /v1/auditoria` — registro `PAGAMENTO_CONFIRMADO` | RF-14 |
| 21 | `POST /v1/pedidos` com a Canjica fora de junho → **422** | **CT-13** |
| 22–23 | Cria um 2º pedido (Cuscuz) e aprova o pagamento | RF-05, RF-09 |
| 24 | Fidelidade da Maria: 30 + 18 = 48 pontos | RF-19 |
| 25 | `POST /v1/pedidos/:id/cancelamento` no pedido **pago**, com `motivo` → `CANCELADO_COM_ESTORNO` | **CT-17** |
| 26 | Fidelidade da Maria: pontos do 2º pedido estornados, saldo volta a 30 | RF-13, RF-19 |
| 27 | `GET /v1/auditoria?tipo=CANCELAMENTO` — registro com autor, papel e motivo | RF-14 |
| 28 | Cancelar o 1º pedido (já `ENTREGUE`) → **409** | RF-13 |
| 29 | Cancelar sem `motivo` → **400** | RF-14 (operação sensível exige motivo) |
| 30 | Login Admin | RF-25 |
| 31 | `GET /v1/clientes/:id` (Admin) — nome/CPF decifrados corretamente | **RNF-06** |
| 32 | Mesmo endpoint com token do Atendente → **403** | RNF-07 (RBAC) |
| 33 | `GET /v1/auditoria?tipo=ACESSO_DADO_PESSOAL` — registra quem acessou | RF-14 |

Outros negativos já suportados pelo código, sem passo dedicado na coleção:
**CT-02** (pedido no totem sem `clienteId`), **CT-03** (pedido pelo atendente),
**CT-10** (PSP fora do ar → pedido nasce `PAGAMENTO_PENDENTE`; pare o container `psp-fake` e refaça o passo 6),
**CT-12** (webhook com HMAC inválido → 401),
**CT-14** (2 pedidos simultâneos de "Bolo de Macaxeira" na unidade 1 — estoque 1 → um 201, outro 422).

---

## Endpoints (matriz papel × acesso)

| Método | Rota | Papel |
|---|---|---|
| POST | `/v1/auth/login` | público |
| POST | `/v1/webhooks/pagamento` | sem JWT — autenticado por HMAC |
| GET | `/v1/unidades/:id/cardapio` | autenticado |
| POST | `/v1/pedidos` | CLIENTE, ATENDENTE |
| GET | `/v1/pedidos/:id` | autenticado (cliente só vê o próprio) |
| GET | `/v1/unidades/:id/fila-cozinha` | COZINHEIRO, GERENTE_UNIDADE |
| PATCH | `/v1/pedidos/:id/status` | COZINHEIRO, ATENDENTE, GERENTE_UNIDADE |
| POST | `/v1/pedidos/:id/cancelamento` | ATENDENTE, GERENTE_UNIDADE (exige `motivo`) |
| GET | `/v1/clientes/:id` | ADMIN, GERENTE_UNIDADE — dados pessoais decifrados; sempre audita `ACESSO_DADO_PESSOAL` |
| GET | `/v1/clientes/:id/fidelidade` | dono, ou ATENDENTE/GERENTE/ADMIN |
| GET | `/v1/relatorios/vendas` | ANALISTA_MATRIZ |
| GET | `/v1/auditoria` | ANALISTA_MATRIZ, ADMIN |
| GET | `/health`, `/ready` | público |

Erros seguem `{ "erro": { "codigo", "mensagem", "detalhes" } }`.

---

## Estrutura

```
src/
  server.js                 montagem do Express e middlewares
  config.js  db.js
  auth/          jwt.js (assinar/autenticar) · rbac.js · routes.js (login)
  lib/           errors.js · asyncHandler.js · audit.js · estoque.js · pontos.js · dadosPessoais.js
  modules/
    catalogo/routes.js
    pedidos/routes.js (criar, status, cancelamento) · stateMachine.js
    pagamento/webhookRoutes.js · pspClient.js
    clientes/routes.js        (cadastro do cliente, dados pessoais decifrados sob auditoria)
    fidelidade/routes.js
    auditoria/routes.js
    relatorios/routes.js
db/schema.sql                DDL (recriado a cada migrate)
scripts/migrate.js · seed.js
psp-fake/server.js           provedor de pagamento simulado (fora do sistema)
postman/                     coleção + environment
test/stateMachine.test.js    unitário puro (roda no CI, sem banco)
```

---

## Testes e CI

```bash
npm test          # unitário: regras da máquina de estados do pedido
```

O workflow em `.github/workflows/ci.yml` roda `npm test` a cada push/PR.

**A coleção Postman foi executada de ponta a ponta contra o stack real** (API + PostgreSQL +
PSP fake) — evidência, relatório HTML e os detalhes (incluindo um bug real encontrado e
corrigido nessa execução) estão em [`test-results/EXECUCAO.md`](test-results/EXECUCAO.md).
Rodar a coleção via Newman dentro do pipeline de CI é o próximo incremento (RNF-12).

---

## Escopo desta entrega e próximos passos

**Implementado:** autenticação + RBAC, cardápio por unidade com sazonalidade e estoque,
criação de pedido com validação e reserva de estoque em transação, integração com o PSP
(solicitação + webhook assinado + idempotência), confirmação/recusa de pagamento com
efeitos (status, pontos condicionados a consentimento LGPD, devolução de estoque),
fila da cozinha e máquina de estados, trilha de auditoria, relatório de vendas agregado,
**cancelamento de pedido pago com estorno ao PSP, reversão de pontos e devolução de
estoque (RF-13, CT-17)**, **dados pessoais do cliente (nome, CPF, e-mail, telefone)
cifrados em repouso com pgcrypto — `pgp_sym_encrypt`/`pgp_sym_decrypt`, chave fora do
código (`DADOS_PESSOAIS_CHAVE`) — com acesso restrito a ADMIN/GERENTE_UNIDADE e sempre
auditado (`ACESSO_DADO_PESSOAL`) (RNF-06)**.

**Ainda não implementado (documentado no PDF, fora do recorte "caminho de ouro"):**
o endpoint de desconto manual; resgate de pontos (RF-20);
campanhas segmentadas (RF-21); revogação de consentimento + anonimização (RF-18 / CT-18);
tabelas `consolidado_*` + job de agregação (hoje o relatório lê direto das transacionais);
reprocessamento automático de `PAGAMENTO_PENDENTE` com backoff; réplica de leitura, cache Redis
e broker de eventos (RabbitMQ) — os efeitos de negócio já estão isolados em funções, prontos
para virar handlers de evento.
