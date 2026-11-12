// Testes da etapa 6: chave de integração, exportação para a planilha/backup e restauração.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { gerarChave, sha256Hex, MAX_PAGAMENTOS } from '../src/integracao.js';
import { converterBackup } from '../scripts/restaurar-backup.mjs';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const novoAmbiente = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') }, NOTIFICAR_TESTE: async () => ({ enviados: 0, falhas: 0 }) });
const JPEG = (n = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 1, 2, 3]);

async function chamar(env, metodo, caminho, { corpo, cookie, bytes, tipo, bearer, cabecalhos = {}, ip } = {}) {
  const h = { ...cabecalhos };
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (bearer) h.Authorization = 'Bearer ' + bearer;
  if (ip) h['CF-Connecting-IP'] = ip;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  if (bytes !== undefined) h['Content-Type'] = tipo;
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: bytes !== undefined ? bytes : corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  const ct = res.headers.get('content-type') || '';
  const dados = ct.includes('json') ? await res.json() : null;
  return { res, dados, status: res.status };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  for (const [login, papel, adm] of [['recep', 'recepcao', false], ['vet2', 'veterinario', false]]) {
    assert.equal((await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: login, login, senha: 'senha-forte-123', papel, admin: adm } })).status, 201);
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, admin, recepcao: await ent('recep'), vet2: await ent('vet2') };
}
const gerar = async (a) => (await chamar(a.env, 'POST', '/api/admin/integracao/chave', { cookie: a.admin, corpo: {} })).dados.token;

let n = 0;
// Conta paga: pet novo + atendimento + itens + pagamento. Devolve ids.
async function contaPaga(a, { valor = 10000, forma = 'pix', pet = null, foto = null } = {}) {
  n++;
  const c = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Tutor ' + n, whatsapp: `(71) 9${String(2000 + n).padStart(4, '0')}-0000` }, pet: { nome: pet || 'Pet' + n, especie: 'cao' } } });
  const at = (await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: c.dados.pet.id, peso_kg: 7.5, motivo: 'x' } })).dados.id;
  const ped = (await chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { cookie: a.admin, corpo: { itens: [{ descricao: 'Serviço ' + n, quantidade: valor % 2 === 0 ? 2 : 1, preco_unitario_centavos: valor % 2 === 0 ? valor / 2 : valor }] } })).dados.pedido.id;
  const pg = await chamar(a.env, 'POST', `/api/pedidos/${ped}/pagamentos`, { cookie: a.recepcao, corpo: { forma, valor_centavos: valor, ...(foto ? { comprovante_foto_id: foto } : {}), ...(forma === 'dinheiro' ? { recebido_dinheiro_centavos: valor } : {}) } });
  assert.equal(pg.status, 201, JSON.stringify(pg.dados));
  return { pet: c.dados.pet, tutor: c.dados.tutor, at, ped, pagamento: pg.dados.pagamento.id };
}
const enviarFoto = async (a, bytes = JPEG(), cookie = a.recepcao) => (await chamar(a.env, 'POST', '/api/fotos', { cookie, bytes, tipo: 'image/jpeg' })).dados.id;

// ---------- chave ----------
test('chave: gera 32 bytes base64url e só o SHA-256 fica no banco', async () => {
  const { token, hash } = await gerarChave();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 32 bytes em base64url
  assert.equal(hash, await sha256Hex(token));
  assert.notEqual((await gerarChave()).token, token);

  const a = await ambiente();
  const r = await chamar(a.env, 'POST', '/api/admin/integracao/chave', { cookie: a.admin, corpo: {} });
  assert.equal(r.status, 201);
  const salvo = a.env.DB.bruto.prepare(`SELECT valor FROM configuracoes WHERE chave = 'integracao_token_hash'`).get().valor;
  assert.equal(salvo, await sha256Hex(r.dados.token));
  assert.ok(!JSON.stringify(a.env.DB.bruto.prepare('SELECT * FROM configuracoes').all()).includes(r.dados.token));
  // O registro de ações existe, mas sem a chave nem o hash.
  const log = JSON.stringify(a.env.DB.bruto.prepare(`SELECT * FROM registro_acoes WHERE acao = 'gerar_chave_integracao'`).all());
  assert.match(log, /gerar_chave_integracao/);
  assert.ok(!log.includes(r.dados.token) && !log.includes(salvo));
  // O status não mostra a chave.
  const st = await chamar(a.env, 'GET', '/api/admin/integracao', { cookie: a.admin });
  assert.equal(st.dados.ativa, true);
  assert.ok(!JSON.stringify(st.dados).includes(r.dados.token));
});

