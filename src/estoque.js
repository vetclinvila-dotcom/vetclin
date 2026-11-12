// Estoque dos produtos do catálogo, com validade.
//  - Cada entrada é um LOTE (quantidade + validade + custo opcional). Recepção, veterinário e suporte podem dar
//    entrada e ajustar (o administrador não é necessário).
//  - Quando uma conta fica PAGA, os produtos que controlam estoque saem sozinhos: primeiro o lote que vence antes
//    (FEFO); lotes sem validade por último. Se não houver produto suficiente a venda segue e a falta fica registrada
//    ("saída sem estoque"). Se a conta voltar a ficar em aberto (estorno do pagamento), tudo volta para os mesmos lotes.
//  - O mesmo item da conta nunca é baixado duas vezes (o banco também impede).
//  - Quantidades podem ter até 3 casas decimais (ex.: 0,5 frasco). Dinheiro em centavos inteiros.
//  - "Agora" vem de agoraDe(env), para os testes poderem mudar o relógio.
import { exigirLogin, exigirPapel } from './auth.js';
import { ErroHttp, agoraDe, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';

const PAPEIS_ESTOQUE = ['recepcao', 'veterinario', 'suporte'];
const MAX_QUANTIDADE = 1_000_000;
const MAX_CUSTO = 10_000_000;
const DIA_MS = 24 * 60 * 60 * 1000;
const JANELA_CONSUMO_DIAS = 30;

const arredondar = (n) => Math.round(n * 1000) / 1000;
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// "AAAA-MM-DD" de hoje no relógio da clínica (America/Bahia, UTC-03:00).
export function hojeBahia(agora) {
  return new Date(agora.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Dias entre hoje e a validade (negativo = já venceu; 0 = vence hoje).
export function diasAteValidade(validade, agora) {
  return Math.round((Date.parse(`${validade}T00:00:00Z`) - Date.parse(`${hojeBahia(agora)}T00:00:00Z`)) / DIA_MS);
}

// ---------- leitura do que o usuário mandou ----------
function lerQuantidade(v, campo = 'quantidade') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_QUANTIDADE) throw new ErroHttp(400, `Informe a ${campo} (maior que zero).`);
  const q = arredondar(v);
  if (q <= 0) throw new ErroHttp(400, `Informe a ${campo} (maior que zero).`);
  return q;
}

function lerValidade(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ErroHttp(400, 'A validade deve ser uma data (AAAA-MM-DD).');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) throw new ErroHttp(400, 'Validade inválida.');
  return v;
}

function lerCusto(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_CUSTO) throw new ErroHttp(400, 'O custo deve ser em centavos, de R$ 0,00 a R$ 100.000,00.');
  return v;
}

async function itemDeEstoque(env, id) {
  const c = await env.DB.prepare('SELECT * FROM catalogo WHERE id = ?').bind(id).first();
  if (!c) throw new ErroHttp(404, 'Produto não encontrado.');
  return c;
}
async function exigirControle(env, id) {
  const c = await itemDeEstoque(env, id);
  if (c.controla_estoque !== 1) throw new ErroHttp(409, 'Este produto não controla estoque. Ative "Controlar estoque" em Preços.');
  return c;
}

