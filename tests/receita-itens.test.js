// Testes do passo 5: produtos e valores da receita (só para a equipe).
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

async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123', crmv: 'CRMV-BA 1234' } });
  const admin = cookieDe(r.res);
  await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: 'Recep', login: 'recep', senha: 'senha-forte-123', papel: 'recepcao' } });
  await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: 'Sup', login: 'sup', senha: 'senha-forte-123', papel: 'suporte' } });
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, vet: admin, recepcao: await ent('recep'), suporte: await ent('sup') };
}
async function novoPet(a, nome = 'Thor', tutor = 'Maria', fone = '(71) 99999-8888') {
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome, especie: 'cao' } } });
  return r.dados.pet;
}
async function atendimento(a, pet) {
  const r = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 5, motivo: 'x' } });
  assert.equal(r.status, 201);
  return r.dados.id;
}
async function rascunho(a, pet, extra = {}) {
  const r = await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { pet_id: pet.id, texto: 'Dipirona\nCefalexina', ...extra } });
  assert.equal(r.status, 201);
  return r.dados.receita.id;
}
const liberar = async (a, id) => assert.equal((await chamar(a.env, 'POST', `/api/receitas/${id}/liberar`, { cookie: a.vet })).status, 200);
const itens = (a, id, lista, cookie = a.vet) => chamar(a.env, 'PUT', `/api/receitas/${id}/itens`, { cookie, corpo: { itens: lista } });
const item = (descricao, temos, quantidade, valor) => ({ descricao, temos, quantidade, valor_unitario_centavos: valor });
const hoje = async (a) => { const r = await chamar(a.env, 'GET', '/api/hoje', { cookie: a.vet }); return [...r.dados.aguardando, ...r.dados.em_atendimento, ...r.dados.finalizados]; };

test('receita nova não tem produtos: total 0 e nada sem valor', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  const { dados } = await chamar(a.env, 'GET', `/api/receitas/${id}`, { cookie: a.vet });
  assert.deepEqual([dados.receita.itens, dados.receita.total_produtos_centavos, dados.receita.itens_sem_valor], [[], 0, 0]);
});

test('PUT itens: veterinário, suporte e recepção podem; sem login é 401; recepção não mexe em rascunho', async () => {
  const a = await ambiente();
  const pet = await novoPet(a);
  const id = await rascunho(a, pet);
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 8500)])).status, 200);
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 8500)], a.suporte)).status, 200);
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 8500)], a.recepcao)).status, 403); // recepção não vê rascunhos
  assert.equal((await chamar(a.env, 'PUT', `/api/receitas/${id}/itens`, { corpo: { itens: [] } })).status, 401);
  await liberar(a, id);
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 9000)], a.recepcao)).status, 200);
  assert.equal((await itens(a, 9999, [])).status, 404);
  // exige o cabeçalho anti-CSRF
  const semCab = await worker.fetch(new Request(ORIGEM + `/api/receitas/${id}/itens`, { method: 'PUT', headers: { Cookie: a.vet, 'Content-Type': 'application/json' }, body: '{"itens":[]}' }), a.env);
  assert.equal(semCab.status, 403);
});

test('PUT itens: valida cada campo', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  const ruim = async (lista) => assert.equal((await itens(a, id, lista)).status, 400, JSON.stringify(lista));
  await ruim('x');
  await chamar(a.env, 'PUT', `/api/receitas/${id}/itens`, { cookie: a.vet, corpo: {} }).then((r) => assert.equal(r.status, 400));
  await ruim(['texto']);
  await ruim([item('', true, 1, 100)]);
  await ruim([item('   ', true, 1, 100)]);
  await ruim([item('a'.repeat(301), true, 1, 100)]);
  await ruim([{ descricao: 'x', quantidade: 1 }]); // falta "temos"
  await ruim([item('x', 'sim', 1, 100)]);
  await ruim([item('x', true, 0, 100)]);
  await ruim([item('x', true, 1000, 100)]);
  await ruim([item('x', true, 1.5, 100)]);
  await ruim([item('x', true, '2', 100)]);
  await ruim([item('x', true, 1, -1)]);
  await ruim([item('x', true, 1, 10000001)]);
  await ruim([item('x', true, 1, 85.5)]);
  await ruim([item('x', true, 1, '85')]);
  await ruim(Array.from({ length: 101 }, (_, i) => item('p' + i, false, 1, null)));
  // limites aceitos
  assert.equal((await itens(a, id, [item('a'.repeat(300), true, 999, 10000000), item('grátis', true, 1, 0)])).status, 200);
  assert.equal((await itens(a, id, Array.from({ length: 100 }, (_, i) => item('p' + i, false, 1, null)))).status, 200);
  // nada foi gravado pelas tentativas inválidas (a última lista válida ficou)
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM receita_itens WHERE receita_id = ?').get(id).n, 100);
});

