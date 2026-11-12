// Apoio dos testes de prontuário, internação e carrinho (não é um teste: o nome não termina em ".test.js").
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { criarBancoLocal } from './d1-local.js';

export const ORIGEM = 'https://vetclin.exemplo.test';

export async function chamar(env, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

// Ambiente com: admin (Dra. Elizabeth, veterinária e administradora), Dr. Filipe (veterinário),
// Sup (suporte, sem admin), Recep (recepção) e um relógio que os testes podem mudar (a.relogio.agora).
export async function ambiente(inicio = '2026-11-10T12:00:00.000Z') {
  const relogio = { agora: new Date(inicio) };
  const env = {
    DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia',
    ASSETS: { fetch: async () => new Response('estatico') }, NOTIFICAR_TESTE: async () => ({ enviados: 0, falhas: 0 }),
    AGORA_TESTE: () => relogio.agora,
  };
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123' } });
  const elizabeth = cookieDe(r.res);
  const ids = { admin: r.dados.id };
  for (const [login, nome, papel] of [['filipe', 'Dr. Filipe', 'veterinario'], ['sup', 'Sup', 'suporte'], ['recep', 'Recep', 'recepcao']]) {
    const c = await chamar(env, 'POST', '/api/usuarios', { cookie: elizabeth, corpo: { nome, login, senha: 'senha-forte-123', papel } });
    assert.equal(c.status, 201);
    ids[login] = c.dados.id;
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, relogio, ids, elizabeth, filipe: await ent('filipe'), suporte: await ent('sup'), recepcao: await ent('recep') };
}

let n = 0;
export async function novoPet(a, nome, tutor = null) {
  n++;
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: tutor ?? 'Tutor ' + n, whatsapp: `(71) 9${String(3000 + n).padStart(4, '0')}-0000` }, pet: { nome, especie: 'cao' } } });
  assert.equal(r.status, 201);
  return r.dados.pet;
}

// Chegada + início do atendimento (feito por quem estiver em "cookie"). Devolve o id do atendimento.
export async function atendimentoEmAndamento(a, pet, cookie = a.filipe) {
  const c = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 8, motivo: 'Teste' } });
  assert.equal(c.status, 201);
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${c.dados.id}/iniciar`, { cookie })).status, 200);
  return c.dados.id;
}

export const minutosDepois = (data, min) => new Date(new Date(data).getTime() + min * 60000);