test('chave: só administrador gera/desativa; gerar outra invalida a anterior; desativar invalida', async () => {
  const a = await ambiente();
  for (const cookie of [a.recepcao, a.vet2]) {
    assert.equal((await chamar(a.env, 'POST', '/api/admin/integracao/chave', { cookie, corpo: {} })).status, 403);
    assert.equal((await chamar(a.env, 'GET', '/api/admin/integracao', { cookie })).status, 403);
    assert.equal((await chamar(a.env, 'POST', '/api/admin/integracao/desativar', { cookie, corpo: {} })).status, 403);
  }
  assert.equal((await chamar(a.env, 'POST', '/api/admin/integracao/chave', { corpo: {} })).status, 401);
  const t1 = await gerar(a);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t1 })).status, 200);
  const t2 = await gerar(a);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t1 })).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t2 })).status, 200);
  assert.equal((await chamar(a.env, 'POST', '/api/admin/integracao/desativar', { cookie: a.admin, corpo: {} })).status, 200);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t2 })).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/admin/integracao', { cookie: a.admin })).dados.ativa, false);
  assert.ok(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao IN ('desativar_chave_integracao')`).get().n === 1);
});

test('401 sem chave, com chave errada, com cookie de admin (sem Bearer) e sem chave cadastrada', async () => {
  const a = await ambiente();
  // Ainda sem chave cadastrada.
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: 'x'.repeat(43) })).status, 401);
  const t = await gerar(a);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos')).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A') })).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { cabecalhos: { Authorization: 'Basic ' + t } })).status, 401);
  // Só o cookie de um administrador logado NÃO vale: as rotas não usam cookies.
  for (const caminho of ['pagamentos', 'backup', 'fotos-backup', 'foto/1']) {
    assert.equal((await chamar(a.env, 'GET', '/api/integracao/' + caminho, { cookie: a.admin })).status, 401, caminho);
  }
  // E a chave de integração não abre as outras rotas da API.
  assert.equal((await chamar(a.env, 'GET', '/api/usuarios', { bearer: t })).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/fotos/1', { bearer: t })).status, 401);
});

test('exceção do CSRF só para GET com Bearer: outros métodos em /api/integracao/* são recusados', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  // GET com Bearer, sem X-Requested-With: ok.
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t })).status, 200);
  // POST/PUT/DELETE/PATCH: 405, mesmo com a chave e com o cabeçalho.
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await chamar(a.env, m, '/api/integracao/pagamentos', { bearer: t, corpo: {} })).status, 405, m);
  }
  // As rotas que alteram dados continuam exigindo o cabeçalho anti-CSRF (cookie sozinho não basta).
  const r = await worker.fetch(new Request(ORIGEM + '/api/admin/integracao/chave', { method: 'POST', headers: { Cookie: a.admin, 'Content-Type': 'application/json' }, body: '{}' }), a.env);
  assert.equal(r.status, 403);
});

test('429: mais de 20 falhas em 15 minutos do mesmo IP bloqueiam, até com a chave certa', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  for (let i = 0; i < 20; i++) assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: 'errada-errada-errada-errada', ip: '203.0.113.9' })).status, 401);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t, ip: '203.0.113.9' })).status, 429);
  // Outro IP não é afetado; as falhas ficam em tentativas_login com o rótulo '(integracao)'.
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t, ip: '203.0.113.10' })).status, 200);
  assert.equal(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM tentativas_login WHERE login = '(integracao)'`).get().n, 20);
  // Falhas antigas (mais de 15 min) não contam.
  a.env.DB.bruto.prepare(`UPDATE tentativas_login SET em = ?`).run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t, ip: '203.0.113.9' })).status, 200);
});

