// Servidor do Vetclin (Cloudflare Worker).
// Recebe as chamadas /api/* e responde em JSON. Arquivos estáticos
// (telas, CSS) são entregues direto pela Cloudflare.
import {
  apagarSessao, cookieSessao, criarSessao, exigirAdmin, exigirLogin,
  hashSenha, lerSessao, normalizarLogin, validarSenha, verificarSenha,
} from './auth.js';
import { ErroHttp, agoraISO, comparacaoSegura, ipDe, json, lerJson, registrarAcao, texto } from './util.js';
import { ROTAS_CADASTRO, normalizarWhatsapp } from './cadastro.js';
import { ROTAS_ATENDIMENTOS } from './atendimentos.js';
import { ROTAS_FOTOS } from './fotos.js';
import { ROTAS_RECEITAS } from './receitas.js';
import { ROTAS_PUSH } from './notificacoes.js';
import { ROTAS_PEDIDOS } from './pedidos.js';
import { ROTAS_CATALOGO } from './catalogo.js';
import { ROTAS_INTEGRACAO } from './integracao.js';
import { ROTAS_PRONTUARIO } from './prontuario.js';
import { ROTAS_INTERNACAO } from './internacao.js';

const JANELA_MS = 15 * 60 * 1000; // 15 minutos
const LIMITE_POR_LOGIN = 5;
const LIMITE_POR_IP = 20;
const PAPEIS = ['recepcao', 'veterinario', 'suporte'];
const LOGIN_VALIDO = /^[a-z0-9._-]{3,32}$/;

// ---------- apoio ----------
async function contarUsuarios(env) {
  const l = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first();
  return l.n;
}

// Mostra ao front só os dados seguros de um usuário.
function usuarioPublico(u) {
  return { id: u.id, nome: u.nome, login: u.login, papel: u.papel, admin: u.admin === 1 || u.admin === true, crmv: u.crmv ?? null, whatsapp: u.whatsapp ?? null, ativo: u.ativo === undefined ? true : u.ativo === 1 };
}

async function contarFalhas(env, coluna, valor) {
  const corte = new Date(Date.now() - JANELA_MS).toISOString();
  const l = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tentativas_login WHERE ${coluna} = ? AND sucesso = 0 AND em >= ?`)
    .bind(valor, corte).first();
  return l.n;
}

async function registrarTentativa(env, login, ip, sucesso) {
  await env.DB.prepare('INSERT INTO tentativas_login (login, ip, sucesso, em) VALUES (?, ?, ?, ?)')
    .bind(login, ip, sucesso ? 1 : 0, agoraISO()).run();
}

// Bloqueia se houver falhas demais para este login ou IP.
async function verificarLimite(env, login, ip) {
  const porLogin = await contarFalhas(env, 'login', login);
  const porIp = ip ? await contarFalhas(env, 'ip', ip) : 0;
  if (porLogin >= LIMITE_POR_LOGIN || porIp >= LIMITE_POR_IP) {
    throw new ErroHttp(429, 'Muitas tentativas. Aguarde 15 minutos.');
  }
}

// Resposta de login bem-sucedido: cria sessão e cookie.
async function respostaComSessao(env, request, usuarioId, dados, status = 200) {
  const token = await criarSessao(env, usuarioId, request.headers.get('User-Agent'));
  return json(dados, status, { 'Set-Cookie': cookieSessao(token) });
}

// WhatsApp opcional do usuário: vazio vira null; senão vira E.164 (+5571999998888).
function lerWhatsappUsuario(valor) {
  const t = String(valor ?? '').trim();
  return t ? normalizarWhatsapp(t).e164 : null;
}

// ---------- rotas ----------
async function saude() {
  return json({ ok: true, hora: agoraISO() });
}

async function configuracaoInicialVer(request, env) {
  return json({ precisa: (await contarUsuarios(env)) === 0 });
}

async function configuracaoInicialCriar(request, env) {
  const ip = ipDe(request);
  const corpo = await lerJson(request);
  if ((await contarUsuarios(env)) > 0) throw new ErroHttp(409, 'O sistema já foi configurado.');
  if (!env.CHAVE_CONFIGURACAO) throw new ErroHttp(403, 'A chave de configuração não está definida no servidor.');

  const rotulo = '(configuracao)';
  await verificarLimite(env, rotulo, ip);
  if (!comparacaoSegura(String(corpo.chave ?? ''), env.CHAVE_CONFIGURACAO)) {
    await registrarTentativa(env, rotulo, ip, false);
    throw new ErroHttp(403, 'Chave de configuração incorreta.');
  }

  const nome = texto(corpo.nome, 'nome');
  const login = normalizarLogin(corpo.login);
  if (!LOGIN_VALIDO.test(login)) throw new ErroHttp(400, 'O login deve ter de 3 a 32 letras, números, ponto, hífen ou sublinhado.');
  validarSenha(corpo.senha);
  const crmv = texto(corpo.crmv, 'CRMV', { obrigatorio: false, max: 30 }) || null;
  const agora = agoraISO();

  // Só insere se a tabela ainda estiver vazia (evita corrida entre duas chamadas).
  const r = await env.DB.prepare(
    `INSERT INTO usuarios (nome, login, senha_hash, papel, admin, crmv, ativo, criado_em, atualizado_em)
     SELECT ?, ?, ?, 'veterinario', 1, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
  ).bind(nome, login, await hashSenha(corpo.senha), crmv, agora, agora).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'O sistema já foi configurado.');

  const id = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: id, acao: 'configuracao_inicial', entidade: 'usuarios', entidadeId: id, depois: { nome, login, papel: 'veterinario', admin: true }, ip });
  await registrarTentativa(env, login, ip, true);
  return respostaComSessao(env, request, id, { id, nome, login, papel: 'veterinario', admin: true }, 201);
}

