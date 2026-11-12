// Prontuário: o histórico de anotações clínicas de cada pet.
//  - Conteúdo clínico: SÓ veterinário e suporte leem e escrevem (a recepção recebe 403).
//  - Cada anotação pode estar ligada a um atendimento e/ou a uma internação.
//  - Só o autor edita, e só até 24 horas depois de criar. Depois disso a anotação fica só para leitura
//    (para corrigir algo, escreve-se uma anotação nova).
//  - O registro de ações guarda só o TAMANHO do texto, nunca o texto (é conteúdo clínico).
import { exigirPapel } from './auth.js';
import { ErroHttp, agoraDe, ipDe, json, lerJson, prepararAcao } from './util.js';

export const PAPEIS_PRONTUARIO = ['veterinario', 'suporte'];
export const MAX_TEXTO = 10000;
export const JANELA_EDICAO_MS = 24 * 60 * 60 * 1000;

const SELECT_NOTA = `
  SELECT n.*, u.nome AS autor_nome, u.papel AS autor_papel, e.nome AS editor_nome,
         a.chegada_em AS atendimento_chegada_em, b.nome AS baia_nome, i.inicio_em AS internacao_inicio_em
    FROM prontuario n
    JOIN usuarios u ON u.id = n.criado_por
    LEFT JOIN usuarios e ON e.id = n.editado_por
    LEFT JOIN atendimentos a ON a.id = n.atendimento_id
    LEFT JOIN internacoes i ON i.id = n.internacao_id
    LEFT JOIN baias b ON b.id = i.baia_id`;

// Só o autor edita, e só dentro de 24 h.
export function podeEditarNota(nota, usuarioId, agora) {
  return nota.criado_por === usuarioId && agora.getTime() - Date.parse(nota.criado_em) < JANELA_EDICAO_MS;
}

export function notaPublica(n, usuarioId, agora) {
  return {
    id: n.id, pet_id: n.pet_id, texto: n.texto, criado_em: n.criado_em, editado_em: n.editado_em ?? null,
    autor: { id: n.criado_por, nome: n.autor_nome, papel: n.autor_papel },
    editado_por_nome: n.editor_nome ?? null,
    atendimento: n.atendimento_id ? { id: n.atendimento_id, chegada_em: n.atendimento_chegada_em } : null,
    internacao: n.internacao_id ? { id: n.internacao_id, baia_nome: n.baia_nome, inicio_em: n.internacao_inicio_em } : null,
    pode_editar: podeEditarNota(n, usuarioId, agora),
  };
}

// Anotações de uma internação (usadas na tela da baia), da mais nova para a mais antiga.
export async function notasDaInternacao(env, internacaoId, usuarioId, agora) {
  const { results } = await env.DB.prepare(`${SELECT_NOTA} WHERE n.internacao_id = ? ORDER BY n.criado_em DESC, n.id DESC LIMIT 200`).bind(internacaoId).all();
  return results.map((n) => notaPublica(n, usuarioId, agora));
}

function idPositivo(valor, mensagem) {
  if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < 1) throw new ErroHttp(400, mensagem);
  return valor;
}

// Lê o texto da anotação: obrigatório, até 10.000 letras.
function lerTexto(valor) {
  if (typeof valor !== 'string') throw new ErroHttp(400, 'Escreva a anotação.');
  const t = valor.replace(/\r\n/g, '\n').trim();
  if (!t) throw new ErroHttp(400, 'Escreva a anotação.');
  if (t.length > MAX_TEXTO) throw new ErroHttp(400, `A anotação pode ter no máximo ${MAX_TEXTO.toLocaleString('pt-BR')} letras.`);
  return t;
}

// ---------- rotas ----------
async function prontuarioDoPet(request, env, petId) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const pet = await env.DB.prepare('SELECT id FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  const agora = agoraDe(env);
  const { results } = await env.DB.prepare(`${SELECT_NOTA} WHERE n.pet_id = ? ORDER BY n.criado_em DESC, n.id DESC LIMIT 500`).bind(petId).all();
  const atual = await env.DB.prepare(
    `SELECT i.id, i.inicio_em, b.nome AS baia_nome FROM internacoes i JOIN baias b ON b.id = i.baia_id WHERE i.pet_id = ? AND i.status = 'internado'`
  ).bind(petId).first();
  return json({
    notas: results.map((n) => notaPublica(n, u.id, agora)),
    internacao_atual: atual ? { id: atual.id, baia_nome: atual.baia_nome, inicio_em: atual.inicio_em } : null,
  });
}