// ---------- pagamentos ----------
test('pagamentos: campos, ordem, itens, recebido_por e comprovante', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  const foto = await enviarFoto(a);
  const c = await contaPaga(a, { valor: 15000, forma: 'cartao', pet: 'Thor', foto });
  const r = await chamar(a.env, 'GET', '/api/integracao/pagamentos', { bearer: t });
  assert.equal(r.status, 200);
  assert.equal(r.dados.pagamentos.length, 1);
  const p = r.dados.pagamentos[0];
  assert.equal(p.id, c.pagamento);
  assert.equal(p.forma, 'cartao');
  assert.equal(p.valor_centavos, 15000);
  assert.equal(p.estornado, false);
  assert.equal(p.estornado_em, null);
  assert.equal(p.recebido_por, 'recep');
  assert.equal(p.comprovante_foto_id, foto);
  assert.match(p.recebido_em, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(p.pedido.itens, [{ descricao: 'Serviço ' + n, quantidade: 2, preco_unitario_centavos: 7500 }]);
  assert.equal(p.pedido.total_centavos, 15000);
  assert.equal(p.pedido.status, 'pago');
  assert.equal(p.pet.nome, 'Thor');
  assert.match(p.pet.codigo, /^P-\d{6}$/);
  assert.match(p.tutor.codigo, /^T-\d{6}$/);
  assert.equal(p.atendimento.peso_kg, 7.5);
  assert.ok(p.atendimento.chegada_em);
  assert.ok('veterinario' in p.atendimento);
  assert.ok(r.dados.proximo);
  assert.equal(r.dados.mais, false);
  // Nada de dados sensíveis (preço de exames etc. não existe aqui; nem senha).
  assert.ok(!JSON.stringify(r.dados).includes('hash'));
});

test('pagamentos: "desde" filtra e o estorno faz o pagamento antigo voltar', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  const c1 = await contaPaga(a, { valor: 10000 });
  const c2 = await contaPaga(a, { valor: 20000 });
  const bruto = a.env.DB.bruto;
  bruto.prepare('UPDATE pagamentos SET recebido_em = ? WHERE id = ?').run('2026-11-01T12:00:00.000Z', c1.pagamento);
  bruto.prepare('UPDATE pagamentos SET recebido_em = ? WHERE id = ?').run('2026-11-02T12:00:00.000Z', c2.pagamento);
  const ids = async (desde) => (await chamar(a.env, 'GET', '/api/integracao/pagamentos?desde=' + encodeURIComponent(desde), { bearer: t })).dados.pagamentos.map((p) => p.id);
  assert.deepEqual(await ids('2026-10-01T00:00:00.000Z'), [c1.pagamento, c2.pagamento]);
  assert.deepEqual(await ids('2026-11-01T12:00:00.000Z'), [c1.pagamento, c2.pagamento]); // "desde" é inclusivo
  assert.deepEqual(await ids('2026-11-01T12:00:00.001Z'), [c2.pagamento]);
  assert.deepEqual(await ids('2026-11-03T00:00:00.000Z'), []);
  // Estorno do pagamento 1 (recebido em 01/11): reaparece, com o motivo.
  const est = await chamar(a.env, 'POST', `/api/pagamentos/${c1.pagamento}/estornar`, { cookie: a.admin, corpo: { motivo: 'Cobrança em duplicidade' } });
  assert.equal(est.status, 200);
  const dep = await chamar(a.env, 'GET', '/api/integracao/pagamentos?desde=' + encodeURIComponent('2026-11-03T00:00:00.000Z'), { bearer: t });
  assert.equal(dep.dados.pagamentos.length, 1);
  const p = dep.dados.pagamentos[0];
  assert.equal(p.id, c1.pagamento);
  assert.equal(p.estornado, true);
  assert.equal(p.estorno_motivo, 'Cobrança em duplicidade');
  assert.ok(p.estornado_em);
  assert.equal(p.pedido.status, 'aguardando_pagamento');
  // "desde" inválido -> 400.
  for (const ruim of ['ontem', '2026-11-01', "2026-11-01T00:00:00Z'; DROP", '2026-11-01T00:00:00.000Z,abc']) {
    assert.equal((await chamar(a.env, 'GET', '/api/integracao/pagamentos?desde=' + encodeURIComponent(ruim), { bearer: t })).status, 400, ruim);
  }
});

