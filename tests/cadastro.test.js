// Testes do passo 2: cadastro de tutores e pets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { normalizarBusca, normalizarWhatsapp, finalTelefone } from '../src/cadastro.js';
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

async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  // Recepção (não admin) e suporte.
  const rec = await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: 'Recep', login: 'recep', senha: 'senha-forte-123', papel: 'recepcao' } });
  assert.equal(rec.status, 201);
  const sup = await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: 'Sup', login: 'sup', senha: 'senha-forte-123', papel: 'suporte' } });
  assert.equal(sup.status, 201);
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, admin, recepcao: await ent('recep'), suporte: await ent('sup') };
}

const FONE = '(71) 99999-8888';
const acoes = (env, acao) => env.DB.bruto.prepare('SELECT * FROM registro_acoes WHERE acao = ?').all(acao);

// ---------- funções puras ----------
test('normalizarBusca tira acentos, põe minúsculas e junta espaços', () => {
  assert.equal(normalizarBusca('  JOÃO   da  Conceição '), 'joao da conceicao');
  assert.equal(normalizarBusca('Melé'), 'mele');
  assert.equal(normalizarBusca(null), '');
});

test('normalizarWhatsapp: celular, fixo, com e sem 55', () => {
  assert.deepEqual(normalizarWhatsapp('(71) 99999-8888'), { e164: '+5571999998888', digitos: '5571999998888' });
  assert.equal(normalizarWhatsapp('+55 71 99999-8888').e164, '+5571999998888');
  assert.equal(normalizarWhatsapp('5571999998888').e164, '+5571999998888');
  assert.equal(normalizarWhatsapp('71 3333-4444').e164, '+557133334444');
  assert.equal(normalizarWhatsapp('55 55 99999-8888').e164, '+5555999998888'); // DDD 55
});

test('normalizarWhatsapp: recusa inválidos', () => {
  for (const ruim of ['', 'abc', '99999-8888', '(01) 99999-8888', '(70) 99999-8888', '(71) 89999-8888', '(71) 1333-4444', '(71) 99999-88888', '71 9999 888', '+1 415 555 2671']) {
    assert.throws(() => normalizarWhatsapp(ruim), (e) => e.status === 400 && /Telefone inválido/.test(e.message), ruim);
  }
});

test('finalTelefone devolve os 4 últimos dígitos', () => {
  assert.equal(finalTelefone('+5571999998888'), '8888');
  assert.equal(finalTelefone(null), '');
});

// ---------- migração 0002 ----------
test('migração 0002 mantém usuários e chaves estrangeiras', async () => {
  const db = criarBancoLocal({ ate: '0001' });
  const b = db.bruto;
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Ana', 'ana', 'hash-x', 'veterinario', 1, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Bia', 'bia', 'hash-y', 'recepcao', 0, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ultimo_uso_em) VALUES ('s1', 1, 'x', 'x', 'x')`).run();
  b.prepare(`INSERT INTO registro_acoes (usuario_id, acao, entidade, em) VALUES (2, 'teste', 'usuarios', 'x')`).run();
  b.prepare(`INSERT INTO tutores (codigo, nome, whatsapp, origem, criado_por, criado_em, atualizado_em) VALUES ('T-000001', 'Carla Antiga', '+5571999990000', 'recepcao', 2, 'x', 'x')`).run();
  db.migrarRestante();

  const us = b.prepare('SELECT id, login, senha_hash, papel, admin FROM usuarios ORDER BY id').all();
  assert.deepEqual(us.map((u) => [u.id, u.login, u.senha_hash, u.papel, u.admin]), [[1, 'ana', 'hash-x', 'veterinario', 1], [2, 'bia', 'hash-y', 'recepcao', 0]]);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM sessoes').get().n, 1);
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
  // Chaves continuam valendo: usuário inexistente é recusado, existente é aceito.
  assert.throws(() => b.prepare(`INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ultimo_uso_em) VALUES ('s2', 99, 'x', 'x', 'x')`).run(), /FOREIGN KEY/);
  b.prepare(`INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ultimo_uso_em) VALUES ('s3', 2, 'x', 'x', 'x')`).run();
  // O papel novo funciona e o antigo inválido continua recusado.
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, criado_em, atualizado_em) VALUES ('Sô', 'so', 'h', 'suporte', 'x', 'x')`).run();
  assert.throws(() => b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, criado_em, atualizado_em) VALUES ('Z', 'z', 'h', 'outro', 'x', 'x')`).run(), /CHECK/);
  // Login continua único e AUTOINCREMENT segue de onde parou.
  assert.throws(() => b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, criado_em, atualizado_em) VALUES ('Ana2', 'ana', 'h', 'recepcao', 'x', 'x')`).run(), /UNIQUE/);
  // Linhas antigas de tutores ganham as colunas de busca.
  const t = b.prepare('SELECT nome_busca, whatsapp_digitos FROM tutores').get();
  assert.deepEqual({ ...t }, { nome_busca: 'carla antiga', whatsapp_digitos: '5571999990000' });
});