async function prontuarioCriar(request, env) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const petId = idPositivo(c.pet_id, 'Escolha o pet.');
  const t = lerTexto(c.texto);
  const pet = await env.DB.prepare('SELECT id FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) throw new ErroHttp(404, 'Pet não encontrado.');
  let atendimentoId = null;
  let internacaoId = null;
  if (c.atendimento_id !== undefined && c.atendimento_id !== null) {
    atendimentoId = idPositivo(c.atendimento_id, 'Atendimento inválido.');
    const a = await env.DB.prepare('SELECT id FROM atendimentos WHERE id = ? AND pet_id = ?').bind(atendimentoId, petId).first();
    if (!a) throw new ErroHttp(400, 'Esse atendimento não é deste pet.');
  }
  if (c.internacao_id !== undefined && c.internacao_id !== null) {
    internacaoId = idPositivo(c.internacao_id, 'Internação inválida.');
    const i = await env.DB.prepare('SELECT id FROM internacoes WHERE id = ? AND pet_id = ?').bind(internacaoId, petId).first();
    if (!i) throw new ErroHttp(400, 'Essa internação não é deste pet.');
  }
  const agora = agoraDe(env);
  const r = await env.DB.prepare(
    'INSERT INTO prontuario (pet_id, atendimento_id, internacao_id, texto, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(petId, atendimentoId, internacaoId, t, u.id, agora.toISOString()).run();
  const id = r.meta.last_row_id;
  // Só o tamanho vai para o registro: o texto é conteúdo clínico.
  await env.DB.batch([prepararAcao(env, {
    usuarioId: u.id, acao: 'criar_prontuario', entidade: 'prontuario', entidadeId: id,
    depois: { pet_id: petId, atendimento_id: atendimentoId, internacao_id: internacaoId, tamanho: t.length }, ip: ipDe(request),
  })]);
  const nota = await env.DB.prepare(`${SELECT_NOTA} WHERE n.id = ?`).bind(id).first();
  return json(notaPublica(nota, u.id, agora), 201);
}

async function prontuarioEditar(request, env, id) {
  const u = await exigirPapel(request, env, PAPEIS_PRONTUARIO);
  const c = await lerJson(request);
  const antes = await env.DB.prepare('SELECT * FROM prontuario WHERE id = ?').bind(id).first();
  if (!antes) throw new ErroHttp(404, 'Anotação não encontrada.');
  if (antes.criado_por !== u.id) throw new ErroHttp(403, 'Só quem escreveu a anotação pode editá-la.');
  const agora = agoraDe(env);
  if (!podeEditarNota(antes, u.id, agora)) throw new ErroHttp(409, 'Já passaram 24 horas: esta anotação ficou só para leitura. Escreva uma anotação nova.');
  const t = lerTexto(c.texto);
  if (t !== antes.texto) {
    const r = await env.DB.prepare('UPDATE prontuario SET texto = ?, editado_em = ?, editado_por = ? WHERE id = ? AND criado_por = ?')
      .bind(t, agora.toISOString(), u.id, id, u.id).run();
    if (!r.meta.changes) throw new ErroHttp(409, 'Esta anotação mudou. Atualize a tela.');
    await env.DB.batch([prepararAcao(env, {
      usuarioId: u.id, acao: 'editar_prontuario', entidade: 'prontuario', entidadeId: id,
      antes: { tamanho: antes.texto.length }, depois: { tamanho: t.length }, ip: ipDe(request),
    })]);
  }
  const nota = await env.DB.prepare(`${SELECT_NOTA} WHERE n.id = ?`).bind(id).first();
  return json(notaPublica(nota, u.id, agora));
}

export const ROTAS_PRONTUARIO = [
  ['GET', '/api/pets/:id/prontuario', prontuarioDoPet],
  ['POST', '/api/prontuario', prontuarioCriar],
  ['PATCH', '/api/prontuario/:id', prontuarioEditar],
];
