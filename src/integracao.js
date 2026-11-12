// Integração com o Google (planilha financeira e cópia de segurança).
// O sistema é a fonte da verdade: o Google Apps Script PUXA os dados daqui (só leitura),
// usando uma "chave de acesso" (token) que o administrador gera na tela Usuários.
// Só o SHA-256 da chave fica no banco; a chave em si aparece UMA vez, ao ser gerada.
import { exigirAdmin } from './auth.js';
import { paraBytes } from './fotos.js';
import { ErroHttp, agoraISO, comparacaoSegura, ipDe, json, prepararAcao } from './util.js';

const JANELA_MS = 15 * 60 * 1000; // 15 minutos
const LIMITE_FALHAS = 20; // falhas por IP em 15 minutos
const ROTULO_LOGIN = '(integracao)'; // como as falhas aparecem em tentativas_login
export const MAX_PAGAMENTOS = 500;
export const MAX_FOTOS_LOTE = 20;
const MAX_BYTES_LOTE_FOTOS = 6 * 1024 * 1024; // para não estourar a memória do servidor

// Tabelas que NUNCA entram na cópia de segurança (sessões, tentativas de login, chaves de notificação).
export const TABELAS_FORA_DO_BACKUP = ['sessoes', 'tentativas_login', 'push_chaves', 'inscricoes_push'];
const CONFIG_SECRETA = ['integracao_token_hash'];

// ---------- conversões ----------
function paraBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const paraBase64Url = (bytes) => paraBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(texto) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Gera uma chave nova (32 bytes aleatórios) e o hash que vai para o banco.
export async function gerarChave() {
  const token = paraBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await sha256Hex(token) };
}

// ---------- conferência da chave (rotas /api/integracao/*) ----------
async function contarFalhas(env, ip) {
  const corte = new Date(Date.now() - JANELA_MS).toISOString();
  const l = ip
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM tentativas_login WHERE login = ? AND ip = ? AND sucesso = 0 AND em >= ?').bind(ROTULO_LOGIN, ip, corte).first()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM tentativas_login WHERE login = ? AND ip IS NULL AND sucesso = 0 AND em >= ?').bind(ROTULO_LOGIN, corte).first();
  return l.n;
}

// Exige "Authorization: Bearer <chave>". Não usa cookies de propósito: um navegador logado
// (cookie) NÃO consegue chamar estas rotas, então elas não precisam do cabeçalho anti-CSRF.
// Erra 20 vezes em 15 minutos (mesmo IP) = bloqueio temporário (429).
export async function exigirIntegracao(request, env) {
  const ip = ipDe(request);
  if ((await contarFalhas(env, ip)) >= LIMITE_FALHAS) throw new ErroHttp(429, 'Muitas tentativas. Aguarde 15 minutos.');

  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('Authorization') || '');
  const guardado = await env.DB.prepare(`SELECT valor FROM configuracoes WHERE chave = 'integracao_token_hash'`).first();
  // Sempre calcula o hash (mesmo sem chave) para gastar o mesmo tempo.
  const calculado = await sha256Hex(m ? m[1] : '');
  const ok = !!(m && guardado && guardado.valor && comparacaoSegura(calculado, guardado.valor));
  if (!ok) {
    await env.DB.prepare('INSERT INTO tentativas_login (login, ip, sucesso, em) VALUES (?, ?, 0, ?)').bind(ROTULO_LOGIN, ip, agoraISO()).run();
    throw new ErroHttp(401, 'Chave de acesso inválida.');
  }
}

// ---------- administração da chave (tela Usuários) ----------
async function integracaoStatus(request, env) {
  await exigirAdmin(request, env);
  const h = await env.DB.prepare(`SELECT valor FROM configuracoes WHERE chave = 'integracao_token_hash'`).first();
  const c = await env.DB.prepare(`SELECT c.valor AS criado_em, u.nome AS criado_por FROM configuracoes c LEFT JOIN usuarios u ON u.id = c.atualizado_por WHERE c.chave = 'integracao_token_criado_em'`).first();
  const ativa = !!(h && h.valor);
  return json({ ativa, criado_em: ativa && c ? c.criado_em : null, criado_por: ativa && c ? c.criado_por ?? null : null });
}

const gravarConfig = (env, chave, valor, agora, usuarioId) => env.DB.prepare(
  `INSERT INTO configuracoes (chave, valor, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?)
   ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`
).bind(chave, valor, agora, usuarioId);