test('pagamentos: paginação por cursor, sem repetir nem perder, inclusive com o mesmo horário', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  const feitos = [];
  for (let i = 0; i < 5; i++) feitos.push((await contaPaga(a, { valor: 1000 + i * 100 })).pagamento);
  // Três pagamentos com exatamente o mesmo horário.
  a.env.DB.bruto.prepare(`UPDATE pagamentos SET recebido_em = '2026-11-05T10:00:00.000Z'`).run();
  const vistos = [];
  let cursor = '';
  let paginas = 0;
  for (;;) {
    const r = await chamar(a.env, 'GET', `/api/integracao/pagamentos?limite=2&desde=${encodeURIComponent(cursor)}`, { bearer: t });
    assert.ok(r.dados.pagamentos.length <= 2);
    vistos.push(...r.dados.pagamentos.map((p) => p.id));
    paginas++;
    if (r.dados.proximo) cursor = r.dados.proximo;
    if (!r.dados.mais) break;
    assert.ok(paginas < 10);
  }
  assert.equal(paginas, 3);
  assert.deepEqual(vistos, feitos);
  // Depois do último cursor não vem nada novo; um pagamento novo aparece.
  assert.deepEqual((await chamar(a.env, 'GET', `/api/integracao/pagamentos?desde=${encodeURIComponent(cursor)}`, { bearer: t })).dados.pagamentos, []);
  const novo = await contaPaga(a);
  const r = await chamar(a.env, 'GET', `/api/integracao/pagamentos?desde=${encodeURIComponent(cursor)}`, { bearer: t });
  assert.deepEqual(r.dados.pagamentos.map((p) => p.id), [novo.pagamento]);
  assert.equal(MAX_PAGAMENTOS, 500);
});

// ---------- foto ----------
test('foto/:id: só comprovantes de pagamento; fotos clínicas dão 404', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  const comprovante = await enviarFoto(a, JPEG(1));
  const clinica = await enviarFoto(a, JPEG(2));
  const orfa = await enviarFoto(a, JPEG(3));
  await contaPaga(a, { forma: 'pix', foto: comprovante });
  // A foto clínica está ligada a um pet.
  const pet = (await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'X', whatsapp: '(71) 98888-7777' }, pet: { nome: 'Y', especie: 'gato' } } })).dados.pet;
  a.env.DB.bruto.prepare('UPDATE pets SET foto_id = ? WHERE id = ?').run(clinica, pet.id);
  const ok = await chamar(a.env, 'GET', `/api/integracao/foto/${comprovante}`, { bearer: t });
  assert.equal(ok.status, 200);
  assert.equal(ok.res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await ok.res.arrayBuffer())], [...JPEG(1)]);
  assert.equal((await chamar(a.env, 'GET', `/api/integracao/foto/${clinica}`, { bearer: t })).status, 404);
  assert.equal((await chamar(a.env, 'GET', `/api/integracao/foto/${orfa}`, { bearer: t })).status, 404);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/foto/99999', { bearer: t })).status, 404);
  assert.equal((await chamar(a.env, 'GET', `/api/integracao/foto/${comprovante}`)).status, 401);
});

