require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://raizes:raizes@localhost:5432/raizes',
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-troque-em-producao',
  jwtExpiraEm: process.env.JWT_EXPIRA_EM || '8h',
  pspBaseUrl: process.env.PSP_BASE_URL || 'http://localhost:4000',
  pspWebhookSecret: process.env.PSP_WEBHOOK_SECRET || 'dev-psp-hmac-secret',
  webhookUrlPublica:
    process.env.WEBHOOK_URL_PUBLICA || 'http://localhost:3000/v1/webhooks/pagamento',
  // Chave simetrica usada pelo pgcrypto (pgp_sym_encrypt/decrypt) para cifrar em
  // repouso os dados pessoais do cliente (RNF-06). Em producao viria de um KMS/cofre
  // (ex.: AWS KMS, Vault), nunca de uma variavel de ambiente estatica como aqui.
  dadosPessoaisChave:
    process.env.DADOS_PESSOAIS_CHAVE || 'dev-chave-dados-pessoais-troque-em-producao',
};
