// Cadastro de tutores e pets: busca, criação, edição, junção e limpeza de testes.
import { exigirAdmin, exigirLogin } from './auth.js';
import { ErroHttp, agoraISO, finalTelefone, ipDe, json, lerJson, prepararAcao, proximoCodigo, registrarAcao, texto } from './util.js';
import { buscarItemAtendimento, comandoFotoDoPet, comandoInserirAtendimento, exigirFoto, exigirVeterinarioAtivo, lerChegada, registrarChegada } from './atendimentos.js';

const ESPECIES = ['cao', 'gato', 'outro'];
const SEXOS = ['macho', 'femea'];

// ---------- funções de apoio (também usadas nos testes) ----------

// Texto para busca: sem acentos, minúsculas, sem espaços sobrando.
export function normalizarBusca(entrada) {
  return String(entrada ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Telefone brasileiro -> { e164: '+5571999998888', digitos: '5571999998888' }.
export function normalizarWhatsapp(entrada) {
  const erro = new ErroHttp(400, 'Telefone inválido. Use DDD + número, ex.: (71) 99999-8888.');
  let d = String(entrada ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    // já tem o código do país
  } else if (d.length === 10 || d.length === 11) {
    d = '55' + d;
  } else {
    throw erro;
  }
  const ddd = d.slice(2, 4);
  if (!/^[1-9][1-9]$/.test(ddd)) throw erro; // DDD de 11 a 99, sem zero
  const local = d.slice(4);
  const celular = local.length === 9 && local[0] === '9';
  const fixo = local.length === 8 && /^[2-5]/.test(local);
  if (!celular && !fixo) throw erro;
  return { e164: '+' + d, digitos: d };
}

// Telefone OPCIONAL: vazio vira { e164: null, digitos: null } (tutor sem telefone).
// Se vier preenchido, precisa ser válido.
export function telefoneOpcional(entrada) {
  if (String(entrada ?? '').replace(/\D/g, '') === '') return { e164: null, digitos: null };
  return normalizarWhatsapp(entrada);
}

// (finalTelefone agora mora em util.js; continua disponível por aqui.)
export { finalTelefone };

// Origem do cadastro conforme quem está logado.
function origemDe(usuario) {
  return usuario.papel === 'recepcao' ? 'recepcao' : 'veterinario';
}

// Inteiro opcional dentro de um intervalo (vazio vira null).
function inteiro(valor, campo, min, max) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroHttp(400, `O campo ${campo} deve ser um número de ${min} a ${max}.`);
  return n;
}

function especieValida(valor) {
  const e = String(valor ?? '').trim().toLowerCase();
  if (!ESPECIES.includes(e)) throw new ErroHttp(400, 'Escolha a espécie: cão, gato ou outro.');
  return e;
}

function sexoValido(valor) {
  const s = String(valor ?? '').trim().toLowerCase();
  if (!s) return null;
  if (!SEXOS.includes(s)) throw new ErroHttp(400, 'Sexo deve ser macho ou fêmea.');
  return s;
}

function nascimentoValido(valor) {
  const n = String(valor ?? '').trim();
  if (!n) return null;
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(n)) throw new ErroHttp(400, 'Data de nascimento inválida.');
  return n;
}

