// Internação: baias, pacientes internados, medicações e doses dadas.
//  - Veterinário e suporte cuidam de tudo (internar, medicar, dar alta).
//  - A recepção só VÊ o quadro das baias (pet, tutor, dias). Nada de medicação nem motivo.
//  - Só administradores criam, renomeiam e desativam baias (e só desativam baia livre).
//  - Horários guardados em UTC; "dias internado" conta dias do calendário em Bahia (UTC-03:00).
//  - Todas as regras de tempo recebem "agora" como parâmetro, para os testes fixarem o relógio
//    (nas rotas, "env.AGORA_TESTE" faz esse papel).
//  - FUTURO (aviso no celular): quando uma medicação chegar na hora ("agora"), a ideia é mandar um push
//    para veterinários/suporte. Isso pede uma tarefa agendada (Cron Trigger do Worker) que ainda não existe;
//    por enquanto o quadro só destaca em cor as medicações na hora e as atrasadas.
import { exigirAdmin, exigirLogin, exigirPapel } from './auth.js';
import { normalizarBusca } from './cadastro.js';
import { PAPEIS_PRONTUARIO, notasDaInternacao } from './prontuario.js';
import { ErroHttp, agoraDe, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';

const DESLOCAMENTO_BAHIA_MS = 3 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const TOLERANCIA_MS = 15 * 60 * 1000; // "agora" = até 15 min antes ou depois da hora marcada
const JANELA_DESFAZER_MS = 60 * 1000; // "Dei agora" pode ser desfeito em 1 minuto (e dois toques seguidos não duplicam)
const STATUS_FINAIS = ['alta', 'obito', 'transferido'];

// ---------- regras de tempo (funções puras, testadas com relógio fixo) ----------

// Número do dia no calendário de Bahia (dias desde 1970).
const numeroDoDiaBahia = (iso) => Math.floor((Date.parse(iso) - DESLOCAMENTO_BAHIA_MS) / DIA_MS);

// Dia da internação: o dia da entrada é o "1º dia"; passou da meia-noite (Bahia), vira o "2º dia".
export function diaDaInternacao(inicioEm, agora) {
  return Math.max(1, numeroDoDiaBahia(new Date(agora).toISOString()) - numeroDoDiaBahia(inicioEm) + 1);
}

// Horas completas desde a entrada.
export function horasInternado(inicioEm, agora) {
  return Math.max(0, Math.floor((new Date(agora).getTime() - Date.parse(inicioEm)) / HORA_MS));
}

// Situação de uma medicação.
//  - próxima dose = (última dose dada, ou o início se ainda não deu nenhuma) + intervalo;
//  - 'atrasada' se a próxima era há mais de 15 min; 'agora' dentro de ±15 min; senão 'futura';
//  - com duração em dias, "dia 3 de 7"; passou a duração (ou não há mais dose dentro dela) = 'concluida';
//  - encerrada à mão = 'encerrada'.
export function calcularMedicacao(m, ultimaEm, agora) {
  const agoraMs = new Date(agora).getTime();
  const inicioMs = Date.parse(m.inicio_em);
  const base = ultimaEm ? Math.max(Date.parse(ultimaEm), inicioMs) : inicioMs;
  const proximaMs = base + m.intervalo_horas * HORA_MS;
  const fimMs = m.duracao_dias ? inicioMs + m.duracao_dias * DIA_MS : null;
  const dia = m.duracao_dias ? Math.min(m.duracao_dias, Math.max(1, Math.floor((agoraMs - inicioMs) / DIA_MS) + 1)) : null;
  const saida = {
    situacao: 'ativa', status: null, proxima_em: new Date(proximaMs).toISOString(), minutos_ate_proxima: Math.round((proximaMs - agoraMs) / 60000),
    ultima_em: ultimaEm ?? null, dia_tratamento: dia, duracao_dias: m.duracao_dias ?? null, fim_em: fimMs === null ? null : new Date(fimMs).toISOString(),
  };
  if (m.encerrada_em) return { ...saida, situacao: 'encerrada' };
  if (fimMs !== null && (agoraMs >= fimMs || proximaMs >= fimMs)) return { ...saida, situacao: 'concluida' };
  const delta = proximaMs - agoraMs;
  return { ...saida, status: delta < -TOLERANCIA_MS ? 'atrasada' : (delta <= TOLERANCIA_MS ? 'agora' : 'futura') };
}

// A medicação ativa que vence primeiro (para o quadro das baias). null se não houver.
export function proximaMedicacao(medicacoes) {
  const ativas = medicacoes.filter((m) => m.situacao === 'ativa');
  ativas.sort((a, b) => Date.parse(a.proxima_em) - Date.parse(b.proxima_em) || a.id - b.id);
  const m = ativas[0];
  return m ? { medicacao_id: m.id, remedio: m.remedio, dose: m.dose ?? null, proxima_em: m.proxima_em, status: m.status, minutos_ate_proxima: m.minutos_ate_proxima } : null;
}

// ---------- leitura ----------
const SELECT_INTERNACAO = `
  SELECT i.*, b.nome AS baia_nome, p.nome AS pet_nome, p.especie, p.foto_id AS pet_foto_id, p.idade_anos, p.idade_meses,
         t.id AS tutor_id, t.nome AS tutor_nome, uc.nome AS criado_por_nome, ue.nome AS encerrado_por_nome
    FROM internacoes i
    JOIN baias b ON b.id = i.baia_id
    JOIN pets p ON p.id = i.pet_id
    JOIN tutores t ON t.id = p.tutor_id
    JOIN usuarios uc ON uc.id = i.criado_por
    LEFT JOIN usuarios ue ON ue.id = i.encerrado_por`;

const marcadores = (n) => Array.from({ length: n }, () => '?').join(',');

// Medicações das internações dadas, já com a situação calculada. Devolve Map internacao_id -> lista.
// "comDoses" também traz as últimas doses de cada medicação (com o nome de quem deu).
async function medicacoesDe(env, internacaoIds, agora, { comDoses = false, soAbertas = false } = {}) {
  const mapa = new Map(internacaoIds.map((id) => [id, []]));
  if (!internacaoIds.length) return mapa;
  const { results } = await env.DB.prepare(
    `SELECT m.*, (SELECT MAX(a.feita_em) FROM administracoes a WHERE a.medicacao_id = m.id) AS ultima_em
       FROM internacao_medicacoes m WHERE m.internacao_id IN (${marcadores(internacaoIds.length)})
        ${soAbertas ? 'AND m.encerrada_em IS NULL' : ''} ORDER BY m.id`
  ).bind(...internacaoIds).all();
  const doses = new Map();
  if (comDoses && results.length) {
    const { results: linhas } = await env.DB.prepare(
      `SELECT a.id, a.medicacao_id, a.feita_em, a.feita_por, a.observacao, u.nome AS feita_por_nome
         FROM administracoes a JOIN usuarios u ON u.id = a.feita_por
        WHERE a.medicacao_id IN (${marcadores(results.length)}) ORDER BY a.feita_em DESC, a.id DESC`
    ).bind(...results.map((m) => m.id)).all();
    for (const d of linhas) {
      const lista = doses.get(d.medicacao_id) ?? [];
      if (lista.length < 30) lista.push({ id: d.id, feita_em: d.feita_em, feita_por: { id: d.feita_por, nome: d.feita_por_nome }, observacao: d.observacao ?? null });
      doses.set(d.medicacao_id, lista);
    }
  }
  for (const m of results) {
    const calc = calcularMedicacao(m, m.ultima_em, agora);
    const ultima = doses.get(m.id)?.[0] ?? null;
    mapa.get(m.internacao_id).push({
      id: m.id, internacao_id: m.internacao_id, remedio: m.remedio, dose: m.dose ?? null, via: m.via ?? null, quantidade: m.quantidade ?? null,
      intervalo_horas: m.intervalo_horas, duracao_dias: m.duracao_dias ?? null, inicio_em: m.inicio_em,
      encerrada_em: m.encerrada_em ?? null, observacao: m.observacao ?? null, ...calc,
      ...(comDoses ? { ultima_por: ultima ? ultima.feita_por.nome : null, doses: doses.get(m.id) ?? [] } : {}),
    });
  }
  return mapa;
}

function cabecalhoInternacao(i, agora) {
  return {
    id: i.id, status: i.status, inicio_em: i.inicio_em, alta_em: i.alta_em ?? null, motivo: i.motivo, observacao_alta: i.observacao_alta ?? null,
    atendimento_id: i.atendimento_id ?? null,
    dias: diaDaInternacao(i.inicio_em, i.alta_em ? new Date(i.alta_em) : agora), horas: horasInternado(i.inicio_em, i.alta_em ? new Date(i.alta_em) : agora),
    baia: { id: i.baia_id, nome: i.baia_nome },
    pet: { id: i.pet_id, nome: i.pet_nome, especie: i.especie, foto_id: i.pet_foto_id ?? null, idade_anos: i.idade_anos ?? null, idade_meses: i.idade_meses ?? null },
    tutor: { id: i.tutor_id, nome: i.tutor_nome },
    criado_por_nome: i.criado_por_nome, encerrado_por_nome: i.encerrado_por_nome ?? null,
  };
}

// Tudo da tela da baia: dados, medicações (com doses) e anotações de evolução.
async function detalhesDaInternacao(env, id, usuario, agora) {
  const i = await env.DB.prepare(`${SELECT_INTERNACAO} WHERE i.id = ?`).bind(id).first();
  if (!i) throw new ErroHttp(404, 'Internação não encontrada.');
  const meds = (await medicacoesDe(env, [id], agora, { comDoses: true })).get(id);
  return {
    agora: agora.toISOString(),
    internacao: cabecalhoInternacao(i, agora),
    medicacoes: meds,
    notas: await notasDaInternacao(env, id, usuario.id, agora),
  };
}

// ---------- quadro das baias ----------
async function quadro(request, env) {
  const u = await exigirLogin(request, env);
  const clinico = PAPEIS_PRONTUARIO.includes(u.papel);
  const agora = agoraDe(env);
  const { results: baias } = await env.DB.prepare('SELECT * FROM baias ORDER BY ordem, id').all();
  const { results: internados } = await env.DB.prepare(`${SELECT_INTERNACAO} WHERE i.status = 'internado'`).all();
  const meds = clinico ? await medicacoesDe(env, internados.map((i) => i.id), agora, { soAbertas: true }) : new Map();
  const porBaia = new Map(internados.map((i) => [i.baia_id, i]));
  let atrasadas = 0;
  let naHora = 0;
  const lista = baias.filter((b) => b.ativa === 1).map((b) => {
    const i = porBaia.get(b.id);
    if (!i) return { id: b.id, nome: b.nome, ordem: b.ordem, ativa: true, ocupante: null };
    const ocupante = {
      internacao_id: i.id, inicio_em: i.inicio_em, dias: diaDaInternacao(i.inicio_em, agora), horas: horasInternado(i.inicio_em, agora),
      pet: { id: i.pet_id, nome: i.pet_nome, especie: i.especie, foto_id: i.pet_foto_id ?? null },
      tutor: { id: i.tutor_id, nome: i.tutor_nome },
    };
    if (clinico) {
      const lm = meds.get(i.id) ?? [];
      atrasadas += lm.filter((m) => m.situacao === 'ativa' && m.status === 'atrasada').length;
      naHora += lm.filter((m) => m.situacao === 'ativa' && m.status === 'agora').length;
      ocupante.motivo = i.motivo;
      ocupante.proxima_medicacao = proximaMedicacao(lm);
    }
    return { id: b.id, nome: b.nome, ordem: b.ordem, ativa: true, ocupante };
  });
  return json({
    agora: agora.toISOString(),
    baias: lista,
    desativadas: u.admin ? baias.filter((b) => b.ativa === 0).map((b) => ({ id: b.id, nome: b.nome })) : [],
    resumo: { internados: internados.length, ...(clinico ? { medicacoes_atrasadas: atrasadas, medicacoes_agora: naHora } : {}) },
  });
}

// ---------- baias (só administrador) ----------
function lerNomeBaia(valor) {
  return texto(valor, 'nome da baia', { max: 40 });
}
async function nomeJaUsado(env, nome, exceto = 0) {
  const { results } = await env.DB.prepare('SELECT id, nome FROM baias WHERE id <> ?').bind(exceto).all();
  return results.some((b) => normalizarBusca(b.nome) === normalizarBusca(nome));
}
const baiaPublica = (b) => ({ id: b.id, nome: b.nome, ordem: b.ordem, ativa: b.ativa === 1 });

async function baiasCriar(request, env) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const nome = lerNomeBaia(c.nome);
  if (await nomeJaUsado(env, nome)) throw new ErroHttp(409, 'Já existe uma baia com esse nome.');
  const ordem = (await env.DB.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM baias').first()).n;
  const agora = agoraDe(env).toISOString();
  let id;
  try {
    id = (await env.DB.prepare('INSERT INTO baias (nome, ordem, ativa, criado_em) VALUES (?, ?, 1, ?)').bind(nome, ordem, agora).run()).meta.last_row_id;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ErroHttp(409, 'Já existe uma baia com esse nome.');
    throw e;
  }
  await registrarAcao(env, { usuarioId: adm.id, acao: 'criar_baia', entidade: 'baias', entidadeId: id, depois: { nome, ordem }, ip: ipDe(request) });
  return json(baiaPublica(await env.DB.prepare('SELECT * FROM baias WHERE id = ?').bind(id).first()), 201);
}

async function baiasAlterar(request, env, id) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  const antes = await env.DB.prepare('SELECT * FROM baias WHERE id = ?').bind(id).first();
  if (!antes) throw new ErroHttp(404, 'Baia não encontrada.');
  const novo = { ...antes };
  if (c.nome !== undefined) novo.nome = lerNomeBaia(c.nome);
  if (c.ativa !== undefined) novo.ativa = c.ativa ? 1 : 0;
  if (c.ordem !== undefined) {
    if (typeof c.ordem !== 'number' || !Number.isInteger(c.ordem) || c.ordem < 0 || c.ordem > 999) throw new ErroHttp(400, 'Ordem inválida.');
    novo.ordem = c.ordem;
  }
  if (novo.nome !== antes.nome && await nomeJaUsado(env, novo.nome, id)) throw new ErroHttp(409, 'Já existe uma baia com esse nome.');
  if (antes.ativa === 1 && novo.ativa === 0) {
    const ocupada = await env.DB.prepare(`SELECT id FROM internacoes WHERE baia_id = ? AND status = 'internado'`).bind(id).first();
    if (ocupada) throw new ErroHttp(409, 'Esta baia está ocupada. Só dá para desativar uma baia livre.');
  }
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE baias SET nome = ?, ordem = ?, ativa = ? WHERE id = ?').bind(novo.nome, novo.ordem, novo.ativa, id),
      prepararAcao(env, { usuarioId: adm.id, acao: 'alterar_baia', entidade: 'baias', entidadeId: id,
        antes: { nome: antes.nome, ordem: antes.ordem, ativa: antes.ativa === 1 }, depois: { nome: novo.nome, ordem: novo.ordem, ativa: novo.ativa === 1 }, ip: ipDe(request) }),
    ]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ErroHttp(409, 'Já existe uma baia com esse nome.');
    throw e;
  }
  return json(baiaPublica(await env.DB.prepare('SELECT * FROM baias WHERE id = ?').bind(id).first()));
}

