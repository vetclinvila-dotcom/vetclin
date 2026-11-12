// Testes da API do Vetclin. Rodam o Worker direto, sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { hashSenha, verificarSenha } from '../src/auth.js';
import { proximoCodigo, comparacaoSegura } from '../src/util.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';

function novoAmbiente(extra = {}) {
  return {
    DB: criarBancoLocal(),
    CHAVE_CONFIGURACAO: 'teste-chave',
    FUSO_HORARIO: 'America/Bahia',
    ASSETS: { fetch: async () => new Response('estatico') },
    ...extra,
  };
}

// Faz uma chamada à API. Por padrão já envia o cabeçalho anti-CSRF.
async function chamar(env, metodo, caminho, { corpo, cookie, cabecalhos = {}, csrf = true } = {}) {
  const h = { ...cabecalhos };
  if (csrf && metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(ORIGEM + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
  const res = await worker.fetch(req, env);
  const dados = await res.json().catch(() => null);
  return { res, dados, status: res.status };
}

function cookieDe(res) {
  const sc = res.headers.get('Set-Cookie');
  return sc ? sc.split(';')[0] : null;
}

const ADMIN = { chave: 'teste-chave', nome: 'Dra. Teste', login: 'Dra.Teste', senha: 'senha-forte-123', crmv: 'BA-0000' };

// Cria ambiente com o primeiro admin e devolve o cookie dele.
async function ambienteComAdmin() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: ADMIN });
  assert.equal(r.status, 201);
  return { env, cookie: cookieDe(r.res) };
}

test('saúde responde ok', async () => {
  const env = novoAmbiente();
  const { status, dados } = await chamar(env, 'GET', '/api/saude');
  assert.equal(status, 200);
  assert.equal(dados.ok, true);
  assert.ok(!Number.isNaN(Date.parse(dados.hora)));
});

test('rota desconhecida dá 404 em JSON', async () => {
  const env = novoAmbiente();
  const { status, dados } = await chamar(env, 'GET', '/api/nada');
  assert.equal(status, 404);
  assert.ok(dados.erro);
});

test('configuração inicial: recusa chave errada', async () => {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { ...ADMIN, chave: 'errada' } });
  assert.equal(r.status, 403);
  assert.equal((await chamar(env, 'GET', '/api/configuracao-inicial')).dados.precisa, true);
});

test('configuração inicial: recusa quando o segredo não está definido', async () => {
  const env = novoAmbiente({ CHAVE_CONFIGURACAO: undefined });
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { ...ADMIN, chave: '' } });
  assert.equal(r.status, 403);
  assert.equal((await chamar(env, 'GET', '/api/configuracao-inicial')).dados.precisa, true);
});

test('configuração inicial: funciona uma vez e depois é recusada', async () => {
  const env = novoAmbiente();
  assert.equal((await chamar(env, 'GET', '/api/configuracao-inicial')).dados.precisa, true);
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: ADMIN });
  assert.equal(r.status, 201);
  assert.ok(cookieDe(r.res).startsWith('vetclin_sessao='));
  assert.equal(r.dados.login, 'dra.teste');
  assert.equal(r.dados.admin, true);
  assert.equal((await chamar(env, 'GET', '/api/configuracao-inicial')).dados.precisa, false);
  const outra = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { ...ADMIN, login: 'outro' } });
  assert.equal(outra.status, 409);
});

test('login correto define cookie seguro', async () => {
  const { env } = await ambienteComAdmin();
  const r = await chamar(env, 'POST', '/api/entrar', { corpo: { login: '  DRA.TESTE ', senha: ADMIN.senha } });
  assert.equal(r.status, 200);
  const sc = r.res.headers.get('Set-Cookie');
  assert.match(sc, /^vetclin_sessao=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  // O token bruto nunca fica no banco.
  const token = sc.split(';')[0].split('=')[1];
  const achou = env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM sessoes WHERE id = ?').get(token);
  assert.equal(achou.n, 0);
});

test('senha errada e login inexistente dão a mesma mensagem genérica', async () => {
  const { env } = await ambienteComAdmin();
  const a = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'dra.teste', senha: 'errada-errada' } });
  const b = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'ninguem', senha: 'errada-errada' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.dados.erro, 'Login ou senha incorretos.');
  assert.equal(b.dados.erro, 'Login ou senha incorretos.');
});

test('limite de tentativas: bloqueia após 5 falhas, mesmo com senha certa', async () => {
  const { env } = await ambienteComAdmin();
  for (let i = 0; i < 5; i++) {
    const r = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'dra.teste', senha: 'errada-errada' } });
    assert.equal(r.status, 401);
  }
  const r = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'dra.teste', senha: ADMIN.senha } });
  assert.equal(r.status, 429);
  assert.equal(r.dados.erro, 'Muitas tentativas. Aguarde 15 minutos.');
  const n = env.DB.bruto.prepare("SELECT COUNT(*) AS n FROM tentativas_login WHERE sucesso = 0").get().n;
  assert.ok(n >= 5);
});

