// Testes do passo 5: pedido (conta) e pagamento, catálogo e caixa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { depoisDoCorte, horaBahia, itemConsulta, reais } from '../src/pedidos.js';
import { criarBancoLocal } from './d1-local.js';

const ORIGEM = 'https://vetclin.exemplo.test';
const novoAmbiente = () => ({ DB: criarBancoLocal(), CHAVE_CONFIGURACAO: 'teste-chave', FUSO_HORARIO: 'America/Bahia', ASSETS: { fetch: async () => new Response('estatico') }, NOTIFICAR_TESTE: async () => ({ enviados: 0, falhas: 0 }) });

async function chamar(env, metodo, caminho, { corpo, cookie, bytes, tipo } = {}) {
  const h = {};
  if (metodo !== 'GET') h['X-Requested-With'] = 'vetclin';
  if (cookie) h.Cookie = cookie;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  if (bytes !== undefined) h['Content-Type'] = tipo;
  const res = await worker.fetch(new Request(ORIGEM + caminho, { method: metodo, headers: h, body: bytes !== undefined ? bytes : corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
  return { res, dados: await res.json().catch(() => null), status: res.status };
}
const cookieDe = (res) => res.headers.get('Set-Cookie').split(';')[0];

// admin (veterinário) + recepção, suporte, outro veterinário (não admin) e uma recepcionista admin.
async function ambiente() {
  const env = novoAmbiente();
  const r = await chamar(env, 'POST', '/api/configuracao-inicial', { corpo: { chave: 'teste-chave', nome: 'Dra. Teste', login: 'admin', senha: 'senha-forte-123' } });
  const admin = cookieDe(r.res);
  for (const [login, papel, adm] of [['recep', 'recepcao', false], ['sup', 'suporte', false], ['vet2', 'veterinario', false], ['recadm', 'recepcao', true]]) {
    assert.equal((await chamar(env, 'POST', '/api/usuarios', { cookie: admin, corpo: { nome: login, login, senha: 'senha-forte-123', papel, admin: adm } })).status, 201);
  }
  const ent = async (login) => cookieDe((await chamar(env, 'POST', '/api/entrar', { corpo: { login, senha: 'senha-forte-123' } })).res);
  return { env, vet: admin, recepcao: await ent('recep'), suporte: await ent('sup'), vet2: await ent('vet2'), recAdmin: await ent('recadm') };
}
async function novoPet(a, nome = 'Thor', tutor = 'Maria', fone = '(71) 99999-8888') {
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: tutor, whatsapp: fone }, pet: { nome, especie: 'cao' } } });
  return r.dados.pet;
}
async function atendimento(a, pet) {
  const r = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 5, motivo: 'x' } });
  assert.equal(r.status, 201);
  return r.dados.id;
}
const bruto = (a) => a.env.DB.bruto;
const acoes = (a, acao) => bruto(a).prepare('SELECT * FROM registro_acoes WHERE acao = ?').all(acao);
const iniciarEm = (a, id, iso) => bruto(a).prepare(`UPDATE atendimentos SET status = 'em_atendimento', iniciado_em = ?, veterinario_id = 1 WHERE id = ?`).run(iso, id);
const verPedido = (a, at, cookie = a.vet) => chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie });
const salvar = (a, at, itens, cookie = a.vet) => chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { cookie, corpo: { itens } });
const livre = (descricao, preco, quantidade = 1) => ({ descricao, quantidade, preco_unitario_centavos: preco });
const pagar = (a, pedido, corpo, cookie = a.recepcao) => chamar(a.env, 'POST', `/api/pedidos/${pedido}/pagamentos`, { cookie, corpo });
// Cria um pedido de R$ 300 (atendimento + conta salva).
let contador = 0;
async function contaDe(a, valor = 30000) {
  contador++;
  const at = await atendimento(a, await novoPet(a, 'Pet' + contador, 'Tutor' + contador, `(71) 9${String(1000 + contador).padStart(4, '0')}-0000`));
  const r = await salvar(a, at, [livre('Serviço', valor)]);
  assert.equal(r.status, 201);
  return { at, id: r.dados.pedido.id };
}
const receitaComItens = async (a, pet, atendimentoId, itens) => {
  const r = await chamar(a.env, 'POST', '/api/receitas', { cookie: a.vet, corpo: { pet_id: pet.id, atendimento_id: atendimentoId, texto: 'Dipirona' } });
  assert.equal(r.status, 201);
  const id = r.dados.receita.id;
  const p = await chamar(a.env, 'PUT', `/api/receitas/${id}/itens`, { cookie: a.vet, corpo: { itens } });
  assert.equal(p.status, 200);
  return id;
};
const it = (descricao, temos, quantidade, valor) => ({ descricao, temos, quantidade, valor_unitario_centavos: valor });

// ---------- regra da consulta ----------
test('consulta: 17:59 em Bahia = R$ 100 e 18:00 = R$ 200 (corte padrão)', () => {
  assert.equal(depoisDoCorte('2026-11-12T20:59:59.000Z'), false); // 17:59:59 em Bahia
  assert.equal(depoisDoCorte('2026-11-12T21:00:00.000Z'), true); // 18:00 em Bahia
  assert.equal(depoisDoCorte('2026-11-12T03:00:00.000Z'), false); // 00:00 em Bahia
  assert.equal(depoisDoCorte('2026-11-13T02:59:00.000Z'), true); // 23:59 em Bahia
  assert.equal(horaBahia('2026-11-12T21:20:00.000Z'), '18:20');
});

