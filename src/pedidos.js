// Pedido (a "conta" do atendimento) e pagamentos.
//  - Um atendimento tem no máximo UM pedido que não esteja cancelado.
//  - O pedido nasce "de mentirinha" (rascunho calculado) quando alguém abre a conta; só é gravado ao salvar os itens.
//  - Dinheiro sempre em centavos inteiros. Datas em texto ISO (UTC).
//  - "Finalizado" (atendimento, clínico) e "Pago" (pedido, financeiro) são coisas independentes.
//  - Nunca guardamos número de cartão: só a forma de pagamento e, se quiserem, a foto do comprovante.
import { exigirAdmin, exigirLogin } from './auth.js';
import { notificar } from './notificacoes.js';
import { sincronizarSemFalhar } from './estoque.js';
import { ErroHttp, agoraISO, inicioDoDiaBahia, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';

export const FORMAS = ['pix', 'cartao', 'dinheiro'];
const ORIGENS = ['consulta', 'receita', 'manual'];
const ABERTOS = ['aberto', 'aguardando_pagamento']; // pedidos que ainda aceitam alterações e pagamentos
const PAPEIS_CLINICOS = ['veterinario', 'suporte'];
const MAX_VALOR = 10_000_000; // R$ 100.000,00 por unidade (igual ao resto do sistema)
const MAX_ITENS = 60;
const CORTE_PADRAO = '18:00';
const DESLOCAMENTO_BAHIA_MS = 3 * 60 * 60 * 1000;

// ---------- apoio ----------

// 1234500 -> "R$ 12.345,00" (mesmo texto que o app mostra na tela).
export function reais(centavos) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number.isFinite(centavos) ? centavos : 0) / 100).replace(/\s/g, ' ');
}

// Produtos "que temos" nas receitas do atendimento (menos os que vieram do carrinho: esses já estão na conta).
// Receitas canceladas não contam; e quando existe
// uma nova versão (que não foi cancelada), só a nova conta, para não somar duas vezes.
// (Precisa de um "a" = atendimento na consulta que usa este trecho.)
export const PRODUTOS_DO_ATENDIMENTO = `
  FROM receita_itens i JOIN receitas r ON r.id = i.receita_id
 WHERE r.atendimento_id = a.id AND r.status <> 'cancelada' AND i.temos = 1 AND i.do_carrinho = 0
   AND NOT (i.catalogo_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM pedidos pe JOIN itens_pedido ip ON ip.pedido_id = pe.id
      WHERE pe.atendimento_id = a.id AND pe.status <> 'cancelado' AND ip.catalogo_id = i.catalogo_id AND ip.origem = 'manual'))
   AND NOT EXISTS (SELECT 1 FROM receitas n WHERE n.receita_anterior_id = r.id AND n.status <> 'cancelada')`;

const inteiro = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const PEDIDO_ATIVO = `status <> 'cancelado'`;
const SOMA_PAGA = `(SELECT COALESCE(SUM(g.valor_centavos), 0) FROM pagamentos g WHERE g.pedido_id = p.id AND g.estornado = 0)`;

// ---------- regra da consulta (valor pelo horário em que o atendimento COMEÇOU) ----------

