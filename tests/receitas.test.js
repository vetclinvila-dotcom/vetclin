// Testes do passo 4: receita rápida (rascunho, liberar, imprimir, sugestões, dados da clínica).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { linhasParaSugestao } from '../src/receitas.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';

function novoAmbiente(db = criarBancoLocal()) {
  return { DB: db, CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') } };
}

async function chamar(env, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

// Admin é a veterinária "Dra. Elizabeth" (com CRMV); também: vet2 (Felipe), recepção e suporte.
async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123', crmv: 'CRMV-BA 1234' } });
  const admin = cookieDe(r.res);
  const ids = {};
  for (const [login, papel, nome] of [['recep', 'recepcao', 'Recep'], ['sup', 'suporte', 'Sup'], ['felipe', 'veterinario', 'Felipe']]) {
    const c = await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome, login, senha: 'senha-forte-123', papel, crmv: papel === 'veterinario' ? 'CRMV-BA 999' : undefined } });
    assert.equal(c.status, 201);
    ids[login] = c.dados.id;
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, vet: admin, vetId: r.dados.id, recepcao: await ent('recep'), suporte: await ent('sup'), felipe: await ent('felipe'), ids };
}

async function novoPet(env, cookie, nome = 'Thor', tutor = 'Maria', fone = '(71) 99999-8888') {
  const r = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome, especie: 'cao' } } });
  assert.equal(r.status, 201);
  return r.dados.pet;
}

const acoes = (env, acao) => env.DB.bruto.prepare('SELECT * FROM registro_acoes WHERE acao = ?').all(acao);
const linhaReceita = (env, id) => env.DB.bruto.prepare('SELECT * FROM receitas WHERE id = ?').get(id);

async function criar(a, cookie, pet, extra = {}) {
  const r = await chamar(a.env, 'POST', '/api/receitas', { cookie, corpo: { pet_id: pet.id, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados.receita;
}
const liberada = async (a, pet, texto = 'Amoxicilina 250 mg — 1 comprimido a cada 12 horas por 7 dias') => {
  const r = await criar(a, a.vet, pet, { texto });
  const l = await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet });
  assert.equal(l.status, 200, JSON.stringify(l.dados));
  return r.id;
};

// ---------- permissões ----------
test('recepção não cria nem vê rascunhos; suporte e veterinário criam', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  assert.equal((await chamar(a.env, 'POST', '/api/receitas', { cookie: a.recepcao, corpo: { pet_id: pet.id } })).status, 403);
  const rs = await criar(a, a.suporte, pet, { texto: 'a' });
  const rv = await criar(a, a.vet, pet, { texto: 'b' });
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${rs.id}`, { cookie: a.recepcao })).status, 403);
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${rv.id}`, { cookie: a.recepcao })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${rv.id}`, { cookie: a.recepcao, corpo: { texto: 'x' } })).status, 403);
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${rv.id}`, { cookie: a.felipe })).status, 200);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas/9999', { cookie: a.vet })).status, 404);
  // pet inexistente e atendimento de outro pet
  assert.equal((await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { pet_id: 999 } })).status, 404);
  assert.equal((await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: {} })).status, 400);
});

test('só veterinário libera; suporte recebe 403; liberar exige texto', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.suporte, pet, { texto: 'Dipirona 500 mg' });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.suporte })).status, 403);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.recepcao })).status, 403);
  assert.equal(linhaReceita(a.env, r.id).status, 'rascunho');
  const vazia = await criar(a, a.vet, pet, { texto: '  \n ' });
  const e = await chamar(a.env, 'POST', `/api/receitas/${vazia.id}/liberar`, { cookie: a.vet });
  assert.equal(e.status, 400);
  const ok = await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.felipe });
  assert.equal(ok.status, 200);
  assert.equal(ok.dados.receita.status, 'liberada');
  assert.equal(ok.dados.veterinario.nome, 'Felipe');
  assert.equal(ok.dados.veterinario.crmv, 'CRMV-BA 999');
  assert.ok(ok.dados.receita.liberada_em);
  assert.equal((await acoes(a.env, 'liberar_receita')).length, 1);
});

test('texto: limites, caracteres invisíveis e quebras de linha', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.vet, pet, { texto: 'Linha 1\r\n​Linha 2﻿  ' });
  assert.equal(linhaReceita(a.env, r.id).texto, 'Linha 1\nLinha 2');
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'x'.repeat(10001) } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { orientacoes: 'x'.repeat(5001) } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'x'.repeat(10000), orientacoes: 'y'.repeat(5000) } })).status, 200);
});

