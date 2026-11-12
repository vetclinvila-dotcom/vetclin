// Receita rápida: o veterinário escreve (ou cola do WhatsApp), libera, e a recepção imprime.
// Fluxo: rascunho -> liberada -> impressa -> entregue (ou cancelada).
// Depois de liberada a receita NÃO muda mais: para corrigir, cria-se uma nova versão.
import { exigirAdmin, exigirLogin, exigirPapel } from './auth.js';
import { ErroHttp, agoraISO, inicioDoDiaBahia, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';
import { likeSeguro, normalizarBusca } from './cadastro.js';
import { notificar } from './notificacoes.js';

const PAPEIS_CLINICOS = ['veterinario', 'suporte']; // quem escreve, pede e cancela
const MAX_TEXTO = 10000;
const MAX_ORIENTACOES = 5000;
const MSG_JA_LIBERADA = 'Receita já liberada. Crie uma nova versão para corrigir.';
const STATUS_VISIVEIS_RECEPCAO = ['liberada', 'impressa', 'entregue'];
const CHAVES_CLINICA = ['clinica_nome', 'clinica_endereco', 'clinica_telefone', 'clinica_cidade'];

// ---------- apoio ----------

// Limpa o texto vindo da tela: tira caracteres invisíveis (comuns ao colar do WhatsApp),
// padroniza quebras de linha e tira espaços das pontas.
function limparTexto(valor, campo, max) {
  if (valor === undefined || valor === null) return '';
  if (typeof valor !== 'string') throw new ErroHttp(400, `O campo ${campo} deve ser um texto.`);
  const t = valor.replace(/[​-‍⁠﻿]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (t.length > max) throw new ErroHttp(400, `O texto de ${campo} está grande demais (máximo ${max} letras).`);
  return t;
}

// "+5571999998888" -> "(71) 99999-8888"
function formatarTelefone(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

// "Dra. Elizabeth" fica como está; "Felipe" vira "Dr(a). Felipe".
export function comTratamento(nome) {
  const n = String(nome ?? '').trim();
  return /^dra?\.?\s/i.test(n) ? n : `Dr(a). ${n}`;
}

function idInteiro(valor, mensagem) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new ErroHttp(400, mensagem);
  return n;
}

// Avisa pelo celular. Nunca atrapalha a receita, mesmo se der problema.
// ("env.NOTIFICAR_TESTE" é um gancho só para os testes conferirem o que seria enviado.)
async function avisar(env, aviso) {
  try { await (env.NOTIFICAR_TESTE ?? notificar)(env, aviso); } catch (e) { console.error('Falha ao notificar:', e); }
}

// Primeira linha do texto (para a prévia nas listas).
function primeiraLinha(t) {
  const l = String(t ?? '').split('\n').map((x) => x.trim()).find((x) => x) || '';
  return l.length > 80 ? l.slice(0, 80) + '…' : l;
}

// Resumo do que mudou (sem o texto clínico, só tamanhos) para o registro de ações.
const resumoReceita = (r) => ({
  status: r.status, versao: r.versao, texto_tamanho: (r.texto ?? '').length, orientacoes_tamanho: (r.orientacoes ?? '').length,
  veterinario_id: r.veterinario_id ?? null, solicitada_a: r.solicitada_a ?? null,
});

// ---------- leitura ----------
const SELECT_RECEITA = `
  SELECT r.*, p.nome AS pet_nome, p.especie, p.raca, p.sexo, p.idade_anos, p.idade_meses, p.tutor_id,
         t.nome AS tutor_nome, t.whatsapp AS tutor_whatsapp,
         v.nome AS vet_nome, v.crmv AS vet_crmv,
         sp.nome AS solicitada_por_nome, sa.nome AS solicitada_a_nome, cp.nome AS criado_por_nome
    FROM receitas r
    JOIN pets p ON p.id = r.pet_id
    JOIN tutores t ON t.id = p.tutor_id
    LEFT JOIN usuarios v ON v.id = r.veterinario_id
    LEFT JOIN usuarios sp ON sp.id = r.solicitada_por
    LEFT JOIN usuarios sa ON sa.id = r.solicitada_a
    LEFT JOIN usuarios cp ON cp.id = r.criado_por`;

async function receitaBruta(env, id) {
  const r = await env.DB.prepare('SELECT * FROM receitas WHERE id = ?').bind(id).first();
  if (!r) throw new ErroHttp(404, 'Receita não encontrada.');
  return r;
}

// A recepção só enxerga receitas liberadas, impressas e entregues (nunca rascunhos).
function exigirVisivel(usuario, r) {
  if (usuario.papel === 'recepcao' && !STATUS_VISIVEIS_RECEPCAO.includes(r.status)) {
    throw new ErroHttp(403, 'Você não tem permissão para ver esta receita.');
  }
}

async function configuracaoClinica(env) {
  const { results } = await env.DB.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'clinica_%'`).all();
  const m = Object.fromEntries(results.map((x) => [x.chave, x.valor]));
  return {
    clinica_nome: m.clinica_nome || 'Vetclin',
    clinica_endereco: m.clinica_endereco || '',
    clinica_telefone: m.clinica_telefone || '',
    clinica_cidade: m.clinica_cidade || '',
  };
}

async function ultimoPeso(env, petId) {
  const a = await env.DB.prepare(
    'SELECT peso_kg, chegada_em FROM atendimentos WHERE pet_id = ? AND peso_kg IS NOT NULL ORDER BY chegada_em DESC, id DESC LIMIT 1'
  ).bind(petId).first();
  return a ? { kg: a.peso_kg, data: a.chegada_em } : null;
}

async function detalheReceita(env, id) {
  const r = await env.DB.prepare(`${SELECT_RECEITA} WHERE r.id = ?`).bind(id).first();
  if (!r) throw new ErroHttp(404, 'Receita não encontrada.');
  const anterior = r.receita_anterior_id
    ? await env.DB.prepare('SELECT id, versao, status, liberada_em FROM receitas WHERE id = ?').bind(r.receita_anterior_id).first()
    : null;
  const proxima = await env.DB.prepare('SELECT id, status FROM receitas WHERE receita_anterior_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
  return {
    receita: {
      id: r.id, status: r.status, versao: r.versao, texto: r.texto, orientacoes: r.orientacoes ?? '',
      origem: r.origem, criado_por_nome: r.criado_por_nome ?? null,
      pet_id: r.pet_id, atendimento_id: r.atendimento_id ?? null, criado_em: r.criado_em, atualizado_em: r.atualizado_em,
      liberada_em: r.liberada_em ?? null, impressa_em: r.impressa_em ?? null, vezes_impressa: r.vezes_impressa,
      entregue_em: r.entregue_em ?? null, cancelada_em: r.cancelada_em ?? null,
      solicitada_a: r.solicitada_a ?? null, solicitada_a_nome: r.solicitada_a_nome ?? null,
      solicitada_por: r.solicitada_por ?? null, solicitada_por_nome: r.solicitada_por_nome ?? null, nota_pedido: r.nota_pedido ?? null,
      receita_anterior_id: r.receita_anterior_id ?? null,
      versao_seguinte: proxima ? { id: proxima.id, status: proxima.status } : null,
    },
    pet: {
      id: r.pet_id, nome: r.pet_nome, especie: r.especie, raca: r.raca ?? null, sexo: r.sexo ?? null,
      idade_anos: r.idade_anos ?? null, idade_meses: r.idade_meses ?? null, ultimo_peso: await ultimoPeso(env, r.pet_id),
    },
    tutor: { id: r.tutor_id, nome: r.tutor_nome, whatsapp: formatarTelefone(r.tutor_whatsapp) },
    veterinario: r.veterinario_id ? { id: r.veterinario_id, nome: r.vet_nome, crmv: r.vet_crmv ?? null } : null,
    clinica: await configuracaoClinica(env),
    receita_anterior: anterior ? { id: anterior.id, versao: anterior.versao, status: anterior.status, liberada_em: anterior.liberada_em ?? null } : null,
  };
}

// Item resumido para listas.
function itemLista(r) {
  return {
    id: r.id, status: r.status, versao: r.versao, atendimento_id: r.atendimento_id ?? null,
    origem: r.origem, transcrita_por: r.origem === 'transcrita' ? r.criado_por_nome : null,
    pet: { id: r.pet_id, nome: r.pet_nome, especie: r.especie },
    tutor: { nome: r.tutor_nome },
    veterinario: r.veterinario_id ? { nome: r.vet_nome } : null,
    liberada_em: r.liberada_em ?? null, impressa_em: r.impressa_em ?? null, vezes_impressa: r.vezes_impressa,
    solicitada_por_nome: r.solicitada_por_nome ?? null, nota_pedido: r.nota_pedido ?? null,
    previa: primeiraLinha(r.texto),
  };
}

// ---------- rotas ----------
async function receitasCriar(request, env) {
  const u = await exigirPapel(request, env, PAPEIS_CLINICOS);
  const c = await lerJson(request);
  let petId = c.pet_id !== undefined && c.pet_id !== null && c.pet_id !== '' ? idInteiro(c.pet_id, 'Escolha o pet.') : null;
  let atendId = null;
  if (c.atendimento_id !== undefined && c.atendimento_id !== null && c.atendimento_id !== '') {
    atendId = idInteiro(c.atendimento_id, 'Atendimento inválido.');
    const a = await env.DB.prepare('SELECT id, pet_id FROM atendimentos WHERE id = ?').bind(atendId).first();
    if (!a) throw new ErroHttp(404, 'Atendimento não encontrado.');
    if (petId !== null && petId !== a.pet_id) throw new ErroHttp(400, 'Este atendimento é de outro pet.');
    petId = a.pet_id;
    // Já existe um rascunho para este atendimento? Abre o mesmo, em vez de criar outro.
    const existente = await env.DB.prepare(`SELECT id FROM receitas WHERE atendimento_id = ? AND status = 'rascunho' ORDER BY id DESC LIMIT 1`).bind(atendId).first();
    if (existente) return json({ ...(await detalheReceita(env, existente.id)), existente: true });
  }
  if (petId === null) throw new ErroHttp(400, 'Escolha o pet.');
  const pet = await env.DB.prepare('SELECT id, ativo FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  if (pet.ativo !== 1) throw new ErroHttp(409, 'Este pet está arquivado.');
  const corpo = limparTexto(c.texto, 'receita', MAX_TEXTO);
  const orient = limparTexto(c.orientacoes, 'orientações', MAX_ORIENTACOES) || null;
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `INSERT INTO receitas (pet_id, atendimento_id, criado_por, texto, orientacoes, status, versao, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, 'rascunho', 1, ?, ?)`
  ).bind(petId, atendId, u.id, corpo, orient, agora, agora).run();
  const id = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_receita', entidade: 'receitas', entidadeId: id, depois: { pet_id: petId, atendimento_id: atendId, texto_tamanho: corpo.length, orientacoes_tamanho: (orient ?? '').length }, ip: ipDe(request) });
  return json(await detalheReceita(env, id), 201);
}

async function receitasVer(request, env, id) {
  const u = await exigirLogin(request, env);
  const bruta = await receitaBruta(env, id);
  exigirVisivel(u, bruta);
  return json(await detalheReceita(env, id));
}

// Autosave: a tela manda o texto a cada 1,5 s. Para não encher o registro de ações,
// várias gravações seguidas da mesma pessoa viram UMA linha de registro (atualizada).
async function receitasAlterar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_CLINICOS);
  const c = await lerJson(request);
  const antes = await receitaBruta(env, id);
  if (antes.status !== 'rascunho') throw new ErroHttp(409, MSG_JA_LIBERADA);
  const novo = { ...antes };
  if (c.texto !== undefined) novo.texto = limparTexto(c.texto, 'receita', MAX_TEXTO);
  if (c.orientacoes !== undefined) novo.orientacoes = limparTexto(c.orientacoes, 'orientações', MAX_ORIENTACOES) || null;
  if (novo.texto === antes.texto && novo.orientacoes === antes.orientacoes) return json({ ok: true, atualizado_em: antes.atualizado_em });

  const agora = agoraISO();
  const r = await env.DB.prepare(`UPDATE receitas SET texto = ?, orientacoes = ?, atualizado_em = ? WHERE id = ? AND status = 'rascunho'`)
    .bind(novo.texto, novo.orientacoes, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, MSG_JA_LIBERADA);

  const ultimo = await env.DB.prepare(`SELECT id, usuario_id, acao, em FROM registro_acoes WHERE entidade = 'receitas' AND entidade_id = ? ORDER BY id DESC LIMIT 1`).bind(id).first();
  const dez = 10 * 60 * 1000;
  if (ultimo && ultimo.acao === 'editar_receita' && ultimo.usuario_id === u.id && Date.now() - Date.parse(ultimo.em) < dez) {
    await env.DB.prepare('UPDATE registro_acoes SET depois = ?, em = ? WHERE id = ?').bind(JSON.stringify(resumoReceita(novo)), agora, ultimo.id).run();
  } else {
    await registrarAcao(env, { usuarioId: u.id, acao: 'editar_receita', entidade: 'receitas', entidadeId: id, antes: resumoReceita(antes), depois: resumoReceita(novo), ip: ipDe(request) });
  }
  return json({ ok: true, atualizado_em: agora });
}

// Cada linha da receita vira (ou reforça) uma sugestão para as próximas receitas.
export function linhasParaSugestao(textoReceita) {
  const vistas = new Map();
  for (const bruta of String(textoReceita ?? '').split('\n')) {
    const linha = bruta.trim();
    if (linha.length < 4 || linha.length > 200) continue;
    const chave = normalizarBusca(linha.replace(/\*/g, ''));
    if (chave.length < 4 || vistas.has(chave)) continue; // a mesma linha conta uma vez por receita
    vistas.set(chave, linha);
    if (vistas.size >= 100) break;
  }
  return [...vistas.entries()].map(([chave, linha]) => ({ chave, linha }));
}

// Comandos que ensinam as sugestões com as linhas da receita liberada.
// (Futuro: o módulo de estoque também vai alimentar esta tabela.)
function comandosSugestoes(env, textoReceita, agora) {
  return linhasParaSugestao(textoReceita).map(({ chave, linha }) => env.DB.prepare(
    `INSERT INTO sugestoes_receita (texto, texto_busca, vezes, ultimo_uso) VALUES (?, ?, 1, ?)
     ON CONFLICT(texto_busca) DO UPDATE SET vezes = vezes + 1, ultimo_uso = excluded.ultimo_uso`
  ).bind(linha, chave, agora));
}

async function receitasLiberar(request, env, id) {
  const u = await exigirPapel(request, env, ['veterinario']); // suporte não assina receitas
  const antes = await receitaBruta(env, id);
  if (antes.status !== 'rascunho') throw new ErroHttp(409, MSG_JA_LIBERADA);
  if (!antes.texto.trim()) throw new ErroHttp(400, 'Escreva a receita antes de liberar.');
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE receitas SET status = 'liberada', veterinario_id = ?, liberada_em = ?, atualizado_em = ? WHERE id = ? AND status = 'rascunho'`
  ).bind(u.id, agora, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, MSG_JA_LIBERADA);

  const comandos = [];
  // Versão nova liberada: a anterior deixa de valer.
  if (antes.receita_anterior_id) {
    comandos.push(env.DB.prepare(
      `UPDATE receitas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, atualizado_em = ? WHERE id = ? AND status <> 'cancelada'`
    ).bind(agora, u.id, agora, antes.receita_anterior_id));
    comandos.push(prepararAcao(env, { usuarioId: u.id, acao: 'cancelar_receita_substituida', entidade: 'receitas', entidadeId: antes.receita_anterior_id, depois: { substituida_por: id }, ip: ipDe(request) }));
  }
  comandos.push(...comandosSugestoes(env, antes.texto, agora));
  comandos.push(prepararAcao(env, {
    usuarioId: u.id, acao: 'liberar_receita', entidade: 'receitas', entidadeId: id,
    antes: resumoReceita(antes), depois: { ...resumoReceita({ ...antes, status: 'liberada', veterinario_id: u.id }), receita_anterior_id: antes.receita_anterior_id ?? null }, ip: ipDe(request),
  }));
  await env.DB.batch(comandos);

  const pet = await env.DB.prepare('SELECT nome FROM pets WHERE id = ?').bind(antes.pet_id).first();
  await avisar(env, {
    para: { papel: 'recepcao' }, titulo: 'Receita pronta para imprimir', corpo: `${pet.nome} · ${comTratamento(u.nome)}`,
    url: '#/receitas/imprimir', tag: 'receita-' + id,
  });
  // Quem pediu a receita também é avisado de que ficou pronta.
  if (antes.solicitada_por && antes.solicitada_por !== u.id) {
    await avisar(env, {
      para: { usuarioId: antes.solicitada_por }, titulo: 'Receita pronta', corpo: `${pet.nome} · escrita por ${comTratamento(u.nome)}`,
      url: '#/receita/' + id, tag: 'receita-' + id,
    });
  }
  return json(await detalheReceita(env, id));
}

// A recepção (ou qualquer pessoa) cola o texto recebido pelo WhatsApp: a receita já nasce
// liberada, em nome do veterinário escolhido (que assina a mão no papel).
async function receitasTranscrever(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const petId = idInteiro(c.pet_id, 'Escolha o pet.');
  const pet = await env.DB.prepare('SELECT id, nome, ativo FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  if (pet.ativo !== 1) throw new ErroHttp(409, 'Este pet está arquivado.');
  let atendId = null;
  if (c.atendimento_id !== undefined && c.atendimento_id !== null && c.atendimento_id !== '') {
    atendId = idInteiro(c.atendimento_id, 'Atendimento inválido.');
    const a = await env.DB.prepare('SELECT id, pet_id FROM atendimentos WHERE id = ?').bind(atendId).first();
    if (!a) throw new ErroHttp(404, 'Atendimento não encontrado.');
    if (a.pet_id !== petId) throw new ErroHttp(400, 'Este atendimento é de outro pet.');
  }
  const vetId = idInteiro(c.veterinario_id, 'Escolha o veterinário que receitou.');
  const vet = await env.DB.prepare(`SELECT id, nome FROM usuarios WHERE id = ? AND papel = 'veterinario' AND ativo = 1`).bind(vetId).first();
  if (!vet) throw new ErroHttp(400, 'Escolha um veterinário ativo.');
  const corpo = limparTexto(c.texto, 'receita', MAX_TEXTO);
  if (!corpo) throw new ErroHttp(400, 'Cole o texto da receita.');
  const orient = limparTexto(c.orientacoes, 'orientações', MAX_ORIENTACOES) || null;
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `INSERT INTO receitas (pet_id, atendimento_id, veterinario_id, criado_por, texto, orientacoes, status, versao, origem, liberada_em, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, 'liberada', 1, 'transcrita', ?, ?, ?)`
  ).bind(petId, atendId, vetId, u.id, corpo, orient, agora, agora, agora).run();
  const id = r.meta.last_row_id;
  await env.DB.batch([
    ...comandosSugestoes(env, corpo, agora),
    prepararAcao(env, { usuarioId: u.id, acao: 'transcrever_receita', entidade: 'receitas', entidadeId: id, depois: { pet_id: petId, atendimento_id: atendId, veterinario_id: vetId, texto_tamanho: corpo.length, orientacoes_tamanho: (orient ?? '').length }, ip: ipDe(request) }),
  ]);
  await avisar(env, {
    para: { usuarioId: vetId }, titulo: 'Receita transcrita pela recepção', corpo: `${pet.nome} · confira se está certa`,
    url: '#/receita/' + id, tag: 'receita-' + id,
  });
  return json(await detalheReceita(env, id), 201);
}

async function receitasPedir(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_CLINICOS);
  const c = await lerJson(request);
  const antes = await receitaBruta(env, id);
  if (antes.status !== 'rascunho') throw new ErroHttp(409, MSG_JA_LIBERADA);
  const alvoId = idInteiro(c.para_usuario_id, 'Escolha o veterinário.');
  if (alvoId === u.id) throw new ErroHttp(400, 'Escolha outro veterinário (não você mesmo).');
  const alvo = await env.DB.prepare(`SELECT id, nome FROM usuarios WHERE id = ? AND papel = 'veterinario' AND ativo = 1`).bind(alvoId).first();
  if (!alvo) throw new ErroHttp(400, 'Escolha um veterinário ativo.');
  const nota = texto(c.nota, 'nota', { obrigatorio: false, max: 200 }) || null;
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE receitas SET solicitada_a = ?, solicitada_por = ?, nota_pedido = ?, atualizado_em = ? WHERE id = ? AND status = 'rascunho'`
  ).bind(alvoId, u.id, nota, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, MSG_JA_LIBERADA);
  await registrarAcao(env, { usuarioId: u.id, acao: 'pedir_receita', entidade: 'receitas', entidadeId: id, antes: { solicitada_a: antes.solicitada_a ?? null }, depois: { solicitada_a: alvoId, nota_pedido: nota }, ip: ipDe(request) });

  const pet = await env.DB.prepare('SELECT nome FROM pets WHERE id = ?').bind(antes.pet_id).first();
  await avisar(env, {
    para: { usuarioId: alvoId }, titulo: `${u.nome} pediu uma receita`, corpo: pet.nome + (nota ? ' · ' + nota : ''),
    url: '#/receita/' + id, tag: 'pedido-receita-' + id,
  });
  return json(await detalheReceita(env, id));
}

async function receitasNovaVersao(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_CLINICOS);
  const base = await receitaBruta(env, id);
  if (!['liberada', 'impressa', 'entregue'].includes(base.status)) throw new ErroHttp(409, 'Só é possível criar nova versão de uma receita liberada.');
  // Se já existe uma versão nova em rascunho, abre a mesma (evita duplicar).
  const jaTem = await env.DB.prepare(`SELECT id FROM receitas WHERE receita_anterior_id = ? AND status = 'rascunho' ORDER BY id DESC LIMIT 1`).bind(id).first();
  if (jaTem) return json({ ...(await detalheReceita(env, jaTem.id)), existente: true });
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `INSERT INTO receitas (pet_id, atendimento_id, criado_por, texto, orientacoes, status, versao, receita_anterior_id, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, 'rascunho', ?, ?, ?, ?)`
  ).bind(base.pet_id, base.atendimento_id, u.id, base.texto, base.orientacoes, base.versao + 1, id, agora, agora).run();
  const novoId = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'nova_versao_receita', entidade: 'receitas', entidadeId: novoId, depois: { receita_anterior_id: id, versao: base.versao + 1, texto_tamanho: base.texto.length }, ip: ipDe(request) });
  return json(await detalheReceita(env, novoId), 201);
}

async function receitasCancelar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_CLINICOS);
  const antes = await receitaBruta(env, id);
  if (!['rascunho', 'liberada'].includes(antes.status)) {
    throw new ErroHttp(409, antes.status === 'cancelada' ? 'Esta receita já está cancelada.' : 'Esta receita já foi impressa. Crie uma nova versão para corrigir.');
  }
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE receitas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, atualizado_em = ? WHERE id = ? AND status IN ('rascunho','liberada')`
  ).bind(agora, u.id, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta receita não pode mais ser cancelada.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'cancelar_receita', entidade: 'receitas', entidadeId: id, antes: { status: antes.status }, depois: { status: 'cancelada' }, ip: ipDe(request) });
  return json(await detalheReceita(env, id));
}

