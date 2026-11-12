// Web Push: a parte "técnica" das notificações no celular.
//
// Como funciona, em linguagem simples:
// 1. Cada aparelho que aceita notificações recebe um "endereço de entrega"
//    no serviço de notificações do fabricante (Apple, Google...).
// 2. Para mandar um aviso, o servidor envia a mensagem CRIPTOGRAFADA para esse
//    endereço. Só o aparelho consegue abrir (nem a Apple lê o conteúdo).
// 3. O servidor também assina o envio com uma chave própria (chamada VAPID),
//    para o serviço saber que a mensagem veio mesmo do Vetclin.
//
// Padrões seguidos: RFC 8291 (criptografia "aes128gcm") e RFC 8292 (VAPID).
// Tudo feito com crypto.subtle, sem bibliotecas externas.

const enc = new TextEncoder();

// ---------- conversões ----------
export function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deB64url(texto) {
  const t = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Uint8Array.from(atob(t + pad), (c) => c.charCodeAt(0));
}

function juntar(...partes) {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const saida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { saida.set(p, i); i += p.length; }
  return saida;
}

// HKDF (extrair + expandir) numa chamada só.
async function hkdf(sal, segredo, info, tamanho) {
  const chave = await crypto.subtle.importKey('raw', segredo, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal, info }, chave, tamanho * 8);
  return new Uint8Array(bits);
}

// ---------- chaves VAPID (identidade do servidor) ----------

/** Cria um par de chaves novo. Retorna { publica: base64url (65 bytes), privadaJwk: string JSON }. */
export async function gerarChavesVapid() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const privadaJwk = await crypto.subtle.exportKey('jwk', par.privateKey);
  return { publica: b64url(publica), privadaJwk: JSON.stringify(privadaJwk) };
}

/**
 * Monta o cabeçalho Authorization do VAPID para um endereço de entrega.
 * @param {string} endpoint  Endereço de entrega do aparelho.
 * @param {{ publica: string, privadaJwk: string }} chaves
 * @param {string} contato   "mailto:..." ou "https://..." (exigido pela Apple).
 */
export async function cabecalhoVapid(endpoint, chaves, contato, agoraSeg = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const cab = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64url(enc.encode(JSON.stringify({ aud, exp: agoraSeg + 12 * 3600, sub: contato })));
  const assinavel = `${cab}.${corpo}`;
  const privada = await crypto.subtle.importKey('jwk', JSON.parse(chaves.privadaJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // O crypto.subtle já devolve a assinatura no formato do JWT (r || s, 64 bytes).
  const assinatura = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privada, enc.encode(assinavel)));
  return `vapid t=${assinavel}.${b64url(assinatura)}, k=${chaves.publica}`;
}

// ---------- criptografia da mensagem (RFC 8291) ----------

/**
 * Criptografa a mensagem para um aparelho.
 * @param {Uint8Array} mensagem   Conteúdo (JSON em bytes).
 * @param {string} p256dh         Chave pública do aparelho (base64url).
 * @param {string} auth           Segredo do aparelho (base64url).
 * @returns {Promise<Uint8Array>} Corpo pronto para enviar (cabeçalho + texto cifrado).
 */
export async function criptografar(mensagem, p256dh, auth, opcoes = {}) {
  const uaPublica = deB64url(p256dh);
  const segredoAuth = deB64url(auth);
  if (uaPublica.length !== 65 || segredoAuth.length < 16) throw new Error('Chaves do aparelho inválidas.');

  // Par de chaves temporário, usado só nesta mensagem.
  const temporario = opcoes.parTemporario
    || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', temporario.publicKey));
  const chaveUa = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredoEcdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: chaveUa }, temporario.privateKey, 256));

  const infoChave = juntar(enc.encode('WebPush: info\0'), uaPublica, asPublica);
  const ikm = await hkdf(segredoAuth, segredoEcdh, infoChave, 32);
  const sal = opcoes.sal || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sal, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(sal, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Um único "registro": mensagem + byte 0x02 (marca de último registro).
  const claro = juntar(mensagem, new Uint8Array([2]));
  const chaveAes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, chaveAes, claro));

  // Cabeçalho: sal (16) | tamanho do registro (4, big-endian) | tamanho da chave (1) | chave temporária (65)
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return juntar(sal, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}

// ---------- envio ----------

// Só aceitamos endereços dos serviços oficiais de notificação
// (evita que alguém cadastre um endereço qualquer para o servidor chamar).
const SERVICOS_PERMITIDOS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^[a-z0-9.-]+\.push\.apple\.com$/,
];

export function enderecoPermitido(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && SERVICOS_PERMITIDOS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Envia uma notificação para UM aparelho.
 * @returns {Promise<{ ok: boolean, status: number, expirado: boolean }>}
 *   expirado = o aparelho não aceita mais (desinstalou, negou): apagar a inscrição.
 */
export async function enviarPush(inscricao, dados, chaves, contato, { urgente = false, ttl = 4 * 3600, fetchFn = fetch } = {}) {
  const corpo = await criptografar(enc.encode(JSON.stringify(dados)), inscricao.p256dh, inscricao.auth);
  const resposta = await fetchFn(inscricao.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await cabecalhoVapid(inscricao.endpoint, chaves, contato),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgente ? 'high' : 'normal',
    },
    body: corpo,
  });
  return { ok: resposta.ok, status: resposta.status, expirado: resposta.status === 404 || resposta.status === 410 };
}