test('temos=false força valor vazio e quantidade 1; quantidade e valor vazios valem 1 e "sem valor"', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  const r = await itens(a, id, [item('Dipirona', false, 5, 9900), { descricao: '  Cefalexina\n 500 mg ', temos: true }, { descricao: 'Omeprazol', temos: 0 }]);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const linhas = a.env.DB.bruto.prepare('SELECT * FROM receita_itens WHERE receita_id = ? ORDER BY ordem').all(id);
  assert.deepEqual(linhas.map((l) => [l.descricao, l.temos, l.quantidade, l.valor_unitario_centavos, l.ordem]), [
    ['Dipirona', 0, 1, null, 0], ['Cefalexina 500 mg', 1, 1, null, 1], ['Omeprazol', 0, 1, null, 2],
  ]);
  assert.equal(r.dados.itens_sem_valor, 1);
});

test('GET traz itens, total (só "temos" com valor) e itens_sem_valor; recepção também vê', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a), { texto: 'A\nB\nC\nD' });
  await itens(a, id, [item('A', true, 2, 8500), item('B', true, 1, null), item('C', false, 1, null), item('D', true, 3, 0)]);
  const dados = (await chamar(a.env, 'GET', `/api/receitas/${id}`, { cookie: a.vet })).dados.receita;
  assert.equal(dados.total_produtos_centavos, 17000);
  assert.equal(dados.itens_sem_valor, 1);
  assert.deepEqual(dados.itens.map((i) => [i.descricao, i.temos, i.quantidade, i.valor_unitario_centavos]), [['A', true, 2, 8500], ['B', true, 1, null], ['C', false, 1, null], ['D', true, 3, 0]]);
  await liberar(a, id);
  const rec = (await chamar(a.env, 'GET', `/api/receitas/${id}`, { cookie: a.recepcao })).dados.receita;
  assert.equal(rec.total_produtos_centavos, 17000);
  assert.equal(rec.itens.length, 4);
});

