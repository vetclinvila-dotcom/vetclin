// Senhas, sessões (login) e permissões.
import { ErroHttp, agoraISO, comparacaoSegura } from './util.js';

const ITERACOES = 100000; // máximo permitido pelo Cloudflare Workers
const NOME_COOKIE = 'vetclin_sessao';
const DURACAO_SESSAO_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const RENOVAR_APOS_MS = 60 * 60 * 1000; // renova no máximo 1 vez por hora

// ---------- conversões ----------
function paraBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function deBase64(texto) {
  return Uint8Array.from(atob(texto), (c) => c.charCodeAt(0));
}
function paraBase64Url(bytes) {
  return paraBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function paraHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- senhas ----------
async function derivar(senha, sal, iteracoes) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, chave, 256);
  return new Uint8Array(bits);
}

// Transforma a senha em um "hash" para guardar: pbkdf2$100000$<sal>$<hash>
export async function hashSenha(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(senha, sal, ITERACOES);
  return `pbkdf2$${ITERACOES}$${paraBase64(sal)}$${paraBase64(hash)}`;
}

// Confere se a senha digitada corresponde ao hash guardado.
export async function verificarSenha(senha, guardado) {
  try {
    const [tipo, iter, sal, hash] = String(guardado).split('$');
    if (tipo !== 'pbkdf2') return false;
    const calculado = await derivar(String(senha), deBase64(sal), Number(iter));
    return comparacaoSegura(paraBase64(calculado), hash);
  } catch {
    return false;
  }
}

// Regra de senha: mínimo de 8 caracteres.
export function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw new ErroHttp(400, 'A senha deve ter pelo menos 8 caracteres.');
  }
}

// Login sempre em minúsculo e sem espaços nas pontas.
export function normalizarLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

// ---------- sessões ----------
async function sha256Hex(texto) {
  return paraHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

// Cria uma sessão. Retorna o token (vai para o cookie) — só o hash dele fica no banco.
export async function criarSessao(env, usuarioId, agente = null) {
  const token = paraBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const id = await sha256Hex(token);
  const agora = new Date();
  await env.DB.prepare(
    'INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ultimo_uso_em, agente) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, usuarioId, agora.toISOString(), new Date(agora.getTime() + DURACAO_SESSAO_MS).toISOString(), agora.toISOString(), agente ? agente.slice(0, 200) : null)
    .run();
  return token;
}

function lerCookie(request, nome) {
  const cabecalho = request.headers.get('Cookie') || '';
  for (const parte of cabecalho.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return v.join('=');
  }
  return null;
}

// Texto do cookie de sessão (ou do cookie que apaga a sessão).
export function cookieSessao(token) {
  const base = `${NOME_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  return token ? `${base}; Max-Age=${DURACAO_SESSAO_MS / 1000}` : `${base}; Max-Age=0`;
}

// Apaga a sessão do banco (usado no "Sair").
export async function apagarSessao(request, env) {
  const token = lerCookie(request, NOME_COOKIE);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessoes WHERE id = ?').bind(await sha256Hex(token)).run();
}

// Descobre quem é o usuário logado. Retorna null se não houver sessão válida.
export async function lerSessao(request, env) {
  const token = lerCookie(request, NOME_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const linha = await env.DB.prepare(
    `SELECT s.id AS sessao_id, s.expira_em, s.ultimo_uso_em,
            u.id, u.nome, u.login, u.papel, u.admin, u.crmv
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.id = ? AND u.ativo = 1`
  )
    .bind(id)
    .first();
  if (!linha) return null;
  const agora = agoraISO();
  if (linha.expira_em <= agora) return null;

  // Renovação: no máximo uma vez por hora.
  if (Date.now() - new Date(linha.ultimo_uso_em).getTime() > RENOVAR_APOS_MS) {
    await env.DB.prepare('UPDATE sessoes SET ultimo_uso_em = ?, expira_em = ? WHERE id = ?')
      .bind(agora, new Date(Date.now() + DURACAO_SESSAO_MS).toISOString(), id)
      .run();
  }
  return { id: linha.id, nome: linha.nome, login: linha.login, papel: linha.papel, admin: linha.admin === 1, crmv: linha.crmv };
}

// ---------- permissões ----------
export async function exigirLogin(request, env) {
  const usuario = await lerSessao(request, env);
  if (!usuario) throw new ErroHttp(401, 'Faça login para continuar.');
  return usuario;
}

export async function exigirAdmin(request, env) {
  const usuario = await exigirLogin(request, env);
  if (!usuario.admin) throw new ErroHttp(403, 'Apenas administradores podem fazer isso.');
  return usuario;
}

// Exige que o usuário tenha um dos papéis informados (ex.: ['veterinario']).
export async function exigirPapel(request, env, papeis) {
  const usuario = await exigirLogin(request, env);
  if (!papeis.includes(usuario.papel)) throw new ErroHttp(403, 'Você não tem permissão para fazer isso.');
  return usuario;
}