// ---------- autosave e registro ----------
test('PATCH salva o rascunho e o registro guarda só tamanhos (sem o texto clínico)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.vet, pet);
  for (const t of ['Amox', 'Amoxicilina 250 mg', 'Amoxicilina 250 mg SEGREDO-CLINICO']) {
    assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: t, orientacoes: 'Repouso' } })).status, 200);
  }
  assert.equal(linhaReceita(a.env, r.id).texto, 'Amoxicilina 250 mg SEGREDO-CLINICO');
  assert.equal(linhaReceita(a.env, r.id).orientacoes, 'Repouso');
  // Gravações seguidas viram uma só linha no registro.
  const log = await acoes(a.env, 'editar_receita');
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log[0]).includes('SEGREDO-CLINICO'));
  assert.equal(JSON.parse(log[0].depois).texto_tamanho, 'Amoxicilina 250 mg SEGREDO-CLINICO'.length);
  const criacao = (await acoes(a.env, 'criar_receita'))[0];
  assert.ok(!criacao.depois.includes('texto"'));
  // PATCH sem mudança não registra nada novo.
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'Amoxicilina 250 mg SEGREDO-CLINICO' } });
  assert.equal((await acoes(a.env, 'editar_receita')).length, 1);
});

test('receita liberada é imutável', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const id = await liberada(a, pet);
  const p = await chamar(a.env, 'PATCH', `/api/receitas/${id}`, { cookie: a.vet, corpo: { texto: 'outra coisa' } });
  assert.equal(p.status, 409);
  assert.equal(p.dados.erro, 'Receita já liberada. Crie uma nova versão para corrigir.');
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id}/liberar`, { cookie: a.vet })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id}/pedir`, { cookie: a.vet, corpo: { para_usuario_id: a.ids.felipe } })).status, 409);
  assert.match(linhaReceita(a.env, id).texto, /^Amoxicilina/);
});

// ---------- nova versão ----------
test('nova versão: copia, encadeia e cancela a anterior só ao liberar', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const id1 = await liberada(a, pet);
  // rascunho não tem nova versão
  const rasc = await criar(a, a.vet, pet, { texto: 'x' });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${rasc.id}/nova-versao`, { cookie: a.vet })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id1}/nova-versao`, { cookie: a.recepcao })).status, 403);

  const nv = await chamar(a.env, 'POST', `/api/receitas/${id1}/nova-versao`, { cookie: a.suporte });
  assert.equal(nv.status, 201);
  const v2 = nv.dados.receita;
  assert.equal(v2.versao, 2);
  assert.equal(v2.status, 'rascunho');
  assert.equal(v2.receita_anterior_id, id1);
  assert.equal(v2.texto, linhaReceita(a.env, id1).texto);
  assert.equal(nv.dados.receita_anterior.id, id1);
  assert.equal(linhaReceita(a.env, id1).status, 'liberada'); // ainda vale
  // pedir de novo devolve o mesmo rascunho
  const outra = await chamar(a.env, 'POST', `/api/receitas/${id1}/nova-versao`, { cookie: a.vet });
  assert.equal(outra.dados.receita.id, v2.id);
  assert.equal(outra.dados.existente, true);
  assert.equal(env2count(a), 2);

  await chamar(a.env, 'PATCH', `/api/receitas/${v2.id}`, { cookie: a.vet, corpo: { texto: 'Amoxicilina 500 mg' } });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${v2.id}/liberar`, { cookie: a.vet })).status, 200);
  assert.equal(linhaReceita(a.env, id1).status, 'cancelada');
  assert.equal(linhaReceita(a.env, v2.id).status, 'liberada');
  // a recepção não vê mais a antiga na lista de impressão
  const lista = await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao });
  assert.deepEqual(lista.dados.receitas.map((r) => r.id), [v2.id]);
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${id1}`, { cookie: a.recepcao })).status, 403);
});
const env2count = (a) => a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM receitas WHERE receita_anterior_id IS NOT NULL OR status = 'liberada'`).get().n;

test('nova versão de uma receita já impressa também funciona', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const id = await liberada(a, pet);
  await chamar(a.env, 'POST', `/api/receitas/${id}/impressa`, { cookie: a.recepcao });
  const nv = await chamar(a.env, 'POST', `/api/receitas/${id}/nova-versao`, { cookie: a.vet });
  assert.equal(nv.status, 201);
  await chamar(a.env, 'POST', `/api/receitas/${nv.dados.receita.id}/liberar`, { cookie: a.vet });
  assert.equal(linhaReceita(a.env, id).status, 'cancelada');
});

// ---------- pedir ----------
test('pedir a outro veterinário: valida o alvo e grava os campos', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.felipe, pet, { texto: 'rascunho do Felipe' });
  const pedir = (corpo, cookie = a.felipe) => chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie, corpo });
  assert.equal((await pedir({ para_usuario_id: a.ids.felipe })).status, 400); // ele mesmo
  assert.equal((await pedir({ para_usuario_id: a.ids.recep })).status, 400);  // não é veterinário
  assert.equal((await pedir({ para_usuario_id: a.ids.sup })).status, 400);
  assert.equal((await pedir({ para_usuario_id: 9999 })).status, 400);
  assert.equal((await pedir({})).status, 400);
  assert.equal((await pedir({ para_usuario_id: a.vetId }, a.recepcao)).status, 403);
  // veterinário desativado não serve
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { ativo: false } });
  assert.equal((await pedir({ para_usuario_id: a.ids.felipe }, a.vet)).status, 400);
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { ativo: true } });
  const novoLogin = cookieDe((await chamar(a.env, 'POST', '/api/entrar', { corpo: { login: 'felipe', senha: 'senha-forte-123' } })).res);

  const ok = await chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie: novoLogin, corpo: { para_usuario_id: a.vetId, nota: 'Cão com otite' } });
  assert.equal(ok.status, 200);
  const l = linhaReceita(a.env, r.id);
  assert.equal(l.solicitada_a, a.vetId);
  assert.equal(l.solicitada_por, a.ids.felipe);
  assert.equal(l.nota_pedido, 'Cão com otite');
  assert.equal(ok.dados.receita.solicitada_por_nome, 'Felipe');
  assert.equal((await acoes(a.env, 'pedir_receita')).length, 1);

  // aparece em "pedidas a mim" só para quem foi pedido
  const minhas = await chamar(a.env, 'GET', '/api/receitas?pedidas_a_mim=1', { cookie: a.vet });
  assert.deepEqual(minhas.dados.receitas.map((x) => x.id), [r.id]);
  assert.equal(minhas.dados.receitas[0].solicitada_por_nome, 'Felipe');
  assert.equal(minhas.dados.receitas[0].nota_pedido, 'Cão com otite');
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?pedidas_a_mim=1', { cookie: novoLogin })).dados.receitas.length, 0);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?pedidas_a_mim=1', { cookie: a.recepcao })).status, 403);
  // depois de liberada, some dos pedidos
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet })).status, 200);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?pedidas_a_mim=1', { cookie: a.vet })).dados.receitas.length, 0);
  assert.equal(linhaReceita(a.env, r.id).veterinario_id, a.vetId); // quem liberou assina
});

// ---------- cancelar ----------
test('cancelar: rascunho e liberada sim; impressa e já cancelada não', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.suporte, pet, { texto: 'x' });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/cancelar`, { cookie: a.recepcao })).status, 403);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/cancelar`, { cookie: a.suporte })).status, 200);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/cancelar`, { cookie: a.suporte })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'y' } })).status, 409);
  const l = await liberada(a, pet);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${l}/cancelar`, { cookie: a.vet })).status, 200);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas.length, 0);
  const i = await liberada(a, pet);
  await chamar(a.env, 'POST', `/api/receitas/${i}/impressa`, { cookie: a.recepcao });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${i}/cancelar`, { cookie: a.vet })).status, 409);
  assert.equal((await acoes(a.env, 'cancelar_receita')).length, 2);
});