// ---------- internar, mover e dar alta ----------
function idPositivo(v, mensagem) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ErroHttp(400, mensagem);
  return v;
}

// Mensagens claras quando o banco barra (baia já ocupada / pet já internado), mesmo se duas pessoas tentarem juntas.
async function erroDeOcupacao(env, baiaId, petId) {
  if (petId) {
    const j = await env.DB.prepare(`SELECT i.id, b.nome FROM internacoes i JOIN baias b ON b.id = i.baia_id WHERE i.pet_id = ? AND i.status = 'internado'`).bind(petId).first();
    if (j) return new ErroHttp(409, `Este pet já está internado (${j.nome}).`);
  }
  return new ErroHttp(409, 'Esta baia já está ocupada.');
}

async function internacoesCriar(request, env) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const petId = idPositivo(c.pet_id, 'Escolha o paciente.');
  const baiaId = idPositivo(c.baia_id, 'Escolha a baia.');
  const motivo = texto(c.motivo, 'motivo da internação', { max: 300 });
  let atendimentoId = null;
  if (c.atendimento_id !== undefined && c.atendimento_id !== null) {
    atendimentoId = idPositivo(c.atendimento_id, 'Atendimento inválido.');
    const a = await env.DB.prepare('SELECT id FROM atendimentos WHERE id = ? AND pet_id = ?').bind(atendimentoId, petId).first();
    if (!a) throw new ErroHttp(400, 'Esse atendimento não é deste pet.');
  }
  const pet = await env.DB.prepare('SELECT id, ativo FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  if (pet.ativo !== 1) throw new ErroHttp(409, 'Este pet está arquivado.');
  const baia = await env.DB.prepare('SELECT id, ativa FROM baias WHERE id = ?').bind(baiaId).first();
  if (!baia) throw new ErroHttp(404, 'Baia não encontrada.');
  if (baia.ativa !== 1) throw new ErroHttp(409, 'Esta baia está desativada.');
  const agora = agoraDe(env);
  let id;
  try {
    id = (await env.DB.prepare(
      `INSERT INTO internacoes (pet_id, atendimento_id, baia_id, inicio_em, motivo, status, criado_por) VALUES (?, ?, ?, ?, ?, 'internado', ?)`
    ).bind(petId, atendimentoId, baiaId, agora.toISOString(), motivo, u.id).run()).meta.last_row_id;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw await erroDeOcupacao(env, baiaId, petId);
    throw e;
  }
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_internacao', entidade: 'internacoes', entidadeId: id, depois: { pet_id: petId, baia_id: baiaId, atendimento_id: atendimentoId, motivo }, ip: ipDe(request) });
  return json(await detalhesDaInternacao(env, id, u, agora), 201);
}

