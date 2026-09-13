-- Esquema do back-end da rede Raizes do Nordeste (recorte da entrega do caminho de ouro).
-- Recria tudo do zero a cada execucao de `npm run migrate`.

-- pgcrypto: usado para cifrar em repouso os dados pessoais do cliente
-- (nome_cif, cpf_cif, email_cif, telefone_cif) via pgp_sym_encrypt/pgp_sym_decrypt
-- (RNF-06). A chave simetrica vem de DADOS_PESSOAIS_CHAVE (config.js), nunca fica
-- hardcoded em SQL; ver src/lib/dadosPessoais.js.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS
  movimento_pontos, conta_fidelidade, consentimento_lgpd,
  evento_pagamento_recebido, pagamento, item_pedido, pedido,
  movimento_estoque, composicao_consumo, item_estoque, item_cardapio_unidade,
  produto_base, registro_auditoria, usuario_papel, usuario, papel,
  cliente, unidade, regiao
  CASCADE;

CREATE TABLE regiao (
  id   BIGSERIAL PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,
  uf   CHAR(2) NOT NULL
);

CREATE TABLE unidade (
  id        BIGSERIAL PRIMARY KEY,
  nome      VARCHAR(120) NOT NULL,
  endereco  VARCHAR(200),
  formato   VARCHAR(10) NOT NULL CHECK (formato IN ('COMPLETA', 'REDUZIDA')),
  ativa     BOOLEAN NOT NULL DEFAULT true,
  fuso      VARCHAR(40) NOT NULL DEFAULT 'America/Recife',
  regras    JSONB NOT NULL DEFAULT '{}',
  regiao_id BIGINT NOT NULL REFERENCES regiao(id)
);

