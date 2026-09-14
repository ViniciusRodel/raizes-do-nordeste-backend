const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { erro, parseId } = require('../../lib/errors');
const { requer } = require('../../auth/rbac');

const router = express.Router();
const DESCONTO_TIPOS = ['PERCENTUAL', 'VALOR_FIXO'];

// ---------------------------------------------------------------------------
// POST /v1/campanhas  -> RF-21
// Cria a campanha com o criterio de segmentacao (JSON): minPedidosPagos,
// dataNascimentoApos/dataNascimentoAntes (faixa etaria) - todos opcionais.
// ---------------------------------------------------------------------------
router.post(
  '/campanhas',
  requer('ADMIN', 'ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const { nome, criterio, descontoTipo, descontoValor, inicio, fim } = req.body || {};
    if (!nome || !inicio || !fim || descontoValor == null) {
      throw erro(400, 'PAYLOAD_INVALIDO', 'Informe nome, descontoValor, inicio e fim');
    }
    if (!DESCONTO_TIPOS.includes(descontoTipo)) {
      throw erro(400, 'PAYLOAD_INVALIDO', `descontoTipo deve ser um de ${DESCONTO_TIPOS.join(', ')}`);
    }

    const { rows } = await db.query(
      `INSERT INTO campanha (nome, criterio, desconto_tipo, desconto_valor, inicio, fim, criada_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, criterio, desconto_tipo, desconto_valor, inicio, fim, criada_em`,
      [nome, criterio || {}, descontoTipo, descontoValor, inicio, fim, req.usuario.id],
    );
    const c = rows[0];
    res.status(201).json({
      id: c.id,
      nome: c.nome,
      criterio: c.criterio,
      descontoTipo: c.desconto_tipo,
      descontoValor: c.desconto_valor,
      inicio: c.inicio,
      fim: c.fim,
      criadaEm: c.criada_em,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /v1/campanhas/:id/segmento  -> RF-21
// So retorna clientes com consentimento CAMPANHA_SEGMENTADA vigente (RF-17)
// e que atendam ao criterio da campanha. Base auditavel: e a mesma consulta
// usada para efetivamente disparar a campanha, nao uma amostra.
// ---------------------------------------------------------------------------
router.get(
  '/campanhas/:id/segmento',
  requer('ANALISTA_MATRIZ'),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'id');
    const { rows: camp } = await db.query('SELECT criterio FROM campanha WHERE id = $1', [id]);
    if (!camp[0]) throw erro(404, 'CAMPANHA_NAO_ENCONTRADA', 'Campanha inexistente');

    const criterio = camp[0].criterio || {};
    const minPedidosPagos = Number.isInteger(criterio.minPedidosPagos) ? criterio.minPedidosPagos : null;
    const nascApos = criterio.dataNascimentoApos || null;
    const nascAntes = criterio.dataNascimentoAntes || null;

    const { rows } = await db.query(
      `SELECT c.id
         FROM cliente c
         JOIN consentimento_lgpd cl
           ON cl.cliente_id = c.id AND cl.finalidade = 'CAMPANHA_SEGMENTADA' AND cl.revogado_em IS NULL
        WHERE c.anonimizado = false
          AND ($2::date IS NULL OR c.data_nascimento >= $2::date)
          AND ($3::date IS NULL OR c.data_nascimento <= $3::date)
          AND (
            $1::int IS NULL OR (
              SELECT count(*) FROM pedido p
               WHERE p.cliente_id = c.id AND p.status IN ('PAGO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE')
            ) >= $1::int
          )`,
      [minPedidosPagos, nascApos, nascAntes],
    );

    res.json({ campanhaId: id, clientes: rows.map((r) => r.id), total: rows.length });
  }),
);

module.exports = router;