async function internacoesVer(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  return json(await detalhesDaInternacao(env, id, u, agoraDe(env)));
}

async function internacaoAberta(env, id) {
  const i = await env.DB.prepare('SELECT * FROM internacoes WHERE id = ?').bind(id).first();
  if (!i) throw new ErroHttp(404, 'Internação não encontrada.');
  if (i.status !== 'internado') throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  return i;
}

async function internacoesMover(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const baiaId = idPositivo(c.baia_id, 'Escolha a baia.');
  const antes = await internacaoAberta(env, id);
  if (antes.baia_id === baiaId) throw new ErroHttp(400, 'O paciente já está nesta baia.');
  const baia = await env.DB.prepare('SELECT id, nome, ativa FROM baias WHERE id = ?').bind(baiaId).first();
  if (!baia) throw new ErroHttp(404, 'Baia não encontrada.');
  if (baia.ativa !== 1) throw new ErroHttp(409, 'Esta baia está desativada.');
  try {
    const r = await env.DB.prepare(`UPDATE internacoes SET baia_id = ? WHERE id = ? AND status = 'internado'`).bind(baiaId, id).run();
    if (!r.meta.changes) throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ErroHttp(409, 'Esta baia já está ocupada.');
    throw e;
  }
  await registrarAcao(env, { usuarioId: u.id, acao: 'mover_internacao', entidade: 'internacoes', entidadeId: id, antes: { baia_id: antes.baia_id }, depois: { baia_id: baiaId }, ip: ipDe(request) });
  return json(await detalhesDaInternacao(env, id, u, agoraDe(env)));
}