// Gera uma chave nova. A anterior deixa de valer. A chave só é devolvida AQUI, uma vez.
async function integracaoGerar(request, env) {
  const adm = await exigirAdmin(request, env);
  const { token, hash } = await gerarChave();
  const agora = agoraISO();
  const depois = await env.DB.prepare(`SELECT 1 AS x FROM configuracoes WHERE chave = 'integracao_token_hash'`).first();
  await env.DB.batch([
    gravarConfig(env, 'integracao_token_hash', hash, agora, adm.id),
    gravarConfig(env, 'integracao_token_criado_em', agora, agora, adm.id),
    // O registro NUNCA leva a chave nem o hash.
    prepararAcao(env, { usuarioId: adm.id, acao: 'gerar_chave_integracao', entidade: 'configuracoes', depois: { criada_em: agora, substituiu_anterior: !!depois }, ip: ipDe(request) }),
  ]);
  return json({ token, criado_em: agora }, 201);
}

async function integracaoDesativar(request, env) {
  const adm = await exigirAdmin(request, env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM configuracoes WHERE chave IN ('integracao_token_hash', 'integracao_token_criado_em')`),
    prepararAcao(env, { usuarioId: adm.id, acao: 'desativar_chave_integracao', entidade: 'configuracoes', ip: ipDe(request) }),
  ]);
  return json({ ativa: false });
}

// ---------- exportação: pagamentos ----------
// "desde" = só uma data ISO (inclusive) OU "<data>,<id>" (o cursor "proximo": só o que vem depois).
// A "atividade" de um pagamento é o estorno (se houve) ou o recebimento; assim estornos
// reaparecem para a planilha atualizar a linha.
const ATIVIDADE = 'COALESCE(g.estornado_em, g.recebido_em)';

function lerCursor(valor) {
  const t = String(valor ?? '').trim();
  if (!t) return { iso: '', id: null };
  const [iso, id] = t.split(',');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(iso) || Number.isNaN(Date.parse(iso))) throw new ErroHttp(400, 'O parâmetro "desde" deve ser uma data ISO (ex.: 2026-11-01T00:00:00.000Z).');
  if (id !== undefined && !/^\d{1,12}$/.test(id)) throw new ErroHttp(400, 'O parâmetro "desde" está inválido.');
  return { iso, id: id === undefined ? null : Number(id) };
}

async function exportarPagamentos(request, env) {
  await exigirIntegracao(request, env);
  const url = new URL(request.url);
  const { iso, id } = lerCursor(url.searchParams.get('desde'));
  let limite = Number(url.searchParams.get('limite') ?? MAX_PAGAMENTOS);
  if (!Number.isInteger(limite) || limite < 1 || limite > MAX_PAGAMENTOS) limite = MAX_PAGAMENTOS;

  const condicao = id === null ? `${ATIVIDADE} >= ?` : `(${ATIVIDADE} > ? OR (${ATIVIDADE} = ? AND g.id > ?))`;
  const args = id === null ? [iso] : [iso, iso, id];
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.recebido_em, g.forma, g.valor_centavos, g.estornado, g.estornado_em, g.estorno_motivo, g.comprovante_foto_id,
            ${ATIVIDADE} AS atividade_em,
            ru.nome AS recebido_por_nome,
            p.id AS pedido_id, p.total_centavos, p.status AS pedido_status,
            pe.codigo AS pet_codigo, pe.nome AS pet_nome, pe.especie,
            t.codigo AS tutor_codigo, t.nome AS tutor_nome,
            a.chegada_em, a.peso_kg, vu.nome AS vet_nome
       FROM pagamentos g
       JOIN pedidos p ON p.id = g.pedido_id
       JOIN atendimentos a ON a.id = p.atendimento_id
       JOIN pets pe ON pe.id = a.pet_id
       JOIN tutores t ON t.id = pe.tutor_id
       LEFT JOIN usuarios ru ON ru.id = g.recebido_por
       LEFT JOIN usuarios vu ON vu.id = a.veterinario_id
      WHERE ${condicao}
      ORDER BY ${ATIVIDADE}, g.id
      LIMIT ${limite + 1}`
  ).bind(...args).all();

  const mais = results.length > limite;
  const linhas = results.slice(0, limite);
  const itensPorPedido = new Map();
  const pedidos = [...new Set(linhas.map((l) => l.pedido_id))];
  if (pedidos.length) {
    const { results: itens } = await env.DB.prepare(
      `SELECT pedido_id, descricao, quantidade, preco_unitario_centavos FROM itens_pedido WHERE pedido_id IN (${pedidos.map(() => '?').join(',')}) ORDER BY id`
    ).bind(...pedidos).all();
    for (const i of itens) {
      if (!itensPorPedido.has(i.pedido_id)) itensPorPedido.set(i.pedido_id, []);
      itensPorPedido.get(i.pedido_id).push({ descricao: i.descricao, quantidade: i.quantidade, preco_unitario_centavos: i.preco_unitario_centavos });
    }
  }
  const pagamentos = linhas.map((l) => ({
    id: l.id, recebido_em: l.recebido_em, forma: l.forma, valor_centavos: l.valor_centavos,
    estornado: l.estornado === 1, estornado_em: l.estornado_em ?? null, estorno_motivo: l.estorno_motivo ?? null,
    recebido_por: l.recebido_por_nome ?? null, comprovante_foto_id: l.comprovante_foto_id ?? null,
    pedido: { id: l.pedido_id, total_centavos: l.total_centavos, status: l.pedido_status, itens: itensPorPedido.get(l.pedido_id) ?? [] },
    pet: { codigo: l.pet_codigo, nome: l.pet_nome, especie: l.especie },
    tutor: { codigo: l.tutor_codigo, nome: l.tutor_nome },
    atendimento: { chegada_em: l.chegada_em, peso_kg: l.peso_kg ?? null, veterinario: l.vet_nome ?? null },
  }));
  const ultimo = linhas[linhas.length - 1];
  return json({ pagamentos, mais, proximo: ultimo ? `${ultimo.atividade_em},${ultimo.id}` : null });
}