// ---------- usuários: suporte ----------
test('papel suporte: criar e editar usuário', async () => {
  const { env, admin } = await ambiente();
  const lista = (await chamar(env, 'GET', '/api/usuarios', { cookie: admin })).dados.usuarios;
  const sup = lista.find((u) => u.login === 'sup');
  assert.equal(sup.papel, 'suporte');
  const r = await chamar(env, 'PATCH', `/api/usuarios/${sup.id}`, { cookie: admin, corpo: { papel: 'recepcao' } });
  assert.equal(r.dados.papel, 'recepcao');
  const volta = await chamar(env, 'PATCH', `/api/usuarios/${sup.id}`, { cookie: admin, corpo: { papel: 'suporte' } });
  assert.equal(volta.dados.papel, 'suporte');
  const ruim = await chamar(env, 'PATCH', `/api/usuarios/${sup.id}`, { cookie: admin, corpo: { papel: 'chefe' } });
  assert.equal(ruim.status, 400);
});

test('último administrador continua protegido (usuário suporte admin)', async () => {
  const { env, admin } = await ambiente();
  const r = await chamar(env, 'PATCH', '/api/usuarios/1', { cookie: admin, corpo: { ativo: false } });
  assert.equal(r.status, 400);
});

// ---------- tutores ----------
test('criar tutor normaliza o WhatsApp, gera código e registra a ação', async () => {
  const { env, recepcao, suporte } = await ambiente();
  const r = await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: ' Maria  Souza ', whatsapp: FONE, observacoes: 'Gosta de café' } });
  assert.equal(r.status, 201);
  assert.equal(r.dados.nome, 'Maria  Souza');
  assert.equal(r.dados.whatsapp, '+5571999998888');
  assert.equal(r.dados.codigo, 'T-000001');
  assert.equal(r.dados.origem, 'recepcao');
  const r2 = await chamar(env, 'POST', '/api/tutores', { cookie: suporte, corpo: { nome: 'José', whatsapp: '71 3333-4444' } });
  assert.equal(r2.dados.origem, 'veterinario');
  assert.equal((await acoes(env, 'criar_tutor')).length, 2);
  const linha = env.DB.bruto.prepare('SELECT nome_busca, whatsapp_digitos FROM tutores WHERE id = ?').get(r2.dados.id);
  assert.deepEqual({ ...linha }, { nome_busca: 'jose', whatsapp_digitos: '557133334444' });
  assert.equal((await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: '', whatsapp: FONE } })).status, 400);
  assert.equal((await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'X', whatsapp: '123' } })).status, 400);
});

test('WhatsApp repetido: 409 com duplicados; confirmar cria mesmo assim', async () => {
  const { env, recepcao } = await ambiente();
  const a = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Maria', whatsapp: FONE }, pet: { nome: 'Rex', especie: 'cao' } } });
  assert.equal(a.status, 201);
  const r = await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Filho da Maria', whatsapp: '+55 71 99999 8888' } });
  assert.equal(r.status, 409);
  assert.equal(r.dados.erro, 'Já existe cadastro com este WhatsApp.');
  assert.equal(r.dados.duplicados.length, 1);
  assert.deepEqual(r.dados.duplicados[0], { id: a.dados.tutor.id, codigo: 'T-000001', nome: 'Maria', final_telefone: '8888', pets: [{ id: a.dados.pet.id, nome: 'Rex', especie: 'cao' }] });
  const ok = await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Filho da Maria', whatsapp: FONE, confirmar_duplicado: true } });
  assert.equal(ok.status, 201);
});

