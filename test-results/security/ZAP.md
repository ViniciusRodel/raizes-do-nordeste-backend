# Varredura de segurança — OWASP ZAP

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