test('consulta: os preços vêm do catálogo, pelo horário em que o atendimento COMEÇOU', async () => {
  const a = await ambiente();
  const at = await atendimento(a, await novoPet(a));
  iniciarEm(a, at, '2026-11-12T20:59:00.000Z');
  let p = (await verPedido(a, at)).dados;
  assert.deepEqual([p.pedido.itens[0].descricao, p.pedido.itens[0].preco_unitario_centavos, p.pedido.total_centavos], ['Consulta (até 18h)', 10000, 10000]);
  iniciarEm(a, at, '2026-11-12T21:00:00.000Z');
  p = (await verPedido(a, at)).dados;
  assert.deepEqual([p.pedido.itens[0].descricao, p.pedido.itens[0].preco_unitario_centavos], ['Consulta (após 18h)', 20000]);
  assert.match(p.automaticos.consulta.explicacao, /iniciado às 18:00 → valor após as 18h/);
  // mudar o preço no catálogo muda a conta (nada fixo no código)
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/2', { cookie: a.recepcao, corpo: { preco_centavos: 25000 } })).status, 200);
  assert.equal((await verPedido(a, at)).dados.pedido.itens[0].preco_unitario_centavos, 25000);
});

test('consulta: sem início usa a hora de agora; o corte é configurável', async () => {
  const a = await ambiente();
  const agoraCedo = new Date('2026-11-12T13:00:00.000Z'); // 10:00 em Bahia
  const agoraTarde = new Date('2026-11-12T22:30:00.000Z'); // 19:30 em Bahia
  const cedo = await itemConsulta(a.env, null, agoraCedo);
  const tarde = await itemConsulta(a.env, null, agoraTarde);
  assert.deepEqual([cedo.preco_unitario_centavos, cedo.iniciado, cedo.depois_do_corte], [10000, false, false]);
  assert.deepEqual([tarde.preco_unitario_centavos, tarde.depois_do_corte], [20000, true]);
  assert.match(tarde.explicacao, /ainda não iniciado/);
  // corte às 17:30
  bruto(a).prepare(`INSERT INTO configuracoes (chave, valor) VALUES ('consulta_hora_corte', '17:30')`).run();
  const t = await itemConsulta(a.env, '2026-11-12T20:30:00.000Z'); // 17:30 em Bahia
  assert.deepEqual([t.preco_unitario_centavos, t.descricao], [20000, 'Consulta (após 17h30)']);
  assert.equal((await itemConsulta(a.env, '2026-11-12T20:29:00.000Z')).preco_unitario_centavos, 10000);
  // valor inválido volta ao padrão 18:00
  bruto(a).prepare(`UPDATE configuracoes SET valor = 'abc' WHERE chave = 'consulta_hora_corte'`).run();
  assert.equal((await itemConsulta(a.env, '2026-11-12T20:30:00.000Z')).preco_unitario_centavos, 10000);
});

// ---------- itens automáticos da receita ----------
test('rascunho: consulta + produtos "temos" com valor; sem valor vira aviso; só a versão mais nova', async () => {
  const a = await ambiente();
  const pet = await novoPet(a);
  const at = await atendimento(a, pet);
  iniciarEm(a, at, '2026-11-12T13:00:00.000Z');
  const r1 = await receitaComItens(a, pet, at, [it('Dipirona', true, 2, 4500), it('Vitamina', false, 1, 9900), it('Probiótico', true, 1, null)]);
  let p = (await verPedido(a, at)).dados;
  assert.equal(p.pedido.rascunho, true);
  assert.equal(p.pedido.id, null);
  assert.deepEqual(p.pedido.itens.map((i) => [i.descricao, i.quantidade, i.preco_unitario_centavos, i.origem]), [['Consulta (até 18h)', 1, 10000, 'consulta'], ['Dipirona', 2, 4500, 'receita']]);
  assert.equal(p.pedido.total_centavos, 19000);
  assert.deepEqual(p.automaticos.sem_valor.map((x) => x.descricao), ['Probiótico']);
  // GET não grava nada
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM pedidos').get().n, 0);
  // nova versão da receita (liberada e corrigida): só a nova conta
  await chamar(a.env, 'POST', `/api/receitas/${r1}/liberar`, { cookie: a.vet });
  const nova = await chamar(a.env, 'POST', `/api/receitas/${r1}/nova-versao`, { cookie: a.vet, corpo: {} });
  assert.equal(nova.status, 201);
  {
    const id2 = nova.dados.receita.id;
    await chamar(a.env, 'PUT', `/api/receitas/${id2}/itens`, { cookie: a.vet, corpo: { itens: [it('Dipirona', true, 1, 5000)] } });
    p = (await verPedido(a, at)).dados;
    assert.deepEqual(p.automaticos.receita.map((i) => [i.descricao, i.quantidade, i.preco_unitario_centavos]), [['Dipirona', 1, 5000]]);
  }
  // receita cancelada não conta
  bruto(a).prepare(`UPDATE receitas SET status = 'cancelada'`).run();
  assert.deepEqual((await verPedido(a, at)).dados.automaticos.receita, []);
});