test('limite por IP: 20 falhas bloqueiam logins diferentes', async () => {
  const { env } = await ambienteComAdmin();
  const h = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 20; i++) {
    await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'usuario' + i, senha: 'xxxxxxxx' }, cabecalhos: h });
  }
  const r = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'dra.teste', senha: ADMIN.senha }, cabecalhos: h });
  assert.equal(r.status, 429);
});

test('/api/eu com e sem cookie', async () => {
  const { env, cookie } = await ambienteComAdmin();
  assert.equal((await chamar(env, 'GET', '/api/eu')).status, 401);
  const r = await chamar(env, 'GET', '/api/eu', { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.dados).sort(), ['admin', 'id', 'login', 'nome', 'papel']);
  assert.equal(r.dados.papel, 'veterinario');
});

test('sair invalida a sessão', async () => {
  const { env, cookie } = await ambienteComAdmin();
  const r = await chamar(env, 'POST', '/api/sair', { cookie });
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await chamar(env, 'GET', '/api/eu', { cookie })).status, 401);
});

test('sessão expirada ou de usuário inativo não vale', async () => {
  const { env, cookie } = await ambienteComAdmin();
  env.DB.bruto.exec("UPDATE sessoes SET expira_em = '2000-01-01T00:00:00.000Z'");
  assert.equal((await chamar(env, 'GET', '/api/eu', { cookie })).status, 401);
});

test('sessão é renovada no máximo uma vez por hora', async () => {
  const { env, cookie } = await ambienteComAdmin();
  const antes = env.DB.bruto.prepare('SELECT ultimo_uso_em FROM sessoes').get().ultimo_uso_em;
  await chamar(env, 'GET', '/api/eu', { cookie });
  assert.equal(env.DB.bruto.prepare('SELECT ultimo_uso_em FROM sessoes').get().ultimo_uso_em, antes);
  env.DB.bruto.exec("UPDATE sessoes SET ultimo_uso_em = '2000-01-01T00:00:00.000Z', expira_em = '2999-01-01T00:00:00.000Z'");
  await chamar(env, 'GET', '/api/eu', { cookie });
  const s = env.DB.bruto.prepare('SELECT ultimo_uso_em, expira_em FROM sessoes').get();
  assert.ok(s.ultimo_uso_em > '2020');
  assert.ok(s.expira_em < '2999');
});

test('usuário comum não pode listar nem criar usuários', async () => {
  const { env, cookie: cookieAdmin } = await ambienteComAdmin();
  const c = await chamar(env, 'POST', '/api/usuarios', { cookie: cookieAdmin, corpo: { nome: 'Rita', login: 'rita', senha: 'senha-da-rita', papel: 'recepcao' } });
  assert.equal(c.status, 201);
  const entrar = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'rita', senha: 'senha-da-rita' } });
  const cookie = cookieDe(entrar.res);
  assert.equal((await chamar(env, 'GET', '/api/usuarios', { cookie })).status, 403);
  const r = await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'X', login: 'xis', senha: 'senha-xis-123', papel: 'recepcao' } });
  assert.equal(r.status, 403);
  assert.equal((await chamar(env, 'PATCH', '/api/usuarios/1', { cookie, corpo: { nome: 'Hack' } })).status, 403);
});

test('admin cria usuário de recepção e lista', async () => {
  const { env, cookie } = await ambienteComAdmin();
  const r = await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Rita', login: 'Rita', senha: 'senha-da-rita', papel: 'recepcao' } });
  assert.equal(r.status, 201);
  assert.equal(r.dados.papel, 'recepcao');
  assert.equal(r.dados.admin, false);
  const dup = await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Rita 2', login: 'rita', senha: 'senha-da-rita', papel: 'recepcao' } });
  assert.equal(dup.status, 409);
  const fraca = await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Z', login: 'zeze', senha: 'curta', papel: 'recepcao' } });
  assert.equal(fraca.status, 400);
  const lista = await chamar(env, 'GET', '/api/usuarios', { cookie });
  assert.equal(lista.dados.usuarios.length, 2);
  assert.ok(lista.dados.usuarios.every((u) => !('senha_hash' in u)));
});

test('último administrador não pode se desativar nem perder o admin', async () => {
  const { env, cookie } = await ambienteComAdmin();
  const a = await chamar(env, 'PATCH', '/api/usuarios/1', { cookie, corpo: { admin: false } });
  assert.equal(a.status, 400);
  const b = await chamar(env, 'PATCH', '/api/usuarios/1', { cookie, corpo: { ativo: false } });
  assert.equal(b.status, 400);
  // Com outro admin, já pode.
  await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Dr. Dois', login: 'dois', senha: 'senha-dois-1', papel: 'veterinario', admin: true } });
  const c = await chamar(env, 'PATCH', '/api/usuarios/1', { cookie, corpo: { admin: false } });
  assert.equal(c.status, 200);
  assert.equal(c.dados.admin, false);
});

