// Testes do passo 3: chegada, tela "Hoje", fotos e transições de atendimento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { inicioDoDiaBahia } from '../src/util.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const FONE = '(71) 99999-8888';

function novoAmbiente(db = criarBancoLocal()) {
  return { DB: db, CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') } };
}

// Chamada à API. "corpo" objeto = JSON; "bytes" = corpo cru (fotos).
async function chamar(env, metodo, caminho, { corpo, cookie, bytes, tipo } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  if (bytes !== undefined) h['Content-Type'] = tipo;
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: bytes !== undefined ? bytes : corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  const copia = res.clone();
  return { res, dados: await res.json().catch(() => null), status: res.status, bytes: new Uint8Array(await copia.arrayBuffer()) };
}

const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

// Admin é veterinário; também criamos recepção e suporte.
async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  for (const [login, papel] of [['recep', 'recepcao'], ['sup', 'suporte'], ['vet2', 'veterinario']]) {
    assert.equal((await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: login, login, senha: 'senha-forte-123', papel } })).status, 201);
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, vet: admin, recepcao: await ent('recep'), suporte: await ent('sup'), vet2: await ent('vet2') };
}

async function novoPet(env, cookie, nome = 'Rex', tutor = 'Maria', fone = FONE) {
  const r = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome, especie: 'cao' } } });
  assert.equal(r.status, 201);
  return r.dados.pet;
}

const chegada = (pet, extra = {}) => ({ pet_id: pet.id, peso_kg: 12.4, motivo: 'Vômito', urgente: false, ...extra });
const acoes = (env, acao) => env.DB.bruto.prepare('SELECT * FROM registro_acoes WHERE acao = ?').all(acao);

// JPEG mínimo: só importa a assinatura FF D8 FF (o servidor confere os primeiros bytes).
const jpeg = (n = 200) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); for (let i = 4; i < n; i++) b[i] = i % 251; return b; };
const webp = () => { const b = new Uint8Array(40); b.set([...'RIFF'].map((c) => c.charCodeAt(0))); b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8); return b; };
const enviarFoto = async (env, cookie, bytes = jpeg(), tipo = 'image/jpeg') => chamar(env, 'POST', '/api/fotos', { cookie, bytes, tipo });

// ---------- início do dia em Bahia ----------
test('inicioDoDiaBahia: bordas da meia-noite (UTC-03:00)', () => {
  assert.equal(inicioDoDiaBahia(new Date('2026-11-11T03:00:00.000Z')), '2026-11-11T03:00:00.000Z'); // meia-noite exata em Bahia
  assert.equal(inicioDoDiaBahia(new Date('2026-11-11T02:59:59.999Z')), '2026-11-10T03:00:00.000Z'); // ainda é dia 10
  assert.equal(inicioDoDiaBahia(new Date('2026-11-11T00:00:00.000Z')), '2026-11-10T03:00:00.000Z');
  assert.equal(inicioDoDiaBahia(new Date('2026-11-11T14:32:00.000Z')), '2026-11-11T03:00:00.000Z');
  assert.equal(inicioDoDiaBahia(new Date('2026-11-11T23:59:59.999Z')), '2026-11-11T03:00:00.000Z'); // 20:59 em Bahia
  assert.equal(inicioDoDiaBahia(new Date('2026-11-12T02:59:59.999Z')), '2026-11-11T03:00:00.000Z');
  // virada de mês e de ano
  assert.equal(inicioDoDiaBahia(new Date('2027-01-01T02:00:00.000Z')), '2026-12-31T03:00:00.000Z');
  assert.equal(inicioDoDiaBahia(new Date('2026-03-01T01:00:00.000Z')), '2026-02-28T03:00:00.000Z');
});