// ---------- salvar itens e permissões ----------
test('salvar itens: recepção, suporte e veterinário podem; cria o pedido uma vez; total é a soma', async () => {
  const a = await ambiente();
  const at = await atendimento(a, await novoPet(a));
  const r = await salvar(a, at, [livre('Consulta', 10000), livre('Vacina', 8500, 2)], a.recepcao);
  assert.equal(r.status, 201);
  assert.equal(r.dados.pedido.total_centavos, 27000);
  assert.equal(r.dados.pedido.status, 'aberto');
  assert.equal(r.dados.pedido.itens[1].subtotal_centavos, 17000);
  const r2 = await salvar(a, at, [livre('Consulta', 10000)], a.suporte);
  assert.equal(r2.status, 200);
  assert.equal(r2.dados.pedido.id, r.dados.pedido.id);
  assert.equal((await salvar(a, at, [livre('Consulta', 12000)], a.vet)).dados.pedido.total_centavos, 12000);
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM pedidos').get().n, 1);
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM itens_pedido').get().n, 1);
  assert.equal((await acoes(a, 'criar_pedido')).length, 1);
  const alt = await acoes(a, 'alterar_itens_pedido');
  assert.equal(alt.length, 2);
  assert.equal(JSON.parse(alt[1].antes).total_centavos, 10000);
  assert.equal(JSON.parse(alt[1].depois).total_centavos, 12000);
});

test('salvar itens: validações, item do catálogo e 401/404', async () => {
  const a = await ambiente();
  const at = await atendimento(a, await novoPet(a));
  assert.equal((await chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { corpo: { itens: [] } })).status, 401);
  assert.equal((await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`)).status, 401);
  assert.equal((await salvar(a, 9999, [])).status, 404);
  assert.equal((await salvar(a, at, 'x')).status, 400);
  assert.equal((await salvar(a, at, [{ descricao: '', preco_unitario_centavos: 100 }])).status, 400);
  assert.equal((await salvar(a, at, [{ descricao: 'x' }])).status, 400); // sem preço
  assert.equal((await salvar(a, at, [livre('x', 10.5)])).status, 400);
  assert.equal((await salvar(a, at, [livre('x', -1)])).status, 400);
  assert.equal((await salvar(a, at, [livre('x', 100, 0)])).status, 400);
  assert.equal((await salvar(a, at, [{ catalogo_id: 9999 }])).status, 400);
  // do catálogo: nome e preço copiados
  const c = await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.recepcao, corpo: { nome: 'Vacina V10', categoria: 'vacina', preco_centavos: 9000 } });
  const ok = await salvar(a, at, [{ catalogo_id: c.dados.id }]);
  assert.deepEqual([ok.status, ok.dados.pedido.itens[0].descricao, ok.dados.pedido.itens[0].preco_unitario_centavos, ok.dados.pedido.itens[0].catalogo_id], [201, 'Vacina V10', 9000, c.dados.id]);
  // depois o preço do catálogo muda: o item já salvo mantém o preço copiado
  await chamar(a.env, 'PATCH', `/api/catalogo/${c.dados.id}`, { cookie: a.recepcao, corpo: { preco_centavos: 9500 } });
  assert.equal((await verPedido(a, at)).dados.pedido.itens[0].preco_unitario_centavos, 9000);
  // sem CSRF
  const semCab = await worker.fetch(new Request(ORIGEM + `/api/atendimentos/${at}/pedido/itens`, { method: 'PUT', headers: { Cookie: a.vet, 'Content-Type': 'application/json' }, body: '{"itens":[]}' }), a.env);
  assert.equal(semCab.status, 403);
});

// ---------- fluxo de status ----------
test('enviar para a recepção: status, aviso e registro', async () => {
  const a = await ambiente();
  const avisos = [];
  a.env.NOTIFICAR_TESTE = async (_e, aviso) => { avisos.push(aviso); return { enviados: 1, falhas: 0 }; };
  const pet = await novoPet(a, 'Thor');
  const at = await atendimento(a, pet);
  const { id } = (await salvar(a, at, [livre('Consulta', 24500)])).dados.pedido;
  const r = await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`, { cookie: a.vet });
  assert.equal(r.status, 200);
  assert.deepEqual([r.dados.pedido.status, r.dados.pedido.onde_cobrar, r.dados.pedido.enviado_por.nome], ['aguardando_pagamento', 'recepcao', 'Dra. Teste']);
  const pagto = avisos.filter((x) => x.tag?.startsWith('pagamento-'));
  assert.equal(pagto.length, 1);
  assert.deepEqual(pagto[0], { para: { papel: 'recepcao', excetoUsuarioId: 1 }, titulo: 'Pagamento para receber', corpo: 'Thor · R$ 245,00 · Dra. Teste', url: '#/hoje', tag: `pagamento-${id}` });
  assert.equal((await acoes(a, 'enviar_pedido_recepcao')).length, 1);
  // não envia duas vezes
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`, { cookie: a.vet })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`)).status, 401);
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/9999/enviar-recepcao`, { cookie: a.vet })).status, 404);
  assert.equal(reais(24500), 'R$ 245,00');
});

test('enviar para a recepção: conta vazia é recusada e falha no aviso não atrapalha', async () => {
  const a = await ambiente();
  const at = await atendimento(a, await novoPet(a));
  const { id } = (await salvar(a, at, [])).dados.pedido;
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`, { cookie: a.vet })).status, 400);
  await salvar(a, at, [livre('x', 1000)]);
  a.env.NOTIFICAR_TESTE = async () => { throw new Error('fora do ar'); };
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`, { cookie: a.suporte })).status, 200);
});

// ---------- pagamentos ----------
test('pagamento: recepção recebe; vários pagamentos até ficar pago; registra quem recebeu', async () => {
  const a = await ambiente();
  const { at, id } = await contaDe(a, 15000);
  const r1 = await pagar(a, id, { forma: 'pix', valor_centavos: 5000 });
  assert.equal(r1.status, 201);
  assert.deepEqual([r1.dados.pedido.status, r1.dados.pedido.pago_centavos, r1.dados.pedido.restante_centavos, r1.dados.pedido.onde_cobrar], ['aguardando_pagamento', 5000, 10000, 'consultorio']);
  assert.equal(r1.dados.pagamento.recebido_por.nome, 'recep');
  const r2 = await pagar(a, id, { forma: 'cartao', valor_centavos: 10000 }, a.vet);
  assert.equal(r2.dados.pedido.status, 'pago');
  assert.ok(r2.dados.pedido.pago_em);
  assert.equal(r2.dados.pedido.pagamentos.length, 2);
  assert.equal(r2.dados.pedido.pagamentos[1].recebido_por.nome, 'Dra. Teste');
  assert.equal((await acoes(a, 'registrar_pagamento')).length, 2);
  // já pago
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 100 })).status, 409);
  assert.equal((await verPedido(a, at)).dados.pedido.status, 'pago');
});

test('pagamento: valor maior que o restante é recusado (nenhuma forma passa a mais)', async () => {
  const a = await ambiente();
  const { id } = await contaDe(a, 10000);
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 10001 })).status, 400);
  assert.equal((await pagar(a, id, { forma: 'dinheiro', valor_centavos: 10001, recebido_dinheiro_centavos: 20000 })).status, 400);
  await pagar(a, id, { forma: 'pix', valor_centavos: 6000 });
  const r = await pagar(a, id, { forma: 'cartao', valor_centavos: 4001 });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /R\$ 40,00/);
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM pagamentos').get().n, 1);
});

test('pagamento: validações (forma, valor, 401, 404, foto)', async () => {
  const a = await ambiente();
  const { id } = await contaDe(a, 10000);
  assert.equal((await pagar(a, id, { forma: 'boleto', valor_centavos: 100 })).status, 400);
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 0 })).status, 400);
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 10.5 })).status, 400);
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: '100' })).status, 400);
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 100, comprovante_foto_id: 999 })).status, 400);
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${id}/pagamentos`, { corpo: { forma: 'pix', valor_centavos: 100 } })).status, 401);
  assert.equal((await pagar(a, 9999, { forma: 'pix', valor_centavos: 100 })).status, 404);
});

