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
| 34 | Login Joao | RF-25 |
| 35 | Joao tenta revogar consentimento da Maria → **403** | RNF-07 |
| 36–37 | Maria revoga o próprio consentimento de FIDELIDADE (idempotente na 2ª chamada) | **RF-18** |
| 38 | `POST /v1/clientes/:id/anonimizacao` → `anonimizado: true` | **RF-18 / CT-18** |
| 39 | Anonimizar de novo → **409** `JA_ANONIMIZADO` | RF-18 |
| 40 | Admin confirma: nome/CPF/e-mail/telefone agora `null` | RNF-06 |
| 41–43 | Novo pedido pago da Maria → saldo de pontos **não muda** (consentimento revogado) | **CT-18** |
| 44 | `GET /v1/auditoria?tipo=ANONIMIZACAO` | RF-14 |
| 45–46 | Joao registra consentimento (`POST /consentimentos`); repetir a mesma finalidade → **409** | **RF-17** |

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
| POST | `/v1/clientes/:id/consentimentos` | CLIENTE (dono), ATENDENTE — 409 se já vigente |
| DELETE | `/v1/clientes/:id/consentimentos/:cid` | CLIENTE (dono) — idempotente |
| POST | `/v1/clientes/:id/anonimizacao` | CLIENTE (dono), ADMIN — 409 se já anonimizado |
| GET | `/v1/clientes/:id/fidelidade` | dono, ou ATENDENTE/GERENTE/ADMIN |
| POST | `/v1/unidades/:id/estoque/movimentos` | GERENTE_UNIDADE (só a própria unidade), ADMIN — `AJUSTE` exige `motivo` e audita `AJUSTE_ESTOQUE` |
| POST | `/v1/campanhas` | ADMIN, ANALISTA_MATRIZ |
| GET | `/v1/campanhas/:id/segmento` | ANALISTA_MATRIZ — só clientes com consentimento `CAMPANHA_SEGMENTADA` vigente |
| GET | `/v1/relatorios/vendas` | ANALISTA_MATRIZ |
| GET | `/v1/relatorios/vendas/export?formato=csv` | ANALISTA_MATRIZ |
| GET | `/v1/relatorios/produtos` | ANALISTA_MATRIZ — ranking por quantidade/valor |
| GET | `/v1/auditoria` | ANALISTA_MATRIZ, ADMIN |
| POST | `/v1/usuarios` | ADMIN — cria usuário interno, audita `ALTERACAO_USUARIO` |
| GET | `/health`, `/ready` | público |

`POST /v1/pedidos` aceita `resgatePontos` (inteiro, opcional): debita pontos do cliente
identificado e aplica desconto de R$ 0,01 por ponto no total (RF-20) — revertido
automaticamente se o pedido for recusado ou cancelado, mesmo padrão da reserva de estoque.

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
    pedidos/routes.js (criar, status, cancelamento, resgate de pontos - RF-20) · stateMachine.js
    pagamento/webhookRoutes.js · pspClient.js
    estoque/routes.js         (entrada e ajuste de estoque - RF-16)
    clientes/routes.js        (cadastro decifrado, consentimentos, anonimizacao - RF-17/RF-18)
    fidelidade/routes.js
    campanhas/routes.js       (criar campanha, segmento por consentimento - RF-21)
    auditoria/routes.js
    relatorios/routes.js      (vendas, export CSV, ranking de produtos - RF-22/RF-23)
    usuarios/routes.js        (cadastro de usuario interno - RF-24)
db/schema.sql                DDL (recriado a cada migrate)
scripts/migrate.js · seed.js · loadtest-setup.js
psp-fake/server.js           provedor de pagamento simulado (fora do sistema)
postman/                     coleção + environment
loadtest/pedidos.js          script k6 do teste de carga (CT-19)
test/stateMachine.test.js    unitário puro (roda no CI, sem banco)
docs/diagramas.drawio        casos de uso, classes, DER, componentes, máquina de estados
```

---

## Testes e CI

```bash
npm test          # unitário: regras da máquina de estados do pedido
npm run lint       # ESLint (regras recomendadas, config em eslint.config.js)
```

O workflow em `.github/workflows/ci.yml` tem dois jobs a cada push/PR:
**`unit`** (`npm test`, sem serviços) e **`e2e`**, que sobe um PostgreSQL real como
serviço do runner, aplica o schema e o seed, sobe a API e o PSP fake, e roda a
coleção Postman completa via Newman (61 requests / 85 assertions) — o relatório
HTML fica publicado como artefato do job (RNF-12 — automatizado, não é mais só
execução manual).

**Evidência de execução real** (fora do CI, feita durante o desenvolvimento):
- [`test-results/EXECUCAO.md`](test-results/EXECUCAO.md) — coleção completa contra
  o stack real, incluindo um bug real encontrado e corrigido.
- [`test-results/loadtest/CT-19.md`](test-results/loadtest/CT-19.md) — teste de
  carga com k6: p95 de 31ms na criação de pedido (meta RNF-02: 1000ms) e 0% de
  erro (meta RNF-03: 0,1%).
- [`test-results/security/ZAP.md`](test-results/security/ZAP.md) — varredura
  OWASP ZAP (passiva + ativa): 1 achado Alto investigado e explicado como falso
  positivo, 2 achados Baixo (headers) corrigidos de verdade no código.

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
auditado (`ACESSO_DADO_PESSOAL`) (RNF-06)**, **registro e revogação de consentimento LGPD
e anonimização do cliente (RF-17, RF-18, CT-18)** — anonimizar revoga também os
consentimentos ainda vigentes, então o acúmulo de pontos e a elegibilidade a campanha
segmentada cessam sozinhos, sem lógica especial; o histórico de pedidos permanece
vinculado ao `cliente_id`, só sem dado pessoal associado. **Resgate de pontos como
desconto progressivo no pedido (RF-20)** — debitado no momento da criação (mesmo padrão
de reserva da RF-15) e revertido automaticamente se o pedido for recusado ou cancelado.
**Entrada e ajuste manual de estoque pelo gerente (RF-16)** — ajuste exige motivo e
audita `AJUSTE_ESTOQUE`; gerente só mexe na própria unidade. **Campanhas segmentadas
(RF-21)** — criação da campanha e consulta do segmento elegível (só clientes com
consentimento `CAMPANHA_SEGMENTADA` vigente, filtrado por critério simples de
frequência/faixa etária). **Ranking de produtos e exportação CSV do relatório de vendas
(RF-22/RF-23)**. **Cadastro de usuário interno com papéis (RF-24)** — só ADMIN, audita
`ALTERACAO_USUARIO`, senha nunca volta na resposta.

**Ainda não implementado (documentado no PDF, fora do recorte "caminho de ouro"):**
o endpoint de desconto manual em um pedido já criado;
tabelas `consolidado_*` + job de agregação (hoje o relatório lê direto das transacionais);
reprocessamento automático de `PAGAMENTO_PENDENTE` com backoff; réplica de leitura, cache Redis
e broker de eventos (RabbitMQ) — os efeitos de negócio já estão isolados em funções, prontos
para virar handlers de evento.