// ---------- migração ----------
test('migração 0003 aplica sobre a 0002 mantendo dados existentes', () => {
  const db = criarBancoLocal({ ate: '0002' });
  const b = db.bruto;
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Ana', 'ana', 'h', 'veterinario', 1, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO tutores (codigo, nome, whatsapp, origem, criado_por, criado_em, atualizado_em) VALUES ('T-000001', 'Carla', '+5571999990000', 'recepcao', 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Mel', 'cao', 'recepcao', 'x', 'x')`).run();
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, registrado_por, criado_em, atualizado_em) VALUES (1, '2026-01-01T10:00:00.000Z', 8.5, 1, 'x', 'x')`).run();
  db.migrarRestante();
  const a = b.prepare('SELECT * FROM atendimentos').get();
  assert.equal(a.peso_kg, 8.5);
  assert.equal(a.foto_id, null);
  assert.equal(b.prepare('SELECT foto_id FROM pets').get().foto_id, null);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM fotos').get().n, 0);
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
  // o índice impede 2 atendimentos abertos do mesmo pet
  const inserir = (quando) => b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, registrado_por, criado_em, atualizado_em) VALUES (1, ?, 1, 'x', 'x')`).run(quando);
  assert.throws(() => inserir('z'), /UNIQUE/); // o atendimento antigo (status chegou) já está aberto
});

// ---------- criar atendimento ----------
test('criar atendimento com peso: origem conforme o papel e registro de ação', async () => {
  const { env, recepcao, vet, suporte } = await ambiente();
  const pets = [await novoPet(env, vet, 'A', 'T1', '71 99999-0001'), await novoPet(env, vet, 'B', 'T2', '71 99999-0002'), await novoPet(env, vet, 'C', 'T3', '71 99999-0003')];
  const r = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pets[0], { urgente: true }) });
  assert.equal(r.status, 201);
  assert.equal(r.dados.status, 'chegou');
  assert.equal(r.dados.peso_kg, 12.4);
  assert.equal(r.dados.peso_origem, 'balanca_recepcao');
  assert.equal(r.dados.sem_peso, false);
  assert.equal(r.dados.urgente, true);
  assert.equal(r.dados.pet.nome, 'A');
  assert.equal(r.dados.tutor.final_telefone, '0001');
  const bruto = env.DB.bruto.prepare('SELECT * FROM atendimentos WHERE id = ?').get(r.dados.id);
  assert.equal(bruto.peso_registrado_por, bruto.registrado_por); // quem pesou = quem registrou
  assert.ok(bruto.chegada_em.endsWith('Z'));
  const v = await chamar(env, 'POST', '/api/atendimentos', { cookie: vet, corpo: chegada(pets[1]) });
  assert.equal(v.dados.peso_origem, 'veterinario');
  const s = await chamar(env, 'POST', '/api/atendimentos', { cookie: suporte, corpo: chegada(pets[2]) });
  assert.equal(s.dados.peso_origem, 'balanca_recepcao');
  const log = await acoes(env, 'criar_atendimento');
  assert.equal(log.length, 3);
  assert.equal(JSON.parse(log[0].depois).peso_kg, 12.4);
});

test('peso: obrigatório sem "Pesar depois"; "Pesar depois" gera sem_peso; faixa 0,01 a 150', async () => {
  const { env, recepcao } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const sem = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: { pet_id: pet.id, peso_kg: null, motivo: 'Consulta' } });
  assert.equal(sem.status, 400);
  assert.equal(sem.dados.erro, 'Informe o peso ou escolha "Pesar depois".');
  for (const ruim of [0, -1, 0.001, 150.01, 'abc', '12,4,5', true]) {
    const r = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { peso_kg: ruim }) });
    assert.equal(r.status, 400, String(ruim));
  }
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { motivo: '  ' }) })).status, 400);
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { motivo: 'x'.repeat(201) }) })).status, 400);
  const depois = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: { pet_id: pet.id, peso_kg: null, pesar_depois: true, motivo: 'Consulta' } });
  assert.equal(depois.status, 201);
  assert.equal(depois.dados.sem_peso, true);
  assert.equal(depois.dados.peso_kg, null);
  assert.equal(depois.dados.peso_origem, null);
  // extremos aceitos; texto com vírgula também é aceito pelo servidor
  const outro = await novoPet(env, recepcao, 'Bolt', 'Joao', '71 99999-0005');
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(outro, { peso_kg: '0,01' }) })).dados.peso_kg, 0.01);
  const o2 = await novoPet(env, recepcao, 'Gigante', 'Joao2', '71 99999-0006');
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(o2, { peso_kg: 150 }) })).dados.peso_kg, 150);
});

test('segundo atendimento aberto do mesmo pet dá 409 com o id do aberto', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).dados;
  const r = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.dados, { erro: 'Este pet já está na clínica.', atendimento_id: a.id });
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: vet });
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).status, 409); // em atendimento também
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: vet });
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).status, 201); // finalizado libera
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada({ id: 9999 }) })).status, 404);
});

// ---------- /api/hoje ----------
test('hoje: agrupa, ordena (urgente primeiro), mostra abertos de ontem marcados e calcula espera', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pets = [];
  for (let i = 0; i < 6; i++) pets.push(await novoPet(env, recepcao, ['Normal1', 'Urgente', 'Normal2', 'EmAtend', 'Final', 'Ontem'][i], 'Tutor' + i, `71 99999-010${i}`));
  const criar = async (pet, extra) => (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, extra) })).dados;
  const a1 = await criar(pets[0]);
  await criar(pets[1], { urgente: true });
  await criar(pets[2], { peso_kg: null, pesar_depois: true });
  const a4 = await criar(pets[3]);
  const a5 = await criar(pets[4]);
  // Ajusta a chegada de cada um (sempre dentro de hoje) para ter espera conhecida.
  const inicio = inicioDoDiaBahia(new Date());
  const t0 = Math.max(Date.parse(inicio), Date.now() - 15 * 60000);
  env.DB.bruto.prepare('UPDATE atendimentos SET chegada_em = ? WHERE id = ?').run(new Date(t0).toISOString(), a1.id);
  await chamar(env, 'POST', `/api/atendimentos/${a4.id}/iniciar`, { cookie: vet });
  await chamar(env, 'POST', `/api/atendimentos/${a5.id}/iniciar`, { cookie: vet });
  await chamar(env, 'POST', `/api/atendimentos/${a5.id}/finalizar`, { cookie: vet });
  // Ontem (Bahia): 1 ms antes do início do dia. Continua aberto, então deve aparecer (marcado).
  const ontem = new Date(Date.parse(inicio) - 1).toISOString();
  env.DB.bruto.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, motivo, status, registrado_por, criado_em, atualizado_em) VALUES (?, ?, 5, 'Ontem', 'chegou', 1, 'x', 'x')`).run(pets[5].id, ontem);
  // Cancelado hoje
  const a6 = await criar(await novoPet(env, recepcao, 'Cancelado', 'Tc', '71 99999-0199'));
  assert.equal((await chamar(env, 'POST', `/api/atendimentos/${a6.id}/cancelar`, { cookie: recepcao, corpo: { motivo: 'Desistiu' } })).status, 200);

  const h = (await chamar(env, 'GET', '/api/hoje', { cookie: recepcao })).dados;
  assert.equal(h.inicio_dia, inicio);
  assert.ok(Math.abs(Date.parse(h.agora) - Date.now()) < 5000);
  assert.deepEqual(h.aguardando.map((x) => x.pet.nome), ['Urgente', 'Ontem', 'Normal1', 'Normal2']);
  assert.equal(h.aguardando.find((x) => x.pet.nome === 'Ontem').de_outro_dia, true);
  assert.equal(h.aguardando.find((x) => x.pet.nome === 'Normal1').de_outro_dia, false);
  assert.deepEqual(h.em_atendimento.map((x) => x.pet.nome), ['EmAtend']);
  assert.deepEqual(h.finalizados.map((x) => x.pet.nome), ['Final']);
  assert.equal(h.cancelados_hoje, 1);
  // Finalizado ontem não aparece em "Finalizados hoje".
  env.DB.bruto.prepare(`UPDATE atendimentos SET status = 'finalizado', finalizado_em = ? WHERE motivo = 'Ontem'`).run(ontem);
  const hOntem = (await chamar(env, 'GET', '/api/hoje', { cookie: recepcao })).dados;
  assert.ok(![...hOntem.aguardando, ...hOntem.em_atendimento, ...hOntem.finalizados].some((x) => x.pet.nome === 'Ontem'));
  const esperado = Math.floor((Date.now() - t0) / 60000);
  const n1 = h.aguardando.find((x) => x.pet.nome === 'Normal1');
  assert.ok(Math.abs(n1.espera_min - esperado) <= 1, `${n1.espera_min} vs ${esperado}`);
  assert.equal(h.aguardando.find((x) => x.pet.nome === 'Normal2').sem_peso, true);
  assert.equal(h.em_atendimento[0].veterinario.nome, 'Dra. Teste');
  assert.ok(h.em_atendimento[0].iniciado_em);
  assert.ok(h.finalizados[0].finalizado_em);
  assert.deepEqual(Object.keys(h.aguardando[0].tutor).sort(), ['final_telefone', 'id', 'nome']);
  assert.ok(!JSON.stringify(h).includes('999990'), 'telefone completo não aparece');
  // espera de quem já começou é fixa (chegada -> início)
  env.DB.bruto.prepare('UPDATE atendimentos SET chegada_em = ?, iniciado_em = ? WHERE id = ?').run(new Date(t0).toISOString(), new Date(t0 + 7 * 60000).toISOString(), a4.id);
  const h2 = (await chamar(env, 'GET', '/api/hoje', { cookie: recepcao })).dados;
  assert.equal(h2.em_atendimento[0].espera_min, 7);
});

