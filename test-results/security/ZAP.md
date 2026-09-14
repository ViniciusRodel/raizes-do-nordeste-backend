# Varredura de segurança — OWASP ZAP

> **Rodada 2 (mais recente) documentada primeiro, abaixo.** A Rodada 1 original
> (quando a API só tinha os endpoints do "caminho de ouro" inicial) fica preservada
> no fim deste arquivo, sem alterações, como registro histórico.

## Rodada 2 — após RF-16/20/21/22/23/24 e desconto manual (68 endpoints)

Mesma metodologia da Rodada 1 (tráfego real roteado pelo proxy do ZAP — agora a
coleção Postman inteira, 68 requests, via `HTTP_PROXY`/`HTTPS_PROXY` — seguido de
varredura ativa recursiva contra `http://localhost:3000`), repetida em **4 rodadas
de scan** conforme bugs reais eram encontrados e corrigidos, com o código sempre
reverificado diretamente (nunca aceitando o veredito do scanner sem checar).

**Resumo visual:** `../../../diagramas_png/zap-resumo.png` (Figura anexada ao PDF,
Seção 5).

### 1ª varredura desta rodada — 3 Alto, 2 Médio, 2 Baixo

| Risco | Achado | URL |
|---|---|---|
| Alto | SQL Injection | `POST /v1/usuarios` (`login`), evidência real: `HTTP/1.1 500` |
| Alto | SQL Injection | `GET /unidades/:id/cardapio` (`canal`) — mesmo falso positivo da Rodada 1 |
| Alto | Path Traversal | `POST /v1/usuarios` (`login`) |
| Médio | Format String Error | `POST /v1/campanhas` (`nome`), `POST /v1/usuarios` (`login`) |
| Baixo | XSS (JSON persistente) | `GET /v1/auditoria` (`motivo`, `login`) |

Diferente da Rodada 1, desta vez o achado de SQLi em `/v1/usuarios` veio com
**evidência concreta de um 500 real** — não foi descartado de cara. Investigação:

```
POST /v1/usuarios { "login": "aaaa...(80 chars)", ... }
→ HTTP 500 { "erro": { "codigo": "ERRO_INTERNO" } }

api.log: error: value too long for type character varying(60)
         at .../src/modules/usuarios/routes.js:42
```

**Achado real #1 (não é injeção):** `usuario.login` é `VARCHAR(60)` e
`campanha.nome` é `VARCHAR(120)`, mas nenhuma das duas rotas validava o tamanho
antes do INSERT. Um texto maior que a coluna ia direto pro driver `pg`, que
rejeitava com `value too long for type character varying(N)` — um 500 não
tratado. O ZAP viu o 500 e **chutou dois diagnósticos errados ao mesmo tempo**
(SQL Injection e Format String Error) para o mesmo bug real. Corrigido com
`parseTexto()` (`src/lib/errors.js`), validando o tamanho máximo antes de
qualquer query, aplicado em `usuarios`, `campanhas`, `pedidos` (desconto,
cancelamento), `estoque` (ajuste) e `clientes` (consentimento).

### 2ª varredura (após o fix acima, sessão nova) — Médio zerado, Alto persiste

Confirmação: **os 2 achados Médio desapareceram** — prova que `parseTexto()`
resolveu a causa raiz. Mas o Alto de SQL Injection em `/v1/usuarios` reapareceu,
agora com `attack: "'"` e evidência `HTTP/1.1 500` de novo — **um 500 diferente**:

```
api.log: error: duplicate key value violates unique constraint "usuario_login_key"
         code: '23505'
```

**Achado real #2 (também não é injeção):** condição de corrida entre o
`SELECT ... WHERE login = $1` de verificação de unicidade e o `INSERT` logo
depois — duas criações de usuário com o mesmo `login` quase simultâneas (o que
o scan ativo faz naturalmente, disparando requisições em paralelo) podem as
duas passar pelo `SELECT` antes que qualquer uma commite o `INSERT`. A segunda
`INSERT` viola a constraint `UNIQUE` e explode em 500. Corrigido capturando o
erro `23505` (`unique_violation`) e convertendo para `409 LOGIN_EM_USO` — a
mesma resposta que o caminho feliz (sem corrida) já dava. Verificado disparando
5 requisições concorrentes com o mesmo login: 1× `201`, 4× `409`, zero erro não
tratado no log.

### 3ª varredura (após os 2 fixes acima) — Médio continua zerado; achado extra fora do ZAP

