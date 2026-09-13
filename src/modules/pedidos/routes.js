const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');
const { podeTransicionar } = require('./stateMachine');
const psp = require('../pagamento/pspClient');
const { registrarAuditoria } = require('../../lib/audit');
const { devolverEstoque } = require('../../lib/estoque');
const { estornarPontos } = require('../../lib/pontos');

const router = express.Router();
const CANAIS = ['APP', 'TOTEM', 'BALCAO', 'PICKUP'];

// ---------------------------------------------------------------------------
// POST /v1/pedidos  -> RF-05, RF-06, RF-15, RF-08 (CT-01/02/03/10/13/14)
// Valida itens, reserva estoque em transacao, cria o pedido e solicita a
// cobranca ao PSP. Se o PSP falha, o pedido nasce PAGAMENTO_PENDENTE.
// ---------------------------------------------------------------------------
router.post(
  '/pedidos',
  requer('CLIENTE', 'ATENDENTE'),
  asyncHandler(async (req, res) => {
    const { unidadeId, canal, itens, clienteId } = req.body || {};

    if (!unidadeId || !canal || !Array.isArray(itens) || itens.length === 0) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'Informe unidadeId, canal e itens[] nao vazio');
    }
    if (!CANAIS.includes(canal)) {
      throw erro(400, 'CANAL_INVALIDO', `canal deve ser um de ${CANAIS.join(', ')}`);
    }

    // Cliente: atendente pode informar (ou deixar anonimo); cliente logado usa o proprio id.
    const ehAtendente = req.usuario.papeis.includes('ATENDENTE');
    const clienteFinal = ehAtendente ? clienteId ?? null : req.usuario.clienteId ?? null;

    const resultado = await db.withTransaction(async (client) => {
      // 1) valida cada item e monta as linhas com snapshot de preco
      const linhas = [];
      const problemas = [];
      for (const it of itens) {
        const { rows } = await client.query(
          `SELECT pb.id, pb.nome, pb.ativo, pb.sazonal, pb.janela_ini, pb.janela_fim,
                  icu.habilitado, icu.preco_venda
             FROM item_cardapio_unidade icu
             JOIN produto_base pb ON pb.id = icu.produto_base_id
            WHERE icu.unidade_id = $1 AND icu.produto_base_id = $2`,
          [unidadeId, it.produtoId],
        );
        const p = rows[0];
        if (!p || !p.ativo || !p.habilitado) {
          problemas.push({ produtoId: it.produtoId, motivo: 'INDISPONIVEL_NA_UNIDADE' });
          continue;
        }
        if (p.sazonal) {
          const { rows: dr } = await client.query(
            'SELECT (CURRENT_DATE BETWEEN $1 AND $2) AS ok',
            [p.janela_ini, p.janela_fim],
          );
          if (!dr[0].ok) {
            problemas.push({ produtoId: it.produtoId, motivo: 'FORA_DA_JANELA_SAZONAL' });
            continue;
          }
        }
        const qtd = Number(it.quantidade || 0);
        if (!Number.isInteger(qtd) || qtd <= 0) {
          problemas.push({ produtoId: it.produtoId, motivo: 'QUANTIDADE_INVALIDA' });
          continue;
        }
        linhas.push({
          produtoId: p.id,
          nome: p.nome,
          precoUnit: Number(p.preco_venda),
          quantidade: qtd,
        });
      }
      if (problemas.length) {
        throw erro(422, 'ITENS_INDISPONIVEIS', 'Um ou mais itens nao podem ser vendidos', problemas);
      }

      // 2) reserva de estoque com trava de linha (RNF-10 / CT-14)
      for (const l of linhas) {
        const { rows: composicao } = await client.query(
          `SELECT cc.item_estoque_id, cc.quantidade
             FROM composicao_consumo cc
             JOIN item_estoque ie ON ie.id = cc.item_estoque_id
            WHERE cc.produto_base_id = $1 AND ie.unidade_id = $2
            FOR UPDATE OF ie`,
          [l.produtoId, unidadeId],
        );
        for (const comp of composicao) {
          const precisa = Number(comp.quantidade) * l.quantidade;
          const upd = await client.query(
            'UPDATE item_estoque SET saldo = saldo - $1 WHERE id = $2 AND saldo >= $1',
            [precisa, comp.item_estoque_id],
          );
          if (upd.rowCount === 0) {
            throw erro(422, 'ESTOQUE_INSUFICIENTE', `Sem saldo para "${l.nome}"`);
          }
          await client.query(
            `INSERT INTO movimento_estoque (item_estoque_id, tipo, quantidade)
             VALUES ($1, 'SAIDA_VENDA', $2)`,
            [comp.item_estoque_id, precisa],
          );
        }
      }

      // 3) cria pedido + itens
      const subtotal = linhas.reduce((s, l) => s + l.precoUnit * l.quantidade, 0);
      const total = subtotal;
      const { rows: pr } = await client.query(
        `INSERT INTO pedido (unidade_id, canal, cliente_id, status, subtotal, total)
         VALUES ($1, $2, $3, 'AGUARDANDO_PAGAMENTO', $4, $5)
         RETURNING id, status`,
        [unidadeId, canal, clienteFinal, subtotal, total],
      );
      const pedido = pr[0];

      for (const l of linhas) {
        await client.query(
          `INSERT INTO item_pedido
             (pedido_id, produto_base_id, descricao_snapshot, preco_unit_snapshot, quantidade, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [pedido.id, l.produtoId, l.nome, l.precoUnit, l.quantidade, l.precoUnit * l.quantidade],
        );
      }

      // 4) solicita cobranca ao PSP
      const chaveIdem = randomUUID();
      try {
        const cobranca = await psp.solicitarCobranca({
          valor: total,
          pedidoId: pedido.id,
          chaveIdempotencia: chaveIdem,
        });
        await client.query(
          `INSERT INTO pagamento
             (pedido_id, id_transacao_psp, status, valor, meio, chave_idempotencia, tentativas)
           VALUES ($1, $2, 'PENDENTE', $3, $4, $5, 1)`,
          [pedido.id, cobranca.idTransacao, total, cobranca.meio || 'PIX', chaveIdem],
        );
        return {
          pedidoId: pedido.id,
          status: pedido.status,
          total,
          pagamento: {
            idTransacaoPSP: cobranca.idTransacao,
            meio: cobranca.meio,
            dadosPagamento: cobranca.dadosPagamento,
          },
        };
      } catch (e) {
        // PSP indisponivel: pedido fica PAGAMENTO_PENDENTE para reprocessamento (CT-10)
        await client.query(
          `INSERT INTO pagamento
             (pedido_id, id_transacao_psp, status, valor, chave_idempotencia, tentativas)
           VALUES ($1, NULL, 'PENDENTE', $2, $3, 1)`,
          [pedido.id, total, chaveIdem],
        );
        await client.query(
          "UPDATE pedido SET status = 'PAGAMENTO_PENDENTE' WHERE id = $1",
          [pedido.id],
        );
        return {
          pedidoId: pedido.id,
          status: 'PAGAMENTO_PENDENTE',
          total,
          pagamento: null,
          aviso: 'PSP indisponivel; a cobranca sera reprocessada automaticamente',
        };
      }
    });

    res.status(201).json(resultado);
  }),
);

// ---------------------------------------------------------------------------
// GET /v1/pedidos/:id  -> RF-12 (acompanhar status)
// ---------------------------------------------------------------------------
router.get(
  '/pedidos/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.id, p.unidade_id, p.canal, p.cliente_id, p.status,
              p.subtotal, p.total, p.criado_em, p.pago_em,
              COALESCE(
                json_agg(json_build_object(
                  'produtoId', ip.produto_base_id,
                  'descricao', ip.descricao_snapshot,
                  'precoUnit', ip.preco_unit_snapshot,
                  'quantidade', ip.quantidade,
                  'subtotal', ip.subtotal
                )) FILTER (WHERE ip.id IS NOT NULL), '[]'
              ) AS itens,
              pg.status AS pagamento_status, pg.id_transacao_psp
         FROM pedido p
         LEFT JOIN item_pedido ip ON ip.pedido_id = p.id
         LEFT JOIN pagamento pg   ON pg.pedido_id = p.id
        WHERE p.id = $1
        GROUP BY p.id, pg.status, pg.id_transacao_psp`,
      [req.params.id],
    );
    const pedido = rows[0];
    if (!pedido) throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido inexistente');

    // cliente so enxerga o proprio pedido
    if (req.usuario.papeis.includes('CLIENTE') && pedido.cliente_id !== req.usuario.clienteId) {
      throw erro(403, 'ACESSO_NEGADO', 'Pedido pertence a outro cliente');
    }
    res.json(pedido);
  }),
);

// ---------------------------------------------------------------------------
// GET /v1/unidades/:unidadeId/fila-cozinha  -> RF-11
// ---------------------------------------------------------------------------
router.get(
  '/unidades/:unidadeId/fila-cozinha',
  requer('COZINHEIRO', 'GERENTE_UNIDADE'),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, canal, status, total, pago_em, criado_em
         FROM pedido
        WHERE unidade_id = $1 AND status IN ('PAGO', 'EM_PREPARO', 'PRONTO')
        ORDER BY pago_em ASC NULLS LAST, criado_em ASC`,
      [req.params.unidadeId],
    );
    res.json({ unidadeId: Number(req.params.unidadeId), fila: rows });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /v1/pedidos/:id/status  -> RF-07, RF-12 (CT-05, CT-20)
// ---------------------------------------------------------------------------
router.patch(
  '/pedidos/:id/status',
  requer('COZINHEIRO', 'ATENDENTE', 'GERENTE_UNIDADE'),
  asyncHandler(async (req, res) => {
    const { novoStatus } = req.body || {};
    const PERMITIDOS = ['EM_PREPARO', 'PRONTO', 'ENTREGUE'];
    if (!PERMITIDOS.includes(novoStatus)) {
      throw erro(400, 'STATUS_INVALIDO', `novoStatus deve ser um de ${PERMITIDOS.join(', ')}`);
    }

    const atualizado = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, status FROM pedido WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      if (!rows[0]) throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido inexistente');

      const atual = rows[0].status;
      if (!podeTransicionar(atual, novoStatus)) {
        throw erro(409, 'TRANSICAO_INVALIDA', `Nao e possivel ir de ${atual} para ${novoStatus}`);
      }
      const { rows: up } = await client.query(
        'UPDATE pedido SET status = $1 WHERE id = $2 RETURNING id, status',
        [novoStatus, req.params.id],
      );
      return up[0];
    });

    res.json(atualizado);
  }),
);

// ---------------------------------------------------------------------------
// POST /v1/pedidos/:id/cancelamento  -> RF-13, RF-14 (CT-17)
// Operacao sensivel: exige motivo, gera auditoria. Se o pedido ja tinha
// pagamento aprovado, soliciata estorno ao PSP e vai para
// CANCELADO_COM_ESTORNO; caso contrario vai para CANCELADO. Em ambos os
// casos o estoque reservado e devolvido. Decisao de negocio documentada no
// PDF (Secao 2.3, ambiguidade 2): pedido pago que a cozinha nao consegue
// produzir e cancelado com estorno, nunca silenciosamente.
// ---------------------------------------------------------------------------
router.post(
  '/pedidos/:id/cancelamento',
  requer('ATENDENTE', 'GERENTE_UNIDADE'),
  asyncHandler(async (req, res) => {
    const { motivo } = req.body || {};
    if (!motivo || !String(motivo).trim()) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'motivo e obrigatorio para cancelar um pedido');
    }

    const resultado = await db.withTransaction(async (client) => {
      const { rows: peds } = await client.query(
        'SELECT * FROM pedido WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      const pedido = peds[0];
      if (!pedido) throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido inexistente');

      const precisaEstorno = ['PAGO', 'EM_PREPARO'].includes(pedido.status);
      const destino = precisaEstorno ? 'CANCELADO_COM_ESTORNO' : 'CANCELADO';
      if (!podeTransicionar(pedido.status, destino)) {
        throw erro(
          409,
          'TRANSICAO_INVALIDA',
          `Pedido em ${pedido.status} nao pode ser cancelado por este endpoint`,
        );
      }

      if (precisaEstorno) {
        const { rows: pgs } = await client.query(
          'SELECT * FROM pagamento WHERE pedido_id = $1 FOR UPDATE',
          [pedido.id],
        );
        const pagamento = pgs[0];
        if (pagamento?.status === 'APROVADO' && pagamento.id_transacao_psp) {
          try {
            await psp.solicitarEstorno({ idTransacaoPSP: pagamento.id_transacao_psp });
          } catch (e) {
            throw erro(
              502,
              'PSP_INDISPONIVEL',
              'Nao foi possivel solicitar o estorno ao PSP; tente novamente em instantes',
            );
          }
          await client.query(
            "UPDATE pagamento SET status = 'ESTORNADO', resolvido_em = now() WHERE id = $1",
            [pagamento.id],
          );
        }
        await estornarPontos(client, pedido);
      }

      await devolverEstoque(client, pedido);

      await client.query(
        `UPDATE pedido
            SET status = $1, cancelado_em = now(), motivo_cancelamento = $2
          WHERE id = $3`,
        [destino, motivo, pedido.id],
      );

      await registrarAuditoria(client, {
        tipo: 'CANCELAMENTO',
        usuarioId: req.usuario.id,
        papel: req.usuario.papeis.join(','),
        unidadeId: pedido.unidade_id,
        entidadeAfetada: 'pedido',
        entidadeId: pedido.id,
        valorAnterior: { status: pedido.status },
        valorNovo: { status: destino },
        motivo,
      });

      return { pedidoId: pedido.id, status: destino };
    });

    res.json(resultado);
  }),
);

module.exports = router;
