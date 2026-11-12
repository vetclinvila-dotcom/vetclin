// Atendimentos: chegada do paciente, tela "Hoje", iniciar, finalizar e cancelar.
// O atendimento é por ordem de chegada (sem hora marcada).
import { exigirLogin, exigirPapel } from './auth.js';
import { notificar } from './notificacoes.js';
import { ErroHttp, agoraISO, finalTelefone, inicioDoDiaBahia, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';

const PAPEIS_CLINICOS = ['veterinario', 'suporte']; // quem pode iniciar e finalizar
const ABERTOS = ['chegou', 'em_atendimento'];
const MSG_PESO = 'Informe o peso ou escolha "Pesar depois".';
const MSG_FAIXA_PESO = 'O peso deve estar entre 0,01 e 150 kg.';

// ---------- validações (também usadas pelo cadastro rápido) ----------

// Peso em kg: aceita número ou texto com vírgula/ponto. Vazio vira null.
export function lerPeso(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'number' && typeof valor !== 'string') throw new ErroHttp(400, MSG_FAIXA_PESO);
  if (typeof valor === 'string') {
    const t = valor.trim().replace(',', '.');
    if (!t) return null;
    if (!/^\d+(\.\d+)?$/.test(t)) throw new ErroHttp(400, MSG_FAIXA_PESO);
    valor = Number(t);
  }
  if (!Number.isFinite(valor) || valor < 0.01 || valor > 150) throw new ErroHttp(400, MSG_FAIXA_PESO);
  return Math.round(valor * 100) / 100;
}

// De onde veio o peso, conforme quem digitou.
export function origemDoPeso(usuario) {
  return usuario.papel === 'veterinario' ? 'veterinario' : 'balanca_recepcao';
}

function fotoIdOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new ErroHttp(400, 'Foto inválida.');
  return n;
}

function booleano(valor) {
  return valor === true || valor === 1 || valor === 'true';
}

// Confere se a foto existe (ainda sem gravar nada).
export async function exigirFoto(env, id) {
  const f = await env.DB.prepare('SELECT id FROM fotos WHERE id = ?').bind(id).first();
  if (!f) throw new ErroHttp(400, 'Foto não encontrada. Envie a foto de novo.');
}

// Lê os dados da chegada: { peso_kg, pesar_depois, motivo, urgente, foto_id }.
export function lerChegada(c, usuario) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new ErroHttp(400, 'Dados da chegada inválidos.');
  const peso = lerPeso(c.peso_kg);
  if (peso === null && c.pesar_depois !== true) throw new ErroHttp(400, MSG_PESO);
  return {
    peso,
    pesoOrigem: peso === null ? null : origemDoPeso(usuario),
    motivo: texto(c.motivo, 'motivo', { max: 200 }),
    urgente: booleano(c.urgente),
    fotoId: fotoIdOpcional(c.foto_id),
  };
}

// ---------- comandos de banco (sem executar; usados em batch) ----------

// Cria o atendimento. O pet pode ser dado por id ou, se acabou de ser criado
// no mesmo batch, pelo código (P-000001).
export function comandoInserirAtendimento(env, { petId, petCodigo, a, usuarioId, agora }) {
  return env.DB.prepare(
    `INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, peso_origem, peso_registrado_por, motivo, urgente, foto_id,
                               status, registrado_por, criado_em, atualizado_em)
     VALUES (${petId ? '?' : '(SELECT id FROM pets WHERE codigo = ?)'}, ?, ?, ?, ?, ?, ?, ?, 'chegou', ?, ?, ?)`
  ).bind(petId ?? petCodigo, agora, a.peso, a.pesoOrigem, a.peso === null ? null : usuarioId, a.motivo, a.urgente ? 1 : 0, a.fotoId,
    usuarioId, agora, agora);
}

// A foto da chegada vira a foto do perfil do pet, se ele ainda não tiver uma.
export function comandoFotoDoPet(env, { petId, petCodigo, fotoId, agora }) {
  return env.DB.prepare(`UPDATE pets SET foto_id = ?, atualizado_em = ? WHERE ${petId ? 'id' : 'codigo'} = ? AND foto_id IS NULL`)
    .bind(fotoId, agora, petId ?? petCodigo);
}

// Apaga uma foto que não é mais usada por ninguém.
function comandoLimparFoto(env, fotoId) {
  return env.DB.prepare(
    `DELETE FROM fotos WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM atendimentos WHERE foto_id = ?)
        AND NOT EXISTS (SELECT 1 FROM pets WHERE foto_id = ?)`
  ).bind(fotoId, fotoId, fotoId);
}

