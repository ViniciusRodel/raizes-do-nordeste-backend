/**
 * Provedor de pagamento SIMULADO.
 * Nao faz parte do sistema Raizes do Nordeste: existe so para a demonstracao,
 * no lugar de um PSP real (a doc do projeto trata pagamento como servico externo).
 *
 * Fluxo:
 *   POST /charges                 -> a API pede uma cobranca; devolve idTransacao + dados de pagamento
 *   POST /charges/:id/aprovar     -> dispara webhook APROVADO (assinado com HMAC) para a API
 *   POST /charges/:id/recusar     -> dispara webhook RECUSADO
 *   POST /charges/:id/reenviar    -> reenvia o ULTIMO webhook com o MESMO idEvento (testa idempotencia, CT-11)
 *   GET  /charges                 -> lista as cobrancas em memoria
 */
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.PSP_WEBHOOK_SECRET || 'dev-psp-hmac-secret';

/** @type {Map<string, {id:string, valor:number, pedidoId:number, urlWebhook:string, ultimoEvento:string|null, status:string}>} */
const charges = new Map();

app.post('/charges', (req, res) => {
  const { valor, pedidoId, urlWebhook } = req.body || {};
  const id = 'psp_' + crypto.randomBytes(8).toString('hex');
  charges.set(id, { id, valor, pedidoId, urlWebhook, ultimoEvento: null, status: 'PENDENTE' });
  res.status(201).json({
    idTransacao: id,
    meio: 'PIX',
    dadosPagamento: { qrCode: 'PIX-COPIA-E-COLA-' + id, expiraEm: 900 },
  });
});

app.get('/charges', (_req, res) => res.json([...charges.values()]));

async function dispararWebhook(charge, status, reusarEvento) {
  const idEvento =
    reusarEvento && charge.ultimoEvento
      ? charge.ultimoEvento
      : 'evt_' + crypto.randomBytes(8).toString('hex');
  charge.ultimoEvento = idEvento;
  charge.status = status;

  const corpo = JSON.stringify({
    idEvento,
    idTransacao: charge.id,
    tipo: 'PAGAMENTO',
    status,
  });
  const assinatura = crypto.createHmac('sha256', SECRET).update(corpo).digest('hex');

  const resp = await fetch(charge.urlWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-psp-signature': assinatura },
    body: corpo,
  });
  return { idEvento, enviadoPara: charge.urlWebhook, httpStatus: resp.status, resposta: await resp.text().catch(() => '') };
}

app.post('/charges/:id/aprovar', async (req, res) => {
  const c = charges.get(req.params.id);
  if (!c) return res.status(404).json({ erro: 'cobranca nao encontrada' });
  res.json(await dispararWebhook(c, 'APROVADO', false));
});

app.post('/charges/:id/recusar', async (req, res) => {
  const c = charges.get(req.params.id);
  if (!c) return res.status(404).json({ erro: 'cobranca nao encontrada' });
  res.json(await dispararWebhook(c, 'RECUSADO', false));
});

app.post('/charges/:id/reenviar', async (req, res) => {
  const c = charges.get(req.params.id);
  if (!c || !c.ultimoEvento) return res.status(404).json({ erro: 'sem evento previo para reenviar' });
  res.json(await dispararWebhook(c, c.status, true));
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`PSP fake ouvindo em http://localhost:${PORT}`));