test('ver e alterar tutor (com checagem de WhatsApp repetido)', async () => {
  const { env, recepcao } = await ambiente();
  const a = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Ana', whatsapp: FONE } })).dados;
  const b = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Bruno', whatsapp: '71 98888-7777' } })).dados;
  const ver = await chamar(env, 'GET', `/api/tutores/${a.id}`, { cookie: recepcao });
  assert.equal(ver.dados.tutor.whatsapp, '+5571999998888');
  assert.deepEqual(ver.dados.pets, []);
  const dup = await chamar(env, 'PATCH', `/api/tutores/${b.id}`, { cookie: recepcao, corpo: { whatsapp: FONE } });
  assert.equal(dup.status, 409);
  const ok = await chamar(env, 'PATCH', `/api/tutores/${b.id}`, { cookie: recepcao, corpo: { nome: 'Brúno Lima', observacoes: 'oi' } });
  assert.equal(ok.dados.nome, 'Brúno Lima');
  assert.equal(env.DB.bruto.prepare('SELECT nome_busca FROM tutores WHERE id = ?').get(b.id).nome_busca, 'bruno lima');
  const acao = (await acoes(env, 'alterar_tutor'))[0];
  assert.equal(JSON.parse(acao.antes).nome, 'Bruno');
  assert.equal(JSON.parse(acao.depois).nome, 'Brúno Lima');
  assert.equal((await chamar(env, 'GET', '/api/tutores/999', { cookie: recepcao })).status, 404);
});

// ---------- pets ----------
test('criar pet: validações, duplicado no mesmo tutor, mesmo nome em outro tutor', async () => {
  const { env, recepcao } = await ambiente();
  const t1 = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Ana', whatsapp: FONE } })).dados;
  const t2 = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Bruno', whatsapp: '71 98888-7777' } })).dados;
  const criar = (corpo) => chamar(env, 'POST', '/api/pets', { cookie: recepcao, corpo });
  const p = await criar({ tutor_id: t1.id, nome: 'Thor', especie: 'cao', raca: 'SRD', sexo: 'macho', idade_anos: 3, idade_meses: 2 });
  assert.equal(p.status, 201);
  assert.equal(p.dados.codigo, 'P-000001');
  assert.equal(p.dados.raca_confirmada, false);
  assert.equal(p.dados.ativo, true);
  assert.equal((await criar({ tutor_id: t1.id, nome: 'THOR', especie: 'gato' })).status, 409);
  const forcado = await criar({ tutor_id: t1.id, nome: 'THOR', especie: 'gato', confirmar_duplicado: true });
  assert.equal(forcado.status, 201);
  assert.equal((await criar({ tutor_id: t2.id, nome: 'Thor', especie: 'cao' })).status, 201);
  // validações
  assert.equal((await criar({ tutor_id: t1.id, nome: 'X' })).status, 400); // sem espécie
  assert.equal((await criar({ tutor_id: t1.id, nome: 'X', especie: 'dragao' })).status, 400);
  assert.equal((await criar({ tutor_id: t1.id, nome: 'X', especie: 'cao', idade_anos: 41 })).status, 400);
  assert.equal((await criar({ tutor_id: t1.id, nome: 'X', especie: 'cao', idade_meses: 12 })).status, 400);
  assert.equal((await criar({ tutor_id: t1.id, nome: 'X', especie: 'cao', sexo: 'x' })).status, 400);
  assert.equal((await criar({ tutor_id: 999, nome: 'X', especie: 'cao' })).status, 404);
  assert.equal((await acoes(env, 'criar_pet')).length, 3);
});