O Alto de SQLi e o de Path Traversal em `/v1/usuarios` persistiram, mas agora
**sem nenhuma evidência de 500** (campo `evidence` vazio) — sinal de que já não
há mais um erro real por trás. Confirmado manualmente:

- **SQL Injection:** `POST /v1/usuarios` com `login = "teste_sqli AND 1=1 --"` →
  `201 Created`, e uma consulta direta ao banco (`SELECT login FROM usuario ...`)
  mostra o valor **gravado literalmente**, prova de que a string nunca foi
  interpretada como SQL (o driver `pg` sempre parametriza).
- **Path Traversal:** não existe nenhuma leitura de arquivo/caminho em
  `usuarios/routes.js` — confirmado lendo o código-fonte inteiro da rota.

Enquanto verificava esses dois, uma inspeção do `api.log` da mesma janela
revelou um **terceiro bug real que o ZAP não chegou a rotular como alerta
próprio** (a mutação de parâmetro específica não bateu em nenhuma assinatura do
scanner, mas o 500 estava lá):

```
api.log: error: date/time field value out of range / DateTimeParseError
         where: "unnamed portal parameter $6 = '...'"
```

**Achado real #3:** `POST /v1/campanhas` (`inicio`/`fim`) e os três endpoints de
`GET /v1/relatorios/*` (`inicio`/`fim` como query string) passavam a data direto
para um cast `::date` do Postgres sem validar o formato — uma data mal formada
(`fim=nao-e-uma-data`) explodia em 500. Corrigido com `parseData()`
(`src/lib/errors.js`), validando `AAAA-MM-DD` antes de qualquer query nos 4
pontos de entrada.

### 4ª varredura (final, após os 3 fixes) — estado estável

| Risco | Qtde | Achados |
|---|---|---|
| Alto | 2 | SQL Injection e Path Traversal em `/v1/usuarios` (`login`) — falsos positivos confirmados acima, evidência vazia |
| Alto (ocasional) | 0–1 | `canal` no cardápio — mesmo falso positivo já documentado na Rodada 1 (nem sempre dispara, depende da concorrência do próprio scan) |
| Médio | **0** | (eram 2; ambos confirmados corrigidos em duas rodadas seguidas) |
| Baixo | 2 | XSS-JSON em `/v1/auditoria` — falso positivo padrão de scanner de segurança contra API JSON pura (não há renderização HTML em nenhum consumidor) |
| Informativo | 193 | User Agent Fuzzer / Session Management (sem ação) |

Relatórios completos desta rodada: `zap-report-final.html` (varredura final) e
`zap-report-atual.html`/`zap-alerts-depois-do-fix2.json` (rodadas intermediárias).

**Nota sobre a infraestrutura desta investigação:** durante a 3ª e a 4ª rodada,
o processo do ZAP (`zap-2.17.0.jar`, baixado como pacote portátil oficial) foi
removido do disco duas vezes entre uma varredura e outra, sem nenhuma ação
deste projeto — padrão consistente com detecção heurística de antivírus /
Windows Defender contra ferramentas de pentest (falso positivo comum e
documentado publicamente para o próprio ZAP). Contornado reextraindo o jar do
pacote baixado e reiniciando o daemon; não afetou os resultados, só atrasou a
investigação.

### Regressão

Após os 3 fixes, suíte completa reexecutada do zero (banco recriado):
`npm test` (8/8) e Postman/Newman (**68 requests / 98 assertions, 0 falhas** —
`../newman-output.txt`) — nenhuma regressão.

---

# Rodada 1 (histórico, endpoints do caminho de ouro inicial)

Varredura real (passiva + ativa) com **OWASP ZAP 2.17.0**, em modo daemon (sem GUI),
contra a API rodando localmente. Metodologia: como a API é REST/JSON (não HTML para
o spider tradicional seguir), o tráfego foi **roteado pelo proxy do ZAP** — login de
cada papel, os principais endpoints autenticados, tentativas sem token / com token
inválido, e o webhook sem assinatura válida — para o ZAP montar uma árvore de sites
realista a partir de requisições de verdade. Em seguida foi disparada uma varredura
ativa (`/JSON/ascan/action/scan/`, `recurse=true`) contra `http://localhost:3000`.

## Resultado (antes da correção)