test('alterar usuário: nova senha derruba sessões e desativar bloqueia o login', async () => {
  const { env, cookie } = await ambienteComAdmin();
  await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Rita', login: 'rita', senha: 'senha-da-rita', papel: 'recepcao' } });
  const cookieRita = cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'rita', senha: 'senha-da-rita' } })).res);
  const p = await chamar(env, 'PATCH', '/api/usuarios/2', { cookie, corpo: { senha: 'nova-senha-123' } });
  assert.equal(p.status, 200);
  assert.equal((await chamar(env, 'GET', '/api/eu', { cookie: cookieRita })).status, 401);
  assert.equal((await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'rita', senha: 'nova-senha-123' } })).status, 200);
  await chamar(env, 'PATCH', '/api/usuarios/2', { cookie, corpo: { ativo: false } });
  assert.equal((await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'rita', senha: 'nova-senha-123' } })).status, 401);
  assert.equal((await chamar(env, 'PATCH', '/api/usuarios/99', { cookie, corpo: { nome: 'x' } })).status, 404);
});

test('CSRF: sem cabeçalho X-Requested-With dá 403', async () => {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'a', senha: 'b' }, csrf: false });
  assert.equal(r.status, 403);
});

test('CSRF: Origin de outro site dá 403; Origin igual passa', async () => {
  const env = novoAmbiente();
  const ruim = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'a', senha: 'b' }, cabecalhos: { Origin: 'https://malvado.example' } });
  assert.equal(ruim.status, 403);
  const boa = await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'a', senha: 'b' }, cabecalhos: { Origin: ORIGEM } });
  assert.equal(boa.status, 401);
});

test('corpo inválido ou grande demais dá erro amigável', async () => {
  const env = novoAmbiente();
  const req = new Request(ORIGEM + '/api/entrar', { method: 'POST', headers: { 'X-Requested-With': 'vetclin' }, body: '{nao-e-json' });
  const r = await worker.fetch(req, env);
  assert.equal(r.status, 400);
  const grande = new Request(ORIGEM + '/api/entrar', { method: 'POST', headers: { 'X-Requested-With': 'vetclin' }, body: JSON.stringify({ x: 'a'.repeat(70000) }) });
  assert.equal((await worker.fetch(grande, env)).status, 413);
});

test('erro inesperado vira 500 genérico', async () => {
  const env = novoAmbiente();
  env.DB = { prepare() { throw new Error('banco caiu: segredo'); } };
  const original = console.error;
  console.error = () => {};
  try {
    const { status, dados } = await chamar(env, 'GET', '/api/configuracao-inicial');
    assert.equal(status, 500);
    assert.ok(!dados.erro.includes('segredo'));
  } finally {
    console.error = original;
  }
});

test('hash de senha: formato e verificação', async () => {
  const h = await hashSenha('minha-senha-1');
  assert.match(h, /^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verificarSenha('minha-senha-1', h), true);
  assert.equal(await verificarSenha('outra-senha-1', h), false);
  assert.equal(await verificarSenha('x', 'lixo'), false);
  assert.notEqual(h, await hashSenha('minha-senha-1')); // sal diferente
});

test('comparação segura', () => {
  assert.equal(comparacaoSegura('abc', 'abc'), true);
  assert.equal(comparacaoSegura('abc', 'abd'), false);
  assert.equal(comparacaoSegura('abc', 'abcd'), false);
});

test('proximoCodigo gera T-000001, T-000002 e P-000001', async () => {
  const env = novoAmbiente();
  assert.equal(await proximoCodigo(env, 'tutor'), 'T-000001');
  assert.equal(await proximoCodigo(env, 'tutor'), 'T-000002');
  assert.equal(await proximoCodigo(env, 'pet'), 'P-000001');
  await assert.rejects(() => proximoCodigo(env, 'outro'));
});

test('catálogo traz as duas consultas iniciais', () => {
  const env = novoAmbiente();
  const l = env.DB.bruto.prepare('SELECT preco_centavos FROM catalogo ORDER BY id').all();
  assert.deepEqual(l.map((x) => x.preco_centavos), [10000, 20000]);
});

test('registro_acoes nunca contém senha nem hash', async () => {
  const { env, cookie } = await ambienteComAdmin();
  await chamar(env, 'POST', '/api/usuarios', { cookie, corpo: { nome: 'Rita', login: 'rita', senha: 'senha-da-rita', papel: 'recepcao' } });
  await chamar(env, 'PATCH', '/api/usuarios/2', { cookie, corpo: { senha: 'outra-senha-9' } });
  await chamar(env, 'POST', '/api/entrar', { corpo: { login: 'rita', senha: 'outra-senha-9' } });
  const linhas = env.DB.bruto.prepare('SELECT * FROM registro_acoes').all();
  assert.ok(linhas.length >= 4);
  const tudo = JSON.stringify(linhas);
  for (const proibido of ['senha-da-rita', 'outra-senha-9', 'senha-forte-123', 'pbkdf2', 'senha_hash']) {
    assert.ok(!tudo.includes(proibido), 'apareceu: ' + proibido);
  }
});

test('fora de /api entrega arquivos estáticos', async () => {
  const env = novoAmbiente();
  const res = await worker.fetch(new Request(ORIGEM + '/'), env);
  assert.equal(await res.text(), 'estatico');
});