test('hoje: finalizados mostra só os 20 mais recentes', async () => {
  const { env, vet } = await ambiente();
  for (let i = 0; i < 22; i++) {
    const pet = await novoPet(env, vet, 'Pet' + i, 'Tut' + i, `71 98888-${String(1000 + i)}`);
    const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: vet, corpo: chegada(pet) })).dados;
    await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: vet });
    await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: vet });
  }
  const h = (await chamar(env, 'GET', '/api/hoje', { cookie: vet })).dados;
  assert.equal(h.finalizados.length, 20);
});

// ---------- iniciar / finalizar / cancelar ----------
test('permissões: recepção não finaliza (403) e só inicia dizendo o veterinário; vet e suporte podem', async () => {
  const { env, recepcao, vet, suporte, vet2 } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).dados;
  assert.equal((await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: recepcao })).status, 400); // recepção sem veterinário
  const ini = await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: vet });
  assert.equal(ini.status, 200);
  assert.equal(ini.dados.status, 'em_atendimento');
  assert.equal(ini.dados.veterinario.nome, 'Dra. Teste');
  assert.ok(ini.dados.iniciado_em);
  assert.equal((await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: recepcao })).status, 403);
  const fim = await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: vet2 });
  assert.equal(fim.status, 200);
  assert.equal(fim.dados.status, 'finalizado');
  assert.ok(fim.dados.finalizado_em);
  // suporte também
  const p2 = await novoPet(env, recepcao, 'Luna', 'Ana', '71 99999-0002');
  const b = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(p2) })).dados;
  const si = await chamar(env, 'POST', `/api/atendimentos/${b.id}/iniciar`, { cookie: suporte });
  assert.equal(si.status, 200);
  assert.equal(si.dados.veterinario.nome, 'sup');
  assert.equal((await chamar(env, 'POST', `/api/atendimentos/${b.id}/finalizar`, { cookie: suporte })).status, 200);
  for (const acao of ['iniciar_atendimento', 'finalizar_atendimento']) assert.equal((await acoes(env, acao)).length, 2, acao);
  assert.equal((await chamar(env, 'POST', '/api/atendimentos/9999/iniciar', { cookie: vet })).status, 404);
});