async function internacoesEncerrar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  if (!STATUS_FINAIS.includes(c.status)) throw new ErroHttp(400, 'Escolha: alta, óbito ou transferido.');
  const observacao = texto(c.observacao, 'observação', { obrigatorio: c.status !== 'alta', max: 1000 }) || null;
  const antes = await internacaoAberta(env, id);
  const agora = agoraDe(env).toISOString();
  const r = await env.DB.prepare(
    `UPDATE internacoes SET status = ?, alta_em = ?, encerrado_por = ?, observacao_alta = ? WHERE id = ? AND status = 'internado'`
  ).bind(c.status, agora, u.id, observacao, id).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  // Os remédios ainda abertos são encerrados junto: sem internação, não há mais dose a dar.
  await env.DB.batch([
    env.DB.prepare('UPDATE internacao_medicacoes SET encerrada_em = ?, encerrada_por = ? WHERE internacao_id = ? AND encerrada_em IS NULL').bind(agora, u.id, id),
    prepararAcao(env, { usuarioId: u.id, acao: 'encerrar_internacao', entidade: 'internacoes', entidadeId: id,
      antes: { status: 'internado', baia_id: antes.baia_id }, depois: { status: c.status, observacao }, ip: ipDe(request) }),
  ]);
  return json(await detalhesDaInternacao(env, id, u, agoraDe(env)));
}

