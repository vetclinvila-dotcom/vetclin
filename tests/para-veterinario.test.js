// Testes: chegada "Para quem?" (veterinário escolhido pela recepção).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const novoAmbiente = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') } });

async function chamar(env, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

// Admin = Dra. Elizabeth (veterinária); Dr. Filipe (veterinário); recepção; vet inativo e suporte.
async function ambiente() {
  const env = novoAmbiente();
  const avisos = [];
  env.NOTIFICAR_TESTE = async (_e, aviso) => { avisos.push(aviso); return { enviados: 1, falhas: 0 }; };
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  const ids = {};
  for (const [login, nome, papel] of [['filipe', 'Dr. Filipe', 'veterinario'], ['recep', 'Recep', 'recepcao'], ['sup', 'Sup', 'suporte'], ['antigo', 'Dr. Antigo', 'veterinario']]) {
    const c = await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome, login, senha: 'senha-forte-123', papel } });
    assert.equal(c.status, 201);
    ids[login] = c.dados.id ?? c.dados.usuario?.id;
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  const eu = (await chamar(env, 'GET', '/api/eu', { cookie: admin })).dados;
  ids.admin = (eu.usuario ?? eu).id;
  const a = { env, avisos, ids, elizabeth: admin, filipe: await ent('filipe'), recepcao: await ent('recep') };
  // desativa o "antigo" depois de ter o id
  const d = await chamar(env, 'PATCH', `/api/usuarios/${ids.antigo}`, { cookie: admin, corpo: { ativo: false } });
  assert.equal(d.status, 200);
  return a;
}
let n = 0;
async function novoPet(a, nome) {
  n++;
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Tutor ' + n, whatsapp: `(71) 9${String(2000 + n).padStart(4, '0')}-0000` }, pet: { nome, especie: 'cao' } } });
  assert.equal(r.status, 201);
  return r.dados.pet;
}
const base = (extra = {}) => ({ peso_kg: 8, motivo: 'Vômito', urgente: false, ...extra });
const hoje = async (a, cookie) => (await chamar(a.env, 'GET', '/api/hoje', { cookie })).dados;

test('POST /api/atendimentos: aceita veterinário ativo, devolve para_veterinario e registra a ação', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const r = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base({ para_veterinario_id: a.ids.filipe }) } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.dados.para_veterinario, { id: a.ids.filipe, nome: 'Dr. Filipe' });
  const acao = a.env.DB.bruto.prepare(`SELECT depois FROM registro_acoes WHERE acao = 'criar_atendimento'`).get();
  assert.equal(JSON.parse(acao.depois).para_veterinario_id, a.ids.filipe);
  // sem o campo: qualquer veterinário
  const pet2 = await novoPet(a, 'Rex');
  const r2 = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet2.id, ...base() } });
  assert.equal(r2.dados.para_veterinario, null);
});