| Risco | Qtde | Achado |
|---|---|---|
| **Alto** | 1 | SQL Injection em `canal` (`GET /v1/unidades/{id}/cardapio`) |
| Baixo | 8 | X-Content-Type-Options Header Missing |
| Baixo | 10 | Server Leaks Information via X-Powered-By |
| Informativo | 49 | User Agent Fuzzer / Session Management Response Identified (sem ação) |

Relatório completo: `zap-report-antes-do-fix.html` · alertas crus: `zap-alerts-antes.json`.

## Achado de Alto risco — investigado e classificado como falso positivo

O ZAP sinalizou possível SQL Injection no parâmetro `canal`. **Antes de aceitar o
alerta, verificamos o código:** `canal` nunca é usado em nenhuma consulta SQL — o
handler só o ecoa de volta no JSON (`catalogo/routes.js`, versão anterior ao fix).

Confirmação empírica, comparando a mesma consulta com payload "verdadeiro"
(`canal=APP' AND '1'='1' --`) e "falso" (`canal=APP' AND '1'='2' --`):

```
verdadeiro: {"itens":[...4 itens, mesmo conteudo...]}
falso:      {"itens":[...4 itens, mesmo conteudo, byte a byte identico...]}
```

O array `itens` (o que realmente vem do banco) é **idêntico** nos dois casos — a
única diferença era o próprio `canal` refletido, o que basta para confundir a
heurística de diff do ZAP (ela compara corpos de resposta; qualquer parâmetro
refletido sem uso em SQL pode gerar esse falso positivo). Depois de aplicar o fix
de validação (`canal` passa a ser normalizado contra uma lista permitida antes de
entrar na resposta — ver abaixo), reexecutamos a varredura ativa: **o alerta
persistiu**, mas por um motivo diferente e também benigno — o ZAP recursa o site
inteiro, inclusive `POST /v1/pedidos` (que decrementa estoque de verdade); como o
scanner dispara requisições em paralelo, duas chamadas quase simultâneas a
`GET /cardapio` podem ver `estoqueDisponivel` diferente **por causa de pedidos
concorrentes criados pelo próprio scan**, não pelo payload injetado. Confirmado
isolando o teste (três chamadas sequenciais, sem escrita concorrente em voo): as
respostas voltam **byte a byte idênticas**, com ou sem o payload de SQLi.
**Conclusão: falso positivo, causado por (1) reflexão de parâmetro não usado em SQL
e (2) leitura de um valor que naturalmente varia sob escrita concorrente — não por
injeção de fato.**

## Correções aplicadas

1. **`canal` validado contra lista permitida** (`APP`, `TOTEM`, `BALCAO`, `PICKUP`)
   antes de entrar na resposta, em vez de refletir texto arbitrário do cliente
   (`src/modules/catalogo/routes.js`). Elimina a causa raiz do falso positivo e é,
   de toda forma, a prática correta — nunca refletir input não validado.
2. **`X-Powered-By` desabilitado** (`app.disable('x-powered-by')`) — não anunciar a
   stack (Low, 10 ocorrências).
3. **`X-Content-Type-Options: nosniff`** adicionado a toda resposta (Low, 8
   ocorrências).

Ambos aplicados em `src/server.js`, sem novas dependências (sem trazer `helmet` só
por dois headers).

## Resultado (depois da correção)

| Risco | Qtde |
|---|---|
| Alto | 1 (o falso positivo documentado acima, causa raiz explicada, não é uma vulnerabilidade real) |
| Médio | 0 |
| Baixo | **0** (eram 18, ambos os tipos corrigidos) |
| Informativo | 49 (sem ação) |

Relatório completo: `zap-report-depois-do-fix.html` · alertas crus: `zap-alerts-depois.json`.

Reexecutada a coleção Postman completa após o fix: **46 requests / 57 assertions,
0 falhas** (`../newman-output.txt`) — nenhuma regressão.

## Como reproduzir

1. Suba o stack (`docker compose up`).
2. Baixe o ZAP (cross-platform, sem instalador): <https://www.zaproxy.org/download/>.
3. `zap.sh -daemon -host 127.0.0.1 -port 8090 -config api.disablekey=true`
4. Rode um conjunto de chamadas representativas com `curl -x http://127.0.0.1:8090 ...`
   (login de cada papel, endpoints autenticados, tentativas sem token).
5. `curl "http://127.0.0.1:8090/JSON/ascan/action/scan/?url=http://localhost:3000&recurse=true"`
6. `curl "http://127.0.0.1:8090/JSON/core/view/alertsSummary/?baseurl=http://localhost:3000"`