// Escapa % e _ para a busca LIKE tratar como letras comuns.
export function likeSeguro(t) {
  return '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

// ---------- leitura de dados ----------
function tutorCompleto(t) {
  return {
    id: t.id, codigo: t.codigo, nome: t.nome, whatsapp: t.whatsapp,
    final_telefone: finalTelefone(t.whatsapp), observacoes: t.observacoes ?? null,
    origem: t.origem, criado_em: t.criado_em, atualizado_em: t.atualizado_em,
    mesclado_em_id: t.mesclado_em_id ?? null,
  };
}

function petCompleto(p) {
  return {
    id: p.id, codigo: p.codigo, tutor_id: p.tutor_id, nome: p.nome, especie: p.especie,
    raca: p.raca ?? null, raca_confirmada: p.raca_confirmada === 1, sexo: p.sexo ?? null,
    idade_anos: p.idade_anos ?? null, idade_meses: p.idade_meses ?? null,
    nascimento_aprox: p.nascimento_aprox ?? null, observacoes: p.observacoes ?? null,
    origem: p.origem, ativo: p.ativo === 1, criado_em: p.criado_em, atualizado_em: p.atualizado_em,
    foto_id: p.foto_id ?? null,
  };
}

async function buscarTutor(env, id) {
  const t = await env.DB.prepare('SELECT * FROM tutores WHERE id = ?').bind(id).first();
  if (!t) throw new ErroHttp(404, 'Tutor não encontrado.');
  return t;
}

async function buscarTutorAtivo(env, id) {
  const t = await buscarTutor(env, id);
  if (t.mesclado_em_id) throw new ErroHttp(409, 'Este cadastro foi unido a outro e não pode mais ser usado.');
  return t;
}

async function petsDoTutor(env, tutorId, { soAtivos = true } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM pets WHERE tutor_id = ? ${soAtivos ? 'AND ativo = 1' : ''} ORDER BY nome_busca, id`
  ).bind(tutorId).all();
  return results;
}

// Outros tutores (não unidos) com o mesmo WhatsApp, já com seus pets.
async function tutoresComMesmoWhatsapp(env, digitos, ignorarId = 0) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM tutores WHERE whatsapp_digitos = ? AND mesclado_em_id IS NULL AND id <> ? ORDER BY id'
  ).bind(digitos, ignorarId).all();
  const saida = [];
  for (const t of results) {
    const pets = await petsDoTutor(env, t.id);
    saida.push({
      id: t.id, codigo: t.codigo, nome: t.nome, final_telefone: finalTelefone(t.whatsapp),
      pets: pets.map((p) => ({ id: p.id, nome: p.nome, especie: p.especie })),
    });
  }
  return saida;
}

function respostaDuplicado(erro, tipo, duplicados) {
  return json({ erro, tipo, duplicados }, 409);
}

// Pets ativos do mesmo tutor com o mesmo nome.
async function petsComMesmoNome(env, tutorId, nomeBusca, ignorarId = 0) {
  const { results } = await env.DB.prepare(
    'SELECT id, codigo, nome, especie FROM pets WHERE tutor_id = ? AND ativo = 1 AND nome_busca = ? AND id <> ?'
  ).bind(tutorId, nomeBusca, ignorarId).all();
  return results;
}

const MSG_PET_DUPLICADO = 'Este tutor já tem um pet com esse nome.';
const MSG_WHATS_DUPLICADO = 'Já existe cadastro com este WhatsApp.';

// ---------- busca ----------
async function buscar(request, env) {
  await exigirLogin(request, env);
  const bruto = new URL(request.url).searchParams.get('q') ?? '';
  const q = normalizarBusca(bruto);
  if (q.length < 2) throw new ErroHttp(400, 'Digite pelo menos 2 letras para buscar.');

  const padrao = likeSeguro(q);
  const soTelefone = /^[\d\s()+.-]+$/.test(bruto.trim());
  const digitos = bruto.replace(/\D/g, '');
  const usaFone = soTelefone && digitos.length >= 4;
  const codigo = bruto.trim().toUpperCase();

  // Condições da busca sobre o tutor (alias t).
  const condTutor = `(t.nome_busca LIKE ? ESCAPE '\\' OR (? = 1 AND t.whatsapp_digitos LIKE ?) OR upper(t.codigo) = ?)`;
  const argsTutor = [padrao, usaFone ? 1 : 0, '%' + digitos + '%', codigo];

  const { results: comPet } = await env.DB.prepare(
    `SELECT p.id AS pet_id, p.codigo AS pet_codigo, p.nome AS pet_nome, p.especie,
            t.id AS tutor_id, t.codigo AS tutor_codigo, t.nome AS tutor_nome, t.whatsapp
       FROM pets p JOIN tutores t ON t.id = p.tutor_id
      WHERE p.ativo = 1 AND t.mesclado_em_id IS NULL
        AND (p.nome_busca LIKE ? ESCAPE '\\' OR upper(p.codigo) = ? OR ${condTutor})
      ORDER BY p.nome_busca, p.id LIMIT 30`
  ).bind(padrao, codigo, ...argsTutor).all();

  const itens = comPet.map((r) => ({
    tipo: 'pet',
    pet: { id: r.pet_id, codigo: r.pet_codigo, nome: r.pet_nome, especie: r.especie },
    tutor: { id: r.tutor_id, codigo: r.tutor_codigo, nome: r.tutor_nome, final_telefone: finalTelefone(r.whatsapp) },
  }));

  if (itens.length < 30) {
    const { results: semPet } = await env.DB.prepare(
      `SELECT t.id, t.codigo, t.nome, t.whatsapp FROM tutores t
        WHERE t.mesclado_em_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM pets p WHERE p.tutor_id = t.id AND p.ativo = 1)
          AND ${condTutor}
        ORDER BY t.nome_busca, t.id LIMIT ?`
    ).bind(...argsTutor, 30 - itens.length).all();
    for (const t of semPet) {
      itens.push({ tipo: 'tutor', pet: null, tutor: { id: t.id, codigo: t.codigo, nome: t.nome, final_telefone: finalTelefone(t.whatsapp) } });
    }
  }
  return json({ resultados: itens });
}

// ---------- sugestões na chegada ----------
// Enquanto a recepção digita nome do pet / tutor / WhatsApp, o painel procura pets já cadastrados.
// Ordem: (1) nome do pet E do tutor combinam; (2) WhatsApp combina (8+ números), qualquer pet do tutor;
// (3) só o nome do pet combina (somente quando o campo do tutor está vazio ou curto).
// Nunca devolve o telefone inteiro, só o final.
const MAX_SUGESTOES_CHEGADA = 5;

function textoIdade(anos, meses) {
  const partes = [];
  if (anos) partes.push(anos === 1 ? '1 ano' : `${anos} anos`);
  if (meses) partes.push(meses === 1 ? '1 mês' : `${meses} meses`);
  return partes.join(' e ') || null;
}

async function chegadaSugestoes(request, env) {
  await exigirLogin(request, env);
  const qs = new URL(request.url).searchParams;
  const pet = normalizarBusca(qs.get('pet'));
  const tutor = normalizarBusca(qs.get('tutor'));
  const digitos = String(qs.get('whatsapp') ?? '').replace(/\D/g, '');
  if (pet.length < 2) return json({ sugestoes: [] });
  const usaFone = digitos.length >= 8;
  const tutorValido = tutor.length >= 2;

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.codigo, p.nome, p.nome_busca, p.especie, p.idade_anos, p.idade_meses, p.foto_id,
            t.id AS tutor_id, t.nome AS tutor_nome, t.nome_busca AS tutor_busca, t.whatsapp, t.whatsapp_digitos,
            (SELECT peso_kg FROM atendimentos a WHERE a.pet_id = p.id AND a.peso_kg IS NOT NULL ORDER BY a.chegada_em DESC, a.id DESC LIMIT 1) AS ultimo_peso_kg,
            (SELECT MAX(chegada_em) FROM atendimentos a WHERE a.pet_id = p.id AND a.status <> 'cancelado') AS ultima_visita_em,
            EXISTS (SELECT 1 FROM atendimentos a WHERE a.pet_id = p.id AND a.status IN ('chegou','em_atendimento')) AS aberto
       FROM pets p JOIN tutores t ON t.id = p.tutor_id
      WHERE p.ativo = 1 AND t.mesclado_em_id IS NULL
        AND (p.nome_busca LIKE ? ESCAPE '\\' OR (? = 1 AND t.whatsapp_digitos LIKE ?))
      ORDER BY p.nome_busca, p.id LIMIT 200`
  ).bind(likeSeguro(pet), usaFone ? 1 : 0, '%' + digitos + '%').all();

  const candidatos = [];
  for (const r of results) {
    const petCombina = r.nome_busca.includes(pet);
    let nivel = 0;
    if (petCombina && tutorValido && r.tutor_busca.includes(tutor)) nivel = 1;
    else if (usaFone && r.whatsapp_digitos.includes(digitos)) nivel = 2;
    else if (petCombina && tutor.length < 3) nivel = 3;
    if (!nivel) continue;
    candidatos.push({ r, nivel, comeca: r.nome_busca.startsWith(pet) ? 0 : 1 });
  }
  // Mesmo nível: quem começa com o texto digitado vem antes; depois os mais recentes.
  candidatos.sort((a, b) => a.nivel - b.nivel || a.comeca - b.comeca || String(b.r.ultima_visita_em ?? '').localeCompare(String(a.r.ultima_visita_em ?? '')) || a.r.id - b.r.id);

  return json({
    sugestoes: candidatos.slice(0, MAX_SUGESTOES_CHEGADA).map(({ r }) => ({
      pet: { id: r.id, codigo: r.codigo, nome: r.nome, especie: r.especie, idade: textoIdade(r.idade_anos, r.idade_meses), foto_id: r.foto_id ?? null },
      tutor: { id: r.tutor_id, nome: r.tutor_nome, final_telefone: finalTelefone(r.whatsapp) },
      ultimo_peso_kg: r.ultimo_peso_kg ?? null,
      ultima_visita_em: r.ultima_visita_em ?? null,
      em_atendimento: r.aberto === 1,
    })),
  });
}