// ---------- números de cada produto ----------
// Devolve um Map catalogo_id -> { total, proxima_validade, dias_para_vencer, vencidos, media_validade_dias,
//   consumo_medio_dia, dura_dias, sem_estoque_qtd }.
//  - total: soma dos lotes com produto;
//  - proxima_validade: a menor validade entre os lotes com produto (pode já ter passado);
//  - vencidos: quantidade em lotes já vencidos;
//  - media_validade_dias ("média de validade"): média, ponderada pela quantidade, dos dias que faltam para vencer,
//    olhando só os lotes com produto, com validade e ainda dentro do prazo (o que já venceu não entra);
//  - consumo_medio_dia: unidades vendidas nos últimos 30 dias dividido por 30;
//  - dura_dias: estoque total / consumo médio (vazio se não houve vendas);
//  - sem_estoque_qtd: quanto foi vendido sem ter estoque (ainda não coberto por uma entrada nova — só informativo).
export async function estatisticasDeEstoque(env, agora = agoraDe(env), ids = null) {
  const filtro = ids && ids.length ? `AND catalogo_id IN (${ids.map(() => '?').join(',')})` : '';
  const args = ids && ids.length ? ids : [];
  const { results: lotes } = await env.DB.prepare(`SELECT catalogo_id, quantidade_atual, validade FROM estoque_lotes WHERE quantidade_atual > 0 ${filtro}`).bind(...args).all();
  const desde = new Date(agora.getTime() - JANELA_CONSUMO_DIAS * DIA_MS).toISOString();
  const { results: vendas } = await env.DB.prepare(
    `SELECT catalogo_id, -SUM(quantidade) AS vendido FROM estoque_movimentos
      WHERE tipo IN ('saida','estorno') AND pedido_id IS NOT NULL AND criado_em >= ? AND criado_em <= ? ${filtro} GROUP BY catalogo_id`
  ).bind(desde, agora.toISOString(), ...args).all();
  const { results: faltas } = await env.DB.prepare(
    `SELECT catalogo_id, -SUM(quantidade) AS faltou FROM estoque_movimentos WHERE tipo = 'saida' AND sem_estoque = 1 AND revertido = 0 ${filtro} GROUP BY catalogo_id`
  ).bind(...args).all();
  const mapa = new Map();
  const de = (id) => {
    if (!mapa.has(id)) mapa.set(id, { total: 0, proxima_validade: null, dias_para_vencer: null, vencidos: 0, media_validade_dias: null, consumo_medio_dia: 0, dura_dias: null, sem_estoque_qtd: 0, _soma: 0, _peso: 0 });
    return mapa.get(id);
  };
  for (const l of lotes) {
    const m = de(l.catalogo_id);
    m.total += l.quantidade_atual;
    if (!l.validade) continue;
    if (m.proxima_validade === null || l.validade < m.proxima_validade) m.proxima_validade = l.validade;
    const dias = diasAteValidade(l.validade, agora);
    if (dias < 0) m.vencidos += l.quantidade_atual;
    else { m._soma += l.quantidade_atual * dias; m._peso += l.quantidade_atual; }
  }
  const consumoExato = new Map(); // sem arredondar, para o "dura N dias" não sofrer com o arredondamento
  for (const v of vendas) { const c = Math.max(0, v.vendido) / JANELA_CONSUMO_DIAS; consumoExato.set(v.catalogo_id, c); de(v.catalogo_id).consumo_medio_dia = c; }
  for (const f of faltas) de(f.catalogo_id).sem_estoque_qtd = arredondar(Math.max(0, f.faltou));
  for (const [cid, m] of mapa) {
    m.total = arredondar(m.total);
    m.vencidos = arredondar(m.vencidos);
    m.dias_para_vencer = m.proxima_validade ? diasAteValidade(m.proxima_validade, agora) : null;
    m.media_validade_dias = m._peso > 0 ? Math.round((m._soma / m._peso) * 10) / 10 : null;
    const exato = consumoExato.get(cid) ?? 0;
    m.consumo_medio_dia = Math.round(exato * 1000) / 1000;
    m.dura_dias = exato > 0 ? Math.floor(m.total / exato + 1e-9) : null;
    delete m._soma; delete m._peso;
  }
  return mapa;
}

const VAZIO = { total: 0, proxima_validade: null, dias_para_vencer: null, vencidos: 0, media_validade_dias: null, consumo_medio_dia: 0, dura_dias: null, sem_estoque_qtd: 0 };

