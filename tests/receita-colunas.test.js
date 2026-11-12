// Testes da receita em colunas: linhas_json, nova versão, sugestões de remédio e quem pediu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { lerLinhas, remediosParaSugestao } from '../src/receitas.js';
import { textoDasLinhas } from '../public/receita-linhas.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const novoEnv = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') }, NOTIFICAR_TESTE: async () => {} });

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
  const env = novoEnv();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123', crmv: 'CRMV-BA 1234' } });
  const admin = cookieDe(r.res);
  const ids = { admin: r.dados.id };
  for (const [login, papel, nome, whatsapp] of [['felipe', 'veterinario', 'Felipe', '(71) 98888-1111'], ['recep', 'recepcao', 'Recep']]) {
    const c = await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome, login, senha: 'senha-forte-123', papel, crmv: papel === 'veterinario' ? 'CRMV-BA 999' : undefined, whatsapp } });
    assert.equal(c.status, 201, JSON.stringify(c.dados));
    ids[login] = c.dados.id;
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  const pet = (await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: admin, corpo: { tutor: { nome: 'Maria', whatsapp: '(71) 99999-8888' }, pet: { nome: 'Thor', especie: 'cao' } } })).dados.pet;
  return { env, vet: admin, felipe: await ent('felipe'), recepcao: await ent('recep'), ids, pet };
}

const LINHAS = [
  { remedio: 'Amoxicilina', dose: '250 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias' },
  { remedio: 'Dipirona', dose: '500 mg', como: '10 gotas', intervalo: '8 h', duracao: '3 dias' },
];

async function criar(a, cookie = a.vet, extra = {}) {
  const r = await chamar(a.env, 'POST', '/api/receitas', { cookie, corpo: { pet_id: a.pet.id, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados.receita;
}

// ---------- validação ----------
test('lerLinhas: via (até 40) e comprar (até 30) entram limpos; sem eles, nada é inventado', () => {
  assert.deepEqual(lerLinhas([{ remedio: 'Otomax', via: '  Uso   otológico ', comprar: ' 1 FR ' }]),
    [{ remedio: 'Otomax', dose: '', como: '', intervalo: '', duracao: '', via: 'Uso otológico', comprar: '1 FR' }]);
  assert.equal('via' in lerLinhas([{ remedio: 'X' }])[0], false);
  assert.doesNotThrow(() => lerLinhas([{ via: 'v'.repeat(40), comprar: 'c'.repeat(30) }]));
  assert.throws(() => lerLinhas([{ via: 'v'.repeat(41) }]), { status: 400 });
  assert.throws(() => lerLinhas([{ comprar: 'c'.repeat(31) }]), { status: 400 });
  assert.throws(() => lerLinhas([{ via: 3 }]), { status: 400 });
  assert.throws(() => lerLinhas([{ comprar: ['1 CX'] }]), { status: 400 });
});

test('via e comprar gravam, voltam na API e a prévia da lista ignora o título do grupo', async () => {
  const a = await ambiente();
  const r = await criar(a);
  const linhas = [{ ...LINHAS[0], via: 'Uso oral', comprar: '1 CX' }, { ...LINHAS[1], via: 'Uso injetável', comprar: '2 FR' }];
  const p = await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(linhas), linhas_json: linhas } });
  assert.equal(p.status, 200, JSON.stringify(p.dados));
  assert.deepEqual((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita.linhas, linhas);
  const ruim = await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { linhas_json: [{ comprar: 'c'.repeat(31) }] } });
  assert.equal(ruim.status, 400);
  const lista = await chamar(a.env, 'GET', `/api/pets/${a.pet.id}`, { cookie: a.vet });
  assert.equal(lista.dados.receitas.find((x) => x.id === r.id).previa, 'Amoxicilina 250 mg');
});

test('lerLinhas: aceita lista, limpa campos e completa os que faltam', () => {
  assert.equal(lerLinhas(null), null);
  assert.deepEqual(lerLinhas([]), []);
  assert.deepEqual(lerLinhas([{ remedio: '  Amox  ', dose: '250 mg', lixo: 'x' }]), [{ remedio: 'Amox', dose: '250 mg', como: '', intervalo: '', duracao: '' }]);
});