test('PUT troca a lista inteira e registra só totais e contagem (sem texto dos produtos)', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  await itens(a, id, [item('Segredo clínico X', true, 1, 8500)]);
  await itens(a, id, [item('Outro', true, 2, 1000), item('Mais', false, 1, null)]);
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM receita_itens WHERE receita_id = ?').get(id).n, 2);
  const regs = a.env.DB.bruto.prepare(`SELECT * FROM registro_acoes WHERE acao = 'editar_valores_receita'`).all();
  assert.equal(regs.length, 1); // gravações seguidas da mesma pessoa viram uma linha
  assert.deepEqual(JSON.parse(regs[0].antes), { total_produtos_centavos: 0, itens_sem_valor: 0, quantidade_itens: 0 });
  assert.deepEqual(JSON.parse(regs[0].depois), { total_produtos_centavos: 2000, itens_sem_valor: 0, quantidade_itens: 2 });
  assert.ok(!regs[0].depois.includes('Outro') && !regs[0].antes.includes('Segredo'));
  // outra pessoa gera outra linha
  await liberar(a, id);
  await itens(a, id, [item('Outro', true, 2, 2000)], a.recepcao);
  assert.equal(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao = 'editar_valores_receita'`).get().n, 2);
});

test('valores podem ser corrigidos depois de liberada e impressa; cancelada recusa', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  await liberar(a, id);
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 8500)])).status, 200);
  await chamar(a.env, 'POST', `/api/receitas/${id}/impressa`, { cookie: a.recepcao });
  assert.equal((await itens(a, id, [item('Dipirona', true, 1, 9000)], a.recepcao)).status, 200);
  // o texto continua imutável
  assert.equal(a.env.DB.bruto.prepare('SELECT texto FROM receitas WHERE id = ?').get(id).texto, 'Dipirona\nCefalexina');
  const outro = await rascunho(a, await novoPet(a, 'Mel', 'Ana', '(71) 98888-7777'));
  await chamar(a.env, 'POST', `/api/receitas/${outro}/cancelar`, { cookie: a.vet });
  const r = await itens(a, outro, [item('x', true, 1, 100)]);
  assert.equal(r.status, 409);
});

test('nova versão copia os produtos e os valores', async () => {
  const a = await ambiente();
  const id = await rascunho(a, await novoPet(a));
  await itens(a, id, [item('Dipirona', true, 2, 8500), item('Cefalexina', false, 1, null)]);
  await liberar(a, id);
  const v2 = (await chamar(a.env, 'POST', `/api/receitas/${id}/nova-versao`, { cookie: a.vet })).dados.receita;
  assert.deepEqual(v2.itens.map((i) => [i.descricao, i.temos, i.quantidade, i.valor_unitario_centavos]), [['Dipirona', true, 2, 8500], ['Cefalexina', false, 1, null]]);
  assert.equal(v2.total_produtos_centavos, 17000);
  // são cópias independentes
  await itens(a, v2.id, [item('Dipirona', true, 1, 100)]);
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${id}`, { cookie: a.vet })).dados.receita.total_produtos_centavos, 17000);
});

test('Hoje: produtos_centavos soma só receitas não canceladas do atendimento; produtos_sem_valor conta', async () => {
  const a = await ambiente();
  const pet = await novoPet(a);
  const outroPet = await novoPet(a, 'Mel', 'Ana', '(71) 98888-7777');
  const at = await atendimento(a, pet);
  const at2 = await atendimento(a, outroPet);
  const r1 = await rascunho(a, pet, { atendimento_id: at });
  await itens(a, r1, [item('A', true, 2, 8500), item('B', true, 1, null)]);
  await liberar(a, r1);
  const r2 = (await chamar(a.env, 'POST', '/api/receitas/transcrever', { cookie: a.recepcao, corpo: { pet_id: pet.id, atendimento_id: at, veterinario_id: 1, texto: 'C' } })).dados.receita.id;
  await itens(a, r2, [item('C', true, 1, 4000)], a.recepcao);
  const r3 = await rascunho(a, pet, { atendimento_id: at }); // rascunho também conta
  await itens(a, r3, [item('D', true, 1, 500)]);
  let linha = (await hoje(a)).find((x) => x.id === at);
  assert.deepEqual([linha.produtos_centavos, linha.produtos_sem_valor], [17000 + 4000 + 500, 1]);
  await chamar(a.env, 'POST', `/api/receitas/${r2}/cancelar`, { cookie: a.vet });
  linha = (await hoje(a)).find((x) => x.id === at);
  assert.equal(linha.produtos_centavos, 17500);
  // atendimento sem produtos e receita de outro atendimento não entram
  const outro = (await hoje(a)).find((x) => x.id === at2);
  assert.deepEqual([outro.produtos_centavos, outro.produtos_sem_valor], [0, 0]);
});

test('Hoje: com nova versão em andamento, o valor não é somado duas vezes', async () => {
  const a = await ambiente();
  const pet = await novoPet(a);
  const at = await atendimento(a, pet);
  const r1 = await rascunho(a, pet, { atendimento_id: at });
  await itens(a, r1, [item('A', true, 1, 8500)]);
  await liberar(a, r1);
  const v2 = (await chamar(a.env, 'POST', `/api/receitas/${r1}/nova-versao`, { cookie: a.vet })).dados.receita.id;
  assert.equal((await hoje(a)).find((x) => x.id === at).produtos_centavos, 8500);
  await itens(a, v2, [item('A', true, 1, 9000)]);
  assert.equal((await hoje(a)).find((x) => x.id === at).produtos_centavos, 9000);
  await chamar(a.env, 'POST', `/api/receitas/${v2}/cancelar`, { cookie: a.vet }); // desistiu da nova versão
  assert.equal((await hoje(a)).find((x) => x.id === at).produtos_centavos, 8500);
});