// ---------- medicações ----------
// Intervalo em horas: aceita número ou texto com vírgula ("0,5"); de 0,5 a 168.
function lerIntervalo(v) {
  const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0.5 || n > 168) throw new ErroHttp(400, 'Informe de quantas em quantas horas (de 0,5 a 168).');
  return Math.round(n * 100) / 100;
}
function lerDuracao(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 365) throw new ErroHttp(400, 'A duração deve ser de 1 a 365 dias (ou deixe em branco).');
  return n;
}
// Hora de início: vazia = agora. Não aceita mais de 30 dias para trás nem mais de 7 dias para frente.
function lerInicio(v, agora) {
  if (v === undefined || v === null || v === '') return agora.toISOString();
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new ErroHttp(400, 'Horário de início inválido.');
  if (ms < agora.getTime() - 30 * DIA_MS || ms > agora.getTime() + 7 * DIA_MS) throw new ErroHttp(400, 'O horário de início está muito longe de hoje.');
  return new Date(ms).toISOString();
}
const textoOpcional = (v, campo, max) => texto(v, campo, { obrigatorio: false, max }) || null;

async function medicacoesCriar(request, env, internacaoId) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const remedio = texto(c.remedio, 'remédio', { max: 120 });
  const dose = textoOpcional(c.dose, 'dose', 60);
  const via = textoOpcional(c.via, 'via', 40);
  const quantidade = textoOpcional(c.quantidade, 'quantidade', 60);
  const intervalo = lerIntervalo(c.intervalo_horas);
  const duracao = lerDuracao(c.duracao_dias);
  const observacao = textoOpcional(c.observacao, 'observação', 300);
  await internacaoAberta(env, internacaoId);
  const agora = agoraDe(env);
  const inicio = lerInicio(c.inicio_em, agora);
  const r = await env.DB.prepare(
    `INSERT INTO internacao_medicacoes (internacao_id, remedio, dose, via, quantidade, intervalo_horas, duracao_dias, inicio_em, observacao, criado_por, criado_em)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM internacoes WHERE id = ? AND status = 'internado')`
  ).bind(internacaoId, remedio, dose, via, quantidade, intervalo, duracao, inicio, observacao, u.id, agora.toISOString(), internacaoId).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_medicacao_internacao', entidade: 'internacao_medicacoes', entidadeId: r.meta.last_row_id,
    depois: { internacao_id: internacaoId, remedio, dose, via, quantidade, intervalo_horas: intervalo, duracao_dias: duracao, inicio_em: inicio }, ip: ipDe(request) });
  return json(await detalhesDaInternacao(env, internacaoId, u, agora), 201);
}

