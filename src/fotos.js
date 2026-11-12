// Fotos: envio e entrega. As fotos ficam guardadas no banco (tabela "fotos").
import { exigirLogin } from './auth.js';
import { ErroHttp, agoraISO, ipDe, json, lerCorpoBruto, registrarAcao } from './util.js';

export const LIMITE_FOTO_BYTES = 1.5 * 1024 * 1024; // 1,5 MB

// Confere se os primeiros bytes são mesmo de uma imagem do tipo informado.
// JPEG começa com FF D8 FF; WEBP é "RIFF" + 4 bytes de tamanho + "WEBP".
export function tipoPelosBytes(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const txt = (de, ate) => String.fromCharCode(...b.slice(de, ate));
  if (b.length >= 12 && txt(0, 4) === 'RIFF' && txt(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// O D1 devolve BLOB como lista de números; o SQLite local, como Uint8Array.
export function paraBytes(valor) {
  if (valor instanceof Uint8Array) return valor;
  if (valor instanceof ArrayBuffer) return new Uint8Array(valor);
  return Uint8Array.from(valor);
}

async function fotosEnviar(request, env) {
  const u = await exigirLogin(request, env);
  const tipo = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (tipo !== 'image/jpeg' && tipo !== 'image/webp') {
    throw new ErroHttp(400, 'Envie uma foto no formato JPEG ou WEBP.');
  }
  const dados = await lerCorpoBruto(request, LIMITE_FOTO_BYTES);
  if (dados.byteLength === 0) throw new ErroHttp(400, 'A foto está vazia.');
  if (tipoPelosBytes(dados) !== tipo) throw new ErroHttp(400, 'O arquivo não é uma foto válida.');
  const r = await env.DB.prepare('INSERT INTO fotos (dados, tipo, tamanho, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)')
    .bind(dados, tipo, dados.byteLength, u.id, agoraISO()).run();
  const id = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'enviar_foto', entidade: 'fotos', entidadeId: id, depois: { tipo, tamanho: dados.byteLength }, ip: ipDe(request) });
  return json({ id }, 201);
}

async function fotosVer(request, env, id) {
  await exigirLogin(request, env);
  const f = await env.DB.prepare('SELECT dados, tipo FROM fotos WHERE id = ?').bind(id).first();
  if (!f) throw new ErroHttp(404, 'Foto não encontrada.');
  return new Response(paraBytes(f.dados), {
    headers: {
      'content-type': f.tipo,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const ROTAS_FOTOS = [
  ['POST', '/api/fotos', fotosEnviar],
  ['GET', '/api/fotos/:id', fotosVer],
];
