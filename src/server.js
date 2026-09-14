const express = require('express');
const { port } = require('./config');
const db = require('./db');
const { autenticar } = require('./auth/jwt');
const { HttpError } = require('./lib/errors');

const app = express();

// Nao anunciar a stack (achado OWASP ZAP: "Server Leaks Information via
// X-Powered-By" - ver test-results/security/ZAP.md).
app.disable('x-powered-by');

// Guarda o corpo cru para validar a assinatura HMAC do webhook do PSP.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Cabecalhos minimos de seguranca (achado OWASP ZAP: "X-Content-Type-Options
// Header Missing"). Sem trazer helmet como dependencia so por isto.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ---- Saude / prontidao (RNF-01) ----
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'degradado' });
  }
});

// ---- Rotas publicas ----
app.use('/v1/auth', require('./auth/routes'));
// Webhook do PSP: autenticado por HMAC, nao por JWT -> montado antes do autenticar
app.use('/v1', require('./modules/pagamento/webhookRoutes'));

// ---- A partir daqui, exige token ----
app.use('/v1', autenticar);
app.use('/v1', require('./modules/catalogo/routes'));
app.use('/v1', require('./modules/pedidos/routes'));
app.use('/v1', require('./modules/estoque/routes'));
app.use('/v1', require('./modules/clientes/routes'));
app.use('/v1', require('./modules/fidelidade/routes'));
app.use('/v1', require('./modules/campanhas/routes'));
app.use('/v1', require('./modules/auditoria/routes'));
app.use('/v1', require('./modules/relatorios/routes'));
app.use('/v1', require('./modules/usuarios/routes'));

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({
    erro: { codigo: 'ROTA_NAO_ENCONTRADA', mensagem: `${req.method} ${req.originalUrl}` },
  });
});

// ---- Middleware de erro ----
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      erro: { codigo: err.codigo, mensagem: err.message, detalhes: err.detalhes },
    });
  }
  console.error(err);
  res.status(500).json({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro inesperado' } });
});

if (require.main === module) {
  app.listen(port, () => console.log(`API Raizes do Nordeste ouvindo em http://localhost:${port}`));
}

module.exports = app;
