const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { criarClienteCifrado } = require('../src/lib/dadosPessoais');
const { PAPEIS_INTERNOS } = require('../src/lib/papeis');

const PRECOS = {
  'Tapioca de Queijo Coalho': 12.0,
  'Cuscuz Nordestino Completo': 18.0,
  'Bolo de Macaxeira': 8.0,
  'Suco de Caju': 9.0,
  'Canjica Junina': 10.0,
};

async function main() {
  const hash = bcrypt.hashSync('senha123', 8);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE
      regiao, unidade, cliente, papel, usuario, usuario_papel,
      produto_base, item_cardapio_unidade, item_estoque, composicao_consumo, movimento_estoque,
      pedido, item_pedido, pagamento, evento_pagamento_recebido, consentimento_lgpd,
      conta_fidelidade, movimento_pontos, registro_auditoria
      RESTART IDENTITY CASCADE`);

    // Regioes e unidades
    const { rows: reg } = await client.query(
      `INSERT INTO regiao (nome, uf) VALUES ('Nordeste', 'PE'), ('Sudeste', 'SP') RETURNING id`,
    );
    const [ne, se] = reg.map((r) => r.id);

    const { rows: uni } = await client.query(
      `INSERT INTO unidade (nome, endereco, formato, regiao_id) VALUES
         ('Raizes - Recife Centro',       'Rua da Aurora, 100 - Recife/PE',   'COMPLETA', $1),
         ('Raizes - Sao Paulo Paulista',  'Av. Paulista, 900 - Sao Paulo/SP', 'REDUZIDA', $2)
       RETURNING id`,
      [ne, se],
    );
    const [u1, u2] = uni.map((r) => r.id);

    // Produtos base (um sazonal: Canjica Junina, so em junho/2026)
    const { rows: prod } = await client.query(
      `INSERT INTO produto_base
         (nome, categoria, preco_referencia, preco_min, preco_max, sazonal, janela_ini, janela_fim)
       VALUES
         ('Tapioca de Queijo Coalho',   'Salgados', 12.00, 10.00, 16.00, false, NULL, NULL),
         ('Cuscuz Nordestino Completo', 'Pratos',   18.00, 15.00, 24.00, false, NULL, NULL),
         ('Bolo de Macaxeira',          'Doces',     8.00,  6.00, 12.00, false, NULL, NULL),
         ('Suco de Caju',               'Bebidas',   9.00,  7.00, 13.00, false, NULL, NULL),
         ('Canjica Junina',             'Doces',    10.00,  8.00, 14.00, true, DATE '2026-06-01', DATE '2026-06-30')
       RETURNING id, nome`,
    );

    // Estoque por unidade + composicao 1:1 (decisao 3 do documento).
    // Unidade 1 / "Bolo de Macaxeira" nasce com saldo 1 -> util para o teste de concorrencia (CT-14).
    for (const unidade of [u1, u2]) {
      for (const p of prod) {
        const saldo = unidade === u1 && p.nome === 'Bolo de Macaxeira' ? 1 : 100;
        const { rows: ie } = await client.query(
          `INSERT INTO item_estoque (unidade_id, nome, saldo, saldo_minimo)
           VALUES ($1, $2, $3, 10) RETURNING id`,
          [unidade, `Insumo: ${p.nome}`, saldo],
        );
        await client.query(
          `INSERT INTO composicao_consumo (produto_base_id, item_estoque_id, quantidade)
           VALUES ($1, $2, 1)`,
          [p.id, ie[0].id],
        );
      }
    }

    // Cardapio: unidade 1 habilita tudo; unidade 2 (formato reduzido) nao serve Canjica.
    for (const p of prod) {
      await client.query(
        `INSERT INTO item_cardapio_unidade (unidade_id, produto_base_id, habilitado, preco_venda)
         VALUES ($1, $2, true, $3)`,
        [u1, p.id, PRECOS[p.nome]],
      );
      await client.query(
        `INSERT INTO item_cardapio_unidade (unidade_id, produto_base_id, habilitado, preco_venda)
         VALUES ($1, $2, $3, $4)`,
        [u2, p.id, p.nome !== 'Canjica Junina', PRECOS[p.nome]],
      );
    }

    // Clientes: Maria consente FIDELIDADE (acumula pontos); Joao NAO consente (CT-15).
    // nome/cpf/email/telefone gravados cifrados em repouso (pgcrypto) - ver
    // src/lib/dadosPessoais.js; dados ficticios, so para o seed de exemplo.
    const maria = await criarClienteCifrado(client, {
      nome: 'Maria Souza',
      cpf: '123.456.789-00',
      email: 'maria.souza@example.com',
      telefone: '+55 51 99999-0001',
      dataNascimento: '1990-04-12',
    });
    const joao = await criarClienteCifrado(client, {
      nome: 'Joao Lima',
      cpf: '987.654.321-00',
      email: 'joao.lima@example.com',
      telefone: '+55 51 99999-0002',
      dataNascimento: '1988-11-03',
    });
    await client.query(
      `INSERT INTO consentimento_lgpd (cliente_id, finalidade) VALUES
         ($1, 'FIDELIDADE'), ($1, 'CAMPANHA_SEGMENTADA')`,
      [maria],
    );
    await client.query(
      `INSERT INTO conta_fidelidade (cliente_id, saldo_pontos) VALUES ($1, 0)`,
      [maria],
    );

    // Papeis e usuarios (senha de todos: senha123)
    const papeis = [...PAPEIS_INTERNOS, 'CLIENTE'];
    const { rows: pr } = await client.query(
      `INSERT INTO papel (nome) SELECT unnest($1::text[]) RETURNING id, nome`,
      [papeis],
    );
    const papelId = Object.fromEntries(pr.map((r) => [r.nome, r.id]));

    async function criarUsuario(nome, login, papel, { unidadeId = null, clienteId = null } = {}) {
      const { rows } = await client.query(
        `INSERT INTO usuario (nome, login, hash_senha, unidade_id, cliente_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [nome, login, hash, unidadeId, clienteId],
      );
      await client.query(
        `INSERT INTO usuario_papel (usuario_id, papel_id) VALUES ($1, $2)`,
        [rows[0].id, papelId[papel]],
      );
    }

    await criarUsuario('Admin Matriz', 'admin', 'ADMIN');
    await criarUsuario('Gerente Recife', 'gerente', 'GERENTE_UNIDADE', { unidadeId: u1 });
    await criarUsuario('Atendente Recife', 'atendente', 'ATENDENTE', { unidadeId: u1 });
    await criarUsuario('Cozinheiro Recife', 'cozinheiro', 'COZINHEIRO', { unidadeId: u1 });
    await criarUsuario('Analista Matriz', 'analista', 'ANALISTA_MATRIZ');
    await criarUsuario('Maria Souza', 'maria', 'CLIENTE', { clienteId: maria });
    await criarUsuario('Joao Lima', 'joao', 'CLIENTE', { clienteId: joao });

    await client.query('COMMIT');
    console.log(
      `seed concluido | unidades: ${u1}, ${u2} | cliente maria=${maria} (consente), joao=${joao} (nao consente)`,
    );
    console.log('produtoId: 1=Tapioca 2=Cuscuz 3=Bolo de Macaxeira 4=Suco de Caju 5=Canjica Junina (sazonal)');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('falha no seed:', e.message);
  process.exit(1);
});