// ---------- impressão e entrega ----------
test('para imprimir, impressa (2ª via) e entregue', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const rasc = await criar(a, a.vet, pet, { texto: 'não liberada' });
  const id = await liberada(a, pet, 'Dipirona 500 mg');
  // lista: só a liberada, com nomes
  const l1 = await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao });
  assert.equal(l1.status, 200);
  assert.equal(l1.dados.receitas.length, 1);
  const item = l1.dados.receitas[0];
  assert.equal(item.id, id);
  assert.equal(item.pet.nome, 'Thor');
  assert.equal(item.tutor.nome, 'Maria');
  assert.equal(item.veterinario.nome, 'Dra. Elizabeth');
  assert.equal(item.previa, 'Dipirona 500 mg');
  assert.ok(item.liberada_em);
  // recepção abre a receita liberada
  const ver = await chamar(a.env, 'GET', `/api/receitas/${id}`, { cookie: a.recepcao });
  assert.equal(ver.status, 200);
  assert.equal(ver.dados.tutor.whatsapp, '(71) 99999-8888');

  const i1 = await chamar(a.env, 'POST', `/api/receitas/${id}/impressa`, { cookie: a.recepcao });
  assert.equal(i1.status, 200);
  assert.equal(i1.dados.receita.status, 'impressa');
  assert.equal(i1.dados.receita.vezes_impressa, 1);
  const i2 = await chamar(a.env, 'POST', `/api/receitas/${id}/impressa`, { cookie: a.recepcao });
  assert.equal(i2.dados.receita.vezes_impressa, 2);
  assert.equal(linhaReceita(a.env, id).impressa_por > 0, true);
  // impressa hoje continua na lista
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas.length, 1);
  // impressa em outro dia sai da lista
  a.env.DB.bruto.prepare(`UPDATE receitas SET impressa_em = '2020-01-01T10:00:00.000Z' WHERE id = ?`).run(id);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas.length, 0);
  a.env.DB.bruto.prepare(`UPDATE receitas SET impressa_em = ? WHERE id = ?`).run(new Date().toISOString(), id);

  const e = await chamar(a.env, 'POST', `/api/receitas/${id}/entregue`, { cookie: a.recepcao });
  assert.equal(e.status, 200);
  assert.equal(e.dados.receita.status, 'entregue');
  assert.ok(linhaReceita(a.env, id).entregue_por);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id}/entregue`, { cookie: a.recepcao })).status, 409);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas.length, 0);
  // rascunho não imprime nem entrega
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${rasc.id}/impressa`, { cookie: a.recepcao })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${rasc.id}/entregue`, { cookie: a.recepcao })).status, 409);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas', { cookie: a.recepcao })).status, 400);
});

test('entregue direto da liberada; liberada antiga (de outro dia) continua na lista', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const id = await liberada(a, pet);
  a.env.DB.bruto.prepare(`UPDATE receitas SET liberada_em = '2020-01-01T10:00:00.000Z' WHERE id = ?`).run(id);
  assert.equal((await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas.length, 1);
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id}/entregue`, { cookie: a.recepcao })).status, 200);
});