// ---------- fotos-backup ----------
test('fotos-backup: até 20 por vez, em ordem, com cursor desde_id', async () => {
  const a = await ambiente();
  const t = await gerar(a);
  const ids = [];
  for (let i = 0; i < 23; i++) ids.push(await enviarFoto(a, JPEG(i)));
  const r1 = await chamar(a.env, 'GET', '/api/integracao/fotos-backup?desde_id=0', { bearer: t });
  assert.equal(r1.dados.fotos.length, 20);
  assert.equal(r1.dados.mais, true);
  assert.equal(r1.dados.proximo, ids[19]);
  assert.equal(r1.dados.fotos[0].tipo, 'image/jpeg');
  assert.deepEqual([...Buffer.from(r1.dados.fotos[3].base64, 'base64')], [...JPEG(3)]);
  const r2 = await chamar(a.env, 'GET', `/api/integracao/fotos-backup?desde_id=${r1.dados.proximo}`, { bearer: t });
  assert.deepEqual(r2.dados.fotos.map((f) => f.id), ids.slice(20));
  assert.equal(r2.dados.mais, false);
  const r3 = await chamar(a.env, 'GET', `/api/integracao/fotos-backup?desde_id=${r2.dados.proximo}`, { bearer: t });
  assert.deepEqual(r3.dados.fotos, []);
  assert.equal(r3.dados.proximo, ids[22]);
  assert.equal((await chamar(a.env, 'GET', '/api/integracao/fotos-backup?desde_id=-1', { bearer: t })).status, 400);
});

// ---------- backup + restauração ----------
// Monta um banco com dados em todas as tabelas.
async function bancoCompleto() {
  const a = await ambiente();
  const t = await gerar(a);
  const bruto = a.env.DB.bruto;
  const foto = await enviarFoto(a, JPEG(9));
  const c1 = await contaPaga(a, { valor: 12345, forma: 'pix', pet: "D'Artagnan", foto });
  const c2 = await contaPaga(a, { valor: 5000, forma: 'dinheiro' });
  await chamar(a.env, 'POST', `/api/pagamentos/${c2.pagamento}/estornar`, { cookie: a.admin, corpo: { motivo: "Erro de digitação; o cliente disse 'não'" } });
  // Receitas (com itens); a segunda corrige a primeira. Tutor mesclado em outro.
  const r1 = (await chamar(a.env, 'POST', '/api/receitas', { cookie: a.admin, corpo: { pet_id: c1.pet.id, atendimento_id: c1.at, texto: 'Dipirona 500 mg' } })).dados.receita.id;
  await chamar(a.env, 'PUT', `/api/receitas/${r1}/itens`, { cookie: a.admin, corpo: { itens: [{ descricao: 'Dipirona', temos: 1, quantidade: 2, valor_unitario_centavos: 1500 }] } });
  const r2 = (await chamar(a.env, 'POST', '/api/receitas', { cookie: a.admin, corpo: { pet_id: c1.pet.id, atendimento_id: c1.at, texto: 'Dipirona 250 mg' } })).dados.receita.id;
  bruto.prepare('UPDATE receitas SET receita_anterior_id = ? WHERE id = ?').run(r1, r2);
  bruto.prepare('UPDATE tutores SET mesclado_em_id = ? WHERE id = ?').run(c2.tutor.id, c1.tutor.id); // aponta para um id MAIOR
  bruto.prepare(`INSERT INTO sugestoes_receita (texto, texto_busca, vezes, ultimo_uso, tipo) VALUES ('Dipirona 500 mg', 'dipirona 500 mg', 3, '2026-11-01T00:00:00.000Z', 'linha')`).run();
  await chamar(a.env, 'PATCH', '/api/configuracoes/clinica', { cookie: a.admin, corpo: { clinica_nome: 'Vetclin Teste', clinica_cidade: 'Salvador' } });
  // Tabelas que NÃO podem sair no backup.
  bruto.prepare(`INSERT INTO push_chaves (id, publica, privada_jwk, contato, criado_em) VALUES (1, 'PUBLICA-SECRETA-X', 'PRIVADA-JWK-SECRETA-Y', 'a@b.c', '2026-01-01T00:00:00.000Z')`).run();
  bruto.prepare(`INSERT INTO inscricoes_push (usuario_id, endpoint, p256dh, auth, criado_em) VALUES (1, 'https://push.exemplo/ENDPOINT-SECRETO', 'P256-SECRETO', 'AUTH-SECRETO', '2026-01-01T00:00:00.000Z')`).run();
  return { a, t, c1, c2, foto };
}