// Impressão: pode ser repetida (2ª via). Só conta e marca; não altera o texto.
async function receitasImpressa(request, env, id) {
  const u = await exigirLogin(request, env);
  const antes = await receitaBruta(env, id);
  if (!STATUS_VISIVEIS_RECEPCAO.includes(antes.status)) throw new ErroHttp(409, 'Só é possível imprimir uma receita liberada.');
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE receitas SET vezes_impressa = vezes_impressa + 1, impressa_em = ?, impressa_por = ?,
            status = CASE WHEN status = 'liberada' THEN 'impressa' ELSE status END, atualizado_em = ?
      WHERE id = ? AND status IN ('liberada','impressa','entregue')`
  ).bind(agora, u.id, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Só é possível imprimir uma receita liberada.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'imprimir_receita', entidade: 'receitas', entidadeId: id, antes: { status: antes.status, vezes_impressa: antes.vezes_impressa }, depois: { vezes_impressa: antes.vezes_impressa + 1 }, ip: ipDe(request) });
  return json(await detalheReceita(env, id));
}

async function receitasEntregue(request, env, id) {
  const u = await exigirLogin(request, env);
  const antes = await receitaBruta(env, id);
  if (!['liberada', 'impressa'].includes(antes.status)) throw new ErroHttp(409, antes.status === 'entregue' ? 'Esta receita já foi marcada como entregue.' : 'Só é possível entregar uma receita liberada.');
  const agora = agoraISO();
  const r = await env.DB.prepare(
    `UPDATE receitas SET status = 'entregue', entregue_em = ?, entregue_por = ?, atualizado_em = ? WHERE id = ? AND status IN ('liberada','impressa')`
  ).bind(agora, u.id, agora, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta receita já foi marcada como entregue.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'entregar_receita', entidade: 'receitas', entidadeId: id, antes: { status: antes.status }, depois: { status: 'entregue' }, ip: ipDe(request) });
  return json(await detalheReceita(env, id));
}

// Listas: ?status=para_imprimir (todos) ou ?pedidas_a_mim=1 (veterinário/suporte).
async function receitasListar(request, env) {
  const u = await exigirLogin(request, env);
  const qs = new URL(request.url).searchParams;
  let onde; let args = []; let ordem;
  if (qs.get('status') === 'para_imprimir') {
    // Liberadas (de qualquer dia) + impressas hoje que ainda não foram entregues.
    onde = `(r.status = 'liberada' OR (r.status = 'impressa' AND r.impressa_em >= ?))`;
    args = [inicioDoDiaBahia()];
    ordem = 'r.liberada_em DESC, r.id DESC';
  } else if (qs.get('pedidas_a_mim') === '1') {
    if (!PAPEIS_CLINICOS.includes(u.papel)) throw new ErroHttp(403, 'Você não tem permissão para fazer isso.');
    onde = `r.status = 'rascunho' AND r.solicitada_a = ?`;
    args = [u.id];
    ordem = 'r.atualizado_em DESC, r.id DESC';
  } else {
    throw new ErroHttp(400, 'Informe o filtro: status=para_imprimir ou pedidas_a_mim=1.');
  }
  const { results } = await env.DB.prepare(`${SELECT_RECEITA} WHERE ${onde} ORDER BY ${ordem} LIMIT 100`).bind(...args).all();
  return json({ receitas: results.map(itemLista) });
}

// Sugestões de linha (aprendidas das receitas liberadas).
async function sugestoesListar(request, env) {
  await exigirPapel(request, env, PAPEIS_CLINICOS);
  const q = normalizarBusca(new URL(request.url).searchParams.get('q') ?? '').replace(/\*/g, '');
  if (q.length < 2) return json({ sugestoes: [] });
  const { results } = await env.DB.prepare(
    `SELECT id, texto, vezes FROM sugestoes_receita WHERE texto_busca LIKE ? ESCAPE '\\'
      ORDER BY (texto_busca LIKE ? ESCAPE '\\') DESC, vezes DESC, ultimo_uso DESC, id LIMIT 8`
  ).bind(likeSeguro(q), likeSeguro(q).slice(1)).all();
  return json({ sugestoes: results });
}

// ---------- dados da clínica ----------
async function clinicaVer(request, env) {
  await exigirLogin(request, env);
  return json(await configuracaoClinica(env));
}

async function clinicaAlterar(request, env) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const antes = await configuracaoClinica(env);
  const novo = { ...antes };
  for (const k of CHAVES_CLINICA) {
    if (c[k] === undefined) continue;
    novo[k] = texto(c[k], k.replace('clinica_', ''), { obrigatorio: k === 'clinica_nome', max: 200 });
  }
  const agora = agoraISO();
  const comandos = CHAVES_CLINICA.filter((k) => novo[k] !== antes[k]).map((k) => env.DB.prepare(
    `INSERT INTO configuracoes (chave, valor, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`
  ).bind(k, novo[k], agora, adm.id));
  if (comandos.length) {
    comandos.push(prepararAcao(env, { usuarioId: adm.id, acao: 'alterar_dados_clinica', entidade: 'configuracoes', antes, depois: novo, ip: ipDe(request) }));
    await env.DB.batch(comandos);
  }
  return json(novo);
}

// Veterinários ativos (para escolher a quem pedir uma receita).
async function veterinariosListar(request, env) {
  await exigirLogin(request, env);
  const { results } = await env.DB.prepare(`SELECT id, nome, crmv, whatsapp FROM usuarios WHERE papel = 'veterinario' AND ativo = 1 ORDER BY nome`).all();
  return json({ veterinarios: results });
}

export const ROTAS_RECEITAS = [
  ['GET', '/api/receitas', receitasListar],
  ['POST', '/api/receitas', receitasCriar],
  ['GET', '/api/receitas/:id', receitasVer],
  ['PATCH', '/api/receitas/:id', receitasAlterar],
  ['POST', '/api/receitas/transcrever', receitasTranscrever],
  ['POST', '/api/receitas/:id/liberar', receitasLiberar],
  ['POST', '/api/receitas/:id/pedir', receitasPedir],
  ['POST', '/api/receitas/:id/nova-versao', receitasNovaVersao],
  ['POST', '/api/receitas/:id/cancelar', receitasCancelar],
  ['POST', '/api/receitas/:id/impressa', receitasImpressa],
  ['POST', '/api/receitas/:id/entregue', receitasEntregue],
  ['GET', '/api/sugestoes-receita', sugestoesListar],
  ['GET', '/api/configuracoes/clinica', clinicaVer],
  ['PATCH', '/api/configuracoes/clinica', clinicaAlterar],
  ['GET', '/api/usuarios/veterinarios', veterinariosListar],
];
