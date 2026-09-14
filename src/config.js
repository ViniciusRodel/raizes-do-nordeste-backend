require('dotenv').config();

const DEV_DEFAULTS = {
  JWT_SECRET: 'dev-jwt-secret-troque-em-producao',
  PSP_WEBHOOK_SECRET: 'dev-psp-hmac-secret',
  DADOS_PESSOAIS_CHAVE: 'dev-chave-dados-pessoais-troque-em-producao',
};

// Avisa (sem bloquear o boot) quando um segredo sensivel esta usando o valor
// padrao de desenvolvimento — facil de esquecer de trocar ao subir em producao.
for (const chave of Object.keys(DEV_DEFAULTS)) {
  if (!process.env[chave]) {
    console.warn(`[config] ${chave} nao definido — usando valor padrao de desenvolvimento (NAO use em producao)`);
  }
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://raizes:raizes@localhost:5432/raizes',
  jwtSecret: process.env.JWT_SECRET || DEV_DEFAULTS.JWT_SECRET,
  jwtExpiraEm: process.env.JWT_EXPIRA_EM || '8h',
  pspBaseUrl: process.env.PSP_BASE_URL || 'http://localhost:4000',
  pspWebhookSecret: process.env.PSP_WEBHOOK_SECRET || DEV_DEFAULTS.PSP_WEBHOOK_SECRET,
  webhookUrlPublica:
    process.env.WEBHOOK_URL_PUBLICA || 'http://localhost:3000/v1/webhooks/pagamento',
  // Chave simetrica usada pelo pgcrypto (pgp_sym_encrypt/decrypt) para cifrar em
  // repouso os dados pessoais do cliente (RNF-06). Em producao viria de um KMS/cofre
  // (ex.: AWS KMS, Vault), nunca de uma variavel de ambiente estatica como aqui.
  dadosPessoaisChave: process.env.DADOS_PESSOAIS_CHAVE || DEV_DEFAULTS.DADOS_PESSOAIS_CHAVE,
};