// Registro de ações de uma chegada nova (depois de gravada).
export async function registrarChegada(env, { usuarioId, atendimentoId, petId, a, ip, via = null }) {
  await registrarAcao(env, {
    usuarioId, acao: 'criar_atendimento', entidade: 'atendimentos', entidadeId: atendimentoId,
    depois: { pet_id: petId, peso_kg: a.peso, peso_origem: a.pesoOrigem, motivo: a.motivo, urgente: a.urgente, foto_id: a.fotoId, ...(via ? { via } : {}) },
    ip,
  });
  await avisarChegada(env, atendimentoId, usuarioId);
}

// Avisa os veterinários no celular que um paciente chegou.
// Nunca atrapalha o registro, mesmo se a notificação falhar.
// ("env.NOTIFICAR_TESTE" é um gancho só para os testes conferirem o que seria enviado.)
const NOME_ESPECIE = { cao: 'cão', gato: 'gato', outro: 'outro' };
export function textoAvisoChegada(item) {
  const pet = item.pet;
  const especie = NOME_ESPECIE[pet.especie] || pet.especie || '';
  const peso = item.sem_peso ? 'Sem peso' : `${String(item.peso_kg).replace('.', ',')} kg`;
  return {
    titulo: `${item.urgente ? 'URGENTE: ' : 'Chegou: '}${pet.nome}${especie ? ` (${especie})` : ''}`,
    corpo: [peso, item.motivo, item.tutor?.nome ? `tutor ${item.tutor.nome}` : ''].filter(Boolean).join(' · '),
  };
}
async function avisarChegada(env, atendimentoId, usuarioId) {
  try {
    const item = await buscarItemAtendimento(env, atendimentoId);
    const { titulo, corpo } = textoAvisoChegada(item);
    await (env.NOTIFICAR_TESTE ?? notificar)(env, {
      para: { papel: 'veterinario', excetoUsuarioId: usuarioId },
      titulo, corpo, url: '#/hoje', tag: `chegada-${atendimentoId}`, urgente: item.urgente,
    });
  } catch (e) {
    console.error('Falha ao avisar chegada:', e);
  }
}

// ---------- leitura ----------
const SELECT_ATENDIMENTO = `
  SELECT a.*, p.codigo AS pet_codigo, p.nome AS pet_nome, p.especie, p.idade_anos, p.idade_meses, p.foto_id AS pet_foto_id,
         t.id AS tutor_id, t.nome AS tutor_nome, t.whatsapp AS tutor_whatsapp,
         v.nome AS vet_nome
    FROM atendimentos a
    JOIN pets p ON p.id = a.pet_id
    JOIN tutores t ON t.id = p.tutor_id
    LEFT JOIN usuarios v ON v.id = a.veterinario_id`;

// Minutos de espera: da chegada até o início do atendimento (ou até agora).
function esperaMinutos(a, agoraMs) {
  const fim = a.iniciado_em ? Date.parse(a.iniciado_em) : agoraMs;
  return Math.max(0, Math.floor((fim - Date.parse(a.chegada_em)) / 60000));
}

function itemAtendimento(a, agoraMs) {
  return {
    id: a.id, status: a.status, chegada_em: a.chegada_em, iniciado_em: a.iniciado_em ?? null, finalizado_em: a.finalizado_em ?? null,
    espera_min: esperaMinutos(a, agoraMs),
    peso_kg: a.peso_kg ?? null, peso_origem: a.peso_origem ?? null, sem_peso: a.peso_kg === null || a.peso_kg === undefined,
    motivo: a.motivo ?? '', urgente: a.urgente === 1, foto_id: a.foto_id ?? null,
    cancelado_em: a.cancelado_em ?? null, motivo_cancelamento: a.motivo_cancelamento ?? null,
    veterinario: a.veterinario_id ? { id: a.veterinario_id, nome: a.vet_nome } : null,
    pet: { id: a.pet_id, codigo: a.pet_codigo, nome: a.pet_nome, especie: a.especie, idade_anos: a.idade_anos ?? null, idade_meses: a.idade_meses ?? null, foto_id: a.pet_foto_id ?? null },
    tutor: { id: a.tutor_id, nome: a.tutor_nome, final_telefone: finalTelefone(a.tutor_whatsapp) },
  };
}

export async function buscarItemAtendimento(env, id) {
  const a = await env.DB.prepare(`${SELECT_ATENDIMENTO} WHERE a.id = ?`).bind(id).first();
  if (!a) throw new ErroHttp(404, 'Atendimento não encontrado.');
  return itemAtendimento(a, Date.now());
}

async function atendimentoBruto(env, id) {
  const a = await env.DB.prepare('SELECT * FROM atendimentos WHERE id = ?').bind(id).first();
  if (!a) throw new ErroHttp(404, 'Atendimento não encontrado.');
  return a;
}