test('pagamento em dinheiro: devolve o troco; o valor aplicado é o do pedido', async () => {
  const a = await ambiente();
  const { id } = await contaDe(a, 10000);
  const r = await pagar(a, id, { forma: 'dinheiro', valor_centavos: 5000, recebido_dinheiro_centavos: 10000 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.dados.troco_centavos, r.dados.pagamento.valor_centavos, r.dados.pedido.pago_centavos], [5000, 5000, 5000]);
  // recebido menor que o valor: recusado
  assert.equal((await pagar(a, id, { forma: 'dinheiro', valor_centavos: 5000, recebido_dinheiro_centavos: 4000 })).status, 400);
  // sem informar o recebido, não há troco
  const r2 = await pagar(a, id, { forma: 'dinheiro', valor_centavos: 5000 });
  assert.equal(r2.dados.troco_centavos, null);
  assert.equal(r2.dados.pedido.status, 'pago');
  // pix ignora "recebido_dinheiro"
  const { id: id2 } = await contaDe(a, 1000);
  const p = await pagar(a, id2, { forma: 'pix', valor_centavos: 1000, recebido_dinheiro_centavos: 5000 });
  assert.deepEqual([p.dados.troco_centavos, p.dados.pagamento.recebido_dinheiro_centavos], [null, null]);
});

test('pagamento com comprovante: guarda o id da foto, nunca número de cartão', async () => {
  const a = await ambiente();
  const { id } = await contaDe(a, 1000);
  const jpeg = new Uint8Array(100); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  const foto = await chamar(a.env, 'POST', '/api/fotos', { cookie: a.recepcao, bytes: jpeg, tipo: 'image/jpeg' });
  const r = await pagar(a, id, { forma: 'cartao', valor_centavos: 1000, comprovante_foto_id: foto.dados.id, numero_cartao: '4111111111111111' });
  assert.equal(r.status, 201);
  assert.equal(r.dados.pagamento.comprovante_foto_id, foto.dados.id);
  const colunas = bruto(a).prepare('PRAGMA table_info(pagamentos)').all().map((c) => c.name);
  assert.ok(!colunas.some((c) => /cartao|numero/.test(c)));
  const log = (await acoes(a, 'registrar_pagamento'))[0];
  assert.ok(!log.depois.includes('4111'));
});

test('contas separadas: pagamento de uma não afeta outra', async () => {
  const a = await ambiente();
  const x = await contaDe(a, 1000);
  const y = await contaDe(a, 1000);
  await pagar(a, x.id, { forma: 'pix', valor_centavos: 1000 });
  assert.equal((await verPedido(a, y.at)).dados.pedido.status, 'aberto');
});

// ---------- itens travados quando pago ----------
test('conta paga não aceita alterar itens (409); aguardando ainda aceita; total não pode ficar menor que o pago', async () => {
  const a = await ambiente();
  const { at, id } = await contaDe(a, 10000);
  await pagar(a, id, { forma: 'pix', valor_centavos: 4000 });
  assert.equal((await salvar(a, at, [livre('Serviço', 12000)])).status, 200); // parcialmente paga: ainda pode
  const baixo = await salvar(a, at, [livre('Serviço', 3000)]);
  assert.equal(baixo.status, 409);
  assert.equal((await verPedido(a, at)).dados.pedido.total_centavos, 12000);
  await pagar(a, id, { forma: 'pix', valor_centavos: 8000 });
  assert.equal((await salvar(a, at, [livre('Serviço', 20000)])).status, 409);
  assert.equal((await verPedido(a, at)).dados.pedido.itens[0].preco_unitario_centavos, 12000);
});

