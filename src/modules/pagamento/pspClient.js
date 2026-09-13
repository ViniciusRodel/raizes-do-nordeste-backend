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

module.exports = { solicitarCobranca };