const resumoAtendimento = (a) => ({ peso_kg: a.peso_kg ?? null, peso_origem: a.peso_origem ?? null, motivo: a.motivo ?? null, urgente: a.urgente === 1, foto_id: a.foto_id ?? null });

// ---------- rotas ----------
async function atendimentosCriar(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const petId = Number(c.pet_id);
  if (!Number.isInteger(petId) || petId < 1) throw new ErroHttp(400, 'Escolha o pet.');
  const a = lerChegada(c, u);
  const pet = await env.DB.prepare('SELECT id, ativo FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  if (pet.ativo !== 1) throw new ErroHttp(409, 'Este pet está arquivado.');
  if (a.fotoId) await exigirFoto(env, a.fotoId);

  const jaNaClinica = async () => {
    const aberto = await env.DB.prepare(`SELECT id FROM atendimentos WHERE pet_id = ? AND status IN ('chegou','em_atendimento')`).bind(petId).first();
    return aberto ? json({ erro: 'Este pet já está na clínica.', atendimento_id: aberto.id }, 409) : null;
  };
  const antes = await jaNaClinica();
  if (antes) return antes;

  const agora = agoraISO();
  let saidas;
  try {
    saidas = await env.DB.batch([
      comandoInserirAtendimento(env, { petId, a, usuarioId: u.id, agora }),
      ...(a.fotoId ? [comandoFotoDoPet(env, { petId, fotoId: a.fotoId, agora })] : []),
    ]);
  } catch (e) {
    // Duas pessoas registraram ao mesmo tempo: o índice único do banco barrou a segunda.
    if (String(e.message).includes('UNIQUE')) {
      const dup = await jaNaClinica();
      if (dup) return dup;
    }
    throw e;
  }
  const id = saidas[0].meta.last_row_id;
  await registrarChegada(env, { usuarioId: u.id, atendimentoId: id, petId, a, ip: ipDe(request) });
  return json(await buscarItemAtendimento(env, id), 201);
}

async function atendimentosVer(request, env, id) {
  await exigirLogin(request, env);
  return json(await buscarItemAtendimento(env, id));
}

async function atendimentosAlterar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const antes = await atendimentoBruto(env, id);
  if (!ABERTOS.includes(antes.status)) throw new ErroHttp(409, 'Este atendimento já foi encerrado e não pode mais ser alterado.');

  const novo = { ...antes };
  if (c.peso_kg !== undefined) {
    const peso = lerPeso(c.peso_kg);
    if (peso === null) throw new ErroHttp(400, 'Informe o peso em kg.');
    if (peso !== antes.peso_kg) {
      novo.peso_kg = peso;
      novo.peso_origem = origemDoPeso(u);
      novo.peso_registrado_por = u.id;
    }
  }
  if (c.motivo !== undefined) novo.motivo = texto(c.motivo, 'motivo', { max: 200 });
  if (c.urgente !== undefined) novo.urgente = booleano(c.urgente) ? 1 : 0;
  if (c.foto_id !== undefined) {
    novo.foto_id = fotoIdOpcional(c.foto_id);
    if (novo.foto_id && novo.foto_id !== antes.foto_id) await exigirFoto(env, novo.foto_id);
  }

  const agora = agoraISO();
  const fotoMudou = novo.foto_id !== antes.foto_id;
  const comandos = [
    env.DB.prepare(`UPDATE atendimentos SET peso_kg = ?, peso_origem = ?, peso_registrado_por = ?, motivo = ?, urgente = ?, foto_id = ?, atualizado_em = ?
                     WHERE id = ? AND status IN ('chegou','em_atendimento')`)
      .bind(novo.peso_kg, novo.peso_origem, novo.peso_registrado_por, novo.motivo, novo.urgente, novo.foto_id, agora, id),
  ];
  if (fotoMudou && novo.foto_id) comandos.push(comandoFotoDoPet(env, { petId: antes.pet_id, fotoId: novo.foto_id, agora }));
  if (fotoMudou && antes.foto_id) comandos.push(comandoLimparFoto(env, antes.foto_id));
  comandos.push(prepararAcao(env, { usuarioId: u.id, acao: 'alterar_atendimento', entidade: 'atendimentos', entidadeId: id, antes: resumoAtendimento(antes), depois: resumoAtendimento(novo), ip: ipDe(request) }));
  await env.DB.batch(comandos);
  return json(await buscarItemAtendimento(env, id));
}