// Hora de corte configurada ("HH:MM" em Bahia). Se estiver vazia ou errada, vale 18:00.
export async function horaDeCorte(env) {
  const l = await env.DB.prepare(`SELECT valor FROM configuracoes WHERE chave = 'consulta_hora_corte'`).first();
  const v = String(l?.valor ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : CORTE_PADRAO;
}

// "HH:MM" no relógio de Bahia (UTC-03:00) de um instante ISO.
export function horaBahia(iso) {
  const d = new Date(new Date(iso).getTime() - DESLOCAMENTO_BAHIA_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// true se o instante é a hora de corte ou depois (18:00 já é "depois"; 17:59 ainda é "até").
export function depoisDoCorte(iso, corte = CORTE_PADRAO) {
  return horaBahia(iso) >= corte; // "HH:MM" com zero à esquerda compara certo como texto
}

// "18:00" -> "18h"; "17:30" -> "17h30"
export function rotuloCorte(corte) {
  const [h, m] = corte.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

// Item da consulta. Os preços vêm do catálogo, pelas marcas "papel_fixo" (consulta_dia = até o corte,
// consulta_noite = depois do corte, retorno = volta do paciente, valor fixo do catálogo).
// Se o atendimento ainda não começou, vale a hora de agora.
export async function itemConsulta(env, iniciadoEm, agora = new Date(), tipo = 'consulta') {
  const { results: fixos } = await env.DB.prepare(`SELECT id, nome, preco_centavos, papel_fixo FROM catalogo WHERE papel_fixo IS NOT NULL`).all();
  const por = (papel) => fixos.find((x) => x.papel_fixo === papel);
  if (tipo === 'retorno' && por('retorno')) {
    const r = por('retorno');
    return {
      descricao: r.nome, quantidade: 1, preco_unitario_centavos: r.preco_centavos, catalogo_id: r.id, origem: 'consulta',
      depois_do_corte: false, hora_base: null, hora_de_corte: null, iniciado: !!iniciadoEm, tipo: 'retorno',
      explicacao: 'Retorno do paciente: valor fixo do catálogo (não depende do horário)',
    };
  }
  const corte = await horaDeCorte(env);
  const dia = por('consulta_dia');
  const noite = por('consulta_noite');
  if (!dia && !noite) return null;
  const base = iniciadoEm || agora.toISOString();
  const depois = depoisDoCorte(base, corte);
  const linha = depois ? (noite ?? dia) : (dia ?? noite);
  const rotulo = rotuloCorte(corte);
  const hora = horaBahia(base);
  return {
    descricao: depois ? `Consulta (após ${rotulo})` : `Consulta (até ${rotulo})`,
    quantidade: 1, preco_unitario_centavos: linha.preco_centavos, catalogo_id: linha.id, origem: 'consulta',
    depois_do_corte: depois, hora_base: hora, hora_de_corte: corte, iniciado: !!iniciadoEm, tipo: 'consulta',
    explicacao: iniciadoEm
      ? `Atendimento iniciado às ${hora} → valor ${depois ? 'após' : 'até'} as ${rotulo}`
      : `Atendimento ainda não iniciado; usando a hora de agora (${hora}) → valor ${depois ? 'após' : 'até'} as ${rotulo}`,
  };
}

// Produtos da receita (só os que "temos"), na versão mais nova de cada receita.
export async function produtosDaReceita(env, atendimentoId) {
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.descricao, j.quantidade, j.valor_unitario_centavos
       FROM atendimentos a JOIN receita_itens j ON j.id IN (SELECT i.id ${PRODUTOS_DO_ATENDIMENTO})
      WHERE a.id = ? ORDER BY j.receita_id, j.ordem, j.id`
  ).bind(atendimentoId).all();
  return {
    itens: results.filter((x) => x.valor_unitario_centavos !== null)
      .map((x) => ({ descricao: x.descricao, quantidade: x.quantidade, preco_unitario_centavos: x.valor_unitario_centavos, catalogo_id: null, origem: 'receita' })),
    sem_valor: results.filter((x) => x.valor_unitario_centavos === null).map((x) => ({ descricao: x.descricao, quantidade: x.quantidade })),
  };
}

// ---------- leitura ----------
async function atendimentoComPet(env, id) {
  const a = await env.DB.prepare(
    `SELECT a.id, a.status, a.tipo, a.peso_kg, a.chegada_em, a.iniciado_em, a.finalizado_em, p.id AS pet_id, p.nome AS pet_nome, p.especie, p.foto_id AS pet_foto_id,
            t.id AS tutor_id, t.nome AS tutor_nome, v.nome AS vet_nome
       FROM atendimentos a JOIN pets p ON p.id = a.pet_id JOIN tutores t ON t.id = p.tutor_id LEFT JOIN usuarios v ON v.id = a.veterinario_id
      WHERE a.id = ?`
  ).bind(id).first();
  if (!a) throw new ErroHttp(404, 'Atendimento não encontrado.');
  return a;
}

const pedidoAtivoDe = (env, atendimentoId) =>
  env.DB.prepare(`SELECT * FROM pedidos WHERE atendimento_id = ? AND ${PEDIDO_ATIVO} ORDER BY id DESC LIMIT 1`).bind(atendimentoId).first();

async function pedidoPorId(env, id) {
  const p = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?').bind(id).first();
  if (!p) throw new ErroHttp(404, 'Pedido não encontrado.');
  return p;
}

async function somaPaga(env, pedidoId) {
  const l = await env.DB.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM pagamentos WHERE pedido_id = ? AND estornado = 0').bind(pedidoId).first();
  return l.n;
}

const subtotal = (i) => i.quantidade * i.preco_unitario_centavos;

function pagamentoPublico(g) {
  return {
    id: g.id, forma: g.forma, valor_centavos: g.valor_centavos,
    recebido_dinheiro_centavos: g.recebido_dinheiro_centavos ?? null,
    troco_centavos: g.forma === 'dinheiro' && g.recebido_dinheiro_centavos != null ? g.recebido_dinheiro_centavos - g.valor_centavos : null,
    comprovante_foto_id: g.comprovante_foto_id ?? null,
    recebido_por: { id: g.recebido_por, nome: g.recebedor_nome }, recebido_em: g.recebido_em,
    estornado: g.estornado === 1,
    estornado_por: g.estornado_por ? { id: g.estornado_por, nome: g.estornador_nome } : null,
    estornado_em: g.estornado_em ?? null, estorno_motivo: g.estorno_motivo ?? null,
  };
}

// Tudo que a tela da conta precisa: o pedido (ou o rascunho calculado), o atendimento e as sugestões automáticas.
export async function respostaPedido(env, atendimentoId) {
  const a = await atendimentoComPet(env, atendimentoId);
  const ped = await pedidoAtivoDe(env, atendimentoId);
  const consulta = await itemConsulta(env, a.iniciado_em, new Date(), a.tipo);
  const receita = await produtosDaReceita(env, atendimentoId);
  const automaticos = { consulta, receita: receita.itens, sem_valor: receita.sem_valor };
  const atendimento = {
    id: a.id, status: a.status, tipo: a.tipo, peso_kg: a.peso_kg ?? null, chegada_em: a.chegada_em, iniciado_em: a.iniciado_em ?? null, finalizado_em: a.finalizado_em ?? null,
    veterinario_nome: a.vet_nome ?? null,
    pet: { id: a.pet_id, nome: a.pet_nome, especie: a.especie, foto_id: a.pet_foto_id ?? null },
    tutor: { id: a.tutor_id, nome: a.tutor_nome },
  };

  if (!ped) {
    // Rascunho: ainda não existe no banco. Só será gravado quando alguém salvar os itens.
    const itens = [consulta, ...receita.itens].filter(Boolean).map(({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }) =>
      ({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem, subtotal_centavos: quantidade * preco_unitario_centavos }));
    const total = itens.reduce((s, i) => s + i.subtotal_centavos, 0);
    return { pedido: { id: null, rascunho: true, status: 'aberto', onde_cobrar: null, total_centavos: total, pago_centavos: 0, restante_centavos: total, itens, pagamentos: [], pode_editar: true }, atendimento, automaticos };
  }

  const { results: itensBrutos } = await env.DB.prepare('SELECT * FROM itens_pedido WHERE pedido_id = ? ORDER BY id').bind(ped.id).all();
  const { results: pagBrutos } = await env.DB.prepare(
    `SELECT g.*, r.nome AS recebedor_nome, e.nome AS estornador_nome FROM pagamentos g
       JOIN usuarios r ON r.id = g.recebido_por LEFT JOIN usuarios e ON e.id = g.estornado_por
      WHERE g.pedido_id = ? ORDER BY g.id`
  ).bind(ped.id).all();
  const pagamentos = pagBrutos.map(pagamentoPublico);
  const pago = pagamentos.filter((g) => !g.estornado).reduce((s, g) => s + g.valor_centavos, 0);
  const enviador = ped.enviado_por ? await env.DB.prepare('SELECT id, nome, papel FROM usuarios WHERE id = ?').bind(ped.enviado_por).first() : null;
  return {
    pedido: {
      id: ped.id, rascunho: false, status: ped.status, onde_cobrar: ped.onde_cobrar ?? null,
      total_centavos: ped.total_centavos, pago_centavos: pago, restante_centavos: Math.max(0, ped.total_centavos - pago),
      itens: itensBrutos.map((i) => ({ id: i.id, descricao: i.descricao, quantidade: i.quantidade, preco_unitario_centavos: i.preco_unitario_centavos, catalogo_id: i.catalogo_id ?? null, origem: i.origem, subtotal_centavos: subtotal(i) })),
      pagamentos,
      enviado_por: enviador ? { id: enviador.id, nome: enviador.nome, papel: enviador.papel } : null, enviado_em: ped.enviado_em ?? null, pago_em: ped.pago_em ?? null,
      criado_em: ped.criado_em, pode_editar: ABERTOS.includes(ped.status),
    },
    atendimento, automaticos,
  };
}

// Resumo do pedido de cada atendimento (para a tela Hoje). Devolve um Map atendimento_id -> resumo.
export async function resumosDePedidos(env, atendimentoIds) {
  const mapa = new Map();
  if (!atendimentoIds.length) return mapa;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.atendimento_id, p.status, p.total_centavos, ${SOMA_PAGA} AS pago FROM pedidos p
      WHERE p.${PEDIDO_ATIVO} AND p.atendimento_id IN (${atendimentoIds.map(() => '?').join(',')})`
  ).bind(...atendimentoIds).all();
  for (const r of results) mapa.set(r.atendimento_id, { id: r.id, status: r.status, total_centavos: r.total_centavos, pago_centavos: r.pago });
  return mapa;
}

// Pedidos esperando pagamento (de qualquer dia): os finalizados e não pagos precisam ficar visíveis.
export async function listaAguardandoPagamento(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.atendimento_id, p.total_centavos, COALESCE(p.enviado_em, p.atualizado_em) AS desde, ${SOMA_PAGA} AS pago,
            p.enviado_por, u.nome AS enviado_nome, u.papel AS enviado_papel, a.status AS atendimento_status,
            pt.id AS pet_id, pt.nome AS pet_nome, pt.especie, pt.foto_id AS pet_foto_id, t.id AS tutor_id, t.nome AS tutor_nome
       FROM pedidos p JOIN atendimentos a ON a.id = p.atendimento_id JOIN pets pt ON pt.id = a.pet_id JOIN tutores t ON t.id = pt.tutor_id
       LEFT JOIN usuarios u ON u.id = p.enviado_por
      WHERE p.status = 'aguardando_pagamento' ORDER BY desde ASC, p.id ASC LIMIT 200`
  ).all();
  return results.map((r) => ({
    pedido_id: r.id, atendimento_id: r.atendimento_id, atendimento_status: r.atendimento_status,
    total_centavos: r.total_centavos, pago_centavos: r.pago, restante_centavos: Math.max(0, r.total_centavos - r.pago),
    enviado_por: r.enviado_por ? { id: r.enviado_por, nome: r.enviado_nome, papel: r.enviado_papel } : null, enviado_em: r.desde,
    pet: { id: r.pet_id, nome: r.pet_nome, especie: r.especie, foto_id: r.pet_foto_id ?? null },
    tutor: { id: r.tutor_id, nome: r.tutor_nome },
  }));
}

// ---------- itens ----------
async function lerItens(env, lista) {
  if (!Array.isArray(lista)) throw new ErroHttp(400, 'Envie a lista de itens.');
  if (lista.length > MAX_ITENS) throw new ErroHttp(400, `A conta pode ter no máximo ${MAX_ITENS} itens.`);
  const saida = [];
  for (const c of lista) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new ErroHttp(400, 'Item inválido.');
    let catalogo = null;
    if (c.catalogo_id !== undefined && c.catalogo_id !== null) {
      if (!inteiro(c.catalogo_id, 1, Number.MAX_SAFE_INTEGER)) throw new ErroHttp(400, 'Item do catálogo inválido.');
      catalogo = await env.DB.prepare('SELECT id, nome, preco_centavos FROM catalogo WHERE id = ?').bind(c.catalogo_id).first();
      if (!catalogo) throw new ErroHttp(400, 'Item do catálogo não encontrado.');
    }
    const descricao = texto(c.descricao ?? catalogo?.nome, 'descrição do item', { max: 200 });
    const quantidade = c.quantidade === undefined ? 1 : c.quantidade;
    if (!inteiro(quantidade, 1, 999)) throw new ErroHttp(400, 'A quantidade deve ser um número inteiro de 1 a 999.');
    const preco = c.preco_unitario_centavos ?? catalogo?.preco_centavos;
    if (!inteiro(preco, 0, MAX_VALOR)) throw new ErroHttp(400, 'Informe o valor do item (em centavos, de 0 a R$ 100.000,00).');
    const origem = c.origem ?? 'manual';
    if (!ORIGENS.includes(origem)) throw new ErroHttp(400, 'Origem do item inválida.');
    saida.push({ descricao, quantidade, preco_unitario_centavos: preco, catalogo_id: catalogo ? catalogo.id : null, origem });
  }
  return saida;
}

const resumoItens = (itens) => itens.map((i) => ({ descricao: i.descricao, quantidade: i.quantidade, preco_unitario_centavos: i.preco_unitario_centavos, origem: i.origem }));

// ---------- rotas ----------
async function pedidoVer(request, env, atendimentoId) {
  await exigirLogin(request, env);
  return json(await respostaPedido(env, atendimentoId));
}

// Salva a lista de itens (cria o pedido se ainda não existir). Recepção, veterinário e suporte podem.
async function pedidoSalvarItens(request, env, atendimentoId) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const a = await atendimentoComPet(env, atendimentoId);
  if (a.status === 'cancelado') throw new ErroHttp(409, 'Este atendimento foi cancelado.');
  const itens = await lerItens(env, c.itens);
  const total = itens.reduce((s, i) => s + subtotal(i), 0);
  if (!Number.isSafeInteger(total) || total > MAX_VALOR * 10) throw new ErroHttp(400, 'O total da conta está alto demais.');
  const agora = agoraISO();
  const ip = ipDe(request);

  let ped = await pedidoAtivoDe(env, atendimentoId);
  let antesItens = null;
  let criou = false;
  if (!ped) {
    try {
      const r = await env.DB.prepare(`INSERT INTO pedidos (atendimento_id, status, total_centavos, criado_por, criado_em, atualizado_em) VALUES (?, 'aberto', 0, ?, ?, ?)`)
        .bind(atendimentoId, u.id, agora, agora).run();
      ped = await pedidoPorId(env, r.meta.last_row_id);
      criou = true;
    } catch (e) {
      // Duas pessoas abriram a conta ao mesmo tempo: o índice único do banco barrou a segunda; usamos a da primeira.
      if (!String(e.message).includes('UNIQUE')) throw e;
      ped = await pedidoAtivoDe(env, atendimentoId);
    }
  }
  if (!criou) {
    if (ped.status === 'pago') throw new ErroHttp(409, 'Esta conta já foi paga e não pode mais ser alterada. Se precisar corrigir, um administrador pode desfazer o pagamento.');
    const { results } = await env.DB.prepare('SELECT descricao, quantidade, preco_unitario_centavos, origem FROM itens_pedido WHERE pedido_id = ? ORDER BY id').bind(ped.id).all();
    antesItens = { total_centavos: ped.total_centavos, itens: resumoItens(results) };
  }
  const pago = await somaPaga(env, ped.id);
  if (total < pago) {
    if (criou) await env.DB.prepare('DELETE FROM pedidos WHERE id = ?').bind(ped.id).run();
    throw new ErroHttp(409, `O total não pode ficar menor que o que já foi pago (${reais(pago)}).`);
  }
  const fechaPago = pago > 0 && total === pago;
  const vivo = `EXISTS (SELECT 1 FROM pedidos WHERE id = ? AND status IN ('aberto','aguardando_pagamento'))`;
  const comandos = [
    env.DB.prepare(`DELETE FROM itens_pedido WHERE pedido_id = ? AND ${vivo}`).bind(ped.id, ped.id),
    ...itens.map((i) => env.DB.prepare(
      `INSERT INTO itens_pedido (pedido_id, catalogo_id, descricao, quantidade, preco_unitario_centavos, origem) SELECT ?, ?, ?, ?, ?, ? WHERE ${vivo}`
    ).bind(ped.id, i.catalogo_id, i.descricao, i.quantidade, i.preco_unitario_centavos, i.origem, ped.id)),
    env.DB.prepare(`UPDATE pedidos SET total_centavos = ?, atualizado_em = ?${fechaPago ? `, status = 'pago', pago_em = ?` : ''} WHERE id = ? AND status IN ('aberto','aguardando_pagamento')`)
      .bind(total, agora, ...(fechaPago ? [agora] : []), ped.id),
    prepararAcao(env, {
      usuarioId: u.id, acao: criou ? 'criar_pedido' : 'alterar_itens_pedido', entidade: 'pedidos', entidadeId: ped.id,
      antes: antesItens, depois: { atendimento_id: atendimentoId, total_centavos: total, itens: resumoItens(itens) }, ip,
    }),
  ];
  await env.DB.batch(comandos);
  await sincronizarSemFalhar(env, ped.id, u.id); // estoque: baixa se a conta fechou paga; devolve se saiu de "paga"
  return json(await respostaPedido(env, atendimentoId), criou ? 201 : 200);
}

// Mudou de "consulta" para "retorno" (ou ao contrário) com a conta já criada: o item da consulta da conta
// troca sozinho. Devolve uma função (agora) -> comandos do batch, ou null se não há nada a trocar.
// Recusa se a conta já foi paga ou se o novo total ficaria igual/menor que o que já foi recebido.
export async function prepararTrocaDeTipo(env, atendimentoId, novoTipo, atendimento) {
  const ped = await pedidoAtivoDe(env, atendimentoId);
  if (!ped) return null;
  if (ped.status === 'pago') throw new ErroHttp(409, 'A conta já foi paga: não dá mais para trocar entre consulta e retorno. Um administrador pode desfazer o pagamento antes.');
  const { results: atuais } = await env.DB.prepare(`SELECT preco_unitario_centavos, quantidade FROM itens_pedido WHERE pedido_id = ? AND origem = 'consulta'`).bind(ped.id).all();
  if (!atuais.length) return null;
  const novo = await itemConsulta(env, atendimento.iniciado_em, new Date(), novoTipo);
  const total = ped.total_centavos - atuais.reduce((t, i) => t + i.quantidade * i.preco_unitario_centavos, 0) + (novo ? novo.preco_unitario_centavos : 0);
  const pago = await somaPaga(env, ped.id);
  if (pago > 0 && total <= pago) throw new ErroHttp(409, `Já foram recebidos ${reais(pago)} desta conta: não dá para trocar o tipo da visita. Peça a um administrador para desfazer o pagamento.`);
  return (agora) => [
    env.DB.prepare(`DELETE FROM itens_pedido WHERE pedido_id = ? AND origem = 'consulta'`).bind(ped.id),
    ...(novo ? [env.DB.prepare(`INSERT INTO itens_pedido (pedido_id, catalogo_id, descricao, quantidade, preco_unitario_centavos, origem) VALUES (?, ?, ?, 1, ?, 'consulta')`)
      .bind(ped.id, novo.catalogo_id, novo.descricao, novo.preco_unitario_centavos)] : []),
    env.DB.prepare(`UPDATE pedidos SET total_centavos = ?, atualizado_em = ? WHERE id = ? AND status IN ('aberto','aguardando_pagamento')`).bind(total, agora, ped.id),
  ];
}

// Manda a conta para a recepção cobrar e avisa a recepção no celular.
async function pedidoEnviarRecepcao(request, env, id) {
  const u = await exigirLogin(request, env);
  const ped = await pedidoPorId(env, id);
  if (ped.status !== 'aberto') throw new ErroHttp(409, ped.status === 'aguardando_pagamento' ? 'Esta conta já está aguardando pagamento.' : 'Só é possível enviar uma conta aberta.');
  if (ped.total_centavos <= 0) throw new ErroHttp(400, 'A conta está vazia. Adicione os itens antes de enviar.');
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE pedidos SET status = 'aguardando_pagamento', onde_cobrar = 'recepcao', enviado_por = ?, enviado_em = ?, atualizado_em = ? WHERE id = ? AND status = 'aberto'`
  ).bind(u.id, agora, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta conta mudou. Atualize a tela.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'enviar_pedido_recepcao', entidade: 'pedidos', entidadeId: id, antes: { status: 'aberto' }, depois: { status: 'aguardando_pagamento', onde_cobrar: 'recepcao', total_centavos: ped.total_centavos }, ip: ipDe(request) });
  // Aviso para a recepção. Nunca atrapalha o envio, mesmo se a notificação falhar.
  // ("env.NOTIFICAR_TESTE" é um gancho só para os testes conferirem o que seria enviado.)
  try {
    const a = await atendimentoComPet(env, ped.atendimento_id);
    await (env.NOTIFICAR_TESTE ?? notificar)(env, {
      para: { papel: 'recepcao', excetoUsuarioId: u.id },
      titulo: 'Pagamento para receber', corpo: `${a.pet_nome} · ${reais(ped.total_centavos)} · ${u.nome}`,
      url: '#/hoje', tag: `pagamento-${id}`,
    });
  } catch (e) {
    console.error('Falha ao avisar a recepção:', e);
  }
  return json(await respostaPedido(env, ped.atendimento_id));
}

// Registra um pagamento (pode haver vários: parte no Pix, parte em dinheiro). Qualquer pessoa da equipe pode receber.
async function pagamentoRegistrar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  if (!FORMAS.includes(c.forma)) throw new ErroHttp(400, 'Escolha a forma de pagamento: Pix, cartão ou dinheiro.');
  if (!inteiro(c.valor_centavos, 1, MAX_VALOR * 10)) throw new ErroHttp(400, 'Informe o valor recebido.');
  let fotoId = null;
  if (c.comprovante_foto_id !== undefined && c.comprovante_foto_id !== null && c.comprovante_foto_id !== '') {
    fotoId = Number(c.comprovante_foto_id);
    if (!Number.isInteger(fotoId) || fotoId < 1) throw new ErroHttp(400, 'Foto inválida.');
    if (!(await env.DB.prepare('SELECT id FROM fotos WHERE id = ?').bind(fotoId).first())) throw new ErroHttp(400, 'Foto não encontrada. Envie a foto de novo.');
  }
  let recebido = null; // só dinheiro: quanto o cliente entregou
  if (c.forma === 'dinheiro' && c.recebido_dinheiro_centavos !== undefined && c.recebido_dinheiro_centavos !== null) {
    if (!inteiro(c.recebido_dinheiro_centavos, 1, MAX_VALOR * 10)) throw new ErroHttp(400, 'Valor entregue pelo cliente inválido.');
    if (c.recebido_dinheiro_centavos < c.valor_centavos) throw new ErroHttp(400, 'O dinheiro recebido é menor que o valor a pagar.');
    recebido = c.recebido_dinheiro_centavos;
  }

  const ped = await pedidoPorId(env, id);
  if (ped.status === 'pago') throw new ErroHttp(409, 'Esta conta já está paga.');
  if (!ABERTOS.includes(ped.status)) throw new ErroHttp(409, 'Esta conta foi cancelada.');
  if (ped.total_centavos <= 0) throw new ErroHttp(400, 'A conta está vazia.');
  const pagoAntes = await somaPaga(env, id);
  const restante = ped.total_centavos - pagoAntes;
  if (c.valor_centavos > restante) throw new ErroHttp(400, `O valor é maior que o que falta pagar (${reais(restante)}).`);

  const agora = agoraISO();
  const saidas = await env.DB.batch([
    // Só grava se, neste instante, o valor ainda couber (protege contra dois recebimentos ao mesmo tempo).
    env.DB.prepare(
      `INSERT INTO pagamentos (pedido_id, forma, valor_centavos, recebido_por, recebido_em, comprovante_foto_id, recebido_dinheiro_centavos)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM pedidos p WHERE p.id = ? AND p.status IN ('aberto','aguardando_pagamento') AND p.total_centavos >= ${SOMA_PAGA} + ?)`
    ).bind(id, c.forma, c.valor_centavos, u.id, agora, fotoId, recebido, id, c.valor_centavos),
    // Pago quando a soma cobre o total; antes disso fica "aguardando pagamento" (faltando o resto).
    env.DB.prepare(
      `UPDATE pedidos AS p SET status = CASE WHEN p.total_centavos <= ${SOMA_PAGA} THEN 'pago' ELSE 'aguardando_pagamento' END,
              onde_cobrar = COALESCE(p.onde_cobrar, 'consultorio'),
              pago_em = CASE WHEN p.total_centavos <= ${SOMA_PAGA} THEN ? ELSE p.pago_em END, atualizado_em = ?
        WHERE p.id = ? AND p.status IN ('aberto','aguardando_pagamento')
          AND EXISTS (SELECT 1 FROM pagamentos WHERE pedido_id = p.id AND estornado = 0)`
    ).bind(agora, agora, id),
  ]);
  if (!saidas[0].meta.changes) throw new ErroHttp(409, 'Esta conta mudou enquanto você pagava. Atualize a tela e confira o que falta.');
  const pagamentoId = saidas[0].meta.last_row_id;
  const depois = await pedidoPorId(env, id);
  await sincronizarSemFalhar(env, id, u.id); // conta ficou paga: baixa o estoque (do lote que vence antes)
  await registrarAcao(env, {
    usuarioId: u.id, acao: 'registrar_pagamento', entidade: 'pagamentos', entidadeId: pagamentoId,
    antes: { pedido_status: ped.status, pago_centavos: pagoAntes },
    depois: { pedido_id: id, forma: c.forma, valor_centavos: c.valor_centavos, recebido_dinheiro_centavos: recebido, comprovante_foto_id: fotoId, pedido_status: depois.status },
    ip: ipDe(request),
  });
  const resp = await respostaPedido(env, ped.atendimento_id);
  const pagamento = resp.pedido.pagamentos.find((g) => g.id === pagamentoId);
  return json({ ...resp, pagamento, troco_centavos: pagamento.troco_centavos }, 201);
}