// ---------- exportação: foto de comprovante ----------
// Só fotos que são comprovante de algum pagamento (nunca fotos clínicas).
async function exportarFoto(request, env, id) {
  await exigirIntegracao(request, env);
  const f = await env.DB.prepare(
    'SELECT f.dados, f.tipo FROM fotos f WHERE f.id = ? AND EXISTS (SELECT 1 FROM pagamentos g WHERE g.comprovante_foto_id = f.id)'
  ).bind(id).first();
  if (!f) throw new ErroHttp(404, 'Foto não encontrada.');
  return new Response(paraBytes(f.dados), { headers: { 'content-type': f.tipo, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

// ---------- exportação: cópia de segurança ----------
async function exportarBackup(request, env) {
  await exigirIntegracao(request, env);
  const { results: tabs } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name`
  ).all();
  const tabelas = {};
  for (const { name } of tabs) {
    if (TABELAS_FORA_DO_BACKUP.includes(name)) continue;
    let sql = `SELECT * FROM "${name}"`;
    if (name === 'fotos') sql = 'SELECT id, tipo, tamanho, largura, altura, criado_por, criado_em FROM fotos ORDER BY id'; // sem os bytes
    else if (name === 'usuarios') sql = 'SELECT * FROM usuarios ORDER BY id';
    else if (name === 'configuracoes') sql = `SELECT * FROM configuracoes WHERE chave NOT IN (${CONFIG_SECRETA.map((c) => `'${c}'`).join(',')}) ORDER BY chave`;
    else sql += ' ORDER BY 1';
    let linhas = (await env.DB.prepare(sql).all()).results;
    if (name === 'usuarios') linhas = linhas.map(({ senha_hash, ...resto }) => resto); // nunca exporta senhas
    tabelas[name] = linhas;
  }
  let migracoes = [];
  try { migracoes = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((r) => r.name); } catch { /* banco sem controle de migrações (testes) */ }
  return json({ versao: 1, gerado_em: agoraISO(), migracoes, tabelas });
}

// ---------- exportação: fotos (cópia incremental no Drive) ----------
async function exportarFotos(request, env) {
  await exigirIntegracao(request, env);
  const desde = Number(new URL(request.url).searchParams.get('desde_id') ?? 0);
  if (!Number.isInteger(desde) || desde < 0) throw new ErroHttp(400, 'O parâmetro "desde_id" deve ser um número inteiro.');
  const { results: ids } = await env.DB.prepare('SELECT id, tipo FROM fotos WHERE id > ? ORDER BY id LIMIT ?').bind(desde, MAX_FOTOS_LOTE + 1).all();
  const fotos = [];
  let bytes = 0;
  let mais = ids.length > MAX_FOTOS_LOTE;
  for (const { id, tipo } of ids.slice(0, MAX_FOTOS_LOTE)) {
    const f = await env.DB.prepare('SELECT dados FROM fotos WHERE id = ?').bind(id).first();
    const b = paraBytes(f.dados);
    if (fotos.length && bytes + b.length > MAX_BYTES_LOTE_FOTOS) { mais = true; break; }
    bytes += b.length;
    fotos.push({ id, tipo, base64: paraBase64(b) });
  }
  return json({ fotos, mais, proximo: fotos.length ? fotos[fotos.length - 1].id : desde });
}

export const ROTAS_INTEGRACAO = [
  ['GET', '/api/admin/integracao', integracaoStatus],
  ['POST', '/api/admin/integracao/chave', integracaoGerar],
  ['POST', '/api/admin/integracao/desativar', integracaoDesativar],
  ['GET', '/api/integracao/pagamentos', exportarPagamentos],
  ['GET', '/api/integracao/foto/:id', exportarFoto],
  ['GET', '/api/integracao/backup', exportarBackup],
  ['GET', '/api/integracao/fotos-backup', exportarFotos],
];