test('ver e alterar pet: arquivar, confirmar raça, transferir de tutor', async () => {
  const { env, recepcao } = await ambiente();
  const t1 = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Ana', whatsapp: FONE } })).dados;
  const t2 = (await chamar(env, 'POST', '/api/tutores', { cookie: recepcao, corpo: { nome: 'Bruno', whatsapp: '71 98888-7777' } })).dados;
  const p = (await chamar(env, 'POST', '/api/pets', { cookie: recepcao, corpo: { tutor_id: t1.id, nome: 'Mel', especie: 'gato' } })).dados;
  const ver = await chamar(env, 'GET', `/api/pets/${p.id}`, { cookie: recepcao });
  assert.equal(ver.dados.tutor.whatsapp, '+5571999998888');
  assert.deepEqual(ver.dados.atendimentos, []);
  const r = await chamar(env, 'PATCH', `/api/pets/${p.id}`, { cookie: recepcao, corpo: { raca: 'Siamês', raca_confirmada: true, tutor_id: t2.id } });
  assert.equal(r.status, 200);
  assert.equal(r.dados.tutor_id, t2.id);
  assert.equal(r.dados.raca_confirmada, true);
  const arq = await chamar(env, 'PATCH', `/api/pets/${p.id}`, { cookie: recepcao, corpo: { ativo: false } });
  assert.equal(arq.dados.ativo, false);
  assert.equal((await acoes(env, 'arquivar_pet')).length, 1);
  assert.equal((await acoes(env, 'alterar_pet')).length, 1);
  // arquivado não aparece na busca
  const b = await chamar(env, 'GET', '/api/busca?q=mel', { cookie: recepcao });
  assert.ok(!b.dados.resultados.some((x) => x.tipo === 'pet'));
  assert.equal((await chamar(env, 'PATCH', `/api/pets/${p.id}`, { cookie: recepcao, corpo: { tutor_id: 999 } })).status, 404);
  assert.equal((await chamar(env, 'PATCH', `/api/pets/${p.id}`, { cookie: recepcao, corpo: { idade_anos: 99 } })).status, 400);
});