test('transições inválidas dão 409', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).dados;
  const rota = (acao) => `/api/atendimentos/${a.id}/${acao}`;
  assert.equal((await chamar(env, 'POST', rota('finalizar'), { cookie: vet })).status, 409); // chegou -> finalizar
  assert.equal((await chamar(env, 'POST', rota('iniciar'), { cookie: vet })).status, 200);
  assert.equal((await chamar(env, 'POST', rota('iniciar'), { cookie: vet })).status, 409); // já iniciado
  assert.equal((await chamar(env, 'POST', rota('cancelar'), { cookie: recepcao, corpo: { motivo: 'x' } })).status, 409); // em atendimento
  assert.equal((await chamar(env, 'POST', rota('finalizar'), { cookie: vet })).status, 200);
  assert.equal((await chamar(env, 'POST', rota('finalizar'), { cookie: vet })).status, 409);
  assert.equal((await chamar(env, 'POST', rota('iniciar'), { cookie: vet })).status, 409);
  assert.equal((await chamar(env, 'POST', rota('cancelar'), { cookie: recepcao, corpo: { motivo: 'x' } })).status, 409); // finalizado
  assert.equal((await chamar(env, 'PATCH', `/api/atendimentos/${a.id}`, { cookie: vet, corpo: { motivo: 'novo' } })).status, 409); // encerrado
});

test('cancelar: só quando aguardando, exige motivo, qualquer papel, e libera o pet', async () => {
  const { env, recepcao } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).dados;
  assert.equal((await chamar(env, 'POST', `/api/atendimentos/${a.id}/cancelar`, { cookie: recepcao, corpo: {} })).status, 400);
  const r = await chamar(env, 'POST', `/api/atendimentos/${a.id}/cancelar`, { cookie: recepcao, corpo: { motivo: 'Tutor foi embora' } });
  assert.equal(r.status, 200);
  assert.equal(r.dados.status, 'cancelado');
  assert.equal(r.dados.motivo_cancelamento, 'Tutor foi embora');
  const log = await acoes(env, 'cancelar_atendimento');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0].depois).motivo_cancelamento, 'Tutor foi embora');
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).status, 201);
});