// ---------- estorno ----------
test('estorno: só administrador (403 para os outros, inclusive vet), com motivo, e a conta reabre', async () => {
  const a = await ambiente();
  const { at, id } = await contaDe(a, 10000);
  const p1 = (await pagar(a, id, { forma: 'pix', valor_centavos: 6000 })).dados.pagamento;
  const p2 = (await pagar(a, id, { forma: 'dinheiro', valor_centavos: 4000, recebido_dinheiro_centavos: 5000 })).dados.pagamento;
  assert.equal((await verPedido(a, at)).dados.pedido.status, 'pago');
  const est = (cookie, pg, corpo) => chamar(a.env, 'POST', `/api/pagamentos/${pg}/estornar`, { cookie, corpo });
  assert.equal((await est(a.recepcao, p2.id, { motivo: 'erro' })).status, 403);
  assert.equal((await est(a.vet2, p2.id, { motivo: 'erro' })).status, 403);
  assert.equal((await est(a.suporte, p2.id, { motivo: 'erro' })).status, 403);
  assert.equal((await est(undefined, p2.id, { motivo: 'erro' })).status, 401);
  assert.equal((await est(a.vet, p2.id, {})).status, 400); // motivo obrigatório
  assert.equal((await est(a.vet, p2.id, { motivo: '  ' })).status, 400);
  assert.equal((await est(a.vet, 9999, { motivo: 'x' })).status, 404);
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM pagamentos WHERE estornado = 1').get().n, 0);
  // recepcionista que é administradora pode
  const ok = await est(a.recAdmin, p2.id, { motivo: 'Cliente pagou em dobro' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.dados.pedido.status, ok.dados.pedido.pago_centavos, ok.dados.pedido.pago_em], ['aguardando_pagamento', 6000, null]);
  const g = ok.dados.pedido.pagamentos.find((x) => x.id === p2.id);
  assert.deepEqual([g.estornado, g.estorno_motivo, g.estornado_por.nome], [true, 'Cliente pagou em dobro', 'recadm']);
  const log = (await acoes(a, 'estornar_pagamento'))[0];
  assert.equal(JSON.parse(log.antes).estornado, false);
  assert.equal(JSON.parse(log.depois).motivo, 'Cliente pagou em dobro');
  assert.equal(JSON.parse(log.depois).pedido_status, 'aguardando_pagamento');
  assert.ok(!/senha|hash/i.test(log.antes + log.depois));
  // já estornado
  assert.equal((await est(a.vet, p2.id, { motivo: 'de novo' })).status, 409);
  // pode receber o resto de novo e fechar
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 4000 })).dados.pedido.status, 'pago');
  // estornar o primeiro também reabre
  assert.equal((await est(a.vet, p1.id, { motivo: 'erro' })).dados.pedido.status, 'aguardando_pagamento');
});

test('estorno: se a conta estava só parcialmente paga, continua aguardando', async () => {
  const a = await ambiente();
  const { id } = await contaDe(a, 10000);
  const p = (await pagar(a, id, { forma: 'pix', valor_centavos: 3000 })).dados.pagamento;
  const r = await chamar(a.env, 'POST', `/api/pagamentos/${p.id}/estornar`, { cookie: a.vet, corpo: { motivo: 'x' } });
  assert.deepEqual([r.dados.pedido.status, r.dados.pedido.pago_centavos, r.dados.pedido.restante_centavos], ['aguardando_pagamento', 0, 10000]);
});

// ---------- cancelar ----------
test('cancelar: veterinário, suporte ou admin, com motivo; recepção comum não; não cancela com pagamento', async () => {
  const a = await ambiente();
  const c1 = await contaDe(a, 1000);
  const cancelar = (id, cookie, corpo = { motivo: 'Lançado errado' }) => chamar(a.env, 'POST', `/api/pedidos/${id}/cancelar`, { cookie, corpo });
  assert.equal((await cancelar(c1.id, a.recepcao)).status, 403);
  assert.equal((await cancelar(c1.id)).status, 401);
  assert.equal((await cancelar(c1.id, a.vet, {})).status, 400);
  assert.equal((await cancelar(9999, a.vet)).status, 404);
  const ok = await cancelar(c1.id, a.suporte);
  assert.equal(ok.status, 200);
  assert.equal(bruto(a).prepare('SELECT status, motivo_cancelamento, cancelado_por FROM pedidos WHERE id = ?').get(c1.id).motivo_cancelamento, 'Lançado errado');
  assert.equal((await cancelar(c1.id, a.vet)).status, 409); // já cancelado
  assert.equal((await acoes(a, 'cancelar_pedido')).length, 1);
  // vet2 cancela; recepção admin também
  const c2 = await contaDe(a, 1000);
  assert.equal((await cancelar(c2.id, a.vet2)).status, 200);
  const c3 = await contaDe(a, 1000);
  assert.equal((await cancelar(c3.id, a.recAdmin)).status, 200);
  // com pagamento: não cancela
  const c4 = await contaDe(a, 1000);
  const pg = (await pagar(a, c4.id, { forma: 'pix', valor_centavos: 400 })).dados.pagamento;
  assert.equal((await cancelar(c4.id, a.vet)).status, 409);
  // depois do estorno, pode cancelar
  await chamar(a.env, 'POST', `/api/pagamentos/${pg.id}/estornar`, { cookie: a.vet, corpo: { motivo: 'x' } });
  assert.equal((await cancelar(c4.id, a.vet)).status, 200);
  // conta paga não cancela
  const c5 = await contaDe(a, 1000);
  await pagar(a, c5.id, { forma: 'pix', valor_centavos: 1000 });
  assert.equal((await cancelar(c5.id, a.vet)).status, 409);
});