// ---------- tutores ----------
// Comandos (sem executar) que criam um tutor; o id vem do resultado do batch.
function comandoInserirTutor(env, { codigo, nome, tel, observacoes, origem, usuarioId, agora }) {
  return env.DB.prepare(
    `INSERT INTO tutores (codigo, nome, whatsapp, observacoes, origem, criado_por, criado_em, atualizado_em, nome_busca, whatsapp_digitos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(codigo, nome, tel.e164, observacoes, origem, usuarioId, agora, agora, normalizarBusca(nome), tel.digitos);
}

function comandoInserirPet(env, { codigo, tutorId, tutorCodigo, d, origem, usuarioId, agora }) {
  // Se o tutor acabou de ser criado no mesmo batch, achamos ele pelo código.
  return env.DB.prepare(
    `INSERT INTO pets (codigo, tutor_id, nome, especie, raca, raca_confirmada, nascimento_aprox, idade_anos, idade_meses, sexo, observacoes,
                       origem, criado_por, criado_em, atualizado_em, ativo, nome_busca)
     VALUES (?, ${tutorId ? '?' : '(SELECT id FROM tutores WHERE codigo = ?)'}, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(codigo, tutorId ?? tutorCodigo, d.nome, d.especie, d.raca, d.nascimento_aprox, d.idade_anos, d.idade_meses, d.sexo, d.observacoes,
    origem, usuarioId, agora, agora, normalizarBusca(d.nome));
}

function lerTutor(c) {
  return {
    nome: texto(c.nome, 'nome do tutor', { max: 120 }),
    tel: telefoneOpcional(c.whatsapp),
    observacoes: texto(c.observacoes, 'observações', { obrigatorio: false, max: 1000 }) || null,
  };
}

// Lê os dados do pet. "parcial" = só os campos enviados (para edição).
function lerPet(c, { parcial = false } = {}) {
  const tem = (k) => !parcial || c[k] !== undefined;
  const d = {};
  if (tem('nome')) d.nome = texto(c.nome, 'nome do pet', { max: 80 });
  if (tem('especie')) d.especie = c.especie === undefined && !parcial ? 'outro' : especieValida(c.especie);
  if (tem('raca')) d.raca = texto(c.raca, 'raça', { obrigatorio: false, max: 80 }) || null;
  if (tem('sexo')) d.sexo = sexoValido(c.sexo);
  if (tem('idade_anos')) d.idade_anos = inteiro(c.idade_anos, 'idade em anos', 0, 40);
  if (tem('idade_meses')) d.idade_meses = inteiro(c.idade_meses, 'idade em meses', 0, 11);
  if (tem('nascimento_aprox')) d.nascimento_aprox = nascimentoValido(c.nascimento_aprox);
  if (tem('observacoes')) d.observacoes = texto(c.observacoes, 'observações', { obrigatorio: false, max: 1000 }) || null;
  return d;
}

async function lerPetPorId(env, id) {
  const p = await env.DB.prepare('SELECT * FROM pets WHERE id = ?').bind(id).first();
  if (!p) throw new ErroHttp(404, 'Pet não encontrado.');
  return p;
}

async function tutoresCriar(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const t = lerTutor(c);
  if (c.confirmar_duplicado !== true && t.tel.digitos) {
    const dup = await tutoresComMesmoWhatsapp(env, t.tel.digitos);
    if (dup.length) return respostaDuplicado(MSG_WHATS_DUPLICADO, 'tutor', dup);
  }
  const codigo = await proximoCodigo(env, 'tutor');
  const agora = agoraISO();
  const r = await comandoInserirTutor(env, { codigo, ...t, origem: origemDe(u), usuarioId: u.id, agora }).run();
  const id = r.meta.last_row_id;
  const novo = await buscarTutor(env, id);
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_tutor', entidade: 'tutores', entidadeId: id, depois: { codigo, nome: t.nome, whatsapp: t.tel.e164, observacoes: t.observacoes }, ip: ipDe(request) });
  return json(tutorCompleto(novo), 201);
}

async function tutoresVer(request, env, id) {
  await exigirLogin(request, env);
  const t = await buscarTutor(env, id);
  const pets = await petsDoTutor(env, id, { soAtivos: false });
  return json({ tutor: tutorCompleto(t), pets: pets.map(petCompleto) });
}

async function tutoresAlterar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const antes = await buscarTutorAtivo(env, id);
  const novo = { nome: antes.nome, whatsapp: antes.whatsapp, digitos: antes.whatsapp_digitos, observacoes: antes.observacoes };
  if (c.nome !== undefined) novo.nome = texto(c.nome, 'nome do tutor', { max: 120 });
  if (c.observacoes !== undefined) novo.observacoes = texto(c.observacoes, 'observações', { obrigatorio: false, max: 1000 }) || null;
  if (c.whatsapp !== undefined) {
    const tel = telefoneOpcional(c.whatsapp);
    if (tel.digitos && tel.digitos !== antes.whatsapp_digitos && c.confirmar_duplicado !== true) {
      const dup = await tutoresComMesmoWhatsapp(env, tel.digitos, id);
      if (dup.length) return respostaDuplicado(MSG_WHATS_DUPLICADO, 'tutor', dup);
    }
    novo.whatsapp = tel.e164;
    novo.digitos = tel.digitos;
  }
  await env.DB.prepare('UPDATE tutores SET nome = ?, nome_busca = ?, whatsapp = ?, whatsapp_digitos = ?, observacoes = ?, atualizado_em = ? WHERE id = ?')
    .bind(novo.nome, normalizarBusca(novo.nome), novo.whatsapp, novo.digitos, novo.observacoes, agoraISO(), id).run();
  const resumo = (x) => ({ nome: x.nome, whatsapp: x.whatsapp, observacoes: x.observacoes });
  await registrarAcao(env, { usuarioId: u.id, acao: 'alterar_tutor', entidade: 'tutores', entidadeId: id, antes: resumo(antes), depois: resumo(novo), ip: ipDe(request) });
  return json(tutorCompleto(await buscarTutor(env, id)));
}

// ---------- pets ----------
async function petsCriar(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const tutorId = Number(c.tutor_id);
  if (!Number.isInteger(tutorId)) throw new ErroHttp(400, 'Escolha o tutor do pet.');
  if (c.especie === undefined || c.especie === '') throw new ErroHttp(400, 'Escolha a espécie: cão, gato ou outro.');
  const d = lerPet(c);
  await buscarTutorAtivo(env, tutorId);
  if (c.confirmar_duplicado !== true) {
    const dup = await petsComMesmoNome(env, tutorId, normalizarBusca(d.nome));
    if (dup.length) return respostaDuplicado(MSG_PET_DUPLICADO, 'pet', dup);
  }
  const codigo = await proximoCodigo(env, 'pet');
  const r = await comandoInserirPet(env, { codigo, tutorId, d, origem: origemDe(u), usuarioId: u.id, agora: agoraISO() }).run();
  const id = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_pet', entidade: 'pets', entidadeId: id, depois: { codigo, tutor_id: tutorId, ...d }, ip: ipDe(request) });
  return json(petCompleto(await lerPetPorId(env, id)), 201);
}

async function petsVer(request, env, id) {
  const u = await exigirLogin(request, env);
  const p = await lerPetPorId(env, id);
  const t = await buscarTutor(env, p.tutor_id);
  // Histórico de atendimentos (o peso de cada visita é o dado mais importante para os médicos).
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.chegada_em, a.status, a.tipo, a.motivo, a.urgente, a.peso_kg, a.peso_origem, a.foto_id, v.nome AS vet_nome
       FROM atendimentos a LEFT JOIN usuarios v ON v.id = a.veterinario_id
      WHERE a.pet_id = ? ORDER BY a.chegada_em DESC, a.id DESC LIMIT 50`
  ).bind(id).all();
  const aberto = await env.DB.prepare(`SELECT id, status FROM atendimentos WHERE pet_id = ? AND status IN ('chegou','em_atendimento')`).bind(id).first();
  // Receitas do pet (as 20 últimas). A recepção nunca vê rascunhos nem canceladas.
  const soLiberadas = u.papel === 'recepcao' ? `AND r.status IN ('liberada','impressa','entregue')` : '';
  const { results: receitas } = await env.DB.prepare(
    `SELECT r.id, r.status, r.versao, r.liberada_em, r.criado_em, v.nome AS vet_nome, r.origem, cp.nome AS criado_por_nome, substr(r.texto, 1, 300) AS inicio,
            (SELECT COALESCE(SUM(i.quantidade * i.valor_unitario_centavos), 0) FROM receita_itens i WHERE i.receita_id = r.id AND i.temos = 1) AS total_produtos_centavos
       FROM receitas r LEFT JOIN usuarios v ON v.id = r.veterinario_id LEFT JOIN usuarios cp ON cp.id = r.criado_por
      WHERE r.pet_id = ? ${soLiberadas} ORDER BY r.id DESC LIMIT 20`
  ).bind(id).all();
  // (pula o título do grupo "USO ORAL" e tira "1 - " e os pontinhos das receitas em colunas)
  const previa = (t) => { const l = (String(t ?? '').split('\n').map((x) => x.trim()).find((x) => x && !/^USO\b[^a-z\d]*$/.test(x)) || '').replace(/^1 - \*(.+?)\*( \.\.\. .*)?$/, '$1'); return l.length > 80 ? l.slice(0, 80) + '…' : l; };
  return json({
    pet: petCompleto(p),
    tutor: { id: t.id, codigo: t.codigo, nome: t.nome, whatsapp: t.whatsapp, final_telefone: finalTelefone(t.whatsapp), mesclado_em_id: t.mesclado_em_id ?? null },
    atendimento_aberto: aberto ? { id: aberto.id, status: aberto.status } : null,
    receitas: receitas.map((r) => ({ id: r.id, status: r.status, versao: r.versao, liberada_em: r.liberada_em ?? null, criado_em: r.criado_em, veterinario: r.vet_nome ?? null, origem: r.origem, transcrita_por: r.origem === 'transcrita' ? r.criado_por_nome : null, previa: previa(r.inicio), total_produtos_centavos: r.total_produtos_centavos })),
    atendimentos: results.map((a) => ({
      id: a.id, chegada_em: a.chegada_em, status: a.status, tipo: a.tipo ?? 'consulta', motivo: a.motivo ?? null, urgente: a.urgente === 1,
      peso_kg: a.peso_kg ?? null, peso_origem: a.peso_origem ?? null, sem_peso: a.peso_kg === null || a.peso_kg === undefined,
      foto_id: a.foto_id ?? null, veterinario: a.vet_nome ?? null,
    })),
  });
}

async function petsAlterar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const antes = await lerPetPorId(env, id);
  const d = lerPet(c, { parcial: true });
  const novo = { ...petCompleto(antes), ...d };
  if (c.raca_confirmada !== undefined) novo.raca_confirmada = !!c.raca_confirmada;
  if (c.ativo !== undefined) novo.ativo = !!c.ativo;
  if (c.tutor_id !== undefined) {
    const tid = Number(c.tutor_id);
    if (!Number.isInteger(tid)) throw new ErroHttp(400, 'Tutor inválido.');
    if (tid !== antes.tutor_id) await buscarTutorAtivo(env, tid);
    novo.tutor_id = tid;
  }
  // Aviso de nome repetido: se mudou nome, tutor ou voltou a ficar ativo.
  const mudou = novo.nome !== antes.nome || novo.tutor_id !== antes.tutor_id || (novo.ativo && antes.ativo !== 1);
  if (novo.ativo && mudou && c.confirmar_duplicado !== true) {
    const dup = await petsComMesmoNome(env, novo.tutor_id, normalizarBusca(novo.nome), id);
    if (dup.length) return respostaDuplicado(MSG_PET_DUPLICADO, 'pet', dup);
  }
  await env.DB.prepare(
    `UPDATE pets SET tutor_id = ?, nome = ?, nome_busca = ?, especie = ?, raca = ?, raca_confirmada = ?, nascimento_aprox = ?,
            idade_anos = ?, idade_meses = ?, sexo = ?, observacoes = ?, ativo = ?, atualizado_em = ? WHERE id = ?`
  ).bind(novo.tutor_id, novo.nome, normalizarBusca(novo.nome), novo.especie, novo.raca, novo.raca_confirmada ? 1 : 0, novo.nascimento_aprox,
    novo.idade_anos, novo.idade_meses, novo.sexo, novo.observacoes, novo.ativo ? 1 : 0, agoraISO(), id).run();
  const campos = ['tutor_id', 'nome', 'especie', 'raca', 'raca_confirmada', 'nascimento_aprox', 'idade_anos', 'idade_meses', 'sexo', 'observacoes', 'ativo'];
  const resumo = (x) => Object.fromEntries(campos.map((k) => [k, x[k]]));
  const acao = antes.ativo === 1 && !novo.ativo ? 'arquivar_pet' : 'alterar_pet';
  await registrarAcao(env, { usuarioId: u.id, acao, entidade: 'pets', entidadeId: id, antes: resumo(petCompleto(antes)), depois: resumo(novo), ip: ipDe(request) });
  return json(petCompleto(await lerPetPorId(env, id)));
}

// ---------- cadastro rápido ----------
// Comandos extras do batch quando há chegada: atendimento (+ foto de perfil do pet).
function comandosChegada(env, { petCodigo, chegada, usuarioId, agora }) {
  if (!chegada) return [];
  return [
    comandoInserirAtendimento(env, { petCodigo, a: chegada, usuarioId, agora }),
    ...(chegada.fotoId ? [comandoFotoDoPet(env, { petCodigo, fotoId: chegada.fotoId, agora })] : []),
  ];
}

// Depois do batch: registra a chegada no registro de ações e devolve o atendimento.
// (O pet acabou de ser criado, então o atendimento mais recente dele é o desta chegada.)
async function registrarEBuscarChegada(env, { chegada, petId, usuarioId, ip }) {
  if (!chegada) return null;
  const linha = await env.DB.prepare('SELECT id FROM atendimentos WHERE pet_id = ? ORDER BY id DESC LIMIT 1').bind(petId).first();
  await registrarChegada(env, { usuarioId, atendimentoId: linha.id, petId, a: chegada, ip, via: 'cadastro_rapido' });
  return buscarItemAtendimento(env, linha.id);
}

async function cadastroRapido(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  // especie ausente = 'outro'. Sexo, raça, idade e observações são opcionais (mesmas regras da edição do pet).
  const pet = lerPet({
    nome: c.pet?.nome, especie: c.pet?.especie, raca: c.pet?.raca, sexo: c.pet?.sexo, idade_anos: c.pet?.idade_anos,
    idade_meses: c.pet?.idade_meses, nascimento_aprox: c.pet?.nascimento_aprox, observacoes: c.pet?.observacoes,
  });
  // Chegada (opcional): validada ANTES de gravar qualquer coisa.
  const chegada = c.chegada !== undefined && c.chegada !== null ? lerChegada(c.chegada, u) : null;
  if (chegada?.fotoId) await exigirFoto(env, chegada.fotoId);
  if (chegada) await exigirVeterinarioAtivo(env, chegada.paraVetId);
  const origem = origemDe(u);
  const ip = ipDe(request);
  const agora = agoraISO();

  // Caso 1: o tutor já existe -> só cria o pet.
  if (c.tutor_existente_id !== undefined && c.tutor_existente_id !== null) {
    const tutorId = Number(c.tutor_existente_id);
    if (!Number.isInteger(tutorId)) throw new ErroHttp(400, 'Tutor inválido.');
    const tutor = await buscarTutorAtivo(env, tutorId);
    if (c.confirmar_duplicado !== true) {
      const dup = await petsComMesmoNome(env, tutorId, normalizarBusca(pet.nome));
      if (dup.length) return respostaDuplicado(MSG_PET_DUPLICADO, 'pet', dup);
    }
    const codigo = await proximoCodigo(env, 'pet');
    const inserirPet = comandoInserirPet(env, { codigo, tutorId, d: pet, origem, usuarioId: u.id, agora });
    // Com chegada, pet e atendimento são gravados juntos (ou entram os dois, ou nenhum).
    const saidas = await env.DB.batch([inserirPet, ...comandosChegada(env, { petCodigo: codigo, chegada, usuarioId: u.id, agora })]);
    const petId = saidas[0].meta.last_row_id;
    await registrarAcao(env, { usuarioId: u.id, acao: 'criar_pet', entidade: 'pets', entidadeId: petId, depois: { codigo, tutor_id: tutorId, ...pet, via: 'cadastro_rapido' }, ip });
    const atendimento = await registrarEBuscarChegada(env, { chegada, petId, usuarioId: u.id, ip });
    return json({ tutor: tutorCompleto(tutor), pet: petCompleto(await lerPetPorId(env, petId)), ...(atendimento ? { atendimento } : {}) }, 201);
  }

  // Caso 2: tutor novo.
  const t = lerTutor({ nome: c.tutor?.nome, whatsapp: c.tutor?.whatsapp });
  if (c.confirmar_duplicado !== true && t.tel.digitos) {
    const dup = await tutoresComMesmoWhatsapp(env, t.tel.digitos);
    if (dup.length) return respostaDuplicado(MSG_WHATS_DUPLICADO, 'tutor', dup);
  }
  const codTutor = await proximoCodigo(env, 'tutor');
  const codPet = await proximoCodigo(env, 'pet');
  // Tutor e pet são gravados juntos: ou entram os dois, ou nenhum.
  // Se vier "chegada", o atendimento entra no mesmo batch: tudo ou nada.
  const saidas = await env.DB.batch([
    comandoInserirTutor(env, { codigo: codTutor, ...t, observacoes: null, origem, usuarioId: u.id, agora }),
    comandoInserirPet(env, { codigo: codPet, tutorCodigo: codTutor, d: pet, origem, usuarioId: u.id, agora }),
    ...comandosChegada(env, { petCodigo: codPet, chegada, usuarioId: u.id, agora }),
  ]);
  const [rt, rp] = saidas;
  const tutorId = rt.meta.last_row_id;
  const petId = rp.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_tutor', entidade: 'tutores', entidadeId: tutorId, depois: { codigo: codTutor, nome: t.nome, whatsapp: t.tel.e164, via: 'cadastro_rapido' }, ip });
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_pet', entidade: 'pets', entidadeId: petId, depois: { codigo: codPet, tutor_id: tutorId, ...pet, via: 'cadastro_rapido' }, ip });
  const atendimento = await registrarEBuscarChegada(env, { chegada, petId, usuarioId: u.id, ip });
  return json({ tutor: tutorCompleto(await buscarTutor(env, tutorId)), pet: petCompleto(await lerPetPorId(env, petId)), ...(atendimento ? { atendimento } : {}) }, 201);
}

// ---------- juntar cadastros duplicados ----------
async function tutoresMesclar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const duplicadoId = Number(c.duplicado_id);
  if (!Number.isInteger(duplicadoId)) throw new ErroHttp(400, 'Escolha o cadastro a ser unido.');
  if (duplicadoId === id) throw new ErroHttp(400, 'Não é possível juntar um cadastro com ele mesmo.');
  const principal = await buscarTutor(env, id);
  const duplicado = await buscarTutor(env, duplicadoId);
  if (principal.mesclado_em_id || duplicado.mesclado_em_id) throw new ErroHttp(409, 'Um dos cadastros já foi unido a outro.');
  const pets = await petsDoTutor(env, duplicadoId, { soAtivos: false });
  const agora = agoraISO();
  await env.DB.batch([
    env.DB.prepare('UPDATE pets SET tutor_id = ?, atualizado_em = ? WHERE tutor_id = ?').bind(id, agora, duplicadoId),
    env.DB.prepare('UPDATE tutores SET mesclado_em_id = ?, atualizado_em = ? WHERE id = ? AND mesclado_em_id IS NULL').bind(id, agora, duplicadoId),
    prepararAcao(env, {
      usuarioId: u.id, acao: 'mesclar_tutores', entidade: 'tutores', entidadeId: id,
      antes: { duplicado_id: duplicadoId, duplicado_codigo: duplicado.codigo },
      depois: { principal_id: id, duplicado_id: duplicadoId, pets_movidos: pets.map((p) => p.id) },
      ip: ipDe(request),
    }),
  ]);
  const todos = await petsDoTutor(env, id, { soAtivos: false });
  return json({ tutor: tutorCompleto(await buscarTutor(env, id)), pets: todos.map(petCompleto), pets_movidos: pets.map((p) => p.id) });
}

// ---------- dados de teste (só administrador) ----------
// "TESTE" só vale como palavra inteira no começo do nome: "TESTE Maria" sim, "Testolin" não.
const ONDE_TUTOR_TESTE = `(nome_busca = 'teste' OR nome_busca LIKE 'teste %')`;
const PETS_TESTE = `SELECT id FROM pets WHERE ${ONDE_TUTOR_TESTE} OR tutor_id IN (SELECT id FROM tutores WHERE ${ONDE_TUTOR_TESTE})`;
const ATEND_TESTE = `SELECT id FROM atendimentos WHERE pet_id IN (${PETS_TESTE})`;
const RECEITAS_TESTE = `SELECT id FROM receitas WHERE pet_id IN (${PETS_TESTE}) OR atendimento_id IN (${ATEND_TESTE})`;
const PEDIDOS_TESTE = `SELECT id FROM pedidos WHERE atendimento_id IN (${ATEND_TESTE})`;
// Internações (e suas medicações e doses) e anotações do prontuário dos pets de teste.
const INTERNACOES_TESTE = `SELECT id FROM internacoes WHERE pet_id IN (${PETS_TESTE}) OR atendimento_id IN (${ATEND_TESTE})`;
const MEDICACOES_TESTE = `SELECT id FROM internacao_medicacoes WHERE internacao_id IN (${INTERNACOES_TESTE})`;
const PRONTUARIO_TESTE = `SELECT id FROM prontuario WHERE pet_id IN (${PETS_TESTE}) OR atendimento_id IN (${ATEND_TESTE}) OR internacao_id IN (${INTERNACOES_TESTE})`;

// Fotos que só os dados de teste usam (se algum cadastro real usa a foto, ela fica).
const FOTOS_TESTE = `
  SELECT foto_id AS id FROM (
    SELECT foto_id FROM atendimentos WHERE id IN (${ATEND_TESTE}) AND foto_id IS NOT NULL
    UNION
    SELECT foto_id FROM pets WHERE id IN (${PETS_TESTE}) AND foto_id IS NOT NULL)
  WHERE foto_id NOT IN (SELECT foto_id FROM atendimentos WHERE foto_id IS NOT NULL AND id NOT IN (${ATEND_TESTE}))
    AND foto_id NOT IN (SELECT foto_id FROM pets WHERE foto_id IS NOT NULL AND id NOT IN (${PETS_TESTE}))`;

// Inclui também as fotos de comprovante dos pagamentos de teste (que só esses pagamentos usam).
async function idsFotosTeste(env) {
  const { results } = await env.DB.prepare(FOTOS_TESTE).all();
  const { results: comprovantes } = await env.DB.prepare(
    `SELECT DISTINCT comprovante_foto_id AS id FROM pagamentos
      WHERE comprovante_foto_id IS NOT NULL AND pedido_id IN (${PEDIDOS_TESTE})
        AND comprovante_foto_id NOT IN (SELECT comprovante_foto_id FROM pagamentos WHERE comprovante_foto_id IS NOT NULL AND pedido_id NOT IN (${PEDIDOS_TESTE}))`
  ).all();
  return [...new Set([...results, ...comprovantes].map((r) => r.id))];
}

async function contarDadosTeste(env) {
  const n = async (sql) => (await env.DB.prepare(sql).first()).n;
  const internacoes = await n(`SELECT COUNT(*) AS n FROM (${INTERNACOES_TESTE})`);
  const anotacoes = await n(`SELECT COUNT(*) AS n FROM (${PRONTUARIO_TESTE})`);
  return {
    tutores: await n(`SELECT COUNT(*) AS n FROM tutores WHERE ${ONDE_TUTOR_TESTE}`),
    pets: await n(`SELECT COUNT(*) AS n FROM (${PETS_TESTE})`),
    atendimentos: await n(`SELECT COUNT(*) AS n FROM (${ATEND_TESTE})`),
    pedidos: await n(`SELECT COUNT(*) AS n FROM (${PEDIDOS_TESTE})`),
    receitas: await n(`SELECT COUNT(*) AS n FROM (${RECEITAS_TESTE})`),
    fotos: (await idsFotosTeste(env)).length,
    // Só aparecem quando existem (assim a contagem de antes continua igual).
    ...(internacoes ? { internacoes } : {}),
    ...(anotacoes ? { anotacoes } : {}),
  };
}

async function dadosTesteVer(request, env) {
  await exigirAdmin(request, env);
  return json(await contarDadosTeste(env));
}

async function dadosTesteApagar(request, env) {
  const adm = await exigirAdmin(request, env);
  const c = await lerJson(request);
  if (c.confirmacao !== 'APAGAR') throw new ErroHttp(400, 'Para apagar, digite APAGAR na confirmação.');
  // Se algum cadastro de verdade foi unido a um de teste, não dá para apagar sem perder dados reais.
  const preso = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tutores WHERE mesclado_em_id IN (SELECT id FROM tutores WHERE ${ONDE_TUTOR_TESTE})
        AND NOT ${ONDE_TUTOR_TESTE}`
  ).first();
  if (preso.n > 0) throw new ErroHttp(409, 'Há cadastros reais unidos a um cadastro de teste. Desfaça isso antes de apagar.');

  const contagem = await contarDadosTeste(env);
  const fotos = await idsFotosTeste(env); // guardadas antes, pois depois da exclusão não dá mais para saber
  // Ordem segura (de quem depende para quem é dependido), tudo de uma vez.
  await env.DB.batch([
    // Prontuário e internação apontam para pets e atendimentos: saem primeiro (anotações, doses, medicações, internações).
    env.DB.prepare(`DELETE FROM prontuario WHERE id IN (${PRONTUARIO_TESTE})`),
    env.DB.prepare(`DELETE FROM administracoes WHERE medicacao_id IN (${MEDICACOES_TESTE})`),
    env.DB.prepare(`DELETE FROM internacao_medicacoes WHERE id IN (${MEDICACOES_TESTE})`),
    env.DB.prepare(`DELETE FROM internacoes WHERE id IN (${INTERNACOES_TESTE})`),
    env.DB.prepare(`DELETE FROM pagamentos WHERE pedido_id IN (${PEDIDOS_TESTE})`),
    env.DB.prepare(`DELETE FROM itens_pedido WHERE pedido_id IN (${PEDIDOS_TESTE})`),
    env.DB.prepare(`DELETE FROM pedidos WHERE id IN (${PEDIDOS_TESTE})`),
    // Receitas apontam para pets e atendimentos (e umas para as outras, nas versões): soltamos
    // as ligações entre elas e só então apagamos.
    env.DB.prepare(`DELETE FROM receita_itens WHERE receita_id IN (${RECEITAS_TESTE})`),
    env.DB.prepare(`UPDATE receitas SET receita_anterior_id = NULL WHERE id IN (${RECEITAS_TESTE})`),
    env.DB.prepare(`DELETE FROM receitas WHERE id IN (${RECEITAS_TESTE})`),
    env.DB.prepare(`DELETE FROM atendimentos WHERE id IN (${ATEND_TESTE})`),
    env.DB.prepare(`DELETE FROM pets WHERE id IN (${PETS_TESTE})`),
    env.DB.prepare(`DELETE FROM tutores WHERE ${ONDE_TUTOR_TESTE}`),
    // Fotos por último (os atendimentos e pets que apontavam para elas já foram apagados).
    ...fotos.map((id) => env.DB.prepare('DELETE FROM fotos WHERE id = ?').bind(id)),
    prepararAcao(env, { usuarioId: adm.id, acao: 'apagar_dados_teste', entidade: 'tutores', depois: contagem, ip: ipDe(request) }),
  ]);
  return json({ apagados: contagem });
}

// Rotas deste arquivo (juntadas à tabela de rotas em index.js).
export const ROTAS_CADASTRO = [
  ['GET', '/api/busca', buscar],
  ['GET', '/api/chegada/sugestoes', chegadaSugestoes],
  ['POST', '/api/tutores', tutoresCriar],
  ['GET', '/api/tutores/:id', tutoresVer],
  ['PATCH', '/api/tutores/:id', tutoresAlterar],
  ['POST', '/api/tutores/:id/mesclar', tutoresMesclar],
  ['POST', '/api/pets', petsCriar],
  ['GET', '/api/pets/:id', petsVer],
  ['PATCH', '/api/pets/:id', petsAlterar],
  ['POST', '/api/cadastro-rapido', cadastroRapido],
  ['GET', '/api/admin/dados-teste', dadosTesteVer],
  ['POST', '/api/admin/apagar-dados-teste', dadosTesteApagar],
];