async function medicacaoPorId(env, id) {
  const m = await env.DB.prepare(
    `SELECT m.*, i.status AS internacao_status FROM internacao_medicacoes m JOIN internacoes i ON i.id = m.internacao_id WHERE m.id = ?`
  ).bind(id).first();
  if (!m) throw new ErroHttp(404, 'Medicação não encontrada.');
  return m;
}

const resumoMed = (m) => ({ remedio: m.remedio, dose: m.dose ?? null, via: m.via ?? null, quantidade: m.quantidade ?? null, intervalo_horas: m.intervalo_horas, duracao_dias: m.duracao_dias ?? null, observacao: m.observacao ?? null, encerrada: !!m.encerrada_em });

// Edita a medicação ou a encerra ({ encerrar: true }).
async function medicacoesAlterar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const antes = await medicacaoPorId(env, id);
  if (antes.encerrada_em) throw new ErroHttp(409, 'Esta medicação já foi encerrada.');
  if (antes.internacao_status !== 'internado') throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  const novo = { ...antes };
  if (c.remedio !== undefined) novo.remedio = texto(c.remedio, 'remédio', { max: 120 });
  if (c.dose !== undefined) novo.dose = textoOpcional(c.dose, 'dose', 60);
  if (c.via !== undefined) novo.via = textoOpcional(c.via, 'via', 40);
  if (c.quantidade !== undefined) novo.quantidade = textoOpcional(c.quantidade, 'quantidade', 60);
  if (c.intervalo_horas !== undefined) novo.intervalo_horas = lerIntervalo(c.intervalo_horas);
  if (c.duracao_dias !== undefined) novo.duracao_dias = lerDuracao(c.duracao_dias);
  if (c.observacao !== undefined) novo.observacao = textoOpcional(c.observacao, 'observação', 300);
  const agora = agoraDe(env);
  const encerrar = c.encerrar === true;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE internacao_medicacoes SET remedio = ?, dose = ?, via = ?, quantidade = ?, intervalo_horas = ?, duracao_dias = ?, observacao = ?
         ${encerrar ? ', encerrada_em = ?, encerrada_por = ?' : ''} WHERE id = ? AND encerrada_em IS NULL`
    ).bind(novo.remedio, novo.dose, novo.via, novo.quantidade, novo.intervalo_horas, novo.duracao_dias, novo.observacao, ...(encerrar ? [agora.toISOString(), u.id] : []), id),
    prepararAcao(env, { usuarioId: u.id, acao: encerrar ? 'encerrar_medicacao_internacao' : 'alterar_medicacao_internacao', entidade: 'internacao_medicacoes', entidadeId: id,
      antes: resumoMed(antes), depois: resumoMed({ ...novo, encerrada_em: encerrar ? agora.toISOString() : null }), ip: ipDe(request) }),
  ]);
  return json(await detalhesDaInternacao(env, antes.internacao_id, u, agora));
}

// "Dei agora": registra a dose neste instante, em nome de quem tocou. Dois toques seguidos (menos de 1 min)
// não duplicam; se foi engano, dá para desfazer em 1 minuto.
async function medicacoesAdministrar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const observacao = textoOpcional(c.observacao, 'observação', 300);
  const m = await medicacaoPorId(env, id);
  if (m.encerrada_em) throw new ErroHttp(409, 'Esta medicação já foi encerrada.');
  if (m.internacao_status !== 'internado') throw new ErroHttp(409, 'Esta internação já foi encerrada.');
  const agora = agoraDe(env);
  const recente = new Date(agora.getTime() - JANELA_DESFAZER_MS).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO administracoes (medicacao_id, feita_em, feita_por, observacao)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM administracoes WHERE medicacao_id = ? AND feita_em > ?)`
  ).bind(id, agora.toISOString(), u.id, observacao, id, recente).run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta dose já foi registrada agora há pouco. Se foi engano, desfaça em até 1 minuto.');
  await registrarAcao(env, { usuarioId: u.id, acao: 'administrar_medicacao', entidade: 'administracoes', entidadeId: r.meta.last_row_id,
    depois: { medicacao_id: id, internacao_id: m.internacao_id, remedio: m.remedio, feita_em: agora.toISOString() }, ip: ipDe(request) });
  return json({ ...(await detalhesDaInternacao(env, m.internacao_id, u, agora)), administracao_id: r.meta.last_row_id }, 201);
}

