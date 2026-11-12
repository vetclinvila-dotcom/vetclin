// Notificações no celular (Web Push).
// Ponto único para avisar pessoas da equipe: qualquer parte do sistema chama
// notificar(env, { ... }) e este arquivo cuida de achar os aparelhos e enviar.
// A parte de criptografia fica em push.js.
import { exigirLogin } from './auth.js';
import { enderecoPermitido, enviarPush, gerarChavesVapid, deB64url } from './push.js';
import { ErroHttp, agoraISO, ipDe, json, lerJson, registrarAcao } from './util.js';

const CONTATO_PADRAO = 'mailto:suporte@vetclin.app';
const TEMPO_LIMITE_MS = 5000; // não espera mais que 5 s por aparelho

// Lê (ou cria, na primeira vez) as chaves do servidor.
// Se existirem os segredos VAPID_PUBLICA e VAPID_PRIVADA_JWK na Cloudflare, eles têm prioridade.
async function obterChaves(env) {
  if (env.VAPID_PUBLICA && env.VAPID_PRIVADA_JWK) {
    return { publica: env.VAPID_PUBLICA, privadaJwk: env.VAPID_PRIVADA_JWK, contato: env.VAPID_CONTATO || CONTATO_PADRAO };
  }
  let linha = await env.DB.prepare('SELECT publica, privada_jwk, contato FROM push_chaves WHERE id = 1').first();
  if (!linha) {
    const novas = await gerarChavesVapid();
    // "OR IGNORE": se duas pessoas ativarem ao mesmo tempo, fica valendo só a primeira.
    await env.DB.prepare('INSERT OR IGNORE INTO push_chaves (id, publica, privada_jwk, criado_em) VALUES (1, ?, ?, ?)')
      .bind(novas.publica, novas.privadaJwk, agoraISO()).run();
    linha = await env.DB.prepare('SELECT publica, privada_jwk, contato FROM push_chaves WHERE id = 1').first();
  }
  return { publica: linha.publica, privadaJwk: linha.privada_jwk, contato: linha.contato || CONTATO_PADRAO };
}

/**
 * Envia uma notificação para a equipe.
 * @param {object} env  Ambiente do Worker (precisa de env.DB).
 * @param {object} aviso
 * @param {{ papel?: 'recepcao'|'veterinario'|'suporte', usuarioId?: number, excetoUsuarioId?: number }} aviso.para
 *        Quem recebe: todos de um papel, OU um usuário específico.
 *        excetoUsuarioId: não manda para quem fez a ação.
 * @param {string} aviso.titulo  Ex.: "Chegou: Thor (cão)"
 * @param {string} aviso.corpo   Ex.: "12,4 kg · Vômito · tutor Maria"
 * @param {string} [aviso.url]   Tela que abre ao tocar. Ex.: "#/hoje"
 * @param {string} [aviso.tag]   Agrupa avisos do mesmo assunto (um novo substitui o anterior).
 * @param {boolean} [aviso.urgente]
 * @returns {Promise<{ enviados: number, falhas: number }>} Nunca lança erro:
 *          uma falha de notificação não pode atrapalhar o atendimento.
 */