async function entrar(request, env) {
  const ip = ipDe(request);
  const corpo = await lerJson(request);
  const login = normalizarLogin(corpo.login);
  const senha = String(corpo.senha ?? '');
  await verificarLimite(env, login, ip);

  const u = await env.DB.prepare('SELECT * FROM usuarios WHERE login = ?').bind(login).first();
  // Se o usuário não existe, ainda calculamos um hash para gastar o mesmo tempo.
  const ok = u && u.ativo === 1
    ? await verificarSenha(senha, u.senha_hash)
    : (await verificarSenha(senha, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);

  await registrarTentativa(env, login, ip, ok);
  if (!ok) throw new ErroHttp(401, 'Login ou senha incorretos.');

  await registrarAcao(env, { usuarioId: u.id, acao: 'entrar', entidade: 'sessoes', ip });
  return respostaComSessao(env, request, u.id, usuarioPublico(u));
}

async function sair(request, env) {
  const usuario = await lerSessao(request, env);
  await apagarSessao(request, env);
  if (usuario) await registrarAcao(env, { usuarioId: usuario.id, acao: 'sair', entidade: 'sessoes', ip: ipDe(request) });
  return json({ ok: true }, 200, { 'Set-Cookie': cookieSessao(null) });
}

async function eu(request, env) {
  const u = await exigirLogin(request, env);
  return json({ id: u.id, nome: u.nome, login: u.login, papel: u.papel, admin: u.admin });
}

async function usuariosListar(request, env) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare('SELECT id, nome, login, papel, admin, crmv, whatsapp, ativo FROM usuarios ORDER BY nome').all();
  return json({ usuarios: results.map(usuarioPublico) });
}