// Anexa (ou troca) a foto do comprovante de um pagamento, na hora ou depois. Qualquer pessoa da equipe pode.
async function pagamentoComprovante(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const fotoId = Number(c.foto_id);
  if (!Number.isInteger(fotoId) || fotoId < 1) throw new ErroHttp(400, 'Foto inválida.');
  if (!(await env.DB.prepare('SELECT id FROM fotos WHERE id = ?').bind(fotoId).first())) throw new ErroHttp(400, 'Foto não encontrada. Envie a foto de novo.');
  const g = await env.DB.prepare('SELECT * FROM pagamentos WHERE id = ?').bind(id).first();
  if (!g) throw new ErroHttp(404, 'Pagamento não encontrado.');
  if (g.estornado === 1) throw new ErroHttp(409, 'Este pagamento foi desfeito.');
  await env.DB.prepare('UPDATE pagamentos SET comprovante_foto_id = ? WHERE id = ?').bind(fotoId, id).run();
  await registrarAcao(env, {
    usuarioId: u.id, acao: 'anexar_comprovante', entidade: 'pagamentos', entidadeId: id,
    antes: { comprovante_foto_id: g.comprovante_foto_id ?? null }, depois: { comprovante_foto_id: fotoId }, ip: ipDe(request),
  });
  const ped = await pedidoPorId(env, g.pedido_id);
  const resp = await respostaPedido(env, ped.atendimento_id);
  return json({ ...resp, pagamento: resp.pedido.pagamentos.find((x) => x.id === id) });
}

