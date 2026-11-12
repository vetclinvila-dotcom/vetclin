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

// Lê o corpo "cru" (bytes), como o de uma foto, recusando o que passar do limite.
// Devolve um ArrayBuffer. Confere o tamanho avisado e também o que realmente chegou.
export async function lerCorpoBruto(request, limite) {
  const aviso = Number(request.headers.get('Content-Length'));
  const grande = () => new ErroHttp(413, 'O arquivo é grande demais.');
  if (Number.isFinite(aviso) && aviso > limite) throw grande();
  if (!request.body) return new ArrayBuffer(0);
  const leitor = request.body.getReader();
  const partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel();
      throw grande();
    }
    partes.push(value);
  }
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) { saida.set(p, pos); pos += p.byteLength; }
  return saida.buffer;
}

// A clínica fica em America/Bahia: UTC-03:00 o ano todo (sem horário de verão).
const DESLOCAMENTO_BAHIA_MS = 3 * 60 * 60 * 1000;

// Começo do dia (00:00 em Bahia) em que "agora" cai, em texto ISO UTC.
// Ex.: 2026-11-11T02:59:59Z ainda é dia 10 em Bahia -> 2026-11-10T03:00:00.000Z.
export function inicioDoDiaBahia(agora = new Date()) {
  const local = new Date(new Date(agora).getTime() - DESLOCAMENTO_BAHIA_MS); // relógio de Bahia, lido como UTC
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + DESLOCAMENTO_BAHIA_MS).toISOString();
}

// Últimos 4 números do telefone (é só isso que as telas mostram).
export function finalTelefone(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
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

// Prepara (sem executar) o comando que grava no registro de ações.
// Útil para incluir o registro dentro de um "batch" junto com a alteração.
// NUNCA passe senhas ou hashes em "antes"/"depois".
export function prepararAcao(env, { usuarioId = null, acao, entidade, entidadeId = null, antes = null, depois = null, ip = null }) {
  return env.DB.prepare(
    `INSERT INTO registro_acoes (usuario_id, acao, entidade, entidade_id, antes, depois, em, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    usuarioId,
    acao,
    entidade,
    entidadeId,
    antes === null ? null : JSON.stringify(antes),
    depois === null ? null : JSON.stringify(depois),
    agoraISO(),
    ip
  );
}

// Grava no registro de ações quem fez o quê.
// NUNCA passe senhas ou hashes em "antes"/"depois".
export async function registrarAcao(env, dados) {
  await prepararAcao(env, dados).run();
}

// Valida um campo de texto: tira espaços das pontas e confere tamanho.
export function texto(valor, campo, { obrigatorio = true, max = 120 } = {}) {
  const t = String(valor ?? '').trim();
  if (obrigatorio && !t) throw new ErroHttp(400, `Preencha o campo ${campo}.`);
  if (t.length > max) throw new ErroHttp(400, `O campo ${campo} está muito longo.`);
  return t;
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