// ---------- editar ----------
test('PATCH: vet muda peso e origem vira "veterinario"; registra antes/depois', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: { pet_id: pet.id, pesar_depois: true, motivo: 'Consulta' } })).dados;
  assert.equal(a.sem_peso, true);
  // recepção adiciona o peso depois
  const r1 = await chamar(env, 'PATCH', `/api/atendimentos/${a.id}`, { cookie: recepcao, corpo: { peso_kg: 10 } });
  assert.equal(r1.dados.peso_kg, 10);
  assert.equal(r1.dados.peso_origem, 'balanca_recepcao');
  assert.equal(r1.dados.sem_peso, false);
  // reenviar o mesmo peso não muda a origem
  const r1b = await chamar(env, 'PATCH', `/api/atendimentos/${a.id}`, { cookie: vet, corpo: { peso_kg: 10, motivo: 'Consulta de rotina', urgente: true } });
  assert.equal(r1b.dados.peso_origem, 'balanca_recepcao');
  assert.equal(r1b.dados.motivo, 'Consulta de rotina');
  assert.equal(r1b.dados.urgente, true);
  // vet muda o peso
  const r2 = await chamar(env, 'PATCH', `/api/atendimentos/${a.id}`, { cookie: vet, corpo: { peso_kg: 10.3 } });
  assert.equal(r2.dados.peso_kg, 10.3);
  assert.equal(r2.dados.peso_origem, 'veterinario');
  assert.equal(env.DB.bruto.prepare('SELECT peso_registrado_por FROM atendimentos WHERE id = ?').get(a.id).peso_registrado_por, 1);
  const log = await acoes(env, 'alterar_atendimento');
  assert.equal(log.length, 3);
  assert.equal(JSON.parse(log[2].antes).peso_kg, 10);
  assert.equal(JSON.parse(log[2].depois).peso_kg, 10.3);
  assert.equal(JSON.parse(log[2].depois).peso_origem, 'veterinario');
  // validações
  for (const corpo of [{ peso_kg: 0 }, { peso_kg: 151 }, { peso_kg: null }, { motivo: '' }]) {
    assert.equal((await chamar(env, 'PATCH', `/api/atendimentos/${a.id}`, { cookie: vet, corpo })).status, 400, JSON.stringify(corpo));
  }
  assert.equal((await chamar(env, 'GET', `/api/atendimentos/${a.id}`, { cookie: recepcao })).dados.peso_kg, 10.3);
  assert.equal((await chamar(env, 'GET', '/api/atendimentos/9999', { cookie: recepcao })).status, 404);
});

// ---------- cadastro rápido com chegada ----------
test('cadastro rápido com chegada cria tutor, pet e atendimento', async () => {
  const { env, recepcao } = await ambiente();
  const r = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: {
    tutor: { nome: 'Maria', whatsapp: FONE }, pet: { nome: 'Thor', especie: 'cao' },
    chegada: { peso_kg: 12.4, motivo: 'Vômito', urgente: true },
  } });
  assert.equal(r.status, 201);
  assert.equal(r.dados.atendimento.peso_kg, 12.4);
  assert.equal(r.dados.atendimento.urgente, true);
  assert.equal(r.dados.atendimento.pet.id, r.dados.pet.id);
  const n = (t) => env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([n('tutores'), n('pets'), n('atendimentos')], [1, 1, 1]);
  const log = JSON.parse((await acoes(env, 'criar_atendimento'))[0].depois);
  assert.equal(log.via, 'cadastro_rapido');
  // sem "chegada": igual a antes (sem atendimento)
  const sem = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Joana', whatsapp: '71 98888-7777' }, pet: { nome: 'Mia', especie: 'gato' } } });
  assert.equal(sem.status, 201);
  assert.equal(sem.dados.atendimento, undefined);
  assert.equal(n('atendimentos'), 1);
});

test('cadastro rápido com chegada: 409 de duplicado não cria nada; confirmar cria tudo', async () => {
  const { env, recepcao } = await ambiente();
  await novoPet(env, recepcao, 'Rex', 'Maria');
  const n = (t) => env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const corpo = { tutor: { nome: 'Outra Maria', whatsapp: FONE }, pet: { nome: 'Luna', especie: 'gato' }, chegada: { peso_kg: 4, motivo: 'Consulta' } };
  const dup = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo });
  assert.equal(dup.status, 409);
  assert.deepEqual([n('tutores'), n('pets'), n('atendimentos')], [1, 1, 0]);
  // escolhendo "é a mesma pessoa": pet novo no tutor existente + atendimento
  const mesmo = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { ...corpo, tutor_existente_id: dup.dados.duplicados[0].id } });
  assert.equal(mesmo.status, 201);
  assert.equal(mesmo.dados.atendimento.pet.nome, 'Luna');
  assert.deepEqual([n('tutores'), n('pets'), n('atendimentos')], [1, 2, 1]);
  // "outra pessoa da família": cria tutor novo + pet + atendimento
  const novo = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { ...corpo, pet: { nome: 'Bolt', especie: 'cao' }, confirmar_duplicado: true } });
  assert.equal(novo.status, 201);
  assert.deepEqual([n('tutores'), n('pets'), n('atendimentos')], [2, 3, 2]);
  // chegada inválida: 400 e nada criado (nem gasta código)
  const ruim = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Zé', whatsapp: '71 97777-6666' }, pet: { nome: 'Zeca' }, chegada: { motivo: 'x' } } });
  assert.equal(ruim.status, 400);
  assert.deepEqual([n('tutores'), n('pets'), n('atendimentos')], [2, 3, 2]);
});