test('atendimentos aparecem na ficha do pet', async () => {
  const { env, recepcao } = await ambiente();
  const r = (await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Ana', whatsapp: FONE }, pet: { nome: 'Mel' } } })).dados;
  assert.equal(r.pet.especie, 'outro');
  env.DB.bruto.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, registrado_por, criado_em, atualizado_em) VALUES (?, '2026-01-01T10:00:00.000Z', 1, 'x', 'x')`).run(r.pet.id);
  const ver = await chamar(env, 'GET', `/api/pets/${r.pet.id}`, { cookie: recepcao });
  assert.equal(ver.dados.atendimentos.length, 1);
});

// ---------- cadastro rápido ----------
test('cadastro rápido: tutor novo + pet; 409 com telefone existente; tutor_existente_id', async () => {
  const { env, recepcao } = await ambiente();
  const r = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Maria', whatsapp: FONE }, pet: { nome: 'Rex', especie: 'cao' } } });
  assert.equal(r.status, 201);
  assert.equal(r.dados.tutor.codigo, 'T-000001');
  assert.equal(r.dados.pet.codigo, 'P-000001');
  assert.equal(r.dados.pet.tutor_id, r.dados.tutor.id);

  const dup = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Maria', whatsapp: FONE }, pet: { nome: 'Luna', especie: 'gato' } } });
  assert.equal(dup.status, 409);
  assert.equal(dup.dados.duplicados[0].pets[0].nome, 'Rex');
  // nada foi criado no 409
  assert.equal(env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM pets').get().n, 1);

  const so = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor_existente_id: r.dados.tutor.id, tutor: { nome: 'ignorado', whatsapp: 'lixo' }, pet: { nome: 'Luna', especie: 'gato' } } });
  assert.equal(so.status, 201);
  assert.equal(so.dados.pet.tutor_id, r.dados.tutor.id);
  assert.equal(env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM tutores').get().n, 1);
  // pet repetido para o mesmo tutor
  const igual = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor_existente_id: r.dados.tutor.id, pet: { nome: 'luna', especie: 'gato' } } });
  assert.equal(igual.status, 409);
  assert.equal(igual.dados.tipo, 'pet');
  // confirmar duplicado de tutor cria outro tutor
  const novo = await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { confirmar_duplicado: true, tutor: { nome: 'Pedro', whatsapp: FONE }, pet: { nome: 'Bob', especie: 'cao' } } });
  assert.equal(novo.status, 201);
  assert.equal((await acoes(env, 'criar_tutor')).length, 2);
  assert.equal((await acoes(env, 'criar_pet')).length, 3);
  // tutor inexistente
  assert.equal((await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor_existente_id: 999, pet: { nome: 'A' } } })).status, 404);
  // pet inválido não deixa tutor órfão
  assert.equal((await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: 'Z', whatsapp: '71 98888-1111' }, pet: { nome: '' } } })).status, 400);
  assert.equal(env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM tutores').get().n, 2);
});

// ---------- busca ----------
async function cenarioBusca() {
  const a = await ambiente();
  const rap = (tutor, whatsapp, pet, especie = 'cao') => chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: tutor, whatsapp }, pet: { nome: pet, especie } } });
  a.joao = (await rap('Maria da Silva', '71 99999-1234', 'João')).dados;
  a.thor = (await rap('Carlos Pereira', '71 98888-5678', 'Thor')).dados;
  return a;
}
const buscar = (a, q) => chamar(a.env, 'GET', '/api/busca?q=' + encodeURIComponent(q), { cookie: a.recepcao });

test('busca por nome do pet, com e sem acento', async () => {
  const a = await cenarioBusca();
  for (const q of ['Joao', 'JOÃO', 'jo']) {
    const r = await buscar(a, q);
    assert.equal(r.status, 200);
    assert.equal(r.dados.resultados.length, 1, q);
    const x = r.dados.resultados[0];
    assert.equal(x.tipo, 'pet');
    assert.equal(x.pet.nome, 'João');
    assert.equal(x.pet.especie, 'cao');
    assert.equal(x.tutor.nome, 'Maria da Silva');
    assert.equal(x.tutor.final_telefone, '1234');
  }
});

test('busca por tutor, final do telefone e código; nunca mostra o telefone inteiro', async () => {
  const a = await cenarioBusca();
  assert.equal((await buscar(a, 'pereira')).dados.resultados[0].pet.nome, 'Thor');
  assert.equal((await buscar(a, '5678')).dados.resultados[0].tutor.nome, 'Carlos Pereira');
  assert.equal((await buscar(a, '(71) 99999-1234')).dados.resultados[0].pet.nome, 'João');
  assert.equal((await buscar(a, 't-000002')).dados.resultados[0].tutor.nome, 'Carlos Pereira');
  assert.equal((await buscar(a, 'P-000001')).dados.resultados[0].pet.nome, 'João');
  assert.equal((await buscar(a, '123')).dados.resultados.length, 0); // menos de 4 dígitos não busca telefone
  const todos = JSON.stringify((await buscar(a, 'a')).status === 400 ? {} : (await buscar(a, 'ar')).dados);
  assert.ok(!todos.includes('99999') && !todos.includes('+55'));
  assert.equal((await buscar(a, 'x')).status, 400);
  assert.equal((await buscar(a, '%%')).dados.resultados.length, 0); // curinga não casa tudo
});

test('busca mostra tutor sem pets como tipo tutor e esconde tutores unidos', async () => {
  const a = await cenarioBusca();
  const sem = (await chamar(a.env, 'POST', '/api/tutores', { cookie: a.recepcao, corpo: { nome: 'Sem Pet', whatsapp: '71 97777-0000' } })).dados;
  const r = (await buscar(a, 'sem pet')).dados.resultados;
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'tutor');
  assert.equal(r[0].pet, null);
  // une o "Sem Pet" ao Carlos: some da busca
  const m = await chamar(a.env, 'POST', `/api/tutores/${a.thor.tutor.id}/mesclar`, { cookie: a.recepcao, corpo: { duplicado_id: sem.id } });
  assert.equal(m.status, 200);
  assert.equal((await buscar(a, 'sem pet')).dados.resultados.length, 0);
  assert.equal((await buscar(a, '0000')).dados.resultados.length, 0);
});

// ---------- mesclar ----------
test('mesclar move os pets e esconde o cadastro duplicado', async () => {
  const a = await cenarioBusca();
  const { env, recepcao } = a;
  const principal = a.thor.tutor.id;
  const dup = a.joao.tutor.id;
  const r = await chamar(env, 'POST', `/api/tutores/${principal}/mesclar`, { cookie: recepcao, corpo: { duplicado_id: dup } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.pets_movidos, [a.joao.pet.id]);
  assert.equal(r.dados.pets.length, 2);
  const joao = (await chamar(env, 'GET', `/api/pets/${a.joao.pet.id}`, { cookie: recepcao })).dados;
  assert.equal(joao.tutor.id, principal);
  assert.equal((await buscar(a, 'maria')).dados.resultados.length, 0);
  assert.equal((await chamar(env, 'GET', `/api/tutores/${dup}`, { cookie: recepcao })).dados.tutor.mesclado_em_id, principal);
  const acao = (await acoes(env, 'mesclar_tutores'))[0];
  const depois = JSON.parse(acao.depois);
  assert.equal(depois.duplicado_id, dup);
  assert.deepEqual(depois.pets_movidos, [a.joao.pet.id]);
  // depois de unido, não pode mais ser usado
  assert.equal((await chamar(env, 'POST', `/api/tutores/${principal}/mesclar`, { cookie: recepcao, corpo: { duplicado_id: dup } })).status, 409);
  assert.equal((await chamar(env, 'POST', `/api/tutores/${dup}/mesclar`, { cookie: recepcao, corpo: { duplicado_id: principal } })).status, 409);
  assert.equal((await chamar(env, 'POST', '/api/pets', { cookie: recepcao, corpo: { tutor_id: dup, nome: 'Novo', especie: 'cao' } })).status, 409);
});

test('mesclar: não une com ele mesmo nem com cadastro inexistente', async () => {
  const a = await cenarioBusca();
  const id = a.thor.tutor.id;
  assert.equal((await chamar(a.env, 'POST', `/api/tutores/${id}/mesclar`, { cookie: a.recepcao, corpo: { duplicado_id: id } })).status, 400);
  assert.equal((await chamar(a.env, 'POST', `/api/tutores/${id}/mesclar`, { cookie: a.recepcao, corpo: { duplicado_id: 999 } })).status, 404);
  assert.equal((await chamar(a.env, 'POST', `/api/tutores/${id}/mesclar`, { cookie: a.recepcao, corpo: {} })).status, 400);
});

// ---------- dados de teste ----------
test('apagar dados de teste: permissões e confirmação', async () => {
  const { env, admin, recepcao } = await ambiente();
  assert.equal((await chamar(env, 'GET', '/api/admin/dados-teste', { cookie: recepcao })).status, 403);
  assert.equal((await chamar(env, 'POST', '/api/admin/apagar-dados-teste', { cookie: recepcao, corpo: { confirmacao: 'APAGAR' } })).status, 403);
  assert.equal((await chamar(env, 'POST', '/api/admin/apagar-dados-teste', { cookie: admin, corpo: {} })).status, 400);
  assert.equal((await chamar(env, 'POST', '/api/admin/apagar-dados-teste', { cookie: admin, corpo: { confirmacao: 'apagar' } })).status, 400);
});

test('apagar dados de teste: só TESTE como palavra, com atendimentos e pedidos', async () => {
  const { env, admin, recepcao } = await ambiente();
  const rap = async (tutor, fone, pet) => (await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: recepcao, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome: pet, especie: 'cao' } } })).dados;
  const teste = await rap('TESTE Maria', '71 99999-0001', 'Rex');
  const testolin = await rap('Testolin', '71 99999-0002', 'Fido');
  const real = await rap('Ana Real', '71 99999-0003', 'Teste Bolinha'); // pet de teste sob tutor real
  const real2 = await rap('Pedro Real', '71 99999-0004', 'Testemunha');
  // outro pet do tutor de teste, com nome comum: também deve sumir
  await chamar(env, 'POST', '/api/pets', { cookie: recepcao, corpo: { tutor_id: teste.tutor.id, nome: 'Luna', especie: 'gato' } });
  // atendimentos / pedidos / itens / pagamentos
  const b = env.DB.bruto;
  const atend = (pet) => Number(b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, registrado_por, criado_em, atualizado_em) VALUES (?, 'x', 1, 'x', 'x')`).run(pet).lastInsertRowid);
  const pedido = (at) => Number(b.prepare(`INSERT INTO pedidos (atendimento_id, criado_por, criado_em, atualizado_em) VALUES (?, 1, 'x', 'x')`).run(at).lastInsertRowid);
  for (const pet of [teste.pet.id, real.pet.id, testolin.pet.id]) {
    const p = pedido(atend(pet));
    b.prepare(`INSERT INTO itens_pedido (pedido_id, descricao, preco_unitario_centavos) VALUES (?, 'Consulta', 10000)`).run(p);
    b.prepare(`INSERT INTO pagamentos (pedido_id, forma, valor_centavos, recebido_por, recebido_em) VALUES (?, 'pix', 10000, 1, 'x')`).run(p);
  }
  const previa = await chamar(env, 'GET', '/api/admin/dados-teste', { cookie: admin });
  assert.deepEqual(previa.dados, { tutores: 1, pets: 3, atendimentos: 2, pedidos: 2, receitas: 0, fotos: 0 });

  const r = await chamar(env, 'POST', '/api/admin/apagar-dados-teste', { cookie: admin, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.apagados, { tutores: 1, pets: 3, atendimentos: 2, pedidos: 2, receitas: 0, fotos: 0 });
  const nomes = (t) => b.prepare(`SELECT nome FROM ${t} ORDER BY nome`).all().map((x) => x.nome);
  assert.deepEqual(nomes('tutores'), ['Ana Real', 'Pedro Real', 'Testolin']);
  assert.deepEqual(nomes('pets'), ['Fido', 'Testemunha']);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM atendimentos').get().n, 1);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM pedidos').get().n, 1);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM itens_pedido').get().n, 1);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM pagamentos').get().n, 1);
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
  const log = await acoes(env, 'apagar_dados_teste');
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0].depois), { tutores: 1, pets: 3, atendimentos: 2, pedidos: 2, receitas: 0, fotos: 0 });
  void real2;
});

