const { pspBaseUrl, webhookUrlPublica } = require('../../config');

/**
 * Solicita a cobranca ao provedor de pagamento externo (RF-08).
 * O sistema NAO processa pagamento: apenas pede, e o resultado chega depois
 * de forma assincrona pelo webhook.
 *
 * @throws Error com .pspStatus quando o PSP responde erro de HTTP (RNF-05 / CT-10).
 */
async function solicitarCobranca({ valor, pedidoId, chaveIdempotencia }) {
  const resp = await fetch(`${pspBaseUrl}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      valor,
      pedidoId,
      chaveIdempotencia,
      urlWebhook: webhookUrlPublica,
    }),
    // timeout curto: se o PSP nao responde rapido, tratamos como indisponivel
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    const texto = await resp.text().catch(() => '');
    const err = new Error(`PSP respondeu HTTP ${resp.status}: ${texto}`);
    err.pspStatus = resp.status;
    throw err;
  }
  return resp.json(); // { idTransacao, meio, dadosPagamento }
}

/**
 * Solicita o estorno de uma cobranca ja aprovada (RF-13).
 * Usado no cancelamento de pedido pago (POST /v1/pedidos/:id/cancelamento).
 * Diferente da cobranca, o estorno aqui e sincrono: o PSP confirma na resposta
 * (nao volta por webhook) — simplificacao razoavel para esta entrega.
 *
 * @throws Error com .pspStatus quando o PSP responde erro de HTTP.
 */
async function solicitarEstorno({ idTransacaoPSP }) {
  const resp = await fetch(`${pspBaseUrl}/charges/${idTransacaoPSP}/estornar`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => '');
    const err = new Error(`PSP respondeu HTTP ${resp.status}: ${texto}`);
    err.pspStatus = resp.status;
    throw err;
  }
  return resp.json(); // { idTransacao, status: 'ESTORNADO' }
}

module.exports = { solicitarCobranca, solicitarEstorno };