// ---------- fotos ----------
test('foto: envio válido, tipo errado, assinatura errada, grande demais', async () => {
  const { env, recepcao } = await ambiente();
  const ok = await enviarFoto(env, recepcao, jpeg(500));
  assert.equal(ok.status, 201);
  assert.ok(ok.dados.id > 0);
  assert.equal((await enviarFoto(env, recepcao, webp(), 'image/webp')).status, 201);
  assert.equal((await enviarFoto(env, recepcao, new TextEncoder().encode('<html>não sou foto</html>'), 'image/jpeg')).status, 400);
  assert.equal((await enviarFoto(env, recepcao, webp(), 'image/jpeg')).status, 400); // tipo diz jpeg, bytes são webp
  assert.equal((await enviarFoto(env, recepcao, jpeg(), 'image/png')).status, 400);
  assert.equal((await enviarFoto(env, recepcao, jpeg(), 'text/html')).status, 400);
  assert.equal((await enviarFoto(env, recepcao, new Uint8Array(0), 'image/jpeg')).status, 400);
  const limite = 1.5 * 1024 * 1024;
  assert.equal((await enviarFoto(env, recepcao, jpeg(limite))).status, 201); // exatamente no limite
  assert.equal((await enviarFoto(env, recepcao, jpeg(limite + 1))).status, 413);
  assert.equal((await acoes(env, 'enviar_foto')).length, 3);
  // sem cabeçalho de segurança: 403
  const res = await worker.fetch(new Request(ORIGEM + '/api/fotos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Cookie: recepcao }, body: jpeg() }), env);
  assert.equal(res.status, 403);
});

test('foto: entrega exige login e devolve os mesmos bytes, tipo e cabeçalhos', async () => {
  const { env, recepcao } = await ambiente();
  const bytes = jpeg(1000);
  const id = (await enviarFoto(env, recepcao, bytes)).dados.id;
  assert.equal((await chamar(env, 'GET', `/api/fotos/${id}`)).status, 401);
  const r = await chamar(env, 'GET', `/api/fotos/${id}`, { cookie: recepcao });
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.res.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(r.bytes, bytes);
  const w = (await enviarFoto(env, recepcao, webp(), 'image/webp')).dados.id;
  assert.equal((await chamar(env, 'GET', `/api/fotos/${w}`, { cookie: recepcao })).res.headers.get('content-type'), 'image/webp');
  assert.equal((await chamar(env, 'GET', '/api/fotos/9999', { cookie: recepcao })).status, 404);
});

test('foto da chegada vira a foto do pet só se o pet ainda não tem', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const f1 = (await enviarFoto(env, recepcao)).dados.id;
  const f2 = (await enviarFoto(env, recepcao)).dados.id;
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { foto_id: f1 }) })).dados;
  assert.equal(a.foto_id, f1);
  assert.equal(a.pet.foto_id, f1);
  assert.equal((await chamar(env, 'GET', `/api/pets/${pet.id}`, { cookie: recepcao })).dados.pet.foto_id, f1);
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: vet });
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: vet });
  const b = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { foto_id: f2 }) })).dados;
  assert.equal(b.foto_id, f2);
  assert.equal(b.pet.foto_id, f1); // continua a primeira
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(await novoPet(env, recepcao, 'Z', 'Z', '71 99999-0042'), { foto_id: 9999 }) })).status, 400);
  // trocar/remover a foto da chegada apaga a foto que ninguém mais usa
  const f3 = (await enviarFoto(env, recepcao)).dados.id;
  await chamar(env, 'PATCH', `/api/atendimentos/${b.id}`, { cookie: recepcao, corpo: { foto_id: f3 } });
  assert.equal(env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM fotos WHERE id = ?').get(f2).n, 0);
  const rem = await chamar(env, 'PATCH', `/api/atendimentos/${b.id}`, { cookie: recepcao, corpo: { foto_id: null } });
  assert.equal(rem.dados.foto_id, null);
  assert.equal(env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM fotos WHERE id = ?').get(f1).n, 1); // foto do pet fica
});