test('cancelado: não recebe pagamento; permite criar nova conta no mesmo atendimento', async () => {
  const a = await ambiente();
  const { at, id } = await contaDe(a, 1000);
  await chamar(a.env, 'POST', `/api/pedidos/${id}/cancelar`, { cookie: a.vet, corpo: { motivo: 'x' } });
  assert.equal((await pagar(a, id, { forma: 'pix', valor_centavos: 100 })).status, 409);
  const v = (await verPedido(a, at)).dados;
  assert.equal(v.pedido.rascunho, true); // volta a ser rascunho
  const nova = await salvar(a, at, [livre('Outra', 500)]);
  assert.equal(nova.status, 201);
  assert.notEqual(nova.dados.pedido.id, id);
});

// ---------- tela Hoje ----------
test('hoje: pedido no atendimento e lista "aguardando pagamento" (finalizado e não pago aparece)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const at = await atendimento(a, pet);
  await chamar(a.env, 'POST', `/api/atendimentos/${at}/iniciar`, { cookie: a.vet });
  let h = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.equal(h.em_atendimento[0].pedido, null);
  assert.deepEqual(h.aguardando_pagamento, []);
  const { id } = (await salvar(a, at, [livre('Consulta', 10000)], a.recepcao)).dados.pedido;
  h = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.deepEqual(h.em_atendimento[0].pedido, { id, status: 'aberto', total_centavos: 10000, pago_centavos: 0 });
  await chamar(a.env, 'POST', `/api/pedidos/${id}/enviar-recepcao`, { cookie: a.vet });
  await chamar(a.env, 'POST', `/api/atendimentos/${at}/finalizar`, { cookie: a.vet });
  await pagar(a, id, { forma: 'pix', valor_centavos: 2500 });
  h = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.deepEqual(h.finalizados[0].pedido, { id, status: 'aguardando_pagamento', total_centavos: 10000, pago_centavos: 2500 });
  assert.equal(h.aguardando_pagamento.length, 1);
  const x = h.aguardando_pagamento[0];
  assert.deepEqual([x.pedido_id, x.atendimento_id, x.pet.nome, x.tutor.nome, x.total_centavos, x.restante_centavos, x.enviado_por.nome, x.atendimento_status], [id, at, 'Thor', 'Maria', 10000, 7500, 'Dra. Teste', 'finalizado']);
  assert.ok(x.enviado_em);
  // aparece mesmo se for de outro dia (finalizado ontem)
  bruto(a).prepare(`UPDATE atendimentos SET chegada_em = '2020-01-01T10:00:00.000Z', finalizado_em = '2020-01-01T11:00:00.000Z'`).run();
  h = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.equal(h.aguardando_pagamento.length, 1);
  // pago sai da lista; o resumo mostra pago
  await pagar(a, id, { forma: 'cartao', valor_centavos: 7500 });
  h = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.equal(h.aguardando_pagamento.length, 0);
});

// ---------- caixa ----------
test('caixa de hoje: só administrador; soma por forma; não conta estornados nem pagamentos de ontem', async () => {
  const a = await ambiente();
  const c1 = await contaDe(a, 10000);
  const c2 = await contaDe(a, 5000);
  await pagar(a, c1.id, { forma: 'pix', valor_centavos: 6000 });
  const din = (await pagar(a, c1.id, { forma: 'dinheiro', valor_centavos: 4000, recebido_dinheiro_centavos: 5000 })).dados.pagamento;
  await pagar(a, c2.id, { forma: 'cartao', valor_centavos: 5000 });
  assert.equal((await chamar(a.env, 'GET', '/api/caixa/hoje', { cookie: a.recepcao })).status, 403);
  assert.equal((await chamar(a.env, 'GET', '/api/caixa/hoje', { cookie: a.vet2 })).status, 403);
  assert.equal((await chamar(a.env, 'GET', '/api/caixa/hoje')).status, 401);
  let cx = (await chamar(a.env, 'GET', '/api/caixa/hoje', { cookie: a.vet })).dados;
  assert.deepEqual([cx.total_centavos, cx.quantidade], [15000, 3]);
  assert.deepEqual(cx.por_forma, { pix: { total_centavos: 6000, quantidade: 1 }, cartao: { total_centavos: 5000, quantidade: 1 }, dinheiro: { total_centavos: 4000, quantidade: 1 } });
  assert.equal(cx.pagamentos.length, 3);
  assert.match(cx.pagamentos[0].pet, /^Pet\d+$/);
  // estorna o dinheiro: sai do total
  await chamar(a.env, 'POST', `/api/pagamentos/${din.id}/estornar`, { cookie: a.vet, corpo: { motivo: 'x' } });
  cx = (await chamar(a.env, 'GET', '/api/caixa/hoje', { cookie: a.recAdmin })).dados;
  assert.deepEqual([cx.total_centavos, cx.quantidade, cx.por_forma.dinheiro.quantidade], [11000, 2, 0]);
  assert.deepEqual(cx.estornados_hoje, { quantidade: 1, total_centavos: 4000 });
  // pagamento de ontem não entra
  bruto(a).prepare(`UPDATE pagamentos SET recebido_em = '2020-01-01T10:00:00.000Z' WHERE forma = 'pix'`).run();
  cx = (await chamar(a.env, 'GET', '/api/caixa/hoje', { cookie: a.vet })).dados;
  assert.equal(cx.total_centavos, 5000);
});

