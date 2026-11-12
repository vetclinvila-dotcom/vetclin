// Testes do Pix (código copia e cola, chave, nome/cidade), do QR Code e das configurações do Pix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { cnpjValido, cpfValido, crc16, mascararChave, normalizarTextoPix, payloadPix, txidDoPedido, validarChavePix, valorParaPix } from '../public/pix.js';
import { criarBancoLocal } from './d1-local.js';

// ---------- código Pix ----------
test('payloadPix: bate exatamente com o exemplo oficial do Banco Central', () => {
  const p = payloadPix({ chave: '123e4567-e12b-12d1-a456-426655440000', nome: 'Fulano de Tal', cidade: 'BRASILIA', txid: '***' });
  assert.equal(p, '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
});

test('crc16: valor conhecido e formato', () => {
  assert.equal(crc16('123456789'), '29B1');
  assert.equal(crc16(''), 'FFFF');
  assert.match(crc16('abc'), /^[0-9A-F]{4}$/);
});

test('payloadPix: valor com ponto e 2 casas; sem valor omite o campo 54', () => {
  assert.equal(valorParaPix(14500), '145.00');
  assert.equal(valorParaPix(5), '0.05');
  assert.equal(valorParaPix(123456), '1234.56');
  const base = { chave: '52998224725', nome: 'VETCLIN', cidade: 'BARCARENA' };
  const com = payloadPix({ ...base, valorCentavos: 9500 });
  assert.ok(com.includes('540595.00'), com);
  assert.ok(!payloadPix({ ...base, valorCentavos: null }).includes('5406'));
  assert.equal(payloadPix({ ...base, valorCentavos: 0 }), payloadPix({ ...base }));
  // CRC confere: os 4 últimos caracteres são o CRC de tudo antes deles
  assert.equal(com.slice(-4), crc16(com.slice(0, -4)));
  assert.equal(com.slice(-8, -4), '6304');
  assert.throws(() => valorParaPix(-1));
  assert.throws(() => valorParaPix(1.5));
});

test('txid: só letras e números; padrão ***', () => {
  assert.equal(txidDoPedido(12, 1), 'VC12P1');
  assert.equal(txidDoPedido(123456, 3), 'VC123456P3');
  const base = { chave: '52998224725', nome: 'VETCLIN', cidade: 'BARCARENA' };
  assert.ok(payloadPix({ ...base, txid: 'VC12P1' }).includes('62100506VC12P1'));
  assert.ok(payloadPix(base).includes('62070503***'));
  for (const ruim of ['a b', 'ação', 'x'.repeat(26), '', 'a-b']) assert.throws(() => payloadPix({ ...base, txid: ruim }), /txid/, ruim);
  assert.ok(payloadPix({ ...base, txid: 'x'.repeat(25) }));
});

test('payloadPix: recusa texto com acento, muito longo ou vazio', () => {
  const base = { chave: '52998224725', nome: 'VETCLIN', cidade: 'BARCARENA' };
  assert.throws(() => payloadPix({ ...base, nome: 'Clínica' }));
  assert.throws(() => payloadPix({ ...base, cidade: 'São Paulo' }));
  assert.throws(() => payloadPix({ ...base, nome: 'A'.repeat(26) }));
  assert.throws(() => payloadPix({ ...base, cidade: 'A'.repeat(16) }));
  assert.throws(() => payloadPix({ ...base, chave: '' }));
  assert.throws(() => payloadPix({ ...base, chave: 'é@x.com' }));
  assert.throws(() => payloadPix({ ...base, nome: '' }));
});

test('normalizarTextoPix: maiúsculas, sem acento, só caracteres permitidos, corta no tamanho', () => {
  assert.equal(normalizarTextoPix('Clínica Veterinária Ação', 25), 'CLINICA VETERINARIA ACAO');
  assert.equal(normalizarTextoPix('Vetclin Clinica Veterinaria Ltda', 25), 'VETCLIN CLINICA VETERINAR');
  assert.equal(normalizarTextoPix('São João d\'Oeste & Cia!', 15), 'SAO JOAO DOESTE');
  assert.equal(normalizarTextoPix('  a   b  ', 25), 'A B');
  assert.equal(normalizarTextoPix('A.B-C,D;E 9', 25), 'A.B-C,D;E 9');
  assert.equal(normalizarTextoPix('ABCDE FGHIJ', 6), 'ABCDE');
  assert.equal(normalizarTextoPix('***', 10), '');
});

// ---------- chave ----------
// CPF e CNPJ de teste, gerados só para estes testes (os dígitos finais são calculados).
test('CPF: dígitos verificadores', () => {
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(cpfValido('52998224725'));
  assert.ok(!cpfValido('52998224724'));
  assert.ok(!cpfValido('111.111.111-11'));
  assert.ok(!cpfValido('1234567890'));
  assert.deepEqual(validarChavePix('529.982.247-25'), { tipo: 'cpf', chave: '52998224725' });
  assert.throws(() => validarChavePix('529.982.247-24'), /CPF inválido/);
});

test('CNPJ: dígitos verificadores', () => {
  assert.ok(cnpjValido('11.222.333/0001-81'));
  assert.ok(!cnpjValido('11.222.333/0001-82'));
  assert.ok(!cnpjValido('00000000000000'));
  assert.deepEqual(validarChavePix('11.222.333/0001-81'), { tipo: 'cnpj', chave: '11222333000181' });
  assert.deepEqual(validarChavePix('11222333000181'), { tipo: 'cnpj', chave: '11222333000181' });
  assert.throws(() => validarChavePix('11.222.333/0001-82'), /CNPJ/);
});

test('telefone, e-mail e chave aleatória', () => {
  assert.deepEqual(validarChavePix('(91) 99999-0000'), { tipo: 'telefone', chave: '+5591999990000' });
  assert.deepEqual(validarChavePix('+55 91 99999-0000'), { tipo: 'telefone', chave: '+5591999990000' });
  assert.deepEqual(validarChavePix('91999990000'), { tipo: 'telefone', chave: '+5591999990000' });
  assert.deepEqual(validarChavePix('(71) 3333-4444'), { tipo: 'telefone', chave: '+557133334444' });
  assert.throws(() => validarChavePix('(91) 9999-000'), /Telefone inválido/);
  assert.throws(() => validarChavePix('(00) 99999-0000'), /Telefone inválido/);
  assert.deepEqual(validarChavePix('  Ana.Souza@Exemplo.COM.br '), { tipo: 'email', chave: 'ana.souza@exemplo.com.br' });
  for (const ruim of ['ana@', '@x.com', 'ana@x', 'a b@x.com']) assert.throws(() => validarChavePix(ruim), /E-mail/, ruim);
  assert.deepEqual(validarChavePix('123E4567-E12B-12D1-A456-426655440000'), { tipo: 'aleatoria', chave: '123e4567-e12b-12d1-a456-426655440000' });
  assert.throws(() => validarChavePix('123e4567-e12b-12d1-a456-42665544000z'), /aleatória/);
  assert.throws(() => validarChavePix('abc'));
  assert.throws(() => validarChavePix(''));
});

test('mascararChave', () => {
  assert.equal(mascararChave('52998224725'), '***.982.247-**');
  assert.equal(mascararChave('11222333000181'), '**.222.333/****-**');
  assert.equal(mascararChave('+5591999990000'), '+55 (91) *****-0000');
  assert.equal(mascararChave('ana@exemplo.com'), 'a***@exemplo.com');
  assert.equal(mascararChave('123e4567-e12b-12d1-a456-426655440000'), '123e4567-****-****-****-0000');
});

// ---------- configurações (API) ----------
const ORIGEM = 'https://vetclin.exemplo.test';
async function chamar(env, metodo, caminho, { corpo, cookie } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { dados: await res.json().catch(() => null), status: res.status, res };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];
async function ambiente() {
  const env = { DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') }, NOTIFICAR_TESTE: async () => ({ enviados: 0, falhas: 0 }) };
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  assert.equal((await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: 'Recep', login: 'recep', senha: 'senha-forte-123', papel: 'recepcao' } })).status, 201);
  const e = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'recep', senha: 'senha-forte-123' } });
  return { env, admin, recepcao: cookieDe(e.res) };
}
const PATCH = (a, corpo, cookie = a.admin) => chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie, corpo });
const LER = (a, cookie = a.admin) => chamar(a.env, 'GET', '/api/configuracoes/clinica', { cookie });