const itemPublico = (c, est) => ({
  id: c.id, nome: c.nome, categoria: c.categoria, apresentacao: c.apresentacao ?? null, unidade: c.unidade || 'un', ativo: c.ativo === 1,
  preco_centavos: c.preco_centavos, ...(est ?? VAZIO),
});

// ---------- baixa automática ao pagar / devolução ao reabrir ----------
// Chamada depois de qualquer mudança da conta. Conta PAGA: baixa o que ainda não foi baixado.
// Conta que deixou de estar paga: devolve o que tinha sido baixado. Pode ser chamada várias vezes (não repete).
export async function sincronizarEstoquePedido(env, pedidoId, usuarioId = null) {
  const ped = await env.DB.prepare('SELECT id, status FROM pedidos WHERE id = ?').bind(pedidoId).first();
  if (!ped) return;
  if (ped.status === 'pago') await baixarPedido(env, ped.id, usuarioId);
  else await devolverPedido(env, ped.id, usuarioId);
}

// Versão que nunca atrapalha o pagamento: se o estoque falhar, o erro vai para o log e a conta segue.
export async function sincronizarSemFalhar(env, pedidoId, usuarioId = null) {
  try { await sincronizarEstoquePedido(env, pedidoId, usuarioId); } catch (e) { console.error('Falha ao atualizar o estoque da conta:', e); }
}

async function baixarPedido(env, pedidoId, usuarioId) {
  const { results: itens } = await env.DB.prepare(
    `SELECT i.id, i.catalogo_id, i.quantidade FROM itens_pedido i JOIN catalogo c ON c.id = i.catalogo_id
      WHERE i.pedido_id = ? AND c.controla_estoque = 1
        AND NOT EXISTS (SELECT 1 FROM estoque_movimentos m WHERE m.item_pedido_id = i.id AND m.tipo = 'saida' AND m.revertido = 0)
      ORDER BY i.id`
  ).bind(pedidoId).all();
  if (!itens.length) return;
  const agora = agoraDe(env).toISOString();
  const ids = [...new Set(itens.map((i) => i.catalogo_id))];
  // Lotes com produto, na ordem de saída: validade mais próxima primeiro; sem validade por último.
  const { results: lotes } = await env.DB.prepare(
    `SELECT id, catalogo_id, quantidade_atual, validade FROM estoque_lotes
      WHERE quantidade_atual > 0 AND catalogo_id IN (${ids.map(() => '?').join(',')})
      ORDER BY catalogo_id, (validade IS NULL), validade, id`
  ).bind(...ids).all();
  const comandos = [];
  const resumo = [];
  for (const it of itens) {
    let falta = arredondar(it.quantidade);
    let faltou = 0;
    for (const l of lotes.filter((x) => x.catalogo_id === it.catalogo_id && x.quantidade_atual > 0)) {
      if (falta <= 0) break;
      const tira = Math.min(l.quantidade_atual, falta);
      l.quantidade_atual = arredondar(l.quantidade_atual - tira);
      falta = arredondar(falta - tira);
      comandos.push(
        env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, pedido_id, item_pedido_id, criado_por, criado_em) VALUES (?, ?, 'saida', ?, 'Venda (conta paga)', ?, ?, ?, ?)`)
          .bind(it.catalogo_id, l.id, -tira, pedidoId, it.id, usuarioId, agora),
        env.DB.prepare('UPDATE estoque_lotes SET quantidade_atual = ROUND(quantidade_atual - ?, 3) WHERE id = ?').bind(tira, l.id));
    }
    if (falta > 0) {
      faltou = falta;
      comandos.push(env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, sem_estoque, pedido_id, item_pedido_id, criado_por, criado_em) VALUES (?, NULL, 'saida', ?, 'Saída sem estoque (conta paga)', 1, ?, ?, ?, ?)`)
        .bind(it.catalogo_id, -falta, pedidoId, it.id, usuarioId, agora));
    }
    resumo.push({ catalogo_id: it.catalogo_id, quantidade: it.quantidade, ...(faltou ? { sem_estoque: faltou } : {}) });
  }
  comandos.push(prepararAcao(env, { usuarioId, acao: 'baixar_estoque_pedido', entidade: 'pedidos', entidadeId: pedidoId, depois: { itens: resumo } }));
  await env.DB.batch(comandos);
}