// Desfaz uma dose registrada por engano: só quem registrou, em até 1 minuto.
async function administracoesDesfazer(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const a = await env.DB.prepare(
    `SELECT a.*, m.internacao_id, m.remedio FROM administracoes a JOIN internacao_medicacoes m ON m.id = a.medicacao_id WHERE a.id = ?`
  ).bind(id).first();
  if (!a) throw new ErroHttp(404, 'Dose não encontrada.');
  if (a.feita_por !== u.id) throw new ErroHttp(403, 'Só quem registrou a dose pode desfazê-la.');
  const agora = agoraDe(env);
  if (agora.getTime() - Date.parse(a.feita_em) > JANELA_DESFAZER_MS) throw new ErroHttp(409, 'Já passou 1 minuto: não dá mais para desfazer esta dose.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM administracoes WHERE id = ?').bind(id),
    prepararAcao(env, { usuarioId: u.id, acao: 'desfazer_administracao', entidade: 'administracoes', entidadeId: id,
      antes: { medicacao_id: a.medicacao_id, remedio: a.remedio, feita_em: a.feita_em }, ip: ipDe(request) }),
  ]);
  return json(await detalhesDaInternacao(env, a.internacao_id, u, agora));
}

export const ROTAS_INTERNACAO = [
  ['GET', '/api/internacao', quadro],
  ['POST', '/api/baias', baiasCriar],
  ['PATCH', '/api/baias/:id', baiasAlterar],
  ['POST', '/api/internacoes', internacoesCriar],
  ['GET', '/api/internacoes/:id', internacoesVer],
  ['POST', '/api/internacoes/:id/medicacoes', medicacoesCriar],
  ['POST', '/api/internacoes/:id/mover', internacoesMover],
  ['POST', '/api/internacoes/:id/encerrar', internacoesEncerrar],
  ['PATCH', '/api/internacao-medicacoes/:id', medicacoesAlterar],
  ['POST', '/api/internacao-medicacoes/:id/administrar', medicacoesAdministrar],
  ['POST', '/api/administracoes/:id/desfazer', administracoesDesfazer],
];