// Muda o status só se ele estiver no estado esperado (evita dois cliques / duas pessoas).
async function mudarStatus(request, env, id, { papeis, de, para, acao, mensagemErro, camposExtras }) {
  const u = papeis ? await exigirPapel(request, env, papeis) : await exigirLogin(request, env);
  const c = camposExtras ? await lerJson(request) : {};
  const antes = await atendimentoBruto(env, id);
  const extras = camposExtras ? camposExtras(c, u) : { sql: '', args: [], depois: {} };
  if (antes.status !== de) throw new ErroHttp(409, mensagemErro);
  const agora = agoraISO();
  const r = await env.DB.prepare(`UPDATE atendimentos SET status = ?, atualizado_em = ?${extras.sql} WHERE id = ? AND status = ?`)
    .bind(para, agora, ...extras.args, id, de).run();
  if (!r.meta.changes) throw new ErroHttp(409, mensagemErro);
  await registrarAcao(env, { usuarioId: u.id, acao, entidade: 'atendimentos', entidadeId: id, antes: { status: de }, depois: { status: para, ...extras.depois }, ip: ipDe(request) });
  return json(await buscarItemAtendimento(env, id));
}

const atendimentosIniciar = (request, env, id) => mudarStatus(request, env, id, {
  papeis: PAPEIS_CLINICOS, de: 'chegou', para: 'em_atendimento', acao: 'iniciar_atendimento',
  mensagemErro: 'Só é possível iniciar um atendimento que está aguardando.',
  camposExtras: (c, u) => ({ sql: ', veterinario_id = ?, iniciado_em = ?', args: [u.id, agoraISO()], depois: { veterinario_id: u.id } }),
});

const atendimentosFinalizar = (request, env, id) => mudarStatus(request, env, id, {
  papeis: PAPEIS_CLINICOS, de: 'em_atendimento', para: 'finalizado', acao: 'finalizar_atendimento',
  mensagemErro: 'Só é possível finalizar um atendimento que está em andamento.',
  camposExtras: () => ({ sql: ', finalizado_em = ?', args: [agoraISO()], depois: {} }),
});

const atendimentosCancelar = (request, env, id) => mudarStatus(request, env, id, {
  de: 'chegou', para: 'cancelado', acao: 'cancelar_atendimento',
  mensagemErro: 'Só é possível cancelar a chegada de quem ainda está aguardando.',
  camposExtras: (c, u) => {
    const motivo = texto(c.motivo, 'motivo do cancelamento', { max: 200 });
    return { sql: ', cancelado_em = ?, cancelado_por = ?, motivo_cancelamento = ?', args: [agoraISO(), u.id, motivo], depois: { motivo_cancelamento: motivo } };
  },
});

// Tela "Hoje": chegadas do dia (dia = 00:00 às 24:00 em Bahia).
async function hoje(request, env) {
  await exigirLogin(request, env);
  const agora = new Date();
  const inicio = inicioDoDiaBahia(agora);
  const agoraMs = agora.getTime();
  // "soHoje": finalizados mostram só os de hoje. Quem ainda está aberto
  // (aguardando ou em atendimento) aparece SEMPRE, mesmo que tenha chegado
  // num dia anterior — assim um atendimento esquecido não fica escondido
  // nem impede o pet de dar entrada de novo. Esses vêm marcados com
  // "de_outro_dia: true" para a tela mostrar a data.
  const lista = async (onde, ordem, limite = 200, soHoje = false) => {
    const filtroData = soHoje ? 'a.chegada_em >= ? AND ' : '';
    const args = soHoje ? [inicio, limite] : [limite];
    const { results } = await env.DB.prepare(`${SELECT_ATENDIMENTO} WHERE ${filtroData}${onde} ORDER BY ${ordem} LIMIT ?`).bind(...args).all();
    return results.map((a) => ({ ...itemAtendimento(a, agoraMs), de_outro_dia: a.chegada_em < inicio }));
  };
  const cancelados = await env.DB.prepare(`SELECT COUNT(*) AS n FROM atendimentos WHERE chegada_em >= ? AND status = 'cancelado'`).bind(inicio).first();
  return json({
    agora: agora.toISOString(),
    inicio_dia: inicio,
    aguardando: await lista(`a.status = 'chegou'`, 'a.urgente DESC, a.chegada_em ASC, a.id ASC'),
    em_atendimento: await lista(`a.status = 'em_atendimento'`, 'a.iniciado_em ASC, a.id ASC'),
    finalizados: await lista(`a.status = 'finalizado'`, 'a.finalizado_em DESC, a.id DESC', 20, true),
    cancelados_hoje: cancelados.n,
  });
}

export const ROTAS_ATENDIMENTOS = [
  ['GET', '/api/hoje', hoje],
  ['POST', '/api/atendimentos', atendimentosCriar],
  ['GET', '/api/atendimentos/:id', atendimentosVer],
  ['PATCH', '/api/atendimentos/:id', atendimentosAlterar],
  ['POST', '/api/atendimentos/:id/iniciar', atendimentosIniciar],
  ['POST', '/api/atendimentos/:id/finalizar', atendimentosFinalizar],
  ['POST', '/api/atendimentos/:id/cancelar', atendimentosCancelar],
];
