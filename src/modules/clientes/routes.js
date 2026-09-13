const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');
const { registrarAuditoria } = require('../../lib/audit');
const { buscarClienteDecifrado } = require('../../lib/dadosPessoais');

const router = express.Router();

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

module.exports = router;