// ---------- rascunho por atendimento ----------
test('receita ligada ao atendimento reaproveita o rascunho existente', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const outro = await novoPet(a.env, a.recepcao, 'Mel', 'Ana', '(71) 99999-0001');
  const at = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 12.4, motivo: 'Vômito' } });
  const atId = at.dados.id;
  const r1 = await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { atendimento_id: atId } }); // pet vem do atendimento
  assert.equal(r1.status, 201);
  assert.equal(r1.dados.receita.pet_id, pet.id);
  assert.equal(r1.dados.receita.atendimento_id, atId);
  const r2 = await chamar(a.env, 'POST', '/api/receitas', { cookie: a.felipe, corpo: { atendimento_id: atId, pet_id: pet.id } });
  assert.equal(r2.status, 200);
  assert.equal(r2.dados.existente, true);
  assert.equal(r2.dados.receita.id, r1.dados.receita.id);
  assert.equal((await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { atendimento_id: atId, pet_id: outro.id } })).status, 400);
  assert.equal((await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { atendimento_id: 999 } })).status, 404);
});

// ---------- detalhe: peso, clínica ----------
test('detalhe traz último peso com data, tutor, veterinário e dados da clínica', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const b = a.env.DB.bruto;
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, status, registrado_por, criado_em, atualizado_em) VALUES (?, '2026-01-10T10:00:00.000Z', 10.1, 'finalizado', 1, 'x', 'x')`).run(pet.id);
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, status, registrado_por, criado_em, atualizado_em) VALUES (?, '2026-03-05T10:00:00.000Z', 12.4, 'finalizado', 1, 'x', 'x')`).run(pet.id);
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, status, registrado_por, criado_em, atualizado_em) VALUES (?, '2026-04-05T10:00:00.000Z', NULL, 'finalizado', 1, 'x', 'x')`).run(pet.id);
  const r = await criar(a, a.vet, pet, { texto: 'x' });
  const d = (await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados;
  assert.deepEqual(d.pet.ultimo_peso, { kg: 12.4, data: '2026-03-05T10:00:00.000Z' });
  assert.equal(d.pet.nome, 'Thor');
  assert.equal(d.pet.especie, 'cao');
  assert.equal(d.tutor.nome, 'Maria');
  assert.equal(d.veterinario, null); // ainda não liberada
  assert.equal(d.clinica.clinica_nome, 'Vetclin');
  assert.equal(d.receita_anterior, null);
});

// ---------- ficha do pet ----------
test('ficha do pet inclui receitas (recepção só vê as liberadas)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  await criar(a, a.vet, pet, { texto: 'Rascunho aqui' });
  const lib = await liberada(a, pet, '\n  Prednisolona 5 mg\nOutra linha');
  const v = (await chamar(a.env, 'GET', `/api/pets/${pet.id}`, { cookie: a.vet })).dados;
  assert.equal(v.receitas.length, 2);
  assert.deepEqual(v.receitas.map((r) => r.status).sort(), ['liberada', 'rascunho']);
  const li = v.receitas.find((r) => r.id === lib);
  assert.equal(li.status, 'liberada');
  assert.equal(li.versao, 1);
  assert.equal(li.veterinario, 'Dra. Elizabeth');
  assert.equal(li.previa, 'Prednisolona 5 mg');
  assert.ok(li.liberada_em);
  const rec = (await chamar(a.env, 'GET', `/api/pets/${pet.id}`, { cookie: a.recepcao })).dados;
  assert.deepEqual(rec.receitas.map((r) => r.id), [lib]);
  // limite de 20
  for (let i = 0; i < 25; i++) await criar(a, a.vet, pet, { texto: 'n' + i });
  assert.equal((await chamar(a.env, 'GET', `/api/pets/${pet.id}`, { cookie: a.vet })).dados.receitas.length, 20);
});

// ---------- sugestões ----------
test('linhasParaSugestao: ignora curtas, tira asteriscos da chave e não repete', () => {
  const l = linhasParaSugestao('*Amoxicilina 250 mg*\nAmoxicilina 250 mg\nok\n  \n  Dipirona  \nAMOXICILINA 250 MG');
  assert.deepEqual(l.map((x) => x.chave), ['amoxicilina 250 mg', 'dipirona']);
  assert.equal(l[0].linha, '*Amoxicilina 250 mg*'); // guarda o texto original
});

test('sugestões aprendidas das receitas liberadas (sem acento, contagem, asteriscos)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  await liberada(a, pet, '*Amoxicilina 250 mg* — 1 comprimido\nPredisolona Ração Hipoalergênica\nok');
  await liberada(a, pet, 'Amoxicilina 250 mg — 1 comprimido\nDipirona 500 mg');
  await liberada(a, pet, '*Amoxicilina 250 mg — 1 comprimido*\nDipirona 500 mg');
  await criar(a, a.vet, pet, { texto: 'Rascunho nao conta\nLinha de rascunho' }); // rascunho não ensina
  const sug = async (q, cookie = a.vet) => chamar(a.env, 'GET', '/api/sugestoes-receita?q=' + encodeURIComponent(q), { cookie });

  const am = (await sug('amox')).dados.sugestoes;
  assert.equal(am.length, 1); // asteriscos não duplicam a chave
  assert.equal(am[0].vezes, 3);
  assert.match(am[0].texto, /Amoxicilina 250 mg/);
  const hip = (await sug('RAÇÃO hipo')).dados.sugestoes; // busca ignora acento e maiúsculas
  assert.equal(hip.length, 1);
  assert.equal(hip[0].texto, 'Predisolona Ração Hipoalergênica');
  const dip = (await sug('dipi')).dados.sugestoes;
  assert.equal(dip[0].vezes, 2);
  // ordem: mais usadas primeiro
  const mg = (await sug('mg')).dados.sugestoes;
  assert.deepEqual(mg.map((s) => s.vezes), [3, 2]);
  assert.equal((await sug('a')).dados.sugestoes.length, 0); // menos de 2 letras
  assert.equal((await sug('rascunho')).dados.sugestoes.length, 0);
  assert.equal((await sug('%')).dados.sugestoes.length, 0); // % é letra comum
  assert.equal((await sug('amox', a.suporte)).status, 200);
  assert.equal((await sug('amox', a.recepcao)).status, 403);
  // no máximo 8
  const longo = Array.from({ length: 12 }, (_, i) => `Remedio numero ${i}`).join('\n');
  await liberada(a, pet, longo);
  assert.equal((await sug('remedio')).dados.sugestoes.length, 8);
});

// ---------- dados da clínica ----------
test('dados da clínica: qualquer um lê, só admin altera', async () => {
  const a = await ambiente();
  const ler = await chamar(a.env, 'GET', '/api/configuracoes/clinica', { cookie: a.recepcao });
  assert.deepEqual(ler.dados, { clinica_nome: 'Vetclin', clinica_endereco: '', clinica_telefone: '', clinica_cidade: '', pix_chave: '', pix_nome: '', pix_cidade: '', financeiro_whatsapp: '', consulta_hora_corte: '18:00' });
  const corpo = { clinica_nome: 'Clínica Vet Teste', clinica_endereco: 'Rua das Flores, 10', clinica_telefone: '(71) 3333-4444', clinica_cidade: 'Salvador' };
  assert.equal((await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.felipe, corpo })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.recepcao, corpo })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.vet, corpo: { clinica_nome: '  ' } })).status, 400);
  const ok = await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.vet, corpo });
  assert.equal(ok.status, 200);
  assert.deepEqual((await chamar(a.env, 'GET', '/api/configuracoes/clinica', { cookie: a.felipe })).dados, { ...corpo, pix_chave: '', pix_nome: '', pix_cidade: '', financeiro_whatsapp: '', consulta_hora_corte: '18:00' });
  // parcial: só muda o que veio
  await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.vet, corpo: { clinica_cidade: 'Lauro de Freitas' } });
  const l = (await chamar(a.env, 'GET', '/api/configuracoes/clinica', { cookie: a.vet })).dados;
  assert.equal(l.clinica_cidade, 'Lauro de Freitas');
  assert.equal(l.clinica_nome, 'Clínica Vet Teste');
  assert.equal((await acoes(a.env, 'alterar_dados_clinica')).length, 2);
  // aparece na receita
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.vet, pet);
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.clinica.clinica_endereco, 'Rua das Flores, 10');
});

test('lista de veterinários ativos', async () => {
  const a = await ambiente();
  const r = await chamar(a.env, 'GET', '/api/usuarios/veterinarios', { cookie: a.recepcao });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.veterinarios.map((v) => v.nome), ['Dra. Elizabeth', 'Felipe']);
  assert.deepEqual(Object.keys(r.dados.veterinarios[0]).sort(), ['crmv', 'id', 'nome', 'whatsapp']);
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { ativo: false } });
  assert.deepEqual((await chamar(a.env, 'GET', '/api/usuarios/veterinarios', { cookie: a.vet })).dados.veterinarios.map((v) => v.nome), ['Dra. Elizabeth']);
  // a rota PATCH /api/usuarios/:id continua funcionando
  assert.equal((await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { crmv: 'CRMV-BA 555' } })).dados.crmv, 'CRMV-BA 555');
});

// ---------- apagar dados de teste ----------
test('apagar dados de teste remove receitas de teste (inclusive versões encadeadas) e mantém as reais', async () => {
  const a = await ambiente();
  const teste = await novoPet(a.env, a.recepcao, 'Rex', 'TESTE Maria', '71 99999-0001');
  const real = await novoPet(a.env, a.recepcao, 'Bolinha', 'Ana Real', '71 99999-0003');
  const at = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: teste.id, peso_kg: 5, motivo: 'x' } });
  const r1 = await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { atendimento_id: at.dados.id, texto: 'Dipirona' } });
  await chamar(a.env, 'POST', `/api/receitas/${r1.dados.receita.id}/liberar`, { cookie: a.vet });
  const v2 = await chamar(a.env, 'POST', `/api/receitas/${r1.dados.receita.id}/nova-versao`, { cookie: a.vet });
  await chamar(a.env, 'POST', `/api/receitas/${v2.dados.receita.id}/liberar`, { cookie: a.vet });
  await criar(a, a.vet, teste, { texto: 'outra de teste' });
  const idReal = await liberada(a, real);
  const previa = await chamar(a.env, 'GET', '/api/admin/dados-teste', { cookie: a.vet });
  assert.equal(previa.dados.receitas, 3);
  const r = await chamar(a.env, 'POST', '/api/admin/apagar-dados-teste', { cookie: a.vet, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal(r.dados.apagados.receitas, 3);
  assert.deepEqual(a.env.DB.bruto.prepare('SELECT id FROM receitas').all().map((x) => x.id), [idReal]);
  assert.equal(a.env.DB.bruto.prepare('PRAGMA foreign_key_check').all().length, 0);
});

// ---------- login obrigatório ----------
test('todas as rotas de receitas exigem login (401)', async () => {
  const env = novoAmbiente();
  const rotas = [
    ['GET', '/api/receitas?status=para_imprimir'], ['POST', '/api/receitas'], ['GET', '/api/receitas/1'], ['PATCH', '/api/receitas/1'],
    ['POST', '/api/receitas/1/liberar'], ['POST', '/api/receitas/transcrever'], ['POST', '/api/receitas/1/pedir'], ['POST', '/api/receitas/1/nova-versao'],
    ['POST', '/api/receitas/1/cancelar'], ['POST', '/api/receitas/1/impressa'], ['POST', '/api/receitas/1/entregue'],
    ['GET', '/api/sugestoes-receita?q=amox'], ['GET', '/api/configuracoes/clinica'], ['PATCH', '/api/configuracoes/clinica'],
    ['GET', '/api/usuarios/veterinarios'],
  ];
  for (const [m, c] of rotas) {
    const r = await chamar(env, m, c, { corpo: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${c}`);
  }
});

