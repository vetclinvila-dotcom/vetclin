// Testes: "Aplicado aqui" (remédio aplicado na clínica: cobra, mas o tutor não compra).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { lerLinhas } from '../src/receitas.js';
import { VIA_APLICADO, gruposDasLinhas, linhaVazia, textoDasLinhas } from '../public/receita-linhas.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const oral = { remedio: 'Amoxicilina', dose: '250 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias', via: 'Uso oral', comprar: '1 CX' };
const injecao = { remedio: 'Dexametasona', dose: '2 mg/ml', como: '0,75 ml', intervalo: '', duracao: '', via: 'Subcutânea', comprar: '', aplicado: true };

// ---------- lerLinhas (servidor) ----------
test('lerLinhas: aplicado precisa ser verdadeiro/falso; aplicado limpa o "comprar"', () => {
  const [a, b, c] = lerLinhas([{ ...oral }, { ...injecao, comprar: '2 CX' }, { ...oral, aplicado: false }]);
  assert.equal('aplicado' in a, false); // receita antiga: o campo só entra quando a tela envia
  assert.equal(b.aplicado, true);
  assert.equal(b.comprar, ''); // aplicado não tem quantidade a comprar
  assert.equal(c.aplicado, false);
  assert.equal(c.comprar, '1 CX');
  for (const ruim of ['true', 1, 0, 'sim', {}, []]) {
    assert.throws(() => lerLinhas([{ ...oral, aplicado: ruim }]), (e) => e.status === 400, String(ruim));
  }
  assert.equal(lerLinhas([{ ...oral, aplicado: null }])[0].aplicado, undefined);
});

// ---------- agrupamento (papel) ----------
test('gruposDasLinhas: aplicados saem dos grupos USO e vão num grupo próprio, por último', () => {
  const g = gruposDasLinhas([injecao, oral, { ...oral, remedio: 'Dipirona', dose: '500 mg', via: 'Uso oral' }]);
  assert.deepEqual(g.map((x) => x.via), ['USO ORAL', VIA_APLICADO]);
  assert.equal(g[0].itens.length, 2);
  assert.deepEqual(g[0].itens.map((i) => i.n), [1, 2]); // a numeração do USO não conta o aplicado
  assert.equal(g[0].aplicado, undefined);
  assert.equal(g[1].aplicado, true);
  assert.deepEqual(g[1].itens.map((i) => [i.n, i.titulo, i.comprar]), [[1, 'Dexametasona 2 mg/ml', '']]);
  assert.equal(g[1].itens[0].instrucao, 'Dexametasona 2 mg/ml — aplicado na clínica. Aplicado por via subcutânea, 0,75 ml.');
});

test('gruposDasLinhas: só aplicados (sem USO) e aplicado sem detalhes', () => {
  const g = gruposDasLinhas([{ ...linhaVazia(), remedio: 'Ondansetrona', aplicado: true, via: 'Uso injetável' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].aplicado, true);
  assert.equal(g[0].itens[0].instrucao, 'Ondansetrona — aplicado na clínica');
  assert.equal(g[0].itens[0].detalhe, '');
  // aplicado sem nome é pulado
  assert.deepEqual(gruposDasLinhas([{ ...linhaVazia(), aplicado: true }]), []);
});

test('textoDasLinhas: bloco "APLICADO NA CLÍNICA (não precisa comprar)" no fim', () => {
  const t = textoDasLinhas([injecao, oral]);
  assert.equal(t, [
    'USO ORAL',
    '1 - *Amoxicilina 250 mg* ... 1 CX',
    'Administrar 1 comprimido a cada 12 h, durante 7 dias.',
    '',
    'APLICADO NA CLÍNICA (não precisa comprar)',
    '1 - *Dexametasona 2 mg/ml* — aplicado na clínica',
    'Aplicado por via subcutânea, 0,75 ml.',
  ].join('\n'));
  assert.equal(textoDasLinhas([{ ...injecao, via: 'Uso injetável', como: '' }]), 'APLICADO NA CLÍNICA (não precisa comprar)\n1 - *Dexametasona 2 mg/ml* — aplicado na clínica');
});

// ---------- cobrança ----------
const novoAmbiente = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') } });
async function chamar(env, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}

test('receita com remédio aplicado: guarda o campo e a conta cobra o item (Temos = Sim com valor)', async () => {
  const env = novoAmbiente();
  const cfg = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Elizabeth', login: 'admin', senha: 'senha-forte-123' } });
  const vet = cfg.res.headers.get('Set-Cookie').split(';')[0];
  const pet = (await chamar(env, 'POST', '/api/cadastro-rapido', { cookie: vet, corpo: { tutor: { nome: 'Maria', whatsapp: '(71) 99999-8888' }, pet: { nome: 'Thor', especie: 'cao' } } })).dados.pet;
  const at = (await chamar(env, 'POST', '/api/atendimentos', { cookie: vet, corpo: { pet_id: pet.id, peso_kg: 9, motivo: 'x' } })).dados.id;
  const rec = (await chamar(env, 'POST', '/api/receitas', { cookie: vet, corpo: { pet_id: pet.id, atendimento_id: at, texto: 'x' } })).dados.receita.id;

  const linhas = [oral, injecao];
  const p = await chamar(env, 'PATCH', `/api/receitas/${rec}`, { cookie: vet, corpo: { texto: textoDasLinhas(linhas), linhas_json: linhas } });
  assert.equal(p.status, 200);
  const guardado = (await chamar(env, 'GET', `/api/receitas/${rec}`, { cookie: vet })).dados.receita;
  assert.equal(guardado.linhas[1].aplicado, true);
  assert.equal(guardado.linhas[1].comprar, '');

  const it = await chamar(env, 'PUT', `/api/receitas/${rec}/itens`, { cookie: vet, corpo: { itens: [
    { descricao: 'Amoxicilina 250 mg', temos: true, quantidade: 1, valor_unitario_centavos: 4500 },
    { descricao: 'Dexametasona 2 mg/ml (aplicado na clínica)', temos: true, quantidade: 1, valor_unitario_centavos: 3000 },
  ] } });
  assert.equal(it.status, 200);
  const conta = (await chamar(env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: vet })).dados;
  assert.deepEqual(conta.automaticos.receita.map((i) => [i.descricao, i.preco_unitario_centavos]), [['Amoxicilina 250 mg', 4500], ['Dexametasona 2 mg/ml (aplicado na clínica)', 3000]]);
  assert.equal(conta.pedido.itens.filter((i) => i.origem === 'receita').reduce((t, i) => t + i.preco_unitario_centavos * i.quantidade, 0), 7500);
});
