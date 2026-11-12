// Testes de GET /api/chegada/sugestoes (reconhecimento automático do pet na chegada).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const env = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') } });

async function chamar(e, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), e);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}

async function ambiente() {
  const e = env();
  const r = await chamar(e, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const cookie = r.res.headers.get('Set-Cookie').split(';')[0];
  return { e, cookie };
}

async function cadastrar(a, pet, tutor, fone, chegada) {
  const r = await chamar(a.e, 'POST', '/api/cadastro-rapido', { cookie: a.cookie, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome: pet, especie: 'cao' }, ...(chegada ? { chegada } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}
const sugerir = (a, qs, cookie = a.cookie) => chamar(a.e, 'GET', '/api/chegada/sugestoes?' + new URLSearchParams(qs), { cookie });

test('exige login (401)', async () => {
  const a = await ambiente();
  assert.equal((await sugerir(a, { pet: 'Thor' }, '')).status, 401);
});

test('pet com menos de 2 letras: lista vazia', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888');
  assert.deepEqual((await sugerir(a, { pet: 'T' })).dados.sugestoes, []);
  assert.deepEqual((await sugerir(a, { pet: ' ' })).dados.sugestoes, []);
  assert.deepEqual((await sugerir(a, {})).dados.sugestoes, []);
});

test('pet + tutor sem acento e sem maiúsculas, prefixo ou trecho', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria José', '(71) 99999-8888');
  const r = await sugerir(a, { pet: 'thor', tutor: 'maria jose' });
  assert.equal(r.status, 200);
  assert.equal(r.dados.sugestoes.length, 1);
  const s = r.dados.sugestoes[0];
  assert.equal(s.pet.nome, 'Thor');
  assert.equal(s.tutor.nome, 'Maria José');
  assert.equal(s.tutor.final_telefone, '8888');
  const acento = await sugerir(a, { pet: 'tho', tutor: 'JOSÉ' });
  assert.equal(acento.dados.sugestoes.length, 1);
});

test('pet com acento no cadastro é achado sem acento', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Mel Pãozinho', 'Ana', '(71) 98888-7777');
  assert.equal((await sugerir(a, { pet: 'paozinho', tutor: 'ana' })).dados.sugestoes.length, 1);
});

test('forma do candidato: pet, tutor, último peso, última visita, em_atendimento, sem telefone inteiro', async () => {
  const a = await ambiente();
  const c = await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888', { peso_kg: 12.4, motivo: 'Vômito' });
  // finaliza a visita para o pet não estar mais na clínica
  await chamar(a.e, 'POST', `/api/atendimentos/${c.atendimento.id}/iniciar`, { cookie: a.cookie, corpo: {} });
  await chamar(a.e, 'POST', `/api/atendimentos/${c.atendimento.id}/finalizar`, { cookie: a.cookie, corpo: {} });
  const r = await sugerir(a, { pet: 'thor', tutor: 'maria' });
  const s = r.dados.sugestoes[0];
  assert.deepEqual(Object.keys(s).sort(), ['em_atendimento', 'pet', 'tutor', 'ultima_visita_em', 'ultimo_peso_kg']);
  assert.deepEqual(Object.keys(s.pet).sort(), ['codigo', 'especie', 'foto_id', 'id', 'idade', 'nome']);
  assert.deepEqual(Object.keys(s.tutor).sort(), ['final_telefone', 'id', 'nome']);
  assert.equal(s.ultimo_peso_kg, 12.4);
  assert.ok(s.ultima_visita_em);
  assert.equal(s.em_atendimento, false);
  const texto = JSON.stringify(r.dados);
  assert.ok(!texto.includes('99999'), 'não pode vazar o telefone inteiro');
  assert.ok(!texto.includes('5571'));
});

test('em_atendimento: true enquanto há atendimento aberto', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888', { peso_kg: 12, motivo: 'Vômito' });
  assert.equal((await sugerir(a, { pet: 'thor', tutor: 'maria' })).dados.sugestoes[0].em_atendimento, true);
});

test('pet sem visitas: peso e visita nulos', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888');
  const s = (await sugerir(a, { pet: 'thor', tutor: 'maria' })).dados.sugestoes[0];
  assert.equal(s.ultimo_peso_kg, null);
  assert.equal(s.ultima_visita_em, null);
  assert.equal(s.em_atendimento, false);
});