export async function notificar(env, aviso, { fetchFn = fetch } = {}) {
  try {
    const para = aviso.para || {};
    let sql = `SELECT i.id, i.endpoint, i.p256dh, i.auth FROM inscricoes_push i
                 JOIN usuarios u ON u.id = i.usuario_id WHERE u.ativo = 1`;
    const args = [];
    if (para.usuarioId) { sql += ' AND u.id = ?'; args.push(para.usuarioId); }
    else if (para.papel) { sql += ' AND u.papel = ?'; args.push(para.papel); }
    else return { enviados: 0, falhas: 0 };
    if (para.excetoUsuarioId) { sql += ' AND u.id <> ?'; args.push(para.excetoUsuarioId); }

    const { results } = await env.DB.prepare(sql).bind(...args).all();
    if (!results.length) return { enviados: 0, falhas: 0 };

    const chaves = await obterChaves(env);
    const dados = {
      titulo: String(aviso.titulo || 'Vetclin').slice(0, 120),
      corpo: String(aviso.corpo || '').slice(0, 300),
      url: aviso.url || '#/hoje',
      tag: aviso.tag || null,
      urgente: !!aviso.urgente,
    };

    const resultados = await Promise.allSettled(results.map(async (insc) => {
      const comLimite = (url, op) => fetchFn(url, { ...op, signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
      const r = await enviarPush(insc, dados, chaves, chaves.contato, { urgente: dados.urgente, fetchFn: comLimite });
      if (r.expirado) {
        // O aparelho não aceita mais (app removido ou permissão negada): apaga.
        await env.DB.prepare('DELETE FROM inscricoes_push WHERE id = ?').bind(insc.id).run();
      } else if (r.ok) {
        await env.DB.prepare('UPDATE inscricoes_push SET ultimo_uso_em = ? WHERE id = ?').bind(agoraISO(), insc.id).run();
      } else {
        console.error('Notificação recusada pelo serviço:', r.status);
      }
      return r.ok;
    }));
    const enviados = resultados.filter((r) => r.status === 'fulfilled' && r.value).length;
    return { enviados, falhas: resultados.length - enviados };
  } catch (e) {
    console.error('Falha ao enviar notificações:', e);
    return { enviados: 0, falhas: 1 };
  }
}

// ---------- rotas ----------

// Chave pública que o celular precisa para se inscrever.
async function chave(request, env) {
  await exigirLogin(request, env);
  const c = await obterChaves(env);
  return json({ publica: c.publica });
}

// Quantos aparelhos deste usuário recebem notificações.
async function estado(request, env) {
  const u = await exigirLogin(request, env);
  const l = await env.DB.prepare('SELECT COUNT(*) AS n FROM inscricoes_push WHERE usuario_id = ?').bind(u.id).first();
  return json({ aparelhos: l.n });
}

// Registra este aparelho para receber notificações.
async function inscrever(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const endpoint = String(c.endpoint || '');
  const p256dh = String(c.keys?.p256dh || '');
  const auth = String(c.keys?.auth || '');
  if (!enderecoPermitido(endpoint) || endpoint.length > 1000) throw new ErroHttp(400, 'Este aparelho não é compatível com notificações.');
  try {
    if (deB64url(p256dh).length !== 65 || deB64url(auth).length < 16) throw new Error();
  } catch {
    throw new ErroHttp(400, 'Dados de notificação inválidos.');
  }
  const agente = (request.headers.get('User-Agent') || '').slice(0, 200) || null;
  const agora = agoraISO();
  // Se o mesmo aparelho já existia (até de outra pessoa), passa a ser deste usuário.
  await env.DB.prepare(
    `INSERT INTO inscricoes_push (usuario_id, endpoint, p256dh, auth, criado_em, ultimo_uso_em, agente)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh,
       auth = excluded.auth, ultimo_uso_em = excluded.ultimo_uso_em, agente = excluded.agente`
  ).bind(u.id, endpoint, p256dh, auth, agora, agora, agente).run();
  // Guarda o endereço do sistema como "contato" (a Apple exige um).
  await obterChaves(env);
  await env.DB.prepare('UPDATE push_chaves SET contato = ? WHERE id = 1 AND contato IS NULL')
    .bind(new URL(request.url).origin).run();
  await registrarAcao(env, { usuarioId: u.id, acao: 'ativar_notificacoes', entidade: 'inscricoes_push', ip: ipDe(request) });
  return json({ ok: true });
}

// Para de receber notificações neste aparelho.
async function cancelar(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  await env.DB.prepare('DELETE FROM inscricoes_push WHERE endpoint = ? AND usuario_id = ?').bind(String(c.endpoint || ''), u.id).run();
  await registrarAcao(env, { usuarioId: u.id, acao: 'desativar_notificacoes', entidade: 'inscricoes_push', ip: ipDe(request) });
  return json({ ok: true });
}

// Manda uma notificação de teste para os aparelhos da própria pessoa.
async function teste(request, env) {
  const u = await exigirLogin(request, env);
  const r = await notificar(env, {
    para: { usuarioId: u.id },
    titulo: 'Notificações ativadas',
    corpo: `Tudo certo, ${u.nome}! Você vai receber os avisos da Vetclin aqui.`,
    url: '#/hoje',
    tag: 'teste',
  });
  return json(r);
}

export const ROTAS_PUSH = [
  ['GET', '/api/push/chave', chave],
  ['GET', '/api/push/estado', estado],
  ['POST', '/api/push/inscrever', inscrever],
  ['POST', '/api/push/cancelar', cancelar],
  ['POST', '/api/push/teste', teste],
];
