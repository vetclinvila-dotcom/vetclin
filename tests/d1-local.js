// Adaptador que imita o banco D1 da Cloudflare usando o SQLite do Node.
// Serve apenas para os testes locais.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pastaMigracoes = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

class Comando {
  constructor(banco, sql, args = []) {
    this.banco = banco;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    // O D1 aceita ArrayBuffer para BLOB; o SQLite do Node quer Uint8Array.
    return new Comando(this.banco, this.sql, args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a)));
  }
  async first() {
    return this.banco.prepare(this.sql).get(...this.args) ?? null;
  }
  async all() {
    const results = this.banco.prepare(this.sql).all(...this.args);
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }
  async run() {
    const r = this.banco.prepare(this.sql).run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

// Cria o banco de testes (em memória), com chaves estrangeiras LIGADAS
// (como no D1 de verdade). Cada migração roda dentro de uma transação.
// Opções (opcional):
//   { ate: '0001' }  aplica só as migrações até esse prefixo (inclusive);
//                    as demais ficam esperando em banco.migrarRestante().
// Aceita também um texto qualquer (ignorado), por compatibilidade.
export function criarBancoLocal(opcoes = {}) {
  const ate = typeof opcoes === 'object' && opcoes ? opcoes.ate : undefined;
  const banco = new DatabaseSync(':memory:');
  banco.exec('PRAGMA foreign_keys = ON');
  const arquivos = readdirSync(pastaMigracoes).filter((f) => f.endsWith('.sql')).sort();
  const pendentes = [];
  let parou = false;
  const aplicar = (arquivo) => {
    banco.exec('BEGIN');
    try {
      banco.exec(readFileSync(path.join(pastaMigracoes, arquivo), 'utf8'));
      banco.exec('COMMIT');
    } catch (e) {
      banco.exec('ROLLBACK');
      throw new Error(`Falha na migração ${arquivo}: ${e.message}`);
    }
  };
  for (const arquivo of arquivos) {
    if (parou) { pendentes.push(arquivo); continue; }
    aplicar(arquivo);
    if (ate && arquivo.startsWith(ate)) parou = true;
  }
  return {
    bruto: banco,
    // Aplica as migrações que ficaram de fora por causa da opção "ate".
    migrarRestante() { while (pendentes.length) aplicar(pendentes.shift()); },
    prepare: (sql) => new Comando(banco, sql),
    async batch(comandos) {
      const saidas = [];
      banco.exec('BEGIN');
      try {
        for (const c of comandos) saidas.push(await c.run());
        banco.exec('COMMIT');
      } catch (e) {
        banco.exec('ROLLBACK');
        throw e;
      }
      return saidas;
    },
  };
}