test('mudanças exigem o cabeçalho X-Requested-With (CSRF)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const res = await worker.fetch(new Request(ORIGEM + '/api/receitas', { method: 'POST', headers: { Cookie: a.vet, 'Content-Type': 'application/json' }, body: JSON.stringify({ pet_id: pet.id }) }), a.env);
  assert.equal(res.status, 403);
});

// ---------- migração ----------
test('migração 0004 aplica sobre dados existentes sem perder nada', () => {
  const db = criarBancoLocal({ ate: '0003' });
  const b = db.bruto;
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Ana', 'ana', 'h', 'veterinario', 1, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO tutores (codigo, nome, whatsapp, origem, criado_por, criado_em, atualizado_em) VALUES ('T-000001', 'Carla', '+5571999990000', 'recepcao', 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Mel', 'cao', 'recepcao', 'x', 'x')`).run();
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, registrado_por, criado_em, atualizado_em) VALUES (1, '2026-01-01T10:00:00.000Z', 8.5, 1, 'x', 'x')`).run();
  db.migrarRestante();
  assert.equal(b.prepare('SELECT peso_kg FROM atendimentos').get().peso_kg, 8.5);
  assert.equal(b.prepare('SELECT nome FROM pets').get().nome, 'Mel');
  assert.equal(b.prepare(`SELECT valor FROM configuracoes WHERE chave = 'clinica_nome'`).get().valor, 'Vetclin');
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM receitas').get().n, 0);
  b.prepare(`INSERT INTO receitas (pet_id, atendimento_id, criado_por, criado_em, atualizado_em) VALUES (1, 1, 1, 'x', 'x')`).run();
  const r = b.prepare('SELECT * FROM receitas').get();
  assert.equal(r.status, 'rascunho');
  assert.equal(r.versao, 1);
  assert.equal(r.texto, '');
  assert.equal(r.vezes_impressa, 0);
  assert.throws(() => b.prepare(`INSERT INTO receitas (pet_id, criado_por, status, criado_em, atualizado_em) VALUES (1, 1, 'xis', 'x', 'x')`).run());
  assert.throws(() => b.prepare(`INSERT INTO receitas (pet_id, criado_por, criado_em, atualizado_em) VALUES (999, 1, 'x', 'x')`).run()); // pet precisa existir
  b.prepare(`INSERT INTO sugestoes_receita (texto, texto_busca) VALUES ('A', 'a')`).run();
  assert.throws(() => b.prepare(`INSERT INTO sugestoes_receita (texto, texto_busca) VALUES ('A2', 'a')`).run());
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
});

