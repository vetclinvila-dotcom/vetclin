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
    return new Comando(this.banco, this.sql, args);
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

export function criarBancoLocal() {
  const banco = new DatabaseSync(':memory:');
  for (const arquivo of readdirSync(pastaMigracoes).filter((f) => f.endsWith('.sql')).sort()) {
    banco.exec(readFileSync(path.join(pastaMigracoes, arquivo), 'utf8'));
  }
  return {
    bruto: banco,
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