const SEGREDOS = ['senha_hash', 'pbkdf2$', 'PRIVADA-JWK-SECRETA-Y', 'PUBLICA-SECRETA-X', 'ENDPOINT-SECRETO', 'P256-SECRETO', 'AUTH-SECRETO', 'integracao_token_hash'];

test('backup: tem todas as tabelas, exceto sessões/tentativas/push, e nenhum segredo', async () => {
  const { a, t } = await bancoCompleto();
  const r = await chamar(a.env, 'GET', '/api/integracao/backup', { bearer: t });
  assert.equal(r.status, 200);
  const b = r.dados;
  assert.equal(b.versao, 1);
  assert.ok(Date.parse(b.gerado_em));
  assert.ok(Array.isArray(b.migracoes));
  for (const proibida of ['sessoes', 'tentativas_login', 'push_chaves', 'inscricoes_push', 'sqlite_sequence', 'd1_migrations']) assert.ok(!(proibida in b.tabelas), proibida);
  const esperadas = ['usuarios', 'tutores', 'pets', 'atendimentos', 'catalogo', 'pedidos', 'itens_pedido', 'pagamentos', 'registro_acoes', 'contadores', 'fotos', 'receitas', 'sugestoes_receita', 'configuracoes', 'receita_itens'];
  assert.deepEqual(Object.keys(b.tabelas).sort(), esperadas.sort());
  for (const nome of esperadas) assert.ok(b.tabelas[nome].length > 0 || ['x'].includes(nome), `${nome} vazia`);
  // Senhas, chaves e token: nada no JSON.
  const texto = JSON.stringify(b);
  for (const s of SEGREDOS) assert.ok(!texto.includes(s), 'vazou: ' + s);
  assert.ok(!texto.includes(t));
  for (const u of b.tabelas.usuarios) assert.ok(!('senha_hash' in u));
  // Fotos: só metadados, sem os bytes.
  assert.ok(b.tabelas.fotos.length >= 1);
  for (const f of b.tabelas.fotos) { assert.ok(!('dados' in f)); assert.ok(f.tipo && f.id); }
  // Configurações vêm (menos o token).
  const chaves = b.tabelas.configuracoes.map((c) => c.chave);
  assert.ok(chaves.includes('clinica_nome'));
  assert.ok(!chaves.includes('integracao_token_hash'));
  // O registro de ações não tem a chave (nem o hash).
  assert.ok(!JSON.stringify(b.tabelas.registro_acoes).includes(t));
});