// ---------- WhatsApp dos usuários ----------
test('usuarios.whatsapp: valida, normaliza e aparece na lista', async () => {
  const a = await ambiente();
  const c = await chamar(a.env, 'POST', '/api/usuarios', { cookie: a.vet, corpo: { nome: 'Novo', login: 'novo', senha: 'senha-forte-123', papel: 'veterinario', whatsapp: '(71) 98888-7777' } });
  assert.equal(c.status, 201);
  assert.equal(c.dados.whatsapp, '+5571988887777');
  assert.equal((await chamar(a.env, 'POST', '/api/usuarios', { cookie: a.vet, corpo: { nome: 'X', login: 'xis', senha: 'senha-forte-123', papel: 'veterinario', whatsapp: '123' } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { whatsapp: 'abc' } })).status, 400);
  const p = await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { whatsapp: '71 99999-1111' } });
  assert.equal(p.dados.whatsapp, '+5571999991111');
  const vets = (await chamar(a.env, 'GET', '/api/usuarios/veterinarios', { cookie: a.recepcao })).dados.veterinarios;
  assert.equal(vets.find((v) => v.nome === 'Felipe').whatsapp, '+5571999991111');
  assert.equal(vets.find((v) => v.nome === 'Dra. Elizabeth').whatsapp, null);
  // limpar
  assert.equal((await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { whatsapp: '' } })).dados.whatsapp, null);
  // editar outro campo não apaga o whatsapp
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { whatsapp: '71 99999-1111' } });
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { nome: 'Felipe S.' } });
  assert.equal(a.env.DB.bruto.prepare('SELECT whatsapp FROM usuarios WHERE id = ?').get(a.ids.felipe).whatsapp, '+5571999991111');
});

