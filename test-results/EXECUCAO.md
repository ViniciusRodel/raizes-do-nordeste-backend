# Evidência de execução - caminho de ouro

Execução real do stack completo (API + PostgreSQL + PSP fake), não apenas leitura de código.

**Ambiente:** Windows, Node.js 20/24, PostgreSQL 16 (instância local dedicada, porta 5433),
API na porta 3000, PSP fake na porta 4000. Banco recriado do zero (`npm run migrate && npm run seed`)
antes da execução. Desde a versão mais recente, **a mesma coleção também roda dentro do CI**
a cada push (`.github/workflows/ci.yml`, job `e2e`) - ver seção "Testes e CI" do README.

Este arquivo cobre o funcional (caminho de ouro). Para os outros dois tipos de evidência do
Plano de Testes:
- [`loadtest/CT-19.md`](loadtest/CT-19.md) - teste de carga (k6).
- [`security/ZAP.md`](security/ZAP.md) - varredura de segurança (OWASP ZAP).

## Resultado da coleção Postman (Newman)

```
70 requests, 70 test-scripts, 102 assertions - 0 falhas
```

(Cresceu de 46/57 para 70/102 nesta rodada, com a cobertura de RF-16, RF-20,
RF-21, RF-22, RF-23, RF-24, do desconto manual e de regressão para os 2 bugs
de validação achados via OWASP ZAP - ver a Seção 5 do PDF e
`security/ZAP.md` para os 3 bugs reais achados e corrigidos durante essa
rodada de testes.)

Cobre o caminho de ouro completo:
- **Cancelamento de pedido pago com estorno** (RF-13, CT-17): cria um segundo pedido, aprova
  o pagamento, credita pontos, cancela com `motivo` obrigatório, confirma que o PSP fake marca
  a cobrança como `ESTORNADO`, que os pontos creditados são revertidos (`saldo` volta ao valor
  anterior) e que a trilha de auditoria registra `CANCELAMENTO` com autor/papel/motivo. Mais
  dois negativos: cancelar um pedido já `ENTREGUE` (409) e cancelar sem `motivo` (400).
- **Dados pessoais cifrados em repouso** (RNF-06): `GET /v1/clientes/:id` (só ADMIN/GERENTE_UNIDADE)
  devolve nome/CPF/e-mail/telefone **decifrados na hora** com `pgp_sym_decrypt` (pgcrypto) - na
  tabela eles ficam como `BYTEA` cifrado com `pgp_sym_encrypt`, nunca texto plano. Testado também
  que um papel sem permissão (ATENDENTE) recebe 403, e que o acesso gera auditoria
  `ACESSO_DADO_PESSOAL` com autor e papel.
- **Revogação de consentimento e anonimização** (RF-17, RF-18, CT-18): registra consentimento
  (`POST /clientes/:id/consentimentos`, com 409 se já vigente), revoga (idempotente), solicita
  anonimização (`POST /clientes/:id/anonimizacao`) e confirma que: o cadastro passa a devolver
  nome/CPF/e-mail/telefone `null`; um novo pedido pago **não** credita pontos (o consentimento de
  FIDELIDADE foi revogado junto); o pedido antigo continua no histórico com `cliente_id` intacto
  (sem dado pessoal associado); anonimizar de novo dá `409 JA_ANONIMIZADO`; e a auditoria registra
  `ANONIMIZACAO`. Mais um negativo: outro cliente tentando revogar consentimento alheio → 403.

Arquivos desta pasta:
- `relatorio-execucao.html` - relatório visual completo (newman-reporter-htmlextra); abra no navegador.
- `newman-output.txt` - saída da execução em texto (linha de comando).
- `auditoria-exemplo.json` - resposta real de `GET /v1/auditoria`, incluindo os registros
  `ANONIMIZACAO`, `ACESSO_DADO_PESSOAL`, `CANCELAMENTO` (com motivo) e `PAGAMENTO_CONFIRMADO`.

## Cifragem verificada diretamente no banco (fora da coleção)

```sql
-- dado bruto na tabela: binario ilegivel (comeca com \xc30d0407..., cabecalho OpenPGP)
SELECT nome_cif FROM cliente WHERE id = 1;

-- com a chave certa, decifra
SELECT pgp_sym_decrypt(nome_cif, 'dev-chave-dados-pessoais') FROM cliente WHERE id = 1;
--> 'Maria Souza'

-- com a chave errada, falha (prova que e cifragem de verdade, nao so encoding)
SELECT pgp_sym_decrypt(nome_cif, 'chave-errada') FROM cliente WHERE id = 1;
--> ERROR:  Wrong key or corrupt data
```

## Bug real encontrado e corrigido nesta execução

A primeira rodada **falhou** em `GET /v1/clientes/:id/fidelidade` (403 para o próprio dono da conta):
o driver `pg` devolve colunas `BIGINT` como *string* por padrão; o `clienteId` vindo do JWT
(`"1"`, string) era comparado com `Number(req.params.id)` (`1`, number) e a comparação estrita
falhava. Corrigido em `src/db.js` configurando `pg.types.setTypeParser(20, parseInt)` para o
driver inteiro (não só o ponto que falhou) - fez o valor voltar consistente como `Number` em toda
a aplicação. Reexecutada a coleção após a correção: 28/28 assertions, 0 falhas.

## 3 bugs reais encontrados e corrigidos na rodada de OWASP ZAP

Detalhe completo em [`security/ZAP.md`](security/ZAP.md) - resumo:

1. **Sem validação de tamanho de texto** (`login`, `nome`, `motivo`, `versaoTexto`)
   contra o limite `VARCHAR` da coluna - um valor maior que a coluna virava
   `500 ERRO_INTERNO` em vez de `400`. Corrigido com `parseTexto()`.
2. **Corrida entre checagem e inserção** em `POST /v1/usuarios`: dois logins
   iguais quase simultâneos podiam os dois passar pela checagem de unicidade
   antes de qualquer um confirmar o `INSERT`, e o segundo explodia em `500`
   em vez de `409 LOGIN_EM_USO`. Corrigido capturando a violação de unicidade
   do Postgres (`23505`).
3. **Sem validação de formato de data** (`inicio`/`fim` em campanhas e
   relatórios) - uma data mal formada ia direto pro cast `::date` do Postgres
   e virava `500`. Corrigido com `parseData()`.

Nenhum dos três era a vulnerabilidade que o ZAP diagnosticou (SQL Injection /
Path Traversal / Format String Error) - eram bugs reais de validação ausente
causando erros não tratados, que o scanner interpretou errado. Todos
verificados por reprodução direta antes e depois do fix.

## Casos extras verificados manualmente (fora da coleção automatizada)

| Caso | Como foi testado | Resultado |
|---|---|---|
| **CT-10** - PSP indisponível | PSP fake derrubado; `POST /v1/pedidos` criado mesmo assim | `201`, pedido em `PAGAMENTO_PENDENTE`, `pagamento: null`, aviso claro na resposta |
| **CT-12** - webhook com assinatura inválida | `POST /v1/webhooks/pagamento` com `x-psp-signature` forjada | `401 ASSINATURA_INVALIDA` |
| **CT-14** - concorrência no estoque | 2 requisições simultâneas de "Bolo de Macaxeira" (saldo = 1 na unidade 1) | uma `201 Created`, outra `422 ESTOQUE_INSUFICIENTE` - nunca as duas `201` (trava `FOR UPDATE` funcionando) |

Reproduzir: suba o stack (`docker compose up` - ver README) e rode
`npx newman run postman/raizes-do-nordeste.postman_collection.json -e postman/raizes-do-nordeste.postman_environment.json`.
