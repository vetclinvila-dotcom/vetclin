// Funções de apoio usadas por todo o servidor.

// Erro "esperado": tem uma mensagem em português e um código HTTP.
// Quando lançado, o servidor responde com esse código e mensagem.
export class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// Monta uma resposta JSON.
export function json(dados, status = 200, cabecalhos = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cabecalhos,
    },
  });
}

// Lê o corpo da requisição como JSON, com limite de tamanho (64 KB).
export async function lerJson(request, limite = 64 * 1024) {
  const texto = await request.text();
  if (texto.length > limite) {
    throw new ErroHttp(413, 'Os dados enviados são grandes demais.');
  }
  if (!texto.trim()) return {};
  try {
    const dados = JSON.parse(texto);
    if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
      throw new Error('formato');
    }
    return dados;
  } catch {
    throw new ErroHttp(400, 'Não foi possível entender os dados enviados.');
  }
}

// Data e hora de agora, em texto ISO (UTC).
export function agoraISO() {
  return new Date().toISOString();
}

// Compara dois textos sem revelar (pelo tempo) onde eles diferem.
export function comparacaoSegura(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  let diferenca = x.length ^ y.length;
  const tamanho = Math.max(x.length, y.length);
  for (let i = 0; i < tamanho; i++) {
    diferenca |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diferenca === 0;
}

// Descobre o IP de quem fez a requisição (a Cloudflare informa no cabeçalho).
export function ipDe(request) {
  return request.headers.get('CF-Connecting-IP') || null;
}

// Grava no registro de ações quem fez o quê.
// NUNCA passe senhas ou hashes em "antes"/"depois".
export async function registrarAcao(env, { usuarioId = null, acao, entidade, entidadeId = null, antes = null, depois = null, ip = null }) {
  await env.DB.prepare(
    `INSERT INTO registro_acoes (usuario_id, acao, entidade, entidade_id, antes, depois, em, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      usuarioId,
      acao,
      entidade,
      entidadeId,
      antes === null ? null : JSON.stringify(antes),
      depois === null ? null : JSON.stringify(depois),
      agoraISO(),
      ip
    )
    .run();
}

// Gera o próximo código: T-000001 (tutor) ou P-000001 (pet).
// O contador é aumentado em uma única operação, então nunca repete.
export async function proximoCodigo(env, tipo) {
  const prefixos = { tutor: 'T', pet: 'P' };
  if (!prefixos[tipo]) throw new Error('Tipo de código desconhecido: ' + tipo);
  const linha = await env.DB.prepare(
    'UPDATE contadores SET valor = valor + 1 WHERE nome = ? RETURNING valor'
  )
    .bind(tipo)
    .first();
  return `${prefixos[tipo]}-${String(linha.valor).padStart(6, '0')}`;
}