// ---------- avisos (notificações) ----------
test('avisos: pedir, liberar (recepção + quem pediu) e transcrever', async () => {
  const a = await ambiente();
  const enviados = [];
  a.env.NOTIFICAR_TESTE = async (_env, aviso) => { enviados.push(aviso); return { enviados: 0, falhas: 0 }; };
  const pet = await novoPet(a.env, a.recepcao);
  const r = await criar(a, a.felipe, pet, { texto: 'Dipirona 500 mg' });
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie: a.felipe, corpo: { para_usuario_id: a.vetId, nota: 'urgente' } });
  assert.deepEqual(enviados.pop(), { para: { usuarioId: a.vetId }, titulo: 'Felipe pediu uma receita', corpo: 'Thor · urgente', url: '#/receita/' + r.id, tag: 'pedido-receita-' + r.id });
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet });
  assert.equal(enviados.length, 2);
  assert.deepEqual(enviados[0], { para: { papel: 'recepcao' }, titulo: 'Receita pronta para imprimir', corpo: 'Thor · Dra. Elizabeth', url: '#/receitas/imprimir', tag: 'receita-' + r.id });
  assert.deepEqual(enviados[1], { para: { usuarioId: a.ids.felipe }, titulo: 'Receita pronta', corpo: 'Thor · escrita por Dra. Elizabeth', url: '#/receita/' + r.id, tag: 'receita-' + r.id });
  // sem pedido: só a recepção é avisada
  enviados.length = 0;
  await liberada(a, pet);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para.papel, 'recepcao');
  // quem libera a própria receita pedida não se avisa
  enviados.length = 0;
  const r2 = await criar(a, a.vet, pet, { texto: 'x y z w' });
  await chamar(a.env, 'POST', `/api/receitas/${r2.id}/pedir`, { cookie: a.vet, corpo: { para_usuario_id: a.ids.felipe } });
  enviados.length = 0;
  await chamar(a.env, 'POST', `/api/receitas/${r2.id}/liberar`, { cookie: a.felipe });
  assert.deepEqual(enviados.map((e) => e.titulo), ['Receita pronta para imprimir', 'Receita pronta']);
  // transcrever avisa o veterinário escolhido
  enviados.length = 0;
  const t = await chamar(a.env, 'POST', '/api/receitas/transcrever', { cookie: a.recepcao, corpo: { pet_id: pet.id, veterinario_id: a.ids.felipe, texto: 'Meloxicam 1 mg' } });
  assert.deepEqual(enviados, [{ para: { usuarioId: a.ids.felipe }, titulo: 'Receita transcrita pela recepção', corpo: 'Thor · confira se está certa', url: '#/receita/' + t.dados.receita.id, tag: 'receita-' + t.dados.receita.id }]);
  // falha no envio não atrapalha
  a.env.NOTIFICAR_TESTE = async () => { throw new Error('boom'); };
  const r3 = await criar(a, a.vet, pet, { texto: 'abc def' });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r3.id}/liberar`, { cookie: a.vet })).status, 200);
});

// ---------- transcrever (colar do WhatsApp) ----------
test('transcrever: recepção cria receita liberada em nome do veterinário escolhido', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const at = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 12.4, motivo: 'Vômito' } });
  const corpo = { pet_id: pet.id, atendimento_id: at.dados.id, veterinario_id: a.ids.felipe, texto: '*Amoxicilina 250 mg* — 1 comprimido\r\nDipirona 500 mg', orientacoes: 'Repouso' };
  const t = await chamar(a.env, 'POST', '/api/receitas/transcrever', { cookie: a.recepcao, corpo });
  assert.equal(t.status, 201, JSON.stringify(t.dados));
  const l = linhaReceita(a.env, t.dados.receita.id);
  assert.equal(l.status, 'liberada');
  assert.equal(l.origem, 'transcrita');
  assert.equal(l.veterinario_id, a.ids.felipe);
  assert.equal(l.criado_por, (await chamar(a.env, 'GET', '/api/eu', { cookie: a.recepcao })).dados.id);
  assert.ok(l.liberada_em);
  assert.equal(l.atendimento_id, at.dados.id);
  assert.equal(l.texto, '*Amoxicilina 250 mg* — 1 comprimido\nDipirona 500 mg');
  assert.equal(t.dados.veterinario.nome, 'Felipe');
  assert.equal(t.dados.receita.criado_por_nome, 'Recep');
  assert.equal((await acoes(a.env, 'transcrever_receita')).length, 1);
  assert.ok(!JSON.stringify(await acoes(a.env, 'transcrever_receita')).includes('Amoxicilina'));
  // aparece em Para imprimir e na ficha, com "transcrita por"
  const lista = (await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao })).dados.receitas;
  assert.equal(lista[0].transcrita_por, 'Recep');
  const ficha = (await chamar(a.env, 'GET', `/api/pets/${pet.id}`, { cookie: a.recepcao })).dados.receitas;
  assert.equal(ficha[0].transcrita_por, 'Recep');
  // sugestões aprendidas (asteriscos não duplicam)
  const sug = (await chamar(a.env, 'GET', '/api/sugestoes-receita?q=amoxi', { cookie: a.vet })).dados.sugestoes;
  assert.equal(sug.length, 1);
  assert.equal(sug[0].vezes, 1);
  // vet/suporte também podem; correção por nova versão (vet/suporte), recepção pode transcrever de novo
  assert.equal((await chamar(a.env, 'POST', '/api/receitas/transcrever', { cookie: a.suporte, corpo: { ...corpo, atendimento_id: undefined } })).status, 201);
  const nv = await chamar(a.env, 'POST', `/api/receitas/${l.id}/nova-versao`, { cookie: a.suporte });
  assert.equal(nv.status, 201);
  assert.equal(nv.dados.receita.origem, 'veterinario');
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${l.id}/nova-versao`, { cookie: a.recepcao })).status, 403);
});

