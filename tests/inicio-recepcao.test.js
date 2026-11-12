// Testes: a recepção marca que o paciente entrou no consultório; detalhes do pet no cadastro rápido.
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

const chegar = async (a, nome) => {
  const pet = await novoPet(a, nome);
  return (await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, ...base() } })).dados;
};
const iniciar = (a, id, cookie, corpo) => chamar(a.env, 'POST', `/api/atendimentos/${id}/iniciar`, { cookie, corpo });

test('recepção inicia com veterinário: em atendimento, iniciado_por registrado, ação registrada e vet avisado', async () => {
  const a = await ambiente();
  const at = await chegar(a, 'Thor');
  const r = await iniciar(a, at.id, a.recepcao, { veterinario_id: a.ids.filipe });
  assert.equal(r.status, 200);
  assert.equal(r.dados.status, 'em_atendimento');
  assert.equal(r.dados.veterinario.id, a.ids.filipe);
  assert.equal(r.dados.iniciado_por, a.ids.recep);
  assert.equal(r.dados.iniciado_pela_recepcao, true);
  const acao = JSON.parse(a.env.DB.bruto.prepare(`SELECT depois, usuario_id FROM registro_acoes WHERE acao = 'iniciar_atendimento'`).get().depois);
  assert.equal(acao.veterinario_id, a.ids.filipe);
  assert.equal(acao.iniciado_por, a.ids.recep);
  assert.equal(acao.marcado_pela_recepcao, true);
  const aviso = a.avisos.find((x) => x.titulo === 'Paciente no consultório');
  assert.deepEqual(aviso.para, { usuarioId: a.ids.filipe });
  assert.equal(aviso.corpo, 'Thor · marcado pela recepção');
  assert.equal(aviso.tag, `atendimento-${at.id}`);
});

test('recepção iniciar: sem veterinário 400; recepção, suporte, inativo ou inexistente 400; atendimento segue aguardando', async () => {
  const a = await ambiente();
  const at = await chegar(a, 'Luna');
  assert.equal((await iniciar(a, at.id, a.recepcao)).status, 400);
  for (const v of [a.ids.recep, a.ids.sup, a.ids.antigo, 99999, 'x', 0]) {
    assert.equal((await iniciar(a, at.id, a.recepcao, { veterinario_id: v })).status, 400, String(v));
  }
  assert.equal((await hoje(a, a.recepcao)).aguardando.length, 1);
  assert.equal(a.avisos.filter((x) => x.titulo === 'Paciente no consultório').length, 0);
});

test('veterinário inicia sem informar (ele mesmo, não marcado pela recepção, sem aviso); recepção não finaliza', async () => {
  const a = await ambiente();
  const at = await chegar(a, 'Mel');
  const r = await iniciar(a, at.id, a.filipe);
  assert.equal(r.status, 200);
  assert.equal(r.dados.veterinario.id, a.ids.filipe);
  assert.equal(r.dados.iniciado_por, a.ids.filipe);
  assert.equal(r.dados.iniciado_pela_recepcao, false);
  assert.equal(a.avisos.filter((x) => x.titulo === 'Paciente no consultório').length, 0);
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at.id}/finalizar`, { cookie: a.recepcao })).status, 200); // recepção pode finalizar
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at.id}/finalizar`, { cookie: a.filipe })).status, 409); // já finalizado
});

test('veterinário pode indicar outro veterinário; já iniciado dá 409', async () => {
  const a = await ambiente();
  const at = await chegar(a, 'Bob');
  const r = await iniciar(a, at.id, a.filipe, { veterinario_id: a.ids.admin });
  assert.equal(r.dados.veterinario.id, a.ids.admin);
  assert.equal(r.dados.iniciado_por, a.ids.filipe);
  assert.equal((await iniciar(a, at.id, a.recepcao, { veterinario_id: a.ids.filipe })).status, 409);
});

test('cadastro rápido grava sexo, raça, idade e observações do pet e valida', async () => {
  const a = await ambiente();
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: {
    tutor: { nome: 'Ana', whatsapp: '(71) 98888-0001' },
    pet: { nome: 'Nina', especie: 'gato', sexo: 'femea', raca: 'SRD', idade_anos: 3, idade_meses: 2, observacoes: 'Medrosa' },
    chegada: base(),
  } });
  assert.equal(r.status, 201);
  const pet = (await chamar(a.env, 'GET', `/api/pets/${r.dados.pet.id}`, { cookie: a.recepcao })).dados.pet;
  assert.equal(pet.sexo, 'femea');
  assert.equal(pet.raca, 'SRD');
  assert.equal(pet.idade_anos, 3);
  assert.equal(pet.idade_meses, 2);
  assert.equal(pet.observacoes, 'Medrosa');
  // sem os detalhes continua funcionando
  const s = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Bia', whatsapp: '(71) 98888-0002' }, pet: { nome: 'Rex', especie: 'cao' } } });
  assert.equal(s.status, 201);
  // valores inválidos: 400 e nada é gravado
  for (const pet of [{ sexo: 'x' }, { idade_meses: 12 }, { idade_anos: 99 }]) {
    const e = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Cris', whatsapp: '(71) 98888-0003' }, pet: { nome: 'Zeca', especie: 'cao', ...pet } } });
    assert.equal(e.status, 400, JSON.stringify(pet));
  }
});

test('editar pet: sexo, raça, idade e observações mudam para qualquer espécie e sexo', async () => {
  const a = await ambiente();
  for (const [i, [especie, sexo]] of [['cao', 'macho'], ['gato', 'femea'], ['outro', 'macho'], ['outro', 'femea'], ['cao', 'femea']].entries()) {
    const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'T' + i, whatsapp: `(71) 97777-000${i}` }, pet: { nome: 'P' + i, especie } } });
    const e = await chamar(a.env, 'PATCH', `/api/pets/${r.dados.pet.id}`, { cookie: a.recepcao, corpo: { sexo, raca: 'Raça ' + i, idade_anos: i, idade_meses: 1, observacoes: 'obs ' + i } });
    assert.equal(e.status, 200, especie + sexo);
    assert.deepEqual([e.dados.sexo, e.dados.raca, e.dados.idade_anos, e.dados.idade_meses, e.dados.observacoes], [sexo, 'Raça ' + i, i, 1, 'obs ' + i]);
  }
});