async function usuariosCriar(request, env) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const nome = texto(c.nome, 'nome');
  const login = normalizarLogin(c.login);
  if (!LOGIN_VALIDO.test(login)) throw new ErroHttp(400, 'O login deve ter de 3 a 32 letras, números, ponto, hífen ou sublinhado.');
  if (!PAPEIS.includes(c.papel)) throw new ErroHttp(400, 'Escolha o papel: recepção, veterinário ou suporte.');
  validarSenha(c.senha);
  const crmv = texto(c.crmv, 'CRMV', { obrigatorio: false, max: 30 }) || null;
  const admin = c.admin ? 1 : 0;
  const whatsapp = lerWhatsappUsuario(c.whatsapp);
  const agora = agoraISO();
  try {
    const r = await env.DB.prepare(
      `INSERT INTO usuarios (nome, login, senha_hash, papel, admin, crmv, whatsapp, ativo, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(nome, login, await hashSenha(c.senha), c.papel, admin, crmv, whatsapp, agora, agora).run();
    const id = r.meta.last_row_id;
    await registrarAcao(env, { usuarioId: adm.id, acao: 'criar_usuario', entidade: 'usuarios', entidadeId: id, depois: { nome, login, papel: c.papel, admin: !!admin, crmv, whatsapp }, ip: ipDe(request) });
    return json({ id, nome, login, papel: c.papel, admin: !!admin, crmv, whatsapp, ativo: true }, 201);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ErroHttp(409, 'Já existe um usuário com esse login.');
    throw e;
  }
}

async function usuariosAlterar(request, env, id) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const antes = await env.DB.prepare('SELECT * FROM usuarios WHERE id = ?').bind(id).first();
  if (!antes) throw new ErroHttp(404, 'Usuário não encontrado.');

  const novo = { nome: antes.nome, papel: antes.papel, admin: antes.admin, ativo: antes.ativo, crmv: antes.crmv, whatsapp: antes.whatsapp ?? null, senha_hash: antes.senha_hash };
  if (c.nome !== undefined) novo.nome = texto(c.nome, 'nome');
  if (c.papel !== undefined) {
    if (!PAPEIS.includes(c.papel)) throw new ErroHttp(400, 'Escolha o papel: recepção, veterinário ou suporte.');
    novo.papel = c.papel;
  }
  if (c.admin !== undefined) novo.admin = c.admin ? 1 : 0;
  if (c.ativo !== undefined) novo.ativo = c.ativo ? 1 : 0;
  if (c.crmv !== undefined) novo.crmv = texto(c.crmv, 'CRMV', { obrigatorio: false, max: 30 }) || null;
  if (c.whatsapp !== undefined) novo.whatsapp = lerWhatsappUsuario(c.whatsapp);
  const trocouSenha = c.senha !== undefined && c.senha !== '';
  if (trocouSenha) {
    validarSenha(c.senha);
    novo.senha_hash = await hashSenha(c.senha);
  }

  // Não pode sobrar o sistema sem nenhum administrador ativo.
  const eraAdminAtivo = antes.admin === 1 && antes.ativo === 1;
  const continuaAdminAtivo = novo.admin === 1 && novo.ativo === 1;
  if (eraAdminAtivo && !continuaAdminAtivo) {
    const o = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios WHERE admin = 1 AND ativo = 1 AND id <> ?').bind(id).first();
    if (o.n === 0) throw new ErroHttp(400, 'Este é o último administrador ativo. Não é possível desativá-lo nem remover o acesso de administrador.');
  }

  await env.DB.prepare('UPDATE usuarios SET nome = ?, papel = ?, admin = ?, ativo = ?, crmv = ?, whatsapp = ?, senha_hash = ?, atualizado_em = ? WHERE id = ?')
    .bind(novo.nome, novo.papel, novo.admin, novo.ativo, novo.crmv, novo.whatsapp, novo.senha_hash, agoraISO(), id).run();
  // Se desativou ou trocou a senha, derruba as sessões abertas dessa pessoa.
  if (novo.ativo === 0 || trocouSenha) {
    await env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(id).run();
  }

  const resumo = (u) => ({ nome: u.nome, papel: u.papel, admin: u.admin === 1, ativo: u.ativo === 1, crmv: u.crmv, whatsapp: u.whatsapp ?? null });
  await registrarAcao(env, { usuarioId: adm.id, acao: 'alterar_usuario', entidade: 'usuarios', entidadeId: id, antes: resumo(antes), depois: { ...resumo(novo), senha_alterada: trocouSenha }, ip: ipDe(request) });
  return json(usuarioPublico({ ...novo, id, login: antes.login }));
}

// Tabela de rotas: [método, caminho, função].
const ROTAS = [
  ['GET', '/api/saude', saude],
  ['GET', '/api/configuracao-inicial', configuracaoInicialVer],
  ['POST', '/api/configuracao-inicial', configuracaoInicialCriar],
  ['POST', '/api/entrar', entrar],
  ['POST', '/api/sair', sair],
  ['GET', '/api/eu', eu],
  ['GET', '/api/usuarios', usuariosListar],
  ['POST', '/api/usuarios', usuariosCriar],
  ['PATCH', '/api/usuarios/:id', usuariosAlterar],
  ...ROTAS_CADASTRO,
  ...ROTAS_ATENDIMENTOS,
  ...ROTAS_FOTOS,
  ...ROTAS_RECEITAS,
  ...ROTAS_PUSH,
  ...ROTAS_PEDIDOS,
  ...ROTAS_CATALOGO,
  ...ROTAS_INTEGRACAO,
  ...ROTAS_PRONTUARIO,
  ...ROTAS_INTERNACAO,
].map(([metodo, caminho, funcao]) => ({
  metodo, funcao,
  padrao: new RegExp('^' + caminho.replace(/:[a-z]+/g, '([^/]+)') + '/?$'),
}));

// Proteção contra CSRF: exige cabeçalho próprio e Origin igual ao do site.
function verificarCsrf(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  if (request.headers.get('X-Requested-With') !== 'vetclin') {
    throw new ErroHttp(403, 'Requisição não permitida.');
  }
  const origem = request.headers.get('Origin');
  if (origem && origem !== url.origin) throw new ErroHttp(403, 'Requisição não permitida.');
}

async function tratarApi(request, env, url) {
  // Rotas da integração com o Google: SÓ leitura (GET) e só com chave no cabeçalho Authorization
  // (sem cookies). Por isso os GETs delas não usam o cabeçalho anti-CSRF; qualquer outro método é recusado.
  if (url.pathname.startsWith('/api/integracao/') && request.method !== 'GET') throw new ErroHttp(405, 'Método não permitido.');
  verificarCsrf(request, url);
  let caminhoExiste = false;
  for (const rota of ROTAS) {
    const m = rota.padrao.exec(url.pathname);
    if (!m) continue;
    caminhoExiste = true;
    if (rota.metodo !== request.method) continue;
    const params = m.slice(1).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return rota.funcao(request, env, ...params);
  }
  if (caminhoExiste) throw new ErroHttp(405, 'Método não permitido.');
  throw new ErroHttp(404, 'Rota não encontrada.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // Fora de /api: entrega os arquivos estáticos.
      return env.ASSETS.fetch(request);
    }
    try {
      return await tratarApi(request, env, url);
    } catch (e) {
      if (e instanceof ErroHttp) return json({ erro: e.message }, e.status);
      console.error('Erro inesperado:', e);
      return json({ erro: 'Algo deu errado. Tente novamente em instantes.' }, 500);
    }
  },
};