async function devolverPedido(env, pedidoId, usuarioId) {
  const { results: saidas } = await env.DB.prepare(`SELECT * FROM estoque_movimentos WHERE pedido_id = ? AND tipo = 'saida' AND revertido = 0 ORDER BY id`).bind(pedidoId).all();
  if (!saidas.length) return;
  const agora = agoraDe(env).toISOString();
  const comandos = [];
  for (const m of saidas) {
    comandos.push(
      env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, sem_estoque, pedido_id, item_pedido_id, criado_por, criado_em) VALUES (?, ?, 'estorno', ?, 'Conta reaberta (pagamento desfeito)', ?, ?, ?, ?, ?)`)
        .bind(m.catalogo_id, m.lote_id, -m.quantidade, m.sem_estoque, pedidoId, m.item_pedido_id, usuarioId, agora),
      env.DB.prepare('UPDATE estoque_movimentos SET revertido = 1 WHERE id = ?').bind(m.id));
    if (m.lote_id) comandos.push(env.DB.prepare('UPDATE estoque_lotes SET quantidade_atual = ROUND(quantidade_atual + ?, 3) WHERE id = ?').bind(-m.quantidade, m.lote_id));
  }
  comandos.push(prepararAcao(env, { usuarioId, acao: 'devolver_estoque_pedido', entidade: 'pedidos', entidadeId: pedidoId, depois: { movimentos: saidas.length } }));
  await env.DB.batch(comandos);
}

// ---------- rotas ----------
async function estoqueListar(request, env) {
  await exigirLogin(request, env);
  const url = new URL(request.url);
  const categoria = url.searchParams.get('categoria') || '';
  const q = semAcento(url.searchParams.get('q'));
  const onde = ['controla_estoque = 1'];
  const args = [];
  if (!['1', 'true'].includes(url.searchParams.get('inativos') || '')) onde.push('ativo = 1');
  if (categoria) { onde.push('categoria = ?'); args.push(categoria); }
  const { results } = await env.DB.prepare(`SELECT * FROM catalogo WHERE ${onde.join(' AND ')} ORDER BY nome COLLATE NOCASE, id LIMIT 1000`).bind(...args).all();
  const lista = q ? results.filter((c) => q.split(' ').every((p) => semAcento(`${c.nome} ${c.apresentacao ?? ''}`).includes(p))) : results;
  const agora = agoraDe(env);
  const est = await estatisticasDeEstoque(env, agora);
  const itens = lista.map((c) => itemPublico(c, est.get(c.id)));
  return json({
    hoje: hojeBahia(agora),
    itens,
    resumo: {
      sem_estoque: itens.filter((i) => i.total <= 0).length,
      com_vencidos: itens.filter((i) => i.vencidos > 0).length,
      vencendo_em_30_dias: itens.filter((i) => i.dias_para_vencer !== null && i.dias_para_vencer >= 0 && i.dias_para_vencer <= 30 && i.total > 0).length,
    },
  });
}

async function estoqueVer(request, env, id) {
  await exigirLogin(request, env);
  const c = await itemDeEstoque(env, id);
  const agora = agoraDe(env);
  const est = (await estatisticasDeEstoque(env, agora, [id])).get(id);
  const { results: lotes } = await env.DB.prepare(
    `SELECT l.*, u.nome AS criado_por_nome FROM estoque_lotes l JOIN usuarios u ON u.id = l.criado_por
      WHERE l.catalogo_id = ? ORDER BY (l.quantidade_atual <= 0), (l.validade IS NULL), l.validade, l.id`
  ).bind(id).all();
  const { results: movs } = await env.DB.prepare(
    `SELECT m.*, u.nome AS usuario_nome, l.validade AS lote_validade FROM estoque_movimentos m
       LEFT JOIN usuarios u ON u.id = m.criado_por LEFT JOIN estoque_lotes l ON l.id = m.lote_id
      WHERE m.catalogo_id = ? ORDER BY m.id DESC LIMIT 100`
  ).bind(id).all();
  return json({
    item: { ...itemPublico(c, est), controla_estoque: c.controla_estoque === 1 },
    hoje: hojeBahia(agora),
    lotes: lotes.map((l) => ({
      id: l.id, quantidade_inicial: l.quantidade_inicial, quantidade_atual: l.quantidade_atual, validade: l.validade ?? null,
      dias_para_vencer: l.validade ? diasAteValidade(l.validade, agora) : null,
      custo_unitario_centavos: l.custo_unitario_centavos ?? null, observacao: l.observacao ?? null, criado_por_nome: l.criado_por_nome, criado_em: l.criado_em,
    })),
    movimentos: movs.map((m) => ({
      id: m.id, tipo: m.tipo, quantidade: m.quantidade, motivo: m.motivo ?? null, sem_estoque: m.sem_estoque === 1, revertido: m.revertido === 1,
      lote_id: m.lote_id ?? null, lote_validade: m.lote_validade ?? null, pedido_id: m.pedido_id ?? null, usuario_nome: m.usuario_nome ?? null, criado_em: m.criado_em,
    })),
  });
}

async function estoqueEntrada(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_ESTOQUE);
  const c = await lerJson(request);
  const item = await exigirControle(env, id);
  const quantidade = lerQuantidade(c.quantidade);
  const validade = lerValidade(c.validade);
  const custo = lerCusto(c.custo_unitario_centavos);
  const observacao = texto(c.observacao, 'observação', { obrigatorio: false, max: 200 }) || null;
  const agora = agoraDe(env).toISOString();
  const saidas = await env.DB.batch([
    env.DB.prepare('INSERT INTO estoque_lotes (catalogo_id, quantidade_inicial, quantidade_atual, validade, custo_unitario_centavos, observacao, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, quantidade, quantidade, validade, custo, observacao, u.id, agora),
    env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, criado_por, criado_em) VALUES (?, last_insert_rowid(), 'entrada', ?, ?, ?, ?)`)
      .bind(id, quantidade, observacao, u.id, agora),
    prepararAcao(env, { usuarioId: u.id, acao: 'entrada_estoque', entidade: 'catalogo', entidadeId: id, depois: { quantidade, validade, custo_unitario_centavos: custo }, ip: ipDe(request) }),
  ]);
  const loteId = saidas[0].meta.last_row_id;
  const est = (await estatisticasDeEstoque(env, agoraDe(env), [id])).get(id);
  return json({ ok: true, lote_id: loteId, item: itemPublico(item, est) }, 201);
}

