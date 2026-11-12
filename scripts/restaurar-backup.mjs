#!/usr/bin/env node
// Restaura a cópia de segurança (JSON) do Vetclin: converte o arquivo em um arquivo SQL.
//
// Uso:   node scripts/restaurar-backup.mjs vetclin-backup-2026-11-12.json saida.sql
//
// O que faz:
//  * escreve um INSERT para cada linha, na ordem certa (primeiro quem é "pai", depois quem depende dele);
//  * as senhas NÃO vêm na cópia de segurança: cada usuário ganha uma senha temporária nova,
//    que é mostrada na tela (stdout). Cada pessoa entra com ela e troca a senha;
//  * as fotos vêm só como registro (sem a imagem): os arquivos das fotos estão na pasta
//    "Vetclin/Backups/Fotos" do Google Drive.
//
// Depois, em um banco NOVO e VAZIO (com as migrações já aplicadas):
//   npx wrangler d1 execute vetclin --remote --file=saida.sql
// Veja docs/PLANILHA-E-BACKUP.md. Apague o arquivo .sql depois de usar (ele contém as senhas temporárias em forma de hash).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashSenha } from '../src/auth.js';

// Ordem segura: pais antes dos filhos (chaves estrangeiras).
const ORDEM = [
  'usuarios', 'tutores', 'fotos', 'pets', 'atendimentos', 'catalogo', 'pedidos', 'itens_pedido', 'pagamentos',
  'receitas', 'receita_itens', 'sugestoes_receita', 'configuracoes', 'contadores', 'registro_acoes',
];
// Colunas que apontam para a própria tabela: entram vazias e são preenchidas depois (a linha apontada pode vir mais adiante).
const AUTO_REFERENCIA = { tutores: 'mesclado_em_id', receitas: 'receita_anterior_id' };
// Tabelas que a migração já preenche com valores iniciais: o INSERT substitui esses valores.
const COM_VALORES_INICIAIS = ['catalogo', 'configuracoes', 'contadores'];

export function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Número inválido no backup: ' + v);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

const aspas = (nome) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome)) throw new Error('Nome inválido no backup: ' + nome);
  return `"${nome}"`;
};

function senhaTemporaria() {
  const alfabeto = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem letras parecidas (l, I, O, 0, 1)
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => alfabeto[x % alfabeto.length]).join('');
}

// Converte o JSON do backup em { sql, senhas: [{ login, senha }] }.
export async function converterBackup(backup) {
  if (!backup || backup.versao !== 1 || typeof backup.tabelas !== 'object') throw new Error('Este arquivo não parece uma cópia de segurança do Vetclin (versão 1).');
  const tabelas = backup.tabelas;
  const nomes = [...ORDEM.filter((n) => n in tabelas), ...Object.keys(tabelas).filter((n) => !ORDEM.includes(n)).sort()];
  const senhas = [];
  const sql = [
    '-- Restauração da cópia de segurança do Vetclin. Gerado por scripts/restaurar-backup.mjs.',
    `-- Cópia gerada em: ${backup.gerado_em ?? '?'}`,
    '-- Aplicar SOMENTE em um banco novo e vazio (com as migrações aplicadas).',
    '',
  ];
  for (const nome of nomes) {
    const linhas = tabelas[nome];
    if (!Array.isArray(linhas)) throw new Error(`Tabela ${nome} inválida no backup.`);
    const autoRef = AUTO_REFERENCIA[nome];
    const adiar = [];
    sql.push(`-- ${nome} (${linhas.length})`);
    for (const original of linhas) {
      const linha = { ...original };
      if (nome === 'usuarios') {
        const senha = senhaTemporaria();
        linha.senha_hash = await hashSenha(senha);
        senhas.push({ login: linha.login, senha });
      }
      if (nome === 'fotos') linha.dados = '__VAZIO__';
      if (autoRef && linha[autoRef] != null) {
        adiar.push(`UPDATE ${aspas(nome)} SET ${aspas(autoRef)} = ${literal(linha[autoRef])} WHERE id = ${literal(linha.id)};`);
        linha[autoRef] = null;
      }
      const colunas = Object.keys(linha);
      const valores = colunas.map((c) => (linha[c] === '__VAZIO__' && c === 'dados' ? "x''" : literal(linha[c])));
      const verbo = COM_VALORES_INICIAIS.includes(nome) ? 'INSERT OR REPLACE' : 'INSERT';
      sql.push(`${verbo} INTO ${aspas(nome)} (${colunas.map(aspas).join(', ')}) VALUES (${valores.join(', ')});`);
    }
    sql.push(...adiar, '');
  }
  return { sql: sql.join('\n'), senhas };
}

// ---------- uso pela linha de comando ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [entrada, saida] = process.argv.slice(2);
  if (!entrada || !saida) {
    console.error('Uso: node scripts/restaurar-backup.mjs <backup.json> <saida.sql>');
    process.exit(1);
  }
  try {
    const { sql, senhas } = await converterBackup(JSON.parse(readFileSync(entrada, 'utf8')));
    writeFileSync(saida, sql, { mode: 0o600 });
    console.log(`Arquivo ${saida} criado.\n`);
    console.log('Senhas TEMPORÁRIAS (cada pessoa deve entrar e trocar a sua):');
    for (const s of senhas) console.log(`  ${s.login}\t${s.senha}`);
    console.log('\nAs fotos vieram só como registro (sem imagem); os arquivos estão na pasta Fotos do Google Drive.');
  } catch (e) {
    console.error('Não deu certo: ' + e.message);
    process.exit(1);
  }
}