// Desfaz um pagamento (estorno). SÓ administradores, com motivo.
async function pagamentoEstornar(request, env, id) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const motivo = texto(c.motivo, 'motivo do estorno', { max: 200 });
  const g = await env.DB.prepare('SELECT * FROM pagamentos WHERE id = ?').bind(id).first();
  if (!g) throw new ErroHttp(404, 'Pagamento não encontrado.');
  if (g.estornado === 1) throw new ErroHttp(409, 'Este pagamento já foi desfeito.');
  const ped = await pedidoPorId(env, g.pedido_id);
  const agora = agoraISO();
  const saidas = await env.DB.batch([
    env.DB.prepare('UPDATE pagamentos SET estornado = 1, estornado_por = ?, estornado_em = ?, estorno_motivo = ? WHERE id = ? AND estornado = 0').bind(adm.id, agora, motivo, id),
    // Se estava pago e agora falta dinheiro, a conta volta a aguardar pagamento.
    env.DB.prepare(
      `UPDATE pedidos AS p SET status = 'aguardando_pagamento', pago_em = NULL, atualizado_em = ?
        WHERE p.id = ? AND p.status = 'pago' AND p.total_centavos > ${SOMA_PAGA}`
    ).bind(agora, g.pedido_id),
  ]);
  if (!saidas[0].meta.changes) throw new ErroHttp(409, 'Este pagamento já foi desfeito.');
  const depois = await pedidoPorId(env, g.pedido_id);
  await sincronizarSemFalhar(env, g.pedido_id, adm.id); // conta reaberta: o estoque volta para os mesmos lotes
  await registrarAcao(env, {
    usuarioId: adm.id, acao: 'estornar_pagamento', entidade: 'pagamentos', entidadeId: id,
    antes: { estornado: false, forma: g.forma, valor_centavos: g.valor_centavos, pedido_status: ped.status },
    depois: { estornado: true, motivo, pedido_status: depois.status }, ip: ipDe(request),
  });
  return json(await respostaPedido(env, ped.atendimento_id));
}

