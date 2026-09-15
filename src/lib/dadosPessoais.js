const { dadosPessoaisChave } = require('../config');

/**
 * Unica porta de entrada/saida dos dados pessoais do cliente (RNF-06).
 * Nome, CPF, e-mail e telefone ficam cifrados em repouso (BYTEA) com
 * pgp_sym_encrypt/pgp_sym_decrypt (pgcrypto) - nunca em texto plano na tabela
 * `cliente`. A chave e passada como parametro bindado da query (nunca
 * concatenada no SQL), para nao aparecer em texto no plano de execucao.
 */

async function criarClienteCifrado(client, {
  nome, cpf = null, email = null, telefone = null, dataNascimento = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO cliente (nome_cif, cpf_cif, email_cif, telefone_cif, data_nascimento)
     VALUES (
       pgp_sym_encrypt($1, $6),
       CASE WHEN $2::text IS NULL THEN NULL ELSE pgp_sym_encrypt($2, $6) END,
       CASE WHEN $3::text IS NULL THEN NULL ELSE pgp_sym_encrypt($3, $6) END,
       CASE WHEN $4::text IS NULL THEN NULL ELSE pgp_sym_encrypt($4, $6) END,
       $5
     )
     RETURNING id`,
    [nome, cpf, email, telefone, dataNascimento, dadosPessoaisChave],
  );
  return rows[0].id;
}

/**
 * Le um cliente decifrando os campos pessoais. Quem chama e responsavel por
 * registrar a auditoria ACESSO_DADO_PESSOAL (RF-14) - esta funcao so decifra.
 */
async function buscarClienteDecifrado(client, id) {
  const { rows } = await client.query(
    `SELECT id, anonimizado, data_nascimento,
            CASE WHEN nome_cif     IS NULL THEN NULL ELSE pgp_sym_decrypt(nome_cif, $2)     END AS nome,
            CASE WHEN cpf_cif      IS NULL THEN NULL ELSE pgp_sym_decrypt(cpf_cif, $2)      END AS cpf,
            CASE WHEN email_cif    IS NULL THEN NULL ELSE pgp_sym_decrypt(email_cif, $2)    END AS email,
            CASE WHEN telefone_cif IS NULL THEN NULL ELSE pgp_sym_decrypt(telefone_cif, $2) END AS telefone
       FROM cliente
      WHERE id = $1`,
    [id, dadosPessoaisChave],
  );
  return rows[0] || null;
}

module.exports = { criarClienteCifrado, buscarClienteDecifrado };
