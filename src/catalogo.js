// Catálogo de serviços e produtos com preços (em centavos).
// Quem mantém: recepção, veterinário e suporte (qualquer pessoa da equipe com login).
// IMPORTANTE (regra futura): preços da categoria "exame" nunca saem da API da equipe logada.
// Por isso NÃO existe nenhuma rota pública de catálogo, e não deve existir.
import { exigirLogin } from './auth.js';
import { normalizarBusca } from './cadastro.js';
import { ErroHttp, agoraISO, ipDe, json, lerJson, prepararAcao, registrarAcao, texto } from './util.js';

export const CATEGORIAS = ['consulta', 'exame', 'vacina', 'procedimento', 'produto', 'outro'];
const MAX_VALOR = 10_000_000;
const ORDEM_CATEGORIA = `CASE categoria WHEN 'consulta' THEN 0 WHEN 'exame' THEN 1 WHEN 'vacina' THEN 2 WHEN 'procedimento' THEN 3 WHEN 'produto' THEN 4 ELSE 5 END`;

const publico = (c) => ({ id: c.id, nome: c.nome, categoria: c.categoria, preco_centavos: c.preco_centavos, ativo: c.ativo === 1 });

function lerCategoria(v) {
  if (!CATEGORIAS.includes(v)) throw new ErroHttp(400, 'Escolha a categoria do item.');
  return v;
}
function lerPreco(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_VALOR) throw new ErroHttp(400, 'Informe o preço (de R$ 0,00 a R$ 100.000,00).');
  return v;
}

// As duas primeiras linhas de "consulta" são as usadas pela regra do horário (até o corte / depois do corte).
async function idsDaConsulta(env) {
  const { results } = await env.DB.prepare(`SELECT id FROM catalogo WHERE categoria = 'consulta' ORDER BY id LIMIT 2`).all();
  return results.map((r) => r.id);
}

async function catalogoListar(request, env) {
  await exigirLogin(request, env);
  const url = new URL(request.url);
  const categoria = url.searchParams.get('categoria') || '';
  if (categoria && !CATEGORIAS.includes(categoria)) throw new ErroHttp(400, 'Categoria inválida.');
  const comInativos = ['1', 'true'].includes(url.searchParams.get('inativos') || '');
  const q = normalizarBusca(url.searchParams.get('q'));
  const onde = [];
  const args = [];
  if (categoria) { onde.push('categoria = ?'); args.push(categoria); }
  if (!comInativos) onde.push('ativo = 1');
  const { results } = await env.DB.prepare(
    `SELECT * FROM catalogo ${onde.length ? 'WHERE ' + onde.join(' AND ') : ''} ORDER BY ${ORDEM_CATEGORIA}, CASE WHEN categoria = 'consulta' THEN id ELSE 0 END, nome COLLATE NOCASE, id LIMIT 1000`
  ).bind(...args).all();
  // A busca ignora acentos e maiúsculas (o catálogo é pequeno, então filtramos aqui mesmo).
  const lista = q ? results.filter((c) => q.split(' ').every((parte) => normalizarBusca(c.nome).includes(parte))) : results;
  return json({ itens: lista.map(publico) });
}

async function duplicado(env, nome, categoria, exceto = 0) {
  const { results } = await env.DB.prepare('SELECT id, nome FROM catalogo WHERE categoria = ? AND ativo = 1 AND id <> ?').bind(categoria, exceto).all();
  return results.some((c) => normalizarBusca(c.nome) === normalizarBusca(nome));
}

async function catalogoCriar(request, env) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const nome = texto(c.nome, 'nome', { max: 120 });
  const categoria = lerCategoria(c.categoria);
  const preco = lerPreco(c.preco_centavos);
  const ativo = c.ativo === undefined ? 1 : (c.ativo ? 1 : 0);
  if (ativo && await duplicado(env, nome, categoria)) throw new ErroHttp(409, 'Já existe um item com esse nome nesta categoria.');
  const agora = agoraISO();
  const r = await env.DB.prepare('INSERT INTO catalogo (nome, categoria, preco_centavos, ativo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nome, categoria, preco, ativo, agora, agora).run();
  const id = r.meta.last_row_id;
  await registrarAcao(env, { usuarioId: u.id, acao: 'criar_catalogo', entidade: 'catalogo', entidadeId: id, depois: { nome, categoria, preco_centavos: preco, ativo: !!ativo }, ip: ipDe(request) });
  return json(publico(await env.DB.prepare('SELECT * FROM catalogo WHERE id = ?').bind(id).first()), 201);
}

async function catalogoAlterar(request, env, id) {
  const u = await exigirLogin(request, env);
  const c = await lerJson(request);
  const antes = await env.DB.prepare('SELECT * FROM catalogo WHERE id = ?').bind(id).first();
  if (!antes) throw new ErroHttp(404, 'Item não encontrado.');
  const novo = { ...antes };
  if (c.nome !== undefined) novo.nome = texto(c.nome, 'nome', { max: 120 });
  if (c.categoria !== undefined) novo.categoria = lerCategoria(c.categoria);
  if (c.preco_centavos !== undefined) novo.preco_centavos = lerPreco(c.preco_centavos);
  if (c.ativo !== undefined) novo.ativo = c.ativo ? 1 : 0;

  // Os dois preços de consulta são usados pela regra do horário: podem mudar de nome e de preço, mas não podem sumir.
  if ((await idsDaConsulta(env)).includes(id) && (novo.categoria !== 'consulta' || novo.ativo !== 1)) {
    throw new ErroHttp(409, 'Os dois preços de consulta não podem ser desativados nem mudar de categoria. Altere apenas o preço.');
  }
  if (novo.ativo === 1 && (novo.nome !== antes.nome || novo.categoria !== antes.categoria || antes.ativo !== 1) && await duplicado(env, novo.nome, novo.categoria, id)) {
    throw new ErroHttp(409, 'Já existe um item com esse nome nesta categoria.');
  }
  const resumo = (x) => ({ nome: x.nome, categoria: x.categoria, preco_centavos: x.preco_centavos, ativo: x.ativo === 1 });
  await env.DB.batch([
    env.DB.prepare('UPDATE catalogo SET nome = ?, categoria = ?, preco_centavos = ?, ativo = ?, atualizado_em = ? WHERE id = ?')
      .bind(novo.nome, novo.categoria, novo.preco_centavos, novo.ativo, agoraISO(), id),
    prepararAcao(env, { usuarioId: u.id, acao: 'alterar_catalogo', entidade: 'catalogo', entidadeId: id, antes: resumo(antes), depois: resumo(novo), ip: ipDe(request) }),
  ]);
  return json(publico(await env.DB.prepare('SELECT * FROM catalogo WHERE id = ?').bind(id).first()));
}

export const ROTAS_CATALOGO = [
  ['GET', '/api/catalogo', catalogoListar],
  ['POST', '/api/catalogo', catalogoCriar],
  ['PATCH', '/api/catalogo/:id', catalogoAlterar],
];