test('lerLinhas: rejeita o que não é lista, linhas demais, campo grande ou que não é texto', () => {
  assert.throws(() => lerLinhas('abc'), { status: 400 });
  assert.throws(() => lerLinhas({}), { status: 400 });
  assert.throws(() => lerLinhas(Array.from({ length: 101 }, () => ({}))), { status: 400 });
  assert.doesNotThrow(() => lerLinhas(Array.from({ length: 100 }, () => ({}))));
  assert.throws(() => lerLinhas([{ remedio: 'x'.repeat(201) }]), { status: 400 });
  assert.doesNotThrow(() => lerLinhas([{ remedio: 'x'.repeat(200) }]));
  assert.throws(() => lerLinhas([{ remedio: 5 }]), { status: 400 });
  assert.throws(() => lerLinhas(['texto']), { status: 400 });
  assert.throws(() => lerLinhas([null]), { status: 400 });
});

test('PATCH com linhas_json inválido devolve 400 e não grava', async () => {
  const a = await ambiente();
  const r = await criar(a);
  for (const ruim of ['abc', { a: 1 }, [{ remedio: 'x'.repeat(201) }], Array.from({ length: 101 }, () => ({}))]) {
    const p = await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { linhas_json: ruim } });
    assert.equal(p.status, 400);
  }
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita.linhas, null);
});

// ---------- ida e volta ----------
test('linhas_json: grava e volta como "linhas" (lista) junto com o texto gerado', async () => {
  const a = await ambiente();
  const r = await criar(a);
  assert.equal(r.linhas, null); // receita nova sem colunas
  const texto = textoDasLinhas(LINHAS);
  const p = await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto, linhas_json: LINHAS } });
  assert.equal(p.status, 200);
  const v = (await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita;
  assert.deepEqual(v.linhas, LINHAS);
  assert.equal(v.texto, 'USO ORAL\n1 - *Amoxicilina 250 mg*\nAdministrar 1 comprimido a cada 12 h, durante 7 dias.\n2 - *Dipirona 500 mg*\nAdministrar 10 gotas a cada 8 h, durante 3 dias.');
  // no banco é um texto JSON
  const bruto = a.env.DB.bruto.prepare('SELECT linhas_json FROM receitas WHERE id = ?').get(r.id);
  assert.equal(typeof bruto.linhas_json, 'string');
  assert.deepEqual(JSON.parse(bruto.linhas_json), LINHAS);
});

test('PATCH só do texto não apaga as linhas; linhas_json null volta ao texto livre', async () => {
  const a = await ambiente();
  const r = await criar(a);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'x', linhas_json: LINHAS } });
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { orientacoes: 'Repouso' } });
  assert.deepEqual((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita.linhas, LINHAS);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { linhas_json: null } });
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita.linhas, null);
});

test('mudar só as linhas conta como alteração (não é ignorado)', async () => {
  const a = await ambiente();
  const r = await criar(a);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: 'x', linhas_json: [LINHAS[0]] } });
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { linhas_json: LINHAS } });
  assert.equal((await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita.linhas.length, 2);
});

test('depois de liberada, linhas_json não muda mais (409)', async () => {
  const a = await ambiente();
  const r = await criar(a);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(LINHAS), linhas_json: LINHAS } });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet, corpo: {} })).status, 200);
  assert.equal((await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { linhas_json: [] } })).status, 409);
});

test('receita antiga (sem linhas_json) vem com linhas: null', async () => {
  const a = await ambiente();
  const r = await criar(a, a.vet, { texto: 'Amoxicilina 250 mg — 1 comprimido' });
  assert.equal(r.linhas, null);
});

test('nova versão copia linhas_json (e os produtos)', async () => {
  const a = await ambiente();
  const r = await criar(a);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(LINHAS), linhas_json: LINHAS } });
  await chamar(a.env, 'PUT', `/api/receitas/${r.id}/itens`, { cookie: a.vet, corpo: { itens: [{ descricao: 'Amoxicilina 250 mg', temos: true, quantidade: 1, valor_unitario_centavos: 4500 }] } });
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet, corpo: {} });
  const nv = await chamar(a.env, 'POST', `/api/receitas/${r.id}/nova-versao`, { cookie: a.vet, corpo: {} });
  assert.equal(nv.status, 201);
  assert.deepEqual(nv.dados.receita.linhas, LINHAS);
  assert.equal(nv.dados.receita.itens.length, 1);
  assert.equal(nv.dados.receita.itens[0].valor_unitario_centavos, 4500);
});