test('ficha do pet: total por receita (só os que "temos")', async () => {
  const a = await ambiente();
  const pet = await novoPet(a);
  const r1 = await rascunho(a, pet);
  await itens(a, r1, [item('A', true, 2, 8500), item('B', false, 1, null), item('C', true, 1, null)]);
  await liberar(a, r1);
  const r2 = await rascunho(a, pet);
  const ficha = async (cookie) => (await chamar(a.env, 'GET', `/api/pets/${pet.id}`, { cookie })).dados.receitas;
  let rs = await ficha(a.vet);
  assert.equal(rs.find((x) => x.id === r1).total_produtos_centavos, 17000);
  assert.equal(rs.find((x) => x.id === r2).total_produtos_centavos, 0);
  rs = await ficha(a.recepcao);
  assert.equal(rs.find((x) => x.id === r1).total_produtos_centavos, 17000);
});

test('apagar dados de teste remove também os produtos das receitas de teste e mantém os reais', async () => {
  const a = await ambiente();
  const teste = await novoPet(a, 'Rex', 'TESTE Maria', '71 99999-0001');
  const real = await novoPet(a, 'Bolinha', 'Ana Real', '71 99999-0003');
  const at = await atendimento(a, teste);
  const r1 = await rascunho(a, teste, { atendimento_id: at });
  await itens(a, r1, [item('A', true, 1, 100)]);
  await liberar(a, r1);
  const v2 = (await chamar(a.env, 'POST', `/api/receitas/${r1}/nova-versao`, { cookie: a.vet })).dados.receita.id;
  await liberar(a, v2);
  const rReal = await rascunho(a, real);
  await itens(a, rReal, [item('Real', true, 1, 700)]);
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM receita_itens').get().n, 3);
  const r = await chamar(a.env, 'POST', '/api/admin/apagar-dados-teste', { cookie: a.vet, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.deepEqual(a.env.DB.bruto.prepare('SELECT receita_id, descricao FROM receita_itens').all().map((x) => [x.receita_id, x.descricao]), [[rReal, 'Real']]);
  assert.equal(a.env.DB.bruto.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('migração 0006 aplica sobre dados existentes sem perder nada', () => {
  const db = criarBancoLocal({ ate: '0005' });
  const b = db.bruto;
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Ana', 'ana', 'h', 'veterinario', 1, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO tutores (codigo, nome, whatsapp, origem, criado_por, criado_em, atualizado_em) VALUES ('T-000001', 'Carla', '+5571999990000', 'recepcao', 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Mel', 'cao', 'recepcao', 'x', 'x')`).run();
  b.prepare(`INSERT INTO receitas (pet_id, criado_por, texto, criado_em, atualizado_em) VALUES (1, 1, 'Dipirona', 'x', 'x')`).run();
  db.migrarRestante();
  assert.equal(b.prepare('SELECT texto FROM receitas').get().texto, 'Dipirona');
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM receita_itens').get().n, 0);
  b.prepare(`INSERT INTO receita_itens (receita_id, descricao, atualizado_em) VALUES (1, 'Dipirona', 'x')`).run();
  const i = b.prepare('SELECT * FROM receita_itens').get();
  assert.deepEqual([i.temos, i.quantidade, i.valor_unitario_centavos, i.ordem], [0, 1, null, 0]);
  const ruim = (sql) => assert.throws(() => b.prepare(sql).run(), sql);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, temos, atualizado_em) VALUES (1, 'x', 2, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, quantidade, atualizado_em) VALUES (1, 'x', 0, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, quantidade, atualizado_em) VALUES (1, 'x', 1000, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, valor_unitario_centavos, atualizado_em) VALUES (1, 'x', -1, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, valor_unitario_centavos, atualizado_em) VALUES (1, 'x', 10000001, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, atualizado_em) VALUES (1, NULL, 'x')`);
  ruim(`INSERT INTO receita_itens (receita_id, descricao, atualizado_em) VALUES (999, 'x', 'x')`);
  assert.equal(b.prepare('PRAGMA foreign_key_check').all().length, 0);
});