// Ajuste: "nova_quantidade" (como deve ficar) ou "delta" (+ ou −), sempre com motivo.
// Sem "lote_id" vale para o produto todo: para menos, tira dos lotes que vencem antes; para mais, cria um lote novo.
// Com "lote_id" vale só para aquele lote.
async function estoqueAjuste(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_ESTOQUE);
  const c = await lerJson(request);
  const item = await exigirControle(env, id);
  const motivo = texto(c.motivo, 'motivo do ajuste', { max: 200 });
  const temNova = c.nova_quantidade !== undefined && c.nova_quantidade !== null;
  const temDelta = c.delta !== undefined && c.delta !== null;
  if (temNova === temDelta) throw new ErroHttp(400, 'Informe a nova quantidade ou quanto somar/tirar (só um dos dois).');
  const valor = temNova ? c.nova_quantidade : c.delta;
  if (typeof valor !== 'number' || !Number.isFinite(valor) || Math.abs(valor) > MAX_QUANTIDADE || (temNova && valor < 0)) throw new ErroHttp(400, 'Quantidade inválida.');
  const validadeNova = lerValidade(c.validade);
  const agora = agoraDe(env).toISOString();

  let lotes;
  if (c.lote_id !== undefined && c.lote_id !== null) {
    if (typeof c.lote_id !== 'number' || !Number.isInteger(c.lote_id)) throw new ErroHttp(400, 'Lote inválido.');
    const l = await env.DB.prepare('SELECT * FROM estoque_lotes WHERE id = ? AND catalogo_id = ?').bind(c.lote_id, id).first();
    if (!l) throw new ErroHttp(404, 'Lote não encontrado.');
    lotes = [l];
  } else {
    ({ results: lotes } = await env.DB.prepare('SELECT * FROM estoque_lotes WHERE catalogo_id = ? AND quantidade_atual > 0 ORDER BY (validade IS NULL), validade, id').bind(id).all());
  }
  const total = arredondar(lotes.reduce((s, l) => s + l.quantidade_atual, 0));
  const delta = arredondar(temNova ? valor - total : valor);
  if (delta === 0) throw new ErroHttp(400, 'Nada a ajustar: a quantidade já é essa.');
  if (total + delta < 0) throw new ErroHttp(400, `Não dá para tirar ${-delta}: só há ${total} em estoque.`);

  const comandos = [];
  if (delta > 0) {
    if (lotes.length === 1 && c.lote_id !== undefined && c.lote_id !== null) {
      comandos.push(
        env.DB.prepare('UPDATE estoque_lotes SET quantidade_atual = ROUND(quantidade_atual + ?, 3) WHERE id = ?').bind(delta, lotes[0].id),
        env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, criado_por, criado_em) VALUES (?, ?, 'ajuste', ?, ?, ?, ?)`).bind(id, lotes[0].id, delta, motivo, u.id, agora));
    } else {
      comandos.push(
        env.DB.prepare('INSERT INTO estoque_lotes (catalogo_id, quantidade_inicial, quantidade_atual, validade, observacao, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, delta, delta, validadeNova, `Ajuste: ${motivo}`.slice(0, 200), u.id, agora),
        env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, criado_por, criado_em) VALUES (?, last_insert_rowid(), 'ajuste', ?, ?, ?, ?)`).bind(id, delta, motivo, u.id, agora));
    }
  } else {
    let falta = -delta;
    for (const l of lotes) {
      if (falta <= 0) break;
      const tira = Math.min(l.quantidade_atual, falta);
      falta = arredondar(falta - tira);
      comandos.push(
        env.DB.prepare('UPDATE estoque_lotes SET quantidade_atual = ROUND(quantidade_atual - ?, 3) WHERE id = ?').bind(tira, l.id),
        env.DB.prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, motivo, criado_por, criado_em) VALUES (?, ?, 'ajuste', ?, ?, ?, ?)`).bind(id, l.id, -tira, motivo, u.id, agora));
    }
  }
  comandos.push(prepararAcao(env, { usuarioId: u.id, acao: 'ajuste_estoque', entidade: 'catalogo', entidadeId: id, antes: { total }, depois: { total: arredondar(total + delta), delta, motivo, lote_id: c.lote_id ?? null }, ip: ipDe(request) }));
  await env.DB.batch(comandos);
  const est = (await estatisticasDeEstoque(env, agoraDe(env), [id])).get(id);
  return json({ ok: true, delta, item: itemPublico(item, est) });
}

export const ROTAS_ESTOQUE = [
  ['GET', '/api/estoque', estoqueListar],
  ['GET', '/api/estoque/:id', estoqueVer],
  ['POST', '/api/estoque/:id/entradas', estoqueEntrada],
  ['POST', '/api/estoque/:id/ajustes', estoqueAjuste],
];