test('cadastro rápido com foto define a foto do pet', async () => {
  const { env, recepcao } = await ambiente();
  const f = (await enviarFoto(env, recepcao)).dados.id;
  const r = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Maria', whatsapp: FONE }, pet: { nome: 'Thor' }, chegada: { peso_kg: 5, motivo: 'x', foto_id: f } } });
  assert.equal(r.dados.pet.foto_id, f);
  assert.equal(r.dados.atendimento.foto_id, f);
});

// ---------- ficha do pet ----------
test('ficha do pet traz o histórico de peso, veterinário e atendimento aberto', async () => {
  const { env, recepcao, vet } = await ambiente();
  const pet = await novoPet(env, recepcao);
  const a = (await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { peso_kg: 11 }) })).dados;
  let f = (await chamar(env, 'GET', `/api/pets/${pet.id}`, { cookie: recepcao })).dados;
  assert.deepEqual(f.atendimento_aberto, { id: a.id, status: 'chegou' });
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/iniciar`, { cookie: vet });
  await chamar(env, 'POST', `/api/atendimentos/${a.id}/finalizar`, { cookie: vet });
  await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: { pet_id: pet.id, pesar_depois: true, motivo: 'Retorno' } });
  f = (await chamar(env, 'GET', `/api/pets/${pet.id}`, { cookie: recepcao })).dados;
  assert.equal(f.atendimentos.length, 2);
  assert.equal(f.atendimentos[0].sem_peso, true); // mais recente primeiro
  const antigo = f.atendimentos[1];
  assert.equal(antigo.peso_kg, 11);
  assert.equal(antigo.status, 'finalizado');
  assert.equal(antigo.veterinario, 'Dra. Teste');
  assert.equal(antigo.motivo, 'Vômito');
  assert.ok(antigo.chegada_em);
  assert.equal(f.atendimento_aberto.status, 'chegou');
});

// ---------- apagar dados de teste ----------
test('apagar dados de teste remove atendimentos e fotos de teste, mantém os reais', async () => {
  const { env, vet, recepcao } = await ambiente();
  const teste = await novoPet(env, recepcao, 'Rex', 'TESTE Maria', '71 99999-0001');
  const real = await novoPet(env, recepcao, 'Bolinha', 'Ana Real', '71 99999-0003');
  const fTeste = (await enviarFoto(env, recepcao)).dados.id;
  const fReal = (await enviarFoto(env, recepcao)).dados.id;
  const fSolta = (await enviarFoto(env, recepcao)).dados.id; // enviada mas sem uso: não é "de teste"
  await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(teste, { foto_id: fTeste }) });
  await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(real, { foto_id: fReal }) });
  const previa = await chamar(env, 'GET', '/api/admin/dados-teste', { cookie: vet });
  assert.deepEqual(previa.dados, { tutores: 1, pets: 1, atendimentos: 1, pedidos: 0, receitas: 0, fotos: 1 });
  const r = await chamar(env, 'POST', '/api/admin/apagar-dados-teste', { cookie: vet, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.apagados, { tutores: 1, pets: 1, atendimentos: 1, pedidos: 0, receitas: 0, fotos: 1 });
  const b = env.DB.bruto;
  assert.deepEqual(b.prepare('SELECT id FROM fotos ORDER BY id').all().map((x) => x.id), [fReal, fSolta]);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM atendimentos').get().n, 1);
  assert.equal(b.prepare('SELECT foto_id FROM pets WHERE nome = ?').get('Bolinha').foto_id, fReal);
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
});

// ---------- login obrigatório ----------
test('todas as rotas novas exigem login (401)', async () => {
  const env = novoAmbiente();
  const rotas = [
    ['GET', '/api/hoje'], ['POST', '/api/atendimentos'], ['GET', '/api/atendimentos/1'], ['PATCH', '/api/atendimentos/1'],
    ['POST', '/api/atendimentos/1/iniciar'], ['POST', '/api/atendimentos/1/finalizar'], ['POST', '/api/atendimentos/1/cancelar'],
    ['POST', '/api/fotos'], ['GET', '/api/fotos/1'],
  ];
  for (const [m, c] of rotas) {
    const r = await chamar(env, m, c, { corpo: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${c}`);
  }
});