// ---------- login obrigatório ----------
test('todas as rotas do cadastro exigem login', async () => {
  const env = novoAmbiente();
  const rotas = [
    ['GET', '/api/busca?q=rex'], ['POST', '/api/tutores'], ['GET', '/api/tutores/1'], ['PATCH', '/api/tutores/1'],
    ['POST', '/api/tutores/1/mesclar'], ['POST', '/api/pets'], ['GET', '/api/pets/1'], ['PATCH', '/api/pets/1'],
    ['POST', '/api/cadastro-rapido'], ['GET', '/api/admin/dados-teste'], ['POST', '/api/admin/apagar-dados-teste'],
  ];
  for (const [m, c] of rotas) {
    const r = await chamar(env, m, c, { corpo: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${c}`);
  }
});

// ---------- telefone do tutor é opcional ----------
test('tutor sem telefone: cadastro, cadastro rápido com chegada, edição e busca funcionam', async () => {
  const a = await ambiente();
  // tutor sem telefone
  const t = await chamar(a.env, 'POST', '/api/tutores', { cookie: a.recepcao, corpo: { nome: 'Sem Fone' } });
  assert.equal(t.status, 201);
  assert.equal(t.dados.whatsapp ?? null, null);
  // dois tutores sem telefone não são "duplicados"
  assert.equal((await chamar(a.env, 'POST', '/api/tutores', { cookie: a.recepcao, corpo: { nome: 'Outro Sem Fone', whatsapp: '' } })).status, 201);
  // telefone preenchido continua precisando ser válido
  assert.equal((await chamar(a.env, 'POST', '/api/tutores', { cookie: a.recepcao, corpo: { nome: 'Fone Ruim', whatsapp: '123' } })).status, 400);
  // cadastro rápido com chegada sem telefone
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: {
    tutor: { nome: 'Joana' }, pet: { nome: 'Luna', especie: 'gato' },
    chegada: { peso_kg: 4.2, motivo: 'Vacina', urgente: false } } });
  assert.equal(r.status, 201);
  assert.ok(r.dados.atendimento);
  // busca mostra sem "final"
  const b = await chamar(a.env, 'GET', '/api/busca?q=luna', { cookie: a.recepcao });
  assert.equal(b.dados.resultados?.[0]?.tutor?.final_telefone ?? b.dados[0]?.tutor?.final_telefone ?? '', '');
  // editar: colocar e depois apagar o telefone
  const id = t.dados.id;
  assert.equal((await chamar(a.env, 'PATCH', `/api/tutores/${id}`, { cookie: a.recepcao, corpo: { whatsapp: FONE } })).dados.whatsapp, '+5571999998888');
  const limpo = await chamar(a.env, 'PATCH', `/api/tutores/${id}`, { cookie: a.recepcao, corpo: { whatsapp: '' } });
  assert.equal(limpo.status, 200);
  assert.equal(limpo.dados.whatsapp ?? null, null);
});