// ---------- sugestões de remédio ----------
test('remediosParaSugestao: nome + dose, sem repetir e sem vazios', () => {
  assert.deepEqual(remediosParaSugestao([...LINHAS, { remedio: 'amoxicilina', dose: '250  mg' }, { remedio: '', dose: '' }, { remedio: 'Ab' }]).map((x) => x.nome),
    ['Amoxicilina 250 mg', 'Dipirona 500 mg']);
  assert.deepEqual(remediosParaSugestao(null), []);
});

test('liberar receita em colunas ensina remédios: "amox" sugere "Amoxicilina 250 mg" no modo remédio', async () => {
  const a = await ambiente();
  const r = await criar(a);
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(LINHAS), linhas_json: LINHAS } });
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet, corpo: {} });
  const rem = await chamar(a.env, 'GET', '/api/sugestoes-receita?tipo=remedio&q=AMOX', { cookie: a.vet });
  assert.deepEqual(rem.dados.sugestoes.map((s) => s.texto), ['Amoxicilina 250 mg']);
  // sem "tipo", continuam as linhas inteiras (comportamento de antes) e não misturam com os nomes
  const lin = await chamar(a.env, 'GET', '/api/sugestoes-receita?q=amox', { cookie: a.vet });
  assert.deepEqual(lin.dados.sugestoes.map((s) => s.texto), ['1 - *Amoxicilina 250 mg*']);
  // modo remédio não devolve linhas inteiras
  assert.equal((await chamar(a.env, 'GET', '/api/sugestoes-receita?tipo=remedio&q=comprimido', { cookie: a.vet })).dados.sugestoes.length, 0);
});

test('usar de novo o remédio reforça a sugestão (vezes)', async () => {
  const a = await ambiente();
  for (let i = 0; i < 2; i++) {
    const r = await criar(a);
    await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(LINHAS), linhas_json: LINHAS } });
    await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet, corpo: {} });
  }
  const s = (await chamar(a.env, 'GET', '/api/sugestoes-receita?tipo=remedio&q=dipi', { cookie: a.vet })).dados.sugestoes;
  assert.equal(s.length, 1);
  assert.equal(s[0].vezes, 2);
});

// ---------- quem pediu ----------
test('GET inclui solicitada_por_usuario (id, nome, whatsapp) depois do pedido', async () => {
  const a = await ambiente();
  const r = await criar(a, a.felipe); // Felipe cria e pede para a Dra. Elizabeth
  assert.equal(r.solicitada_por_usuario, null);
  const p = await chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie: a.felipe, corpo: { para_usuario_id: a.ids.admin } });
  assert.equal(p.status, 200);
  const v = (await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.vet })).dados.receita;
  assert.deepEqual(v.solicitada_por_usuario, { id: a.ids.felipe, nome: 'Felipe', whatsapp: '+5571988881111' });
  assert.equal(v.solicitada_por, a.ids.felipe);
});

test('requerente sem WhatsApp: solicitada_por_usuario com whatsapp null', async () => {
  const a = await ambiente();
  const r = await criar(a, a.vet);
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie: a.vet, corpo: { para_usuario_id: a.ids.felipe } });
  const v = (await chamar(a.env, 'GET', `/api/receitas/${r.id}`, { cookie: a.felipe })).dados.receita;
  assert.equal(v.solicitada_por_usuario.nome, 'Dra. Elizabeth');
  assert.equal(v.solicitada_por_usuario.whatsapp, null);
});

test('liberada por quem recebeu o pedido: aparece para a recepção imprimir e sem preços no papel', async () => {
  const a = await ambiente();
  const r = await criar(a, a.felipe);
  await chamar(a.env, 'POST', `/api/receitas/${r.id}/pedir`, { cookie: a.felipe, corpo: { para_usuario_id: a.ids.admin } });
  await chamar(a.env, 'PATCH', `/api/receitas/${r.id}`, { cookie: a.vet, corpo: { texto: textoDasLinhas(LINHAS), linhas_json: LINHAS } });
  await chamar(a.env, 'PUT', `/api/receitas/${r.id}/itens`, { cookie: a.vet, corpo: { itens: [{ descricao: 'Amoxicilina 250 mg', temos: true, quantidade: 1, valor_unitario_centavos: 4500 }, { descricao: 'Dipirona 500 mg', temos: false }] } });
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${r.id}/liberar`, { cookie: a.vet, corpo: {} })).status, 200);
  const fila = await chamar(a.env, 'GET', '/api/receitas?status=para_imprimir', { cookie: a.recepcao });
  assert.deepEqual(fila.dados.receitas.map((x) => x.id), [r.id]);
  assert.ok(!JSON.stringify(fila.dados).includes('4500'));
});
