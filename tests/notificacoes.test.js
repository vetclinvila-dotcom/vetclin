// Testes do envio de notificações: quem recebe, aparelhos expirados e falhas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { criarBancoLocal } from './d1-local.js';
import { notificar } from '../src/notificacoes.js';
import { b64url } from '../src/push.js';

async function chavesAparelho() {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey))),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

// Banco com 4 pessoas, cada uma com um aparelho.
async function ambiente() {
  const DB = criarBancoLocal();
  const pessoas = [
    ['Dra. Elizabeth', 'eli', 'veterinario', 1],
    ['Dr. Felipe', 'felipe', 'veterinario', 1],
    ['Recepção', 'recep', 'recepcao', 1],
    ['Dr. Antigo', 'antigo', 'veterinario', 0], // inativo: nunca recebe
  ];
  const ids = {};
  for (const [nome, login, papel, ativo] of pessoas) {
    const r = DB.bruto.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em)
      VALUES (?, ?, 'x', ?, 0, ?, 'x', 'x')`).run(nome, login, papel, ativo);
    ids[login] = Number(r.lastInsertRowid);
    const k = await chavesAparelho();
    DB.bruto.prepare(`INSERT INTO inscricoes_push (usuario_id, endpoint, p256dh, auth, criado_em) VALUES (?, ?, ?, ?, 'x')`)
      .run(ids[login], `https://web.push.apple.com/aparelho-${login}`, k.p256dh, k.auth);
  }
  return { env: { DB }, ids };
}

function fetchGravando(status = 201) {
  const chamadas = [];
  const fn = async (url) => { chamadas.push(url); return new Response(null, { status: typeof status === 'function' ? status(url) : status }); };
  return { fn, chamadas };
}

test('notificar: papel veterinario vai só para veterinários ativos', async () => {
  const { env } = await ambiente();
  const f = fetchGravando();
  const r = await notificar(env, { para: { papel: 'veterinario' }, titulo: 'Chegou: Thor' }, { fetchFn: f.fn });
  assert.deepEqual(r, { enviados: 2, falhas: 0 });
  assert.deepEqual(f.chamadas.sort(), ['https://web.push.apple.com/aparelho-eli', 'https://web.push.apple.com/aparelho-felipe']);
});

test('notificar: usuário específico e "exceto quem fez a ação"', async () => {
  const { env, ids } = await ambiente();
  const a = fetchGravando();
  await notificar(env, { para: { usuarioId: ids.eli }, titulo: 'Pedido' }, { fetchFn: a.fn });
  assert.deepEqual(a.chamadas, ['https://web.push.apple.com/aparelho-eli']);
  const b = fetchGravando();
  await notificar(env, { para: { papel: 'veterinario', excetoUsuarioId: ids.felipe }, titulo: 'x' }, { fetchFn: b.fn });
  assert.deepEqual(b.chamadas, ['https://web.push.apple.com/aparelho-eli']);
});

test('notificar: sem destinatário definido não envia nada', async () => {
  const { env } = await ambiente();
  const f = fetchGravando();
  assert.deepEqual(await notificar(env, { titulo: 'x' }, { fetchFn: f.fn }), { enviados: 0, falhas: 0 });
  assert.equal(f.chamadas.length, 0);
});

test('notificar: aparelho expirado (410) é removido; os outros continuam', async () => {
  const { env } = await ambiente();
  const f = fetchGravando((url) => (url.endsWith('eli') ? 410 : 201));
  const r = await notificar(env, { para: { papel: 'veterinario' }, titulo: 'x' }, { fetchFn: f.fn });
  assert.deepEqual(r, { enviados: 1, falhas: 1 });
  const resta = env.DB.bruto.prepare(`SELECT endpoint FROM inscricoes_push WHERE endpoint LIKE '%eli'`).all();
  assert.equal(resta.length, 0);
  const felipe = env.DB.bruto.prepare(`SELECT ultimo_uso_em FROM inscricoes_push WHERE endpoint LIKE '%felipe'`).get();
  assert.ok(felipe.ultimo_uso_em);
});

test('notificar: falha de rede nunca lança erro', async () => {
  const { env } = await ambiente();
  const r = await notificar(env, { para: { papel: 'recepcao' }, titulo: 'x' }, { fetchFn: async () => { throw new Error('sem rede'); } });
  assert.deepEqual(r, { enviados: 0, falhas: 1 });
  // Banco quebrado também não derruba quem chamou.
  const r2 = await notificar({ DB: { prepare() { throw new Error('banco fora'); } } }, { para: { papel: 'recepcao' } });
  assert.deepEqual(r2, { enviados: 0, falhas: 1 });
});

test('notificar: chaves do servidor são criadas uma vez só e reaproveitadas', async () => {
  const { env } = await ambiente();
  const f = fetchGravando();
  await notificar(env, { para: { papel: 'recepcao' }, titulo: 'a' }, { fetchFn: f.fn });
  const c1 = env.DB.bruto.prepare('SELECT publica FROM push_chaves').all();
  await notificar(env, { para: { papel: 'recepcao' }, titulo: 'b' }, { fetchFn: f.fn });
  const c2 = env.DB.bruto.prepare('SELECT publica FROM push_chaves').all();
  assert.equal(c1.length, 1);
  assert.deepEqual(c1, c2);
});
