/**
 * Grava um registro na trilha de auditoria (RF-14).
 * Deve ser chamado dentro da mesma transacao da operacao auditada.
 */
async function registrarAuditoria(client, {
  tipo,
  usuarioId = null,
  papel = null,
  unidadeId = null,
  entidadeAfetada,
  entidadeId,
  valorAnterior = null,
  valorNovo = null,
  motivo = null,
}) {
  await client.query(
    `INSERT INTO registro_auditoria
       (tipo, usuario_id, papel, unidade_id, entidade_afetada, entidade_id,
        valor_anterior, valor_novo, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tipo,
      usuarioId,
      papel,
      unidadeId,
      entidadeAfetada,
      String(entidadeId),
      valorAnterior ? JSON.stringify(valorAnterior) : null,
      valorNovo ? JSON.stringify(valorNovo) : null,
      motivo,
    ],
  );
}

module.exports = { registrarAuditoria };