// Cancela a conta (antes de qualquer pagamento). Veterinário, suporte ou administrador, com motivo.
async function pedidoCancelar(request, env, id) {
  const u = await exigirLogin(request, env);
  if (!u.admin && !PAPEIS_CLINICOS.includes(u.papel)) throw new ErroHttp(403, 'Você não tem permissão para cancelar a conta.');
  const c = await lerJson(request);
  const motivo = texto(c.motivo, 'motivo do cancelamento', { max: 200 });
  const ped = await pedidoPorId(env, id);
  if (!ABERTOS.includes(ped.status)) throw new ErroHttp(409, ped.status === 'pago' ? 'Esta conta já foi paga. Peça a um administrador para desfazer o pagamento.' : 'Esta conta já foi cancelada.');
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE pedidos SET status = 'cancelado', cancelado_por = ?, cancelado_em = ?, motivo_cancelamento = ?, atualizado_em = ?
      WHERE id = ? AND status IN ('aberto','aguardando_pagamento') AND NOT EXISTS (SELECT 1 FROM pagamentos WHERE pedido_id = ? AND estornado = 0)`
  ).bind(u.id, agora, motivo, agora, id, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta conta já tem pagamento. Um administrador precisa desfazer o pagamento antes de cancelar.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'cancelar_pedido', entidade: 'pedidos', entidadeId: id, antes: { status: ped.status, total_centavos: ped.total_centavos }, depois: { status: 'cancelado', motivo }, ip: ipDe(request) });
  return json(await respostaPedido(env, ped.atendimento_id));
}

// Caixa do dia (só administrador): o que entrou hoje por forma de pagamento. Pagamentos desfeitos não contam.
async function caixaHoje(request, env) {
  await exigirAdmin(request, env);
  const inicio = inicioDoDiaBahia(new Date());
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.pedido_id, g.forma, g.valor_centavos, g.recebido_em, g.comprovante_foto_id, u.nome AS recebedor, pt.nome AS pet_nome, t.nome AS tutor_nome
       FROM pagamentos g JOIN usuarios u ON u.id = g.recebido_por JOIN pedidos p ON p.id = g.pedido_id
       JOIN atendimentos a ON a.id = p.atendimento_id JOIN pets pt ON pt.id = a.pet_id JOIN tutores t ON t.id = pt.tutor_id
      WHERE g.estornado = 0 AND g.recebido_em >= ? ORDER BY g.recebido_em ASC, g.id ASC`
  ).bind(inicio).all();
  const porForma = Object.fromEntries(FORMAS.map((f) => [f, { total_centavos: 0, quantidade: 0 }]));
  let total = 0;
  for (const g of results) { porForma[g.forma].total_centavos += g.valor_centavos; porForma[g.forma].quantidade += 1; total += g.valor_centavos; }
  const est = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS v FROM pagamentos WHERE estornado = 1 AND estornado_em >= ?').bind(inicio).first();
  return json({
    inicio_dia: inicio, total_centavos: total, quantidade: results.length, por_forma: porForma,
    estornados_hoje: { quantidade: est.n, total_centavos: est.v },
    pagamentos: results.map((g) => ({ id: g.id, pedido_id: g.pedido_id, forma: g.forma, valor_centavos: g.valor_centavos, recebido_em: g.recebido_em, recebido_por: g.recebedor, pet: g.pet_nome, tutor: g.tutor_nome, comprovante_foto_id: g.comprovante_foto_id ?? null })),
  });
}

export const ROTAS_PEDIDOS = [
  ['GET', '/api/atendimentos/:id/pedido', pedidoVer],
  ['PUT', '/api/atendimentos/:id/pedido/itens', pedidoSalvarItens],
  ['POST', '/api/pedidos/:id/enviar-recepcao', pedidoEnviarRecepcao],
  ['POST', '/api/pedidos/:id/pagamentos', pagamentoRegistrar],
  ['POST', '/api/pedidos/:id/cancelar', pedidoCancelar],
  ['POST', '/api/pagamentos/:id/estornar', pagamentoEstornar],
  ['PATCH', '/api/pagamentos/:id/comprovante', pagamentoComprovante],
  ['GET', '/api/caixa/hoje', caixaHoje],
];
