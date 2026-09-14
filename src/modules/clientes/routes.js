const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');
const { registrarAuditoria } = require('../../lib/audit');
const { buscarClienteDecifrado } = require('../../lib/dadosPessoais');

const router = express.Router();
const FINALIDADES = ['FIDELIDADE', 'CAMPANHA_SEGMENTADA', 'ANALISE_PERFIL'];

/**
 * Papeis de staff em `papeisStaff` sempre podem agir; caso contrario, so o
 * proprio cliente (token CLIENTE com clienteId batendo com :id) pode.
 */
function garantirDonoOuStaff(req, idParam, papeisStaff = []) {
  if (req.usuario.papeis.some((p) => papeisStaff.includes(p))) return;
  if (req.usuario.papeis.includes('CLIENTE') && req.usuario.clienteId === Number(idParam)) return;
  throw erro(403, 'ACESSO_NEGADO', 'So o proprio cliente (ou papel autorizado) pode realizar esta acao');
}

// GET /v1/clientes/:id  -> RNF-06 (dados pessoais cifrados em repouso) + RF-14
// Cadastro completo do cliente, decifrado sob demanda (pgp_sym_decrypt). Acesso
// restrito a ADMIN/GERENTE_UNIDADE e SEMPRE gera um registro de auditoria
// ACESSO_DADO_PESSOAL — ninguem consulta nome/CPF/e-mail/telefone sem deixar rastro.
router.get(
  '/clientes/:id',
  requer('ADMIN', 'GERENTE_UNIDADE'),
  asyncHandler(async (req, res) => {
    const cliente = await db.withTransaction(async (client) => {
      const c = await buscarClienteDecifrado(client, req.params.id);
      if (!c) throw erro(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente inexistente');

      await registrarAuditoria(client, {
        tipo: 'ACESSO_DADO_PESSOAL',
        usuarioId: req.usuario.id,
        papel: req.usuario.papeis.join(','),
        entidadeAfetada: 'cliente',
        entidadeId: c.id,
        motivo: 'Consulta do cadastro completo do cliente',
      });

      return c;
    });

    res.json({
      id: cliente.id,
      nome: cliente.nome,
      cpf: cliente.cpf,
      email: cliente.email,
      telefone: cliente.telefone,
      dataNascimento: cliente.data_nascimento,
      anonimizado: cliente.anonimizado,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /v1/clientes/:id/consentimentos  -> RF-17
// Registra consentimento explicito (finalidade + versao do texto). O proprio
// cliente registra o seu; o atendente pode registrar em nome de um cliente
// presencial (ex.: totem/balcao sem app). Nao ha "renovar": se ja existe
// consentimento vigente para a mesma finalidade, e 409 (revogue antes).
// ---------------------------------------------------------------------------
router.post(
  '/clientes/:id/consentimentos',
  requer('CLIENTE', 'ATENDENTE'),
  asyncHandler(async (req, res) => {
    garantirDonoOuStaff(req, req.params.id, ['ATENDENTE']);

    const { finalidade, versaoTexto } = req.body || {};
    if (!FINALIDADES.includes(finalidade)) {
      throw erro(400, 'PAYLOAD_INVALIDO', `finalidade deve ser um de ${FINALIDADES.join(', ')}`);
    }

    const resultado = await db.withTransaction(async (client) => {
      const { rows: cli } = await client.query('SELECT id FROM cliente WHERE id = $1', [req.params.id]);
      if (!cli[0]) throw erro(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente inexistente');

      const { rows: vigente } = await client.query(
        `SELECT 1 FROM consentimento_lgpd
          WHERE cliente_id = $1 AND finalidade = $2 AND revogado_em IS NULL`,
        [req.params.id, finalidade],
      );
      if (vigente.length) {
        throw erro(409, 'CONSENTIMENTO_JA_VIGENTE', 'Ja existe consentimento vigente para essa finalidade');
      }

      const { rows } = await client.query(
        `INSERT INTO consentimento_lgpd (cliente_id, finalidade, versao_texto)
         VALUES ($1, $2, $3)
         RETURNING id, cliente_id, finalidade, versao_texto, concedido_em`,
        [req.params.id, finalidade, versaoTexto || 'v1'],
      );
      return rows[0];
    });

    res.status(201).json({
      id: resultado.id,
      clienteId: resultado.cliente_id,
      finalidade: resultado.finalidade,
      versaoTexto: resultado.versao_texto,
      concedidoEm: resultado.concedido_em,
    });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /v1/clientes/:id/consentimentos/:cid  -> RF-18 (revogacao)
// So o proprio dono revoga. Idempotente: revogar de novo um consentimento ja
// revogado apenas devolve o revogadoEm original, sem erro.
// ---------------------------------------------------------------------------
router.delete(
  '/clientes/:id/consentimentos/:cid',
  requer('CLIENTE'),
  asyncHandler(async (req, res) => {
    garantirDonoOuStaff(req, req.params.id, []);

    const resultado = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, revogado_em FROM consentimento_lgpd WHERE id = $1 AND cliente_id = $2',
        [req.params.cid, req.params.id],
      );
      if (!rows[0]) {
        throw erro(404, 'CONSENTIMENTO_NAO_ENCONTRADO', 'Consentimento inexistente para este cliente');
      }
      if (rows[0].revogado_em) return rows[0];

      const { rows: upd } = await client.query(
        'UPDATE consentimento_lgpd SET revogado_em = now() WHERE id = $1 RETURNING revogado_em',
        [req.params.cid],
      );
      return upd[0];
    });

    res.json({ revogadoEm: resultado.revogado_em });
  }),
);

// ---------------------------------------------------------------------------
// POST /v1/clientes/:id/anonimizacao  -> RF-18 (anonimizacao) + CT-18
// Apaga (NULL) nome/cpf/email/telefone e marca anonimizado=true; o historico
// de pedidos permanece (FK cliente_id intacta) mas sem dado pessoal associado
// - "pedidos antigos mantidos sem identificacao" (decisao documentada no PDF).
// Revoga tambem qualquer consentimento ainda vigente: sem consentimento, o
// credito de pontos (RF-19) e a segmentacao de campanha (RF-21) param sozinhos,
// sem precisar de logica especial em nenhum dos dois.
// ---------------------------------------------------------------------------
router.post(
  '/clientes/:id/anonimizacao',
  requer('CLIENTE', 'ADMIN'),
  asyncHandler(async (req, res) => {
    garantirDonoOuStaff(req, req.params.id, ['ADMIN']);

    await db.withTransaction(async (client) => {
      const { rows: cli } = await client.query(
        'SELECT id, anonimizado FROM cliente WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      if (!cli[0]) throw erro(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente inexistente');
      if (cli[0].anonimizado) throw erro(409, 'JA_ANONIMIZADO', 'Cliente ja foi anonimizado');

      await client.query(
        `UPDATE cliente
            SET nome_cif = NULL, cpf_cif = NULL, email_cif = NULL, telefone_cif = NULL,
                data_nascimento = NULL, anonimizado = true
          WHERE id = $1`,
        [req.params.id],
      );
      await client.query(
        `UPDATE consentimento_lgpd SET revogado_em = now()
          WHERE cliente_id = $1 AND revogado_em IS NULL`,
        [req.params.id],
      );

      await registrarAuditoria(client, {
        tipo: 'ANONIMIZACAO',
        usuarioId: req.usuario.id,
        papel: req.usuario.papeis.join(','),
        entidadeAfetada: 'cliente',
        entidadeId: req.params.id,
        valorAnterior: { anonimizado: false },
        valorNovo: { anonimizado: true },
        motivo: 'Solicitacao de exclusao/anonimizacao de dados pessoais (RF-18)',
      });
    });

    res.json({ clienteId: Number(req.params.id), anonimizado: true });
  }),
);

module.exports = router;