test('ranking: pet+tutor antes de WhatsApp antes de só o pet', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thorzinho', 'Carlos', '(71) 91111-2222');   // só o pet combina
  await cadastrar(a, 'Bidu', 'Maria', '(71) 99999-8888');         // WhatsApp combina (outro pet do tutor)
  await cadastrar(a, 'Thor', 'Maria', '(71) 93333-4444');         // pet e tutor combinam
  // tutor "maria" digitado: o pet "Thorzinho" (tutor Carlos) NÃO entra (tutor preenchido e diferente)
  let r = await sugerir(a, { pet: 'thor', tutor: 'maria', whatsapp: '71 99999-8888' });
  assert.deepEqual(r.dados.sugestoes.map((s) => s.pet.nome), ['Thor', 'Bidu']);
  // tutor vazio: só o nome do pet combina, nos dois "thor*"
  r = await sugerir(a, { pet: 'thor' });
  assert.deepEqual(r.dados.sugestoes.map((s) => s.pet.nome).sort(), ['Thor', 'Thorzinho']);
  // quem começa com o texto vem primeiro
  await cadastrar(a, 'Dathor', 'Zeca', '(71) 95555-6666');
  r = await sugerir(a, { pet: 'thor' });
  assert.equal(r.dados.sugestoes.at(-1).pet.nome, 'Dathor');
});

test('WhatsApp só vale com 8 ou mais números', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Bidu', 'Maria', '(71) 99999-8888');
  // pet "thor" não existe; só o WhatsApp poderia achar
  assert.deepEqual((await sugerir(a, { pet: 'thor', tutor: 'maria', whatsapp: '9999888' })).dados.sugestoes, []);
  const r = await sugerir(a, { pet: 'thor', tutor: 'maria', whatsapp: '99999-8888' });
  assert.deepEqual(r.dados.sugestoes.map((s) => s.pet.nome), ['Bidu']);
});

test('só o nome do pet: não entra quando o tutor digitado é longo e diferente', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888');
  assert.equal((await sugerir(a, { pet: 'thor', tutor: 'Joana' })).dados.sugestoes.length, 0);
  assert.equal((await sugerir(a, { pet: 'thor', tutor: 'jo' })).dados.sugestoes.length, 1); // tutor curto = ainda digitando
});

test('exclui pet arquivado e tutor unido a outro', async () => {
  const a = await ambiente();
  const c1 = await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888');
  const c2 = await cadastrar(a, 'Thor', 'Maria', '(71) 92222-3333');
  assert.equal((await sugerir(a, { pet: 'thor', tutor: 'maria' })).dados.sugestoes.length, 2);
  // arquiva o primeiro
  assert.equal((await chamar(a.e, 'PATCH', `/api/pets/${c1.pet.id}`, { cookie: a.cookie, corpo: { ativo: false } })).status, 200);
  let r = await sugerir(a, { pet: 'thor', tutor: 'maria' });
  assert.deepEqual(r.dados.sugestoes.map((s) => s.pet.id), [c2.pet.id]);
  // une o tutor 2 ao tutor 1: o pet do tutor 2 passa a ser do tutor principal, e o duplicado some
  const c3 = await cadastrar(a, 'Rex', 'Pedro', '(71) 94444-5555');
  const c4 = await cadastrar(a, 'Rex', 'Pedro', '(71) 96666-7777');
  const m = await chamar(a.e, 'POST', `/api/tutores/${c3.tutor.id}/mesclar`, { cookie: a.cookie, corpo: { duplicado_id: c4.tutor.id } });
  assert.equal(m.status, 200);
  r = await sugerir(a, { pet: 'rex', tutor: 'pedro' });
  assert.ok(r.dados.sugestoes.every((s) => s.tutor.id === c3.tutor.id));
  // mesmo buscando pelo WhatsApp do tutor unido, ele não aparece como tutor
  r = await sugerir(a, { pet: 'rex', whatsapp: '71 96666-7777' });
  assert.ok(r.dados.sugestoes.every((s) => s.tutor.id !== c4.tutor.id));
});

test('no máximo 5 candidatos', async () => {
  const a = await ambiente();
  for (let i = 0; i < 7; i++) await cadastrar(a, `Thor ${i}`, `Maria ${i}`, `(71) 9${1000 + i}-0000`.replace('-', '-') );
  const r = await sugerir(a, { pet: 'thor', tutor: 'maria' });
  assert.equal(r.dados.sugestoes.length, 5);
});

test('caracteres de LIKE (% e _) são tratados como letras', async () => {
  const a = await ambiente();
  await cadastrar(a, 'Thor', 'Maria', '(71) 99999-8888');
  assert.equal((await sugerir(a, { pet: '%%', tutor: 'maria' })).dados.sugestoes.length, 0);
  assert.equal((await sugerir(a, { pet: 't_r', tutor: 'maria' })).dados.sugestoes.length, 0);
});