test('Pix nas configurações: começa vazio e qualquer pessoa logada lê', async () => {
  const a = await ambiente();
  const r = await LER(a, a.recepcao);
  assert.equal(r.status, 200);
  assert.deepEqual([r.dados.pix_chave, r.dados.pix_nome, r.dados.pix_cidade], ['', '', '']);
  assert.equal((await chamar(a.env, 'GET', '/api/configuracoes/clinica')).status, 401);
});

test('Pix nas configurações: só administrador altera (403) e exige o cabeçalho CSRF', async () => {
  const a = await ambiente();
  const corpo = { pix_chave: '529.982.247-25', pix_nome: 'Vetclin', pix_cidade: 'Barcarena' };
  assert.equal((await PATCH(a, corpo, a.recepcao)).status, 403);
  assert.equal((await LER(a)).dados.pix_chave, '');
  const semCsrf = await worker.fetch(new Request(ORIGEM + '/api/configuracoes/clinica', { method: 'PATCH', headers: { Cookie: a.admin, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }), a.env);
  assert.ok(semCsrf.status >= 400);
});

test('Pix nas configurações: CPF válido vira só dígitos; nome e cidade são normalizados ao salvar', async () => {
  const a = await ambiente();
  const r = await PATCH(a, { pix_chave: '529.982.247-25', pix_nome: 'Vetclin Clínica Veterinária Ltda', pix_cidade: 'São Brás do Barcarena' });
  assert.equal(r.status, 200);
  assert.equal(r.dados.pix_chave, '52998224725');
  assert.equal(r.dados.pix_nome, 'VETCLIN CLINICA VETERINAR');
  assert.equal(r.dados.pix_cidade, 'SAO BRAS DO BAR');
  assert.ok(r.dados.pix_nome.length <= 25 && r.dados.pix_cidade.length <= 15);
  const l = (await LER(a)).dados;
  assert.equal(l.pix_chave, '52998224725');
  // o que foi salvo gera um código Pix válido
  assert.ok(payloadPix({ chave: l.pix_chave, nome: l.pix_nome, cidade: l.pix_cidade, valorCentavos: 100 }));
  // e fica registrado em registro_acoes
  const acoes = a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao = 'alterar_dados_clinica'`).get().n;
  assert.equal(acoes, 1);
});

test('Pix nas configurações: CPF e CNPJ com dígito errado são recusados (400, em português)', async () => {
  const a = await ambiente();
  const base = { pix_nome: 'Vetclin', pix_cidade: 'Barcarena' };
  const ruimCpf = await PATCH(a, { ...base, pix_chave: '529.982.247-24' });
  assert.equal(ruimCpf.status, 400);
  assert.match(ruimCpf.dados.erro ?? ruimCpf.dados.mensagem ?? JSON.stringify(ruimCpf.dados), /CPF inválido/);
  assert.equal((await PATCH(a, { ...base, pix_chave: '111.111.111-11' })).status, 400);
  assert.equal((await PATCH(a, { ...base, pix_chave: '11.222.333/0001-82' })).status, 400);
  const ok = await PATCH(a, { ...base, pix_chave: '11.222.333/0001-81' });
  assert.equal(ok.status, 200);
  assert.equal(ok.dados.pix_chave, '11222333000181');
  assert.equal((await LER(a)).dados.pix_chave, '11222333000181');
});

test('Pix nas configurações: telefone, e-mail e chave aleatória', async () => {
  const a = await ambiente();
  const base = { pix_nome: 'Vetclin', pix_cidade: 'Barcarena' };
  assert.equal((await PATCH(a, { ...base, pix_chave: '(91) 99999-0000' })).dados.pix_chave, '+5591999990000');
  assert.equal((await PATCH(a, { ...base, pix_chave: 'Contato@Vetclin-Exemplo.com' })).dados.pix_chave, 'contato@vetclin-exemplo.com');
  assert.equal((await PATCH(a, { ...base, pix_chave: '123E4567-E12B-12D1-A456-426655440000' })).dados.pix_chave, '123e4567-e12b-12d1-a456-426655440000');
  assert.equal((await PATCH(a, { ...base, pix_chave: 'telefone-ruim' })).status, 400);
  assert.equal((await PATCH(a, { ...base, pix_chave: 'sem-arroba.com' })).status, 400);
  // a chave anterior continua valendo depois de um erro
  assert.equal((await LER(a)).dados.pix_chave, '123e4567-e12b-12d1-a456-426655440000');
});

test('Pix nas configurações: com chave, nome e cidade são obrigatórios; chave vazia desliga o QR', async () => {
  const a = await ambiente();
  assert.equal((await PATCH(a, { pix_chave: '52998224725' })).status, 400);
  assert.equal((await PATCH(a, { pix_chave: '52998224725', pix_nome: 'Vetclin' })).status, 400);
  assert.equal((await PATCH(a, { pix_chave: '52998224725', pix_nome: '***', pix_cidade: 'Barcarena' })).status, 400);
  assert.equal((await LER(a)).dados.pix_chave, '');
  assert.equal((await PATCH(a, { pix_chave: '52998224725', pix_nome: 'Vetclin', pix_cidade: 'Barcarena' })).status, 200);
  // só trocar a cidade mantém o resto
  const c = await PATCH(a, { pix_cidade: 'Belém' });
  assert.equal(c.dados.pix_cidade, 'BELEM');
  assert.equal(c.dados.pix_chave, '52998224725');
  // vazio desliga
  const v = await PATCH(a, { pix_chave: '   ' });
  assert.equal(v.status, 200);
  assert.equal(v.dados.pix_chave, '');
  assert.equal((await LER(a)).dados.pix_chave, '');
});