test('para_veterinario_id inválido: recepção, inativo, inexistente e formato errado dão 400', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  for (const id of [a.ids.recep, a.ids.sup, a.ids.antigo, 9999, 'abc', 0, -1, 1.5]) {
    const r = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base({ para_veterinario_id: id }) } });
    assert.equal(r.status, 400, `id ${id}`);
  }
  const c = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Z', whatsapp: '(71) 98888-7777' }, pet: { nome: 'Zeca', especie: 'cao' }, chegada: base({ para_veterinario_id: a.ids.recep }) } });
  assert.equal(c.status, 400);
  // nada foi gravado (nem pet, nem atendimento)
  assert.equal(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM pets WHERE nome = 'Zeca'`).get().n, 0);
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM atendimentos').get().n, 0);
});

test('cadastro-rapido com chegada aceita para_veterinario_id', async () => {
  const a = await ambiente();
  const c = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Ana', whatsapp: '(71) 97777-6666' }, pet: { nome: 'Mel', especie: 'gato' }, chegada: base({ para_veterinario_id: a.ids.filipe }) } });
  assert.equal(c.status, 201);
  assert.equal(c.dados.atendimento.para_veterinario.id, a.ids.filipe);
});

test('aviso na chegada: com "Para quem?" só aquele veterinário é avisado, com "Para você — "', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base({ para_veterinario_id: a.ids.filipe }) } });
  assert.equal(a.avisos.length, 1);
  assert.deepEqual(a.avisos[0].para, { usuarioId: a.ids.filipe });
  assert.equal(a.avisos[0].titulo, 'Para você — Chegou: Thor (cão)');
  // urgente continua urgente
  const pet2 = await novoPet(a, 'Bidu');
  await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet2.id, ...base({ urgente: true, para_veterinario_id: a.ids.filipe }) } });
  assert.equal(a.avisos[1].urgente, true);
  assert.equal(a.avisos[1].titulo, 'Para você — URGENTE: Bidu (cão)');
  // sem "Para quem?": comportamento de sempre
  const pet3 = await novoPet(a, 'Luna');
  await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.filipe, corpo: { pet_id: pet3.id, ...base() } });
  assert.deepEqual(a.avisos[2].para, { papel: 'veterinario', excetoUsuarioId: a.ids.filipe });
  assert.equal(a.avisos[2].titulo, 'Chegou: Luna (cão)');
});

test('Hoje: traz para_veterinario e, para o veterinário indicado, os dele vêm primeiro (urgente sempre antes)', async () => {
  const a = await ambiente();
  const pets = [];
  for (const nome of ['Primeiro', 'ParaFilipe', 'ParaElizabeth', 'Urgente']) pets.push(await novoPet(a, nome));
  const criar = (pet, extra) => chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base(extra) } });
  await criar(pets[0], {});
  await criar(pets[1], { para_veterinario_id: a.ids.filipe });
  await criar(pets[2], { para_veterinario_id: a.ids.admin });
  await criar(pets[3], { urgente: true });
  const nomes = (d) => d.aguardando.map((x) => x.pet.nome);
  assert.deepEqual(nomes(await hoje(a, a.filipe)), ['Urgente', 'ParaFilipe', 'Primeiro', 'ParaElizabeth']);
  assert.deepEqual(nomes(await hoje(a, a.elizabeth)), ['Urgente', 'ParaElizabeth', 'Primeiro', 'ParaFilipe']);
  assert.deepEqual(nomes(await hoje(a, a.recepcao)), ['Urgente', 'Primeiro', 'ParaFilipe', 'ParaElizabeth']);
  const item = (await hoje(a, a.elizabeth)).aguardando.find((x) => x.pet.nome === 'ParaFilipe');
  assert.deepEqual(item.para_veterinario, { id: a.ids.filipe, nome: 'Dr. Filipe' });
  assert.equal((await hoje(a, a.elizabeth)).aguardando.find((x) => x.pet.nome === 'Primeiro').para_veterinario, null);
  // qualquer veterinário ainda pode iniciar o atendimento
  const ini = await chamar(a.env, 'POST', `/api/atendimentos/${item.id}/iniciar`, { cookie: a.elizabeth });
  assert.equal(ini.status, 200);
  assert.equal(ini.dados.veterinario.id, a.ids.admin);
});

test('PATCH: reatribui enquanto aguarda, limpa com null, valida e registra a ação', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const id = (await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base() } })).dados.id;
  let r = await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.filipe } });
  assert.equal(r.status, 200);
  assert.equal(r.dados.para_veterinario.id, a.ids.filipe);
  r = await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.admin } });
  assert.equal(r.dados.para_veterinario.id, a.ids.admin);
  assert.equal((await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.recep } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.antigo } })).status, 400);
  // outros campos não mexem na atribuição
  r = await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { motivo: 'Outro' } });
  assert.equal(r.dados.para_veterinario.id, a.ids.admin);
  r = await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: null } });
  assert.equal(r.dados.para_veterinario, null);
  const acoes = a.env.DB.bruto.prepare(`SELECT depois FROM registro_acoes WHERE acao = 'alterar_atendimento' ORDER BY id`).all().map((x) => JSON.parse(x.depois).para_veterinario_id);
  assert.deepEqual(acoes, [a.ids.filipe, a.ids.admin, a.ids.admin, null]);
  // depois de iniciado não dá mais para reatribuir (mas repetir o mesmo valor é aceito)
  await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.filipe } });
  await chamar(a.env, 'POST', `/api/atendimentos/${id}/iniciar`, { cookie: a.filipe });
  assert.equal((await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.admin } })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', `/api/atendimentos/${id}`, { cookie: a.recepcao, corpo: { para_veterinario_id: a.ids.filipe, motivo: 'Ok' } })).status, 200);
});