test('restauração: backup -> SQL -> banco novo com as mesmas linhas e campos-chave', async () => {
  const { a, t, c1 } = await bancoCompleto();
  const backup = (await chamar(a.env, 'GET', '/api/integracao/backup', { bearer: t })).dados;
  const { sql, senhas } = await converterBackup(JSON.parse(JSON.stringify(backup)));

  // Senhas temporárias: uma por usuário, diferentes, e o SQL não contém a senha em si.
  assert.equal(senhas.length, backup.tabelas.usuarios.length);
  assert.equal(new Set(senhas.map((s) => s.senha)).size, senhas.length);
  for (const s of senhas) { assert.ok(s.senha.length >= 12); assert.ok(!sql.includes(s.senha)); }
  assert.ok(!sql.includes('senha-forte-123'));

  // Aplica em um banco NOVO (só com as migrações), com chaves estrangeiras ligadas, como no D1.
  const novo = novoAmbiente();
  novo.DB.bruto.exec('BEGIN');
  novo.DB.bruto.exec(sql);
  novo.DB.bruto.exec('COMMIT');
  assert.deepEqual(novo.DB.bruto.prepare('PRAGMA foreign_key_check').all(), []);

  // Cada tabela exportada: mesma contagem e mesmos valores (menos o que não é exportado).
  for (const [nome, linhas] of Object.entries(backup.tabelas)) {
    let colunas = '*';
    if (nome === 'fotos') colunas = 'id, tipo, tamanho, largura, altura, criado_por, criado_em';
    let restauradas = novo.DB.bruto.prepare(`SELECT ${colunas} FROM "${nome}" ORDER BY 1`).all();
    if (nome === 'usuarios') restauradas = restauradas.map(({ senha_hash, ...r }) => r);
    if (nome === 'configuracoes') restauradas = restauradas.filter((c) => c.chave !== 'integracao_token_hash');
    assert.equal(restauradas.length, linhas.length, `contagem de ${nome}`);
    assert.deepEqual(JSON.parse(JSON.stringify(restauradas)), linhas, `conteúdo de ${nome}`);
  }
  // Campos-chave conferidos "à mão".
  const pg = novo.DB.bruto.prepare('SELECT * FROM pagamentos WHERE id = ?').get(c1.pagamento);
  assert.equal(pg.valor_centavos, 12345);
  assert.equal(novo.DB.bruto.prepare(`SELECT nome FROM pets WHERE id = ?`).get(c1.pet.id).nome, "D'Artagnan");
  assert.match(novo.DB.bruto.prepare(`SELECT motivo FROM (SELECT estorno_motivo AS motivo FROM pagamentos WHERE estornado = 1)`).get().motivo, /Erro de digitação; o cliente disse 'não'/);
  assert.equal(novo.DB.bruto.prepare('SELECT COUNT(*) AS n FROM receita_itens').get().n, 1);
  assert.equal(novo.DB.bruto.prepare('SELECT valor FROM contadores WHERE nome = ?').get('pet').valor, backup.tabelas.contadores.find((x) => x.nome === 'pet').valor);
  // Tabelas excluídas ficam vazias no banco novo; o token não volta.
  assert.equal(novo.DB.bruto.prepare('SELECT COUNT(*) AS n FROM push_chaves').get().n, 0);
  assert.equal(novo.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM configuracoes WHERE chave = 'integracao_token_hash'`).get().n, 0);

  // As senhas temporárias funcionam; a antiga não.
  const adm = senhas.find((s) => s.login === 'admin');
  assert.equal((await chamar(novo, 'POST', '/api/entrar', { corpo: { login: 'admin', senha: 'senha-forte-123' } })).status, 401);
  const ent = await chamar(novo, 'POST', '/api/entrar', { corpo: { login: 'admin', senha: adm.senha } });
  assert.equal(ent.status, 200);
  assert.equal(ent.dados.admin, true);
  // E a chave antiga não vale no sistema restaurado.
  assert.equal((await chamar(novo, 'GET', '/api/integracao/pagamentos', { bearer: t })).status, 401);
  // Novos cadastros continuam a numeração sem repetir códigos (contadores restaurados).
  const cad = await chamar(novo, 'POST', '/api/cadastro-rapido', { cookie: cookieDe(ent.res), corpo: { tutor: { nome: 'Novo', whatsapp: '(71) 97777-6666' }, pet: { nome: 'Novo', especie: 'cao' } } });
  assert.equal(cad.status, 201);
  assert.ok(!backup.tabelas.pets.some((p) => p.codigo === cad.dados.pet.codigo));
});

test('restauração: arquivo que não é backup dá erro claro', async () => {
  await assert.rejects(() => converterBackup({ foo: 1 }), /cópia de segurança/);
});