test('transcrever: valida veterinário, texto, pet e atendimento', async () => {
  const a = await ambiente();
  const pet = await novoPet(a.env, a.recepcao);
  const outro = await novoPet(a.env, a.recepcao, 'Mel', 'Ana', '(71) 99999-0001');
  const at = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: outro.id, peso_kg: 3, motivo: 'x' } });
  const base = { pet_id: pet.id, veterinario_id: a.ids.felipe, texto: 'Dipirona' };
  const t = (corpo, cookie = a.recepcao) => chamar(a.env, 'POST', '/api/receitas/transcrever', { cookie, corpo });
  assert.equal((await t({ ...base, veterinario_id: a.ids.recep })).status, 400);
  assert.equal((await t({ ...base, veterinario_id: a.ids.sup })).status, 400);
  assert.equal((await t({ ...base, veterinario_id: undefined })).status, 400);
  assert.equal((await t({ ...base, veterinario_id: 9999 })).status, 400);
  assert.equal((await t({ ...base, texto: '  ' })).status, 400);
  assert.equal((await t({ ...base, texto: 'x'.repeat(10001) })).status, 400);
  assert.equal((await t({ ...base, pet_id: 999 })).status, 404);
  assert.equal((await t({ ...base, pet_id: undefined })).status, 400);
  assert.equal((await t({ ...base, atendimento_id: at.dados.id })).status, 400); // atendimento de outro pet
  await chamar(a.env, 'PATCH', `/api/usuarios/${a.ids.felipe}`, { cookie: a.vet, corpo: { ativo: false } });
  assert.equal((await t(base, a.vet)).status, 400); // veterinário desativado
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM receitas').get().n, 0);
});