-- nome_cif/cpf_cif/email_cif/telefone_cif: BYTEA cifrado com pgp_sym_encrypt (pgcrypto),
-- nunca texto plano. Ver src/lib/dadosPessoais.js (unica porta de entrada/saida desses campos).
CREATE TABLE cliente (
  id              BIGSERIAL PRIMARY KEY,
  nome_cif        BYTEA,
  cpf_cif         BYTEA,
  email_cif       BYTEA,
  telefone_cif    BYTEA,
  data_nascimento DATE,
  anonimizado     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE papel (
  id         BIGSERIAL PRIMARY KEY,
  nome       VARCHAR(30) UNIQUE NOT NULL,
  permissoes JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE usuario (
  id         BIGSERIAL PRIMARY KEY,
  nome       VARCHAR(120) NOT NULL,
  login      VARCHAR(60) UNIQUE NOT NULL,
  hash_senha VARCHAR(120) NOT NULL,
  unidade_id BIGINT REFERENCES unidade(id),
  cliente_id BIGINT REFERENCES cliente(id),
  ativo      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE usuario_papel (
  usuario_id BIGINT NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  papel_id   BIGINT NOT NULL REFERENCES papel(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, papel_id)
);

CREATE TABLE produto_base (
  id                 BIGSERIAL PRIMARY KEY,
  nome               VARCHAR(120) NOT NULL,
  descricao          VARCHAR(300),
  categoria          VARCHAR(60) NOT NULL,
  preco_referencia   NUMERIC(10,2) NOT NULL,
  preco_min          NUMERIC(10,2) NOT NULL,
  preco_max          NUMERIC(10,2) NOT NULL,
  regiao_restrita_id BIGINT REFERENCES regiao(id),
  sazonal            BOOLEAN NOT NULL DEFAULT false,
  janela_ini         DATE,
  janela_fim         DATE,
  ativo              BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE item_cardapio_unidade (
  id              BIGSERIAL PRIMARY KEY,
  unidade_id      BIGINT NOT NULL REFERENCES unidade(id),
  produto_base_id BIGINT NOT NULL REFERENCES produto_base(id),
  habilitado      BOOLEAN NOT NULL DEFAULT true,
  preco_venda     NUMERIC(10,2) NOT NULL,
  UNIQUE (unidade_id, produto_base_id)
);

CREATE TABLE item_estoque (
  id             BIGSERIAL PRIMARY KEY,
  unidade_id     BIGINT NOT NULL REFERENCES unidade(id),
  nome           VARCHAR(120) NOT NULL,
  unidade_medida VARCHAR(20) NOT NULL DEFAULT 'un',
  saldo          NUMERIC(12,3) NOT NULL DEFAULT 0,
  saldo_minimo   NUMERIC(12,3) NOT NULL DEFAULT 0
);

CREATE TABLE composicao_consumo (
  id              BIGSERIAL PRIMARY KEY,
  produto_base_id BIGINT NOT NULL REFERENCES produto_base(id),
  item_estoque_id BIGINT NOT NULL REFERENCES item_estoque(id),
  quantidade      NUMERIC(12,3) NOT NULL DEFAULT 1,
  UNIQUE (produto_base_id, item_estoque_id)
);

CREATE TABLE movimento_estoque (
  id              BIGSERIAL PRIMARY KEY,
  item_estoque_id BIGINT NOT NULL REFERENCES item_estoque(id),
  tipo            VARCHAR(30) NOT NULL,
  quantidade      NUMERIC(12,3) NOT NULL,
  pedido_id       BIGINT,
  usuario_id      BIGINT,
  motivo          VARCHAR(200),
  data_hora       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mov_estoque ON movimento_estoque (item_estoque_id, data_hora);

CREATE TABLE pedido (
  id                  BIGSERIAL PRIMARY KEY,
  unidade_id          BIGINT NOT NULL REFERENCES unidade(id),
  canal               VARCHAR(10) NOT NULL CHECK (canal IN ('APP', 'TOTEM', 'BALCAO', 'PICKUP')),
  cliente_id          BIGINT REFERENCES cliente(id),
  status              VARCHAR(30) NOT NULL DEFAULT 'CRIADO',
  subtotal            NUMERIC(12,2) NOT NULL DEFAULT 0,
  desconto_pontos     NUMERIC(12,2) NOT NULL DEFAULT 0,
  desconto_campanha   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total               NUMERIC(12,2) NOT NULL DEFAULT 0,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  pago_em             TIMESTAMPTZ,
  cancelado_em        TIMESTAMPTZ,
  motivo_cancelamento VARCHAR(200)
);
CREATE INDEX idx_pedido_fila    ON pedido (unidade_id, status, criado_em);
CREATE INDEX idx_pedido_pago_em ON pedido (pago_em);

CREATE TABLE item_pedido (
  id                  BIGSERIAL PRIMARY KEY,
  pedido_id           BIGINT NOT NULL REFERENCES pedido(id) ON DELETE CASCADE,
  produto_base_id     BIGINT NOT NULL REFERENCES produto_base(id),
  descricao_snapshot  VARCHAR(120) NOT NULL,
  preco_unit_snapshot NUMERIC(10,2) NOT NULL,
  quantidade          INT NOT NULL,
  subtotal            NUMERIC(12,2) NOT NULL
);

CREATE TABLE pagamento (
  id                  BIGSERIAL PRIMARY KEY,
  pedido_id           BIGINT NOT NULL UNIQUE REFERENCES pedido(id),
  id_transacao_psp    VARCHAR(80) UNIQUE,
  status              VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  valor               NUMERIC(10,2) NOT NULL,
  meio                VARCHAR(20),
  chave_idempotencia  VARCHAR(80),
  solicitado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em        TIMESTAMPTZ,
  tentativas          INT NOT NULL DEFAULT 0
);

-- Idempotencia do webhook: a PK e o id do evento vindo do PSP (RF-10).
CREATE TABLE evento_pagamento_recebido (
  id_evento     VARCHAR(80) PRIMARY KEY,
  pagamento_id  BIGINT REFERENCES pagamento(id),
  tipo          VARCHAR(30) NOT NULL,
  payload_hash  VARCHAR(80) NOT NULL,
  recebido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processado_em TIMESTAMPTZ
);

CREATE TABLE consentimento_lgpd (
  id           BIGSERIAL PRIMARY KEY,
  cliente_id   BIGINT NOT NULL REFERENCES cliente(id),
  finalidade   VARCHAR(30) NOT NULL,
  versao_texto VARCHAR(20) NOT NULL DEFAULT 'v1',
  concedido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogado_em  TIMESTAMPTZ,
  base_legal   VARCHAR(20) NOT NULL DEFAULT 'CONSENTIMENTO'
);
CREATE INDEX idx_consent ON consentimento_lgpd (cliente_id, finalidade);

CREATE TABLE conta_fidelidade (
  id           BIGSERIAL PRIMARY KEY,
  cliente_id   BIGINT NOT NULL UNIQUE REFERENCES cliente(id),
  saldo_pontos INT NOT NULL DEFAULT 0,
  criada_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE movimento_pontos (
  id        BIGSERIAL PRIMARY KEY,
  conta_id  BIGINT NOT NULL REFERENCES conta_fidelidade(id),
  tipo      VARCHAR(20) NOT NULL,
  pontos    INT NOT NULL,
  pedido_id BIGINT,
  data_hora TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trilha de auditoria imutavel (RF-14 / RNF-08).
-- Em producao a aplicacao conecta com uma role SEM privilegio de UPDATE/DELETE aqui;
-- correcoes entram como novos registros.
CREATE TABLE registro_auditoria (
  id               BIGSERIAL PRIMARY KEY,
  tipo             VARCHAR(40) NOT NULL,
  usuario_id       BIGINT,
  papel            VARCHAR(30),
  unidade_id       BIGINT,
  entidade_afetada VARCHAR(40) NOT NULL,
  entidade_id      VARCHAR(40) NOT NULL,
  valor_anterior   JSONB,
  valor_novo       JSONB,
  motivo           VARCHAR(200),
  data_hora        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_tipo    ON registro_auditoria (tipo, data_hora);
CREATE INDEX idx_auditoria_unidade ON registro_auditoria (unidade_id, data_hora);