// ---------- notificações de chegada (passo 4) ----------
test('chegada avisa os veterinários (menos quem registrou), com peso e urgência', async () => {
  const { env, recepcao, vet } = await ambiente();
  const avisos = [];
  env.NOTIFICAR_TESTE = async (_env, aviso) => { avisos.push(aviso); return { enviados: 1, falhas: 0 }; };
  const pet = await novoPet(env, recepcao, 'Thor', 'Maria');
  const r = await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet, { urgente: true }) });
  assert.equal(r.status, 201);
  assert.equal(avisos.length, 1);
  const a = avisos[0];
  assert.equal(a.para.papel, 'veterinario');
  assert.ok(a.para.excetoUsuarioId > 0);
  assert.equal(a.titulo, 'URGENTE: Thor (cão)');
  assert.equal(a.corpo, '12,4 kg · Vômito · tutor Maria');
  assert.equal(a.urgente, true);
  assert.equal(a.url, '#/hoje');

  // "Pesar depois" e cadastro rápido com chegada também avisam.
  avisos.length = 0;
  const r2 = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: vet, corpo: {
    tutor: { nome: 'Joana', whatsapp: '(71) 98888-7777' }, pet: { nome: 'Luna', especie: 'gato' },
    chegada: { peso_kg: null, pesar_depois: true, motivo: 'Rotina', urgente: false } } });
  assert.equal(r2.status, 201);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].titulo, 'Chegou: Luna (gato)');
  assert.equal(avisos[0].corpo, 'Sem peso · Rotina · tutor Joana');
});

test('chegada: falha na notificação não impede o registro', async () => {
  const { env, recepcao } = await ambiente();
  env.NOTIFICAR_TESTE = async () => { throw new Error('serviço fora do ar'); };
  const pet = await novoPet(env, recepcao, 'Bob');
  assert.equal((await chamar(env, 'POST', '/api/atendimentos', { cookie: recepcao, corpo: chegada(pet) })).status, 201);
});

test('push: rotas exigem login e só aceitam endereços oficiais', async () => {
  const { env, vet } = await ambiente();
  for (const [m, c] of [['GET', '/api/push/chave'], ['GET', '/api/push/estado'], ['POST', '/api/push/inscrever'], ['POST', '/api/push/cancelar'], ['POST', '/api/push/teste']]) {
    assert.equal((await chamar(env, m, c, { corpo: m === 'POST' ? {} : undefined })).status, 401, c);
  }
  const chave = await chamar(env, 'GET', '/api/push/chave', { cookie: vet });
  assert.equal(chave.status, 200);
  assert.ok(chave.dados.publica.length > 80);
  // Mesmo valor nas próximas chamadas (chave criada uma vez só).
  assert.equal((await chamar(env, 'GET', '/api/push/chave', { cookie: vet })).dados.publica, chave.dados.publica);

  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const keys = { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };

  const ruim = await chamar(env, 'POST', '/api/push/inscrever', { cookie: vet, corpo: { endpoint: 'https://atacante.exemplo/x', keys } });
  assert.equal(ruim.status, 400);
  const chavesRuins = await chamar(env, 'POST', '/api/push/inscrever', { cookie: vet, corpo: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'abc', auth: 'def' } } });
  assert.equal(chavesRuins.status, 400);

  const ok = await chamar(env, 'POST', '/api/push/inscrever', { cookie: vet, corpo: { endpoint: 'https://web.push.apple.com/aparelho1', keys } });
  assert.equal(ok.status, 200);
  assert.equal((await chamar(env, 'GET', '/api/push/estado', { cookie: vet })).dados.aparelhos, 1);
  // O contato (exigido pela Apple) passa a ser o endereço do sistema.
  assert.equal(env.DB.bruto.prepare('SELECT contato FROM push_chaves').get().contato, ORIGEM);
  // Inscrever de novo o mesmo aparelho não duplica.
  await chamar(env, 'POST', '/api/push/inscrever', { cookie: vet, corpo: { endpoint: 'https://web.push.apple.com/aparelho1', keys } });
  assert.equal((await chamar(env, 'GET', '/api/push/estado', { cookie: vet })).dados.aparelhos, 1);

  assert.equal((await chamar(env, 'POST', '/api/push/cancelar', { cookie: vet, corpo: { endpoint: 'https://web.push.apple.com/aparelho1' } })).status, 200);
  assert.equal((await chamar(env, 'GET', '/api/push/estado', { cookie: vet })).dados.aparelhos, 0);
  assert.equal(acoes(env, 'ativar_notificacoes').length, 2);
});