// ---------- catálogo ----------
test('catálogo: listar (qualquer equipe), buscar sem acento, filtros e 401', async () => {
  const a = await ambiente();
  assert.equal((await chamar(a.env, 'GET', '/api/catalogo')).status, 401);
  const todos = await chamar(a.env, 'GET', '/api/catalogo', { cookie: a.recepcao });
  assert.equal(todos.status, 200);
  assert.deepEqual(todos.dados.itens.map((i) => [i.nome, i.preco_centavos]), [['Consulta (até o horário de corte)', 10000], ['Consulta (após o horário de corte)', 20000]]);
  await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.recepcao, corpo: { nome: 'Hemograma', categoria: 'exame', preco_centavos: 6000 } });
  await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.recepcao, corpo: { nome: 'Antipulgas', categoria: 'produto', preco_centavos: 8900, ativo: false } });
  const q = (qs) => chamar(a.env, 'GET', '/api/catalogo' + qs, { cookie: a.suporte });
  assert.deepEqual((await q('?q=ate o horario')).dados.itens.length, 1);
  assert.deepEqual((await q('?q=HEMO')).dados.itens.map((i) => i.nome), ['Hemograma']);
  assert.deepEqual((await q('?categoria=exame')).dados.itens.map((i) => i.nome), ['Hemograma']);
  assert.equal((await q('?q=antipulgas')).dados.itens.length, 0); // inativo escondido
  assert.equal((await q('?q=antipulgas&inativos=1')).dados.itens.length, 1);
  assert.equal((await q('?categoria=xx')).status, 400);
  // ordem por categoria
  assert.deepEqual((await q('?inativos=1')).dados.itens.map((i) => i.categoria), ['consulta', 'consulta', 'exame', 'produto']);
});

test('catálogo: criar, alterar, desativar (todas as funções da equipe) e registrar', async () => {
  const a = await ambiente();
  for (const cookie of [a.recepcao, a.vet2, a.suporte]) {
    const r = await chamar(a.env, 'POST', '/api/catalogo', { cookie, corpo: { nome: 'Item ' + cookie.length + Math.random(), categoria: 'outro', preco_centavos: 1000 } });
    assert.equal(r.status, 201);
  }
  const c = (await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.recepcao, corpo: { nome: 'Vacina V10', categoria: 'vacina', preco_centavos: 9000 } })).dados;
  assert.deepEqual([c.ativo, c.preco_centavos], [true, 9000]);
  const flags = bruto(a).prepare('SELECT ia_pode_informar, aparece_no_site, exige_receita FROM catalogo WHERE id = ?').get(c.id);
  assert.deepEqual({ ...flags }, { ia_pode_informar: 0, aparece_no_site: 0, exige_receita: 0 });
  const p = await chamar(a.env, 'PATCH', `/api/catalogo/${c.id}`, { cookie: a.vet2, corpo: { nome: 'Vacina V10 importada', preco_centavos: 11000 } });
  assert.deepEqual([p.status, p.dados.nome, p.dados.preco_centavos], [200, 'Vacina V10 importada', 11000]);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${c.id}`, { cookie: a.suporte, corpo: { ativo: false } })).dados.ativo, false);
  const log = await acoes(a, 'alterar_catalogo');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(log[0].antes).preco_centavos, 9000);
  assert.equal(JSON.parse(log[0].depois).preco_centavos, 11000);
  assert.equal((await acoes(a, 'criar_catalogo')).length, 4);
  // flags continuam intactas
  assert.deepEqual({ ...bruto(a).prepare('SELECT ia_pode_informar, aparece_no_site, exige_receita FROM catalogo WHERE id = ?').get(c.id) }, { ia_pode_informar: 0, aparece_no_site: 0, exige_receita: 0 });
});

test('catálogo: validações, duplicados, 404 e proteção dos preços de consulta', async () => {
  const a = await ambiente();
  const post = (corpo, cookie = a.recepcao) => chamar(a.env, 'POST', '/api/catalogo', { cookie: cookie || undefined, corpo });
  assert.equal((await post({ nome: '', categoria: 'outro', preco_centavos: 1 })).status, 400);
  assert.equal((await post({ nome: 'x', categoria: 'xx', preco_centavos: 1 })).status, 400);
  assert.equal((await post({ nome: 'x', categoria: 'outro', preco_centavos: -1 })).status, 400);
  assert.equal((await post({ nome: 'x', categoria: 'outro', preco_centavos: 1.5 })).status, 400);
  assert.equal((await post({ nome: 'x', categoria: 'outro', preco_centavos: '10' })).status, 400);
  assert.equal((await post({ nome: 'x', categoria: 'outro', preco_centavos: 1 }, null)).status, 401);
  assert.equal((await post({ nome: 'Raio X', categoria: 'exame', preco_centavos: 1 })).status, 201);
  assert.equal((await post({ nome: 'raio x', categoria: 'exame', preco_centavos: 1 })).status, 409);
  assert.equal((await post({ nome: 'Raio X', categoria: 'outro', preco_centavos: 1 })).status, 201); // outra categoria
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/9999', { cookie: a.recepcao, corpo: { preco_centavos: 1 } })).status, 404);
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/3', { cookie: a.recepcao, corpo: { preco_centavos: -5 } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/3', { corpo: { preco_centavos: 5 } })).status, 401);
  // consultas base: só preço e nome
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/1', { cookie: a.recepcao, corpo: { ativo: false } })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/2', { cookie: a.recepcao, corpo: { categoria: 'outro' } })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', '/api/catalogo/1', { cookie: a.recepcao, corpo: { preco_centavos: 11000 } })).status, 200);
  // não existe rota pública de catálogo
  const semLogin = await chamar(a.env, 'GET', '/api/catalogo?categoria=exame');
  assert.equal(semLogin.status, 401);
});

// ---------- apagar dados de teste ----------
test('apagar dados de teste: remove pedidos, itens, pagamentos e comprovantes dos pets TESTE (e só deles)', async () => {
  const a = await ambiente();
  const jpeg = (n) => { const b = new Uint8Array(100); b.set([0xff, 0xd8, 0xff, 0xe0]); b[10] = n; return b; };
  const foto = async () => (await chamar(a.env, 'POST', '/api/fotos', { cookie: a.recepcao, bytes: jpeg(Math.floor(Math.random() * 200)), tipo: 'image/jpeg' })).dados.id;
  const tutorTeste = await novoPet(a, 'Rex', 'TESTE Maria', '(71) 98888-7777');
  const real = await novoPet(a, 'Mel', 'Joana', '(71) 97777-6666');
  const atT = await atendimento(a, tutorTeste);
  const atR = await atendimento(a, real);
  const pedT = (await salvar(a, atT, [livre('x', 1000)])).dados.pedido.id;
  const pedR = (await salvar(a, atR, [livre('y', 1000)])).dados.pedido.id;
  const fT = await foto(); const fR = await foto();
  await pagar(a, pedT, { forma: 'cartao', valor_centavos: 500, comprovante_foto_id: fT });
  await pagar(a, pedR, { forma: 'cartao', valor_centavos: 500, comprovante_foto_id: fR });
  const g = (await chamar(a.env, 'POST', '/api/pedidos/' + pedT + '/pagamentos', { cookie: a.recepcao, corpo: { forma: 'pix', valor_centavos: 500 } })).dados.pagamento;
  await chamar(a.env, 'POST', `/api/pagamentos/${g.id}/estornar`, { cookie: a.vet, corpo: { motivo: 'teste' } });
  const previa = (await chamar(a.env, 'GET', '/api/admin/dados-teste', { cookie: a.vet })).dados;
  assert.deepEqual([previa.pedidos, previa.fotos], [1, 1]);
  const r = await chamar(a.env, 'POST', '/api/admin/apagar-dados-teste', { cookie: a.vet, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200);
  const n = (sql) => bruto(a).prepare(sql).get().n;
  assert.equal(n('SELECT COUNT(*) AS n FROM pedidos'), 1);
  assert.equal(n('SELECT COUNT(*) AS n FROM itens_pedido'), 1);
  assert.equal(n('SELECT COUNT(*) AS n FROM pagamentos'), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM fotos WHERE id = ${fT}`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM fotos WHERE id = ${fR}`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM pedidos WHERE id = ${pedR}`), 1);
});

