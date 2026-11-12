// Testes da criptografia e da assinatura das notificações (Web Push).
// Aqui fazemos o papel do CELULAR: geramos as chaves do aparelho, recebemos a
// mensagem criptografada pelo servidor e conferimos se ela abre corretamente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64url, deB64url, gerarChavesVapid, cabecalhoVapid, criptografar, enviarPush, enderecoPermitido } from '../src/push.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hkdf(sal, segredo, info, n) {
  const k = await crypto.subtle.importKey('raw', segredo, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal, info }, k, n * 8));
}
const juntar = (...p) => { const s = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { s.set(x, i); i += x.length; } return s; };

// Cria as chaves de um "aparelho" de mentira.
async function aparelho() {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { par, publica, auth, p256dh: b64url(publica), authB64: b64url(auth) };
}

// Decifra como o celular faria (RFC 8291), implementado aqui de forma independente.
async function decifrar(corpo, ap) {
  const sal = corpo.slice(0, 16);
  const rs = new DataView(corpo.buffer, corpo.byteOffset + 16, 4).getUint32(0);
  const idlen = corpo[20];
  const asPublica = corpo.slice(21, 21 + idlen);
  const cifrado = corpo.slice(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const chaveAs = await crypto.subtle.importKey('raw', asPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: chaveAs }, ap.par.privateKey, 256));
  const ikm = await hkdf(ap.auth, ecdh, juntar(enc.encode('WebPush: info\0'), ap.publica, asPublica), 32);
  const cek = await hkdf(sal, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(sal, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, cifrado));
  // Remove o enchimento: último byte diferente de zero deve ser 0x02.
  let fim = claro.length - 1;
  while (fim >= 0 && claro[fim] === 0) fim--;
  assert.equal(claro[fim], 2, 'marca de último registro');
  return dec.decode(claro.slice(0, fim));
}

test('push: base64url ida e volta', () => {
  const b = crypto.getRandomValues(new Uint8Array(33));
  assert.deepEqual(deB64url(b64url(b)), b);
  assert.ok(!/[+/=]/.test(b64url(b)));
});

test('push: mensagem criptografada abre no aparelho (RFC 8291)', async () => {
  const ap = await aparelho();
  const texto = JSON.stringify({ titulo: 'Chegou: Thor (cão)', corpo: '12,4 kg · Vômito · ação: ãéç' });
  const corpo = await criptografar(enc.encode(texto), ap.p256dh, ap.authB64);
  assert.equal(await decifrar(corpo, ap), texto);
});

test('push: cada envio usa sal e chave temporária diferentes', async () => {
  const ap = await aparelho();
  const a = await criptografar(enc.encode('x'), ap.p256dh, ap.authB64);
  const b = await criptografar(enc.encode('x'), ap.p256dh, ap.authB64);
  assert.notDeepEqual(a.slice(0, 86), b.slice(0, 86));
});

test('push: chaves do aparelho inválidas são recusadas', async () => {
  await assert.rejects(() => criptografar(enc.encode('x'), b64url(new Uint8Array(10)), b64url(new Uint8Array(16))));
});

test('push: assinatura VAPID válida, com aud, exp e sub corretos', async () => {
  const chaves = await gerarChavesVapid();
  assert.equal(deB64url(chaves.publica).length, 65);
  const agora = 1_800_000_000;
  const cab = await cabecalhoVapid('https://web.push.apple.com/QGuQyavXutnMH/abc', chaves, 'https://vetclin.exemplo.workers.dev', agora);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(cab);
  assert.ok(m, cab);
  const [, h, p, s, k] = m;
  assert.equal(k, chaves.publica);
  assert.deepEqual(JSON.parse(dec.decode(deB64url(h))), { typ: 'JWT', alg: 'ES256' });
  const carga = JSON.parse(dec.decode(deB64url(p)));
  assert.equal(carga.aud, 'https://web.push.apple.com');
  assert.equal(carga.sub, 'https://vetclin.exemplo.workers.dev');
  assert.equal(carga.exp, agora + 12 * 3600);
  const pub = await crypto.subtle.importKey('raw', deB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const assinatura = deB64url(s);
  assert.equal(assinatura.length, 64);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, assinatura, enc.encode(`${h}.${p}`)));
});

test('push: só aceita endereços dos serviços oficiais', () => {
  assert.ok(enderecoPermitido('https://web.push.apple.com/abc'));
  assert.ok(enderecoPermitido('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(enderecoPermitido('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(!enderecoPermitido('http://web.push.apple.com/abc'));
  assert.ok(!enderecoPermitido('https://exemplo.com/abc'));
  assert.ok(!enderecoPermitido('https://web.push.apple.com.exemplo.com/abc'));
  assert.ok(!enderecoPermitido('nada'));
});

test('push: enviarPush monta a requisição certa e detecta aparelho expirado', async () => {
  const ap = await aparelho();
  const chaves = await gerarChavesVapid();
  let pedido;
  const fetchFalso = async (url, op) => { pedido = { url, op }; return new Response(null, { status: 201 }); };
  const r = await enviarPush({ endpoint: 'https://web.push.apple.com/x', p256dh: ap.p256dh, auth: ap.authB64 }, { titulo: 'Oi' }, chaves, 'https://a.b', { urgente: true, fetchFn: fetchFalso });
  assert.deepEqual(r, { ok: true, status: 201, expirado: false });
  assert.equal(pedido.op.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(pedido.op.headers.Urgency, 'high');
  assert.ok(pedido.op.headers.Authorization.startsWith('vapid t='));
  assert.equal(JSON.parse(await decifrar(pedido.op.body, ap)).titulo, 'Oi');

  const expirado = await enviarPush({ endpoint: 'https://web.push.apple.com/x', p256dh: ap.p256dh, auth: ap.authB64 }, {}, chaves, 'https://a.b', { fetchFn: async () => new Response(null, { status: 410 }) });
  assert.equal(expirado.expirado, true);
});

// Exemplo oficial do RFC 8291 (Apêndice A): com as mesmas chaves e o mesmo sal,
// o resultado precisa ser idêntico, byte a byte.
test('push: resultado idêntico ao exemplo oficial do RFC 8291', async () => {
  const asPub = deB64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(asPub.slice(1, 33)), y: b64url(asPub.slice(33)), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const saida = await criptografar(
    enc.encode('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    { parTemporario: { privateKey, publicKey }, sal: deB64url('DGv6ra1nlYgDCS1FRnbzlw') },
  );
  assert.equal(b64url(saida), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