// ---------- migração ----------
test('migração 0008 aplica sobre a 0007 mantendo pedidos e pagamentos existentes', () => {
  const db = criarBancoLocal({ ate: '0007' });
  const b = db.bruto;
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Ana', 'ana', 'h', 'veterinario', 1, 1, 'x', 'x')`).run();
  b.prepare(`INSERT INTO tutores (codigo, nome, origem, criado_em, atualizado_em) VALUES ('T-000001', 'Carla', 'recepcao', 'x', 'x')`).run();
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Mel', 'cao', 'recepcao', 'x', 'x')`).run();
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, status, registrado_por, criado_em, atualizado_em) VALUES (1, '2026-01-01T10:00:00.000Z', 'finalizado', 1, 'x', 'x')`).run();
  // dois pedidos ativos no mesmo atendimento (não deveria existir) + um cancelado
  for (const s of ['aberto', 'aguardando_pagamento', 'cancelado']) b.prepare(`INSERT INTO pedidos (atendimento_id, status, total_centavos, criado_por, criado_em, atualizado_em) VALUES (1, ?, 10000, 1, '2026-01-01T10:00:00.000Z', 'x')`).run(s);
  b.prepare(`INSERT INTO itens_pedido (pedido_id, descricao, quantidade, preco_unitario_centavos) VALUES (1, 'Consulta', 1, 10000)`).run();
  b.prepare(`INSERT INTO pagamentos (pedido_id, forma, valor_centavos, recebido_por, recebido_em) VALUES (1, 'pix', 5000, 1, '2026-01-01T11:00:00.000Z')`).run();
  db.migrarRestante();
  assert.deepEqual(b.prepare('SELECT id, status FROM pedidos ORDER BY id').all().map((p) => p.status), ['aberto', 'cancelado', 'cancelado']);
  const i = b.prepare('SELECT * FROM itens_pedido').get();
  assert.deepEqual([i.origem, i.preco_unitario_centavos], ['manual', 10000]);
  const g = b.prepare('SELECT * FROM pagamentos').get();
  assert.deepEqual([g.valor_centavos, g.comprovante_foto_id, g.recebido_dinheiro_centavos, g.estorno_motivo], [5000, null, null, null]);
  assert.equal(b.prepare('SELECT enviado_por FROM pedidos WHERE id = 1').get().enviado_por, null);
  // o índice impede dois pedidos ativos
  assert.throws(() => b.prepare(`INSERT INTO pedidos (atendimento_id, criado_por, criado_em, atualizado_em) VALUES (1, 1, 'x', 'x')`).run(), /UNIQUE/);
});
