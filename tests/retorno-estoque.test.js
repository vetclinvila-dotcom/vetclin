// Testes do retorno (tipo da visita), do estoque com validade, da receita montada com o carrinho
// e da migração 0012 sobre dados existentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizarEstoquePedido } from '../src/estoque.js';
import { ambiente, atendimentoEmAndamento, chamar, minutosDepois, novoPet } from './apoio-clinico.js';
import { criarBancoLocal } from './d1-local.js';

const bruto = (a) => a.env.DB.bruto;
const umDia = 24 * 60 * 60 * 1000;
const dataEm = (a, dias) => new Date(a.relogio.agora.getTime() - 3 * 3600000 + dias * umDia).toISOString().slice(0, 10); // dias a partir de "hoje" em Bahia

async function chegar(a, pet, extra = {}, cookie = a.recepcao) {
  const r = await chamar(a.env, 'POST', '/api/atendimentos', { cookie, corpo: { pet_id: pet.id, peso_kg: 8, motivo: 'Teste', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}
async function criarProduto(a, extra = {}, cookie = a.recepcao) {
  const r = await chamar(a.env, 'POST', '/api/catalogo', { cookie, corpo: { nome: 'Produto ' + Math.random().toString(36).slice(2, 7), categoria: 'produto', preco_centavos: 2500, controla_estoque: true, unidade: 'cx', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}
const entrada = (a, id, corpo, cookie = a.recepcao) => chamar(a.env, 'POST', `/api/estoque/${id}/entradas`, { cookie, corpo });
const estoqueDe = async (a, id) => (await chamar(a.env, 'GET', `/api/estoque/${id}`, { cookie: a.recepcao })).dados;

// Conta com os itens do catálogo e pagamento total. Devolve { at, pedidoId, total }.
async function contaPaga(a, atId, itens, { pagar = true } = {}) {
  const r = await chamar(a.env, 'PUT', `/api/atendimentos/${atId}/pedido/itens`, { cookie: a.filipe, corpo: { itens } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.dados));
  const pedidoId = r.dados.pedido.id;
  const total = r.dados.pedido.total_centavos;
  if (pagar) {
    const p = await chamar(a.env, 'POST', `/api/pedidos/${pedidoId}/pagamentos`, { cookie: a.recepcao, corpo: { forma: 'pix', valor_centavos: total } });
    assert.equal(p.status, 201, JSON.stringify(p.dados));
    return { pedidoId, total, pagamentoId: p.dados.pagamento.id };
  }
  return { pedidoId, total };
}
const saldo = (a, id) => bruto(a).prepare('SELECT validade, quantidade_atual FROM estoque_lotes WHERE catalogo_id = ? ORDER BY id').all(id).map((l) => [l.validade, l.quantidade_atual]);

// ================= RETORNO =================
test('retorno: chegada aceita tipo; padrão é consulta; valor inválido é recusado', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Bolinha');
  const bad = await chamar(a.env, 'POST', '/api/atendimentos', { cookie: a.recepcao, corpo: { pet_id: pet.id, peso_kg: 5, motivo: 'x', tipo: 'revisao' } });
  assert.equal(bad.status, 400);
  const r = await chegar(a, pet, { tipo: 'retorno' });
  assert.equal(r.tipo, 'retorno');
  const outro = await novoPet(a, 'Nina');
  assert.equal((await chegar(a, outro)).tipo, 'consulta');
  const hoje = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.recepcao })).dados;
  assert.deepEqual(hoje.aguardando.map((x) => [x.pet.nome, x.tipo]).sort(), [['Bolinha', 'retorno'], ['Nina', 'consulta']]);
});

test('retorno: paciente ainda não cadastrado (cadastro rápido com chegada.tipo = retorno)', async () => {
  const a = await ambiente();
  const avisos = [];
  a.env.NOTIFICAR_TESTE = async (_e, aviso) => { avisos.push(aviso); return { enviados: 0, falhas: 0 }; };
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Joana', whatsapp: '(71) 98888-1111' }, pet: { nome: 'Floquinho', especie: 'gato' }, chegada: { peso_kg: 4.1, motivo: 'Voltou para ver o exame', tipo: 'retorno' } } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  assert.equal(r.dados.atendimento.tipo, 'retorno');
  assert.equal(bruto(a).prepare('SELECT tipo FROM atendimentos WHERE id = ?').get(r.dados.atendimento.id).tipo, 'retorno');
  assert.match(avisos[0].titulo, /^Chegou \(retorno\): Floquinho/);
  // Sem tipo: consulta e título normal.
  const r2 = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Rui', whatsapp: '(71) 98888-2222' }, pet: { nome: 'Totó', especie: 'cao' }, chegada: { peso_kg: 9, motivo: 'Vômito' } } });
  assert.equal(r2.dados.atendimento.tipo, 'consulta');
  assert.match(avisos[1].titulo, /^Chegou: Totó/);
});

test('retorno: a conta usa o item "Retorno" (R$ 0) em vez da consulta por horário', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Mel');
  const at = await chegar(a, pet, { tipo: 'retorno' });
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at.id}/iniciar`, { cookie: a.filipe })).status, 200);
  const c = (await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados;
  const retornoId = bruto(a).prepare(`SELECT id FROM catalogo WHERE papel_fixo = 'retorno'`).get().id;
  assert.equal(c.automaticos.consulta.catalogo_id, retornoId);
  assert.equal(c.automaticos.consulta.descricao, 'Retorno');
  assert.equal(c.automaticos.consulta.preco_unitario_centavos, 0);
  assert.equal(c.atendimento.tipo, 'retorno');
  assert.equal(c.pedido.total_centavos, 0);
  // Admin muda o preço do retorno: a conta acompanha.
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retornoId}`, { cookie: a.elizabeth, corpo: { preco_centavos: 3000 } })).status, 200);
  assert.equal((await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados.pedido.total_centavos, 3000);
  // Consulta comum continua pelo horário.
  const pet2 = await novoPet(a, 'Rex');
  const at2 = await chegar(a, pet2);
  const c2 = (await chamar(a.env, 'GET', `/api/atendimentos/${at2.id}/pedido`, { cookie: a.filipe })).dados;
  assert.equal(c2.automaticos.consulta.descricao.startsWith('Consulta ('), true);
  assert.ok([10000, 20000].includes(c2.automaticos.consulta.preco_unitario_centavos));
});

test('retorno: PATCH muda o tipo enquanto não está pago e troca o item da consulta na conta; pago recusa', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Lua');
  const at = await chegar(a, pet);
  // Conta salva com a consulta (R$ 100 ou 200 conforme o horário).
  const auto = (await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados.automaticos.consulta;
  const salvo = await chamar(a.env, 'PUT', `/api/atendimentos/${at.id}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [{ descricao: auto.descricao, quantidade: 1, preco_unitario_centavos: auto.preco_unitario_centavos, catalogo_id: auto.catalogo_id, origem: 'consulta' }] } });
  assert.equal(salvo.dados.pedido.total_centavos, auto.preco_unitario_centavos);
  const mudou = await chamar(a.env, 'PATCH', `/api/atendimentos/${at.id}`, { cookie: a.recepcao, corpo: { tipo: 'retorno' } });
  assert.equal(mudou.status, 200);
  assert.equal(mudou.dados.tipo, 'retorno');
  const depois = (await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados;
  assert.deepEqual(depois.pedido.itens.map((i) => [i.descricao, i.origem, i.preco_unitario_centavos]), [['Retorno', 'consulta', 0]]);
  assert.equal(depois.pedido.total_centavos, 0);
  assert.equal((await chamar(a.env, 'PATCH', `/api/atendimentos/${at.id}`, { cookie: a.recepcao, corpo: { tipo: 'xyz' } })).status, 400);
  // Com a conta paga não muda mais.
  const prod = await criarProduto(a, { controla_estoque: false, preco_centavos: 1000 });
  const conta = await contaPaga(a, at.id, [{ descricao: 'Retorno', quantidade: 1, preco_unitario_centavos: 0, catalogo_id: depois.pedido.itens[0].catalogo_id, origem: 'consulta' }, { catalogo_id: prod.id, quantidade: 1, origem: 'manual' }]);
  assert.ok(conta.total === 1000);
  const recusa = await chamar(a.env, 'PATCH', `/api/atendimentos/${at.id}`, { cookie: a.recepcao, corpo: { tipo: 'consulta' } });
  assert.equal(recusa.status, 409);
  assert.equal(bruto(a).prepare('SELECT tipo FROM atendimentos WHERE id = ?').get(at.id).tipo, 'retorno');
});

test('retorno: itens fixos pela marca papel_fixo (só administrador muda preço/nome; não desativa); itens novos de consulta não são fixos', async () => {
  const a = await ambiente();
  const fixos = bruto(a).prepare('SELECT id, papel_fixo FROM catalogo WHERE papel_fixo IS NOT NULL ORDER BY id').all().map((x) => ({ ...x }));
  assert.deepEqual(fixos.map((x) => x.papel_fixo), ['consulta_dia', 'consulta_noite', 'retorno']);
  const retorno = fixos[2].id;
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.recepcao, corpo: { preco_centavos: 500 } })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.filipe, corpo: { nome: 'Voltinha' } })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.elizabeth, corpo: { ativo: false } })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.elizabeth, corpo: { categoria: 'produto' } })).status, 409);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.elizabeth, corpo: { controla_estoque: true } })).status, 409);
  const ok = await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.elizabeth, corpo: { nome: 'Retorno (até 15 dias)', preco_centavos: 2000 } });
  assert.deepEqual([ok.status, ok.dados.papel_fixo], [200, 'retorno']);
  // Quem não é admin pode mexer no resto do item (ex.: apresentação) sem mudar nome/preço? Só se nada mudar.
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${retorno}`, { cookie: a.recepcao, corpo: { nome: 'Retorno (até 15 dias)' } })).status, 200);
  // Um item novo de categoria consulta NÃO é fixo: edita e desativa livremente, e não muda qual consulta a conta usa.
  const extra = (await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.recepcao, corpo: { nome: 'Consulta domiciliar', categoria: 'consulta', preco_centavos: 30000 } })).dados;
  assert.equal(extra.papel_fixo, null);
  assert.equal((await chamar(a.env, 'PATCH', `/api/catalogo/${extra.id}`, { cookie: a.recepcao, corpo: { ativo: false } })).status, 200);
  const pet = await novoPet(a, 'Teco');
  const at = await chegar(a, pet);
  const c = (await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados.automaticos.consulta;
  assert.ok([fixos[0].id, fixos[1].id].includes(c.catalogo_id));
  // Mesmo que a ordem dos ids mude (ex.: consulta domiciliar criada antes), vale a marca, não a posição.
  bruto(a).prepare(`UPDATE catalogo SET ativo = 1 WHERE id = ?`).run(extra.id);
  const c2 = (await chamar(a.env, 'GET', `/api/atendimentos/${at.id}/pedido`, { cookie: a.filipe })).dados.automaticos.consulta;
  assert.ok([fixos[0].id, fixos[1].id].includes(c2.catalogo_id));
});

test('migração 0012 sobre dados existentes: marca as duas consultas, cria Retorno e mantém tudo', async () => {
  const db = criarBancoLocal({ ate: '0011' });
  const b = db.bruto;
  const t = '2026-01-01T00:00:00.000Z';
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Vet', 'vet', 'x', 'veterinario', 1, 1, ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO tutores (codigo, nome, origem, criado_em, atualizado_em) VALUES ('T-000001', 'Ana', 'recepcao', ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Rex', 'cao', 'recepcao', ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, peso_kg, status, registrado_por, criado_em, atualizado_em) VALUES (1, ?, 12.5, 'finalizado', 1, ?, ?)`).run(t, t, t);
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, status, registrado_por, criado_em, atualizado_em) VALUES (1, ?, 'finalizado', 1, ?, ?)`).run(t, t, t);
  // A clínica já tinha criado um "Retorno" e uma consulta extra depois das duas iniciais, e um produto.
  b.prepare(`INSERT INTO catalogo (nome, categoria, preco_centavos, criado_em, atualizado_em) VALUES ('retorno ', 'consulta', 4000, ?, ?), ('Consulta noturna', 'consulta', 30000, ?, ?), ('Vacina V10', 'vacina', 9000, ?, ?)`).run(t, t, t, t, t, t);
  b.prepare(`INSERT INTO pedidos (atendimento_id, status, total_centavos, criado_por, criado_em, atualizado_em) VALUES (1, 'aberto', 10000, 1, ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO itens_pedido (pedido_id, catalogo_id, descricao, quantidade, preco_unitario_centavos, origem) VALUES (1, 1, 'Consulta', 1, 10000, 'consulta')`).run();
  db.migrarRestante();
  const cat = b.prepare('SELECT id, nome, preco_centavos, papel_fixo, controla_estoque, unidade, apresentacao FROM catalogo ORDER BY id').all().map((x) => ({ ...x }));
  assert.deepEqual(cat.map((c) => [c.id, c.papel_fixo]), [[1, 'consulta_dia'], [2, 'consulta_noite'], [3, 'retorno'], [4, null], [5, null]]);
  assert.equal(cat[2].preco_centavos, 4000); // o "Retorno" que já existia foi aproveitado (nada duplicado)
  assert.equal(cat.filter((c) => c.nome.toLowerCase().trim() === 'retorno').length, 1);
  assert.deepEqual([cat[4].controla_estoque, cat[4].unidade, cat[4].apresentacao], [0, 'un', null]);
  const at = b.prepare('SELECT id, tipo, peso_em, chegada_em FROM atendimentos ORDER BY id').all();
  assert.deepEqual(at.map((x) => x.tipo), ['consulta', 'consulta']);
  assert.equal(at[0].peso_em, at[0].chegada_em); // peso antigo: hora da chegada
  assert.equal(at[1].peso_em, null);
  assert.equal(b.prepare('SELECT total_centavos FROM pedidos').get().total_centavos, 10000);
  assert.deepEqual(b.prepare('PRAGMA foreign_key_check').all(), []);
  // Sem "Retorno" prévio, a migração cria o item com preço 0 (já coberto pelo banco novo dos outros testes).
  assert.throws(() => b.prepare(`INSERT INTO catalogo (nome, categoria, preco_centavos, papel_fixo, criado_em, atualizado_em) VALUES ('outro retorno', 'consulta', 0, 'retorno', ?, ?)`).run(t, t), /UNIQUE/);
  assert.throws(() => b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, tipo, status, registrado_por, criado_em, atualizado_em) VALUES (1, ?, 'visita', 'chegou', 1, ?, ?)`).run(t, t, t), /CHECK/);
  // Tabelas de estoque funcionam sobre dados antigos.
  b.prepare(`INSERT INTO estoque_lotes (catalogo_id, quantidade_inicial, quantidade_atual, validade, criado_por, criado_em) VALUES (5, 3, 3, '2027-01-01', 1, ?)`).run(t);
  assert.throws(() => b.prepare(`INSERT INTO estoque_lotes (catalogo_id, quantidade_inicial, quantidade_atual, criado_por, criado_em) VALUES (5, 3, -1, 1, ?)`).run(t), /CHECK/);
});

test('migração 0012 sem item de retorno prévio cria "Retorno" com preço 0', () => {
  const db = criarBancoLocal();
  const r = db.bruto.prepare(`SELECT nome, categoria, preco_centavos, ativo FROM catalogo WHERE papel_fixo = 'retorno'`).get();
  assert.deepEqual({ ...r }, { nome: 'Retorno', categoria: 'consulta', preco_centavos: 0, ativo: 1 });
});

// ================= ESTOQUE =================
test('estoque: recepção, veterinário e suporte dão entrada; validações; produto sem controle é recusado', async () => {
  const a = await ambiente();
  const p = await criarProduto(a, { nome: 'Amoxicilina 250 mg', apresentacao: '250 mg · caixa com 10 comprimidos' });
  assert.deepEqual([p.controla_estoque, p.unidade, p.apresentacao, p.estoque_total], [true, 'cx', '250 mg · caixa com 10 comprimidos', 0]);
  assert.equal((await chamar(a.env, 'POST', `/api/estoque/${p.id}/entradas`, { corpo: { quantidade: 1 } })).status, 401);
  for (const cookie of [a.recepcao, a.filipe, a.suporte]) {
    const r = await entrada(a, p.id, { quantidade: 2, validade: dataEm(a, 100), custo_unitario_centavos: 1200, observacao: 'NF 123' }, cookie);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
  }
  assert.equal(bruto(a).prepare('SELECT SUM(quantidade_atual) AS n FROM estoque_lotes').get().n, 6);
  assert.equal(bruto(a).prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao = 'entrada_estoque'`).get().n, 3);
  for (const ruim of [{ quantidade: 0 }, { quantidade: -1 }, { quantidade: '3' }, { quantidade: 1, validade: '2026-13-45' }, { quantidade: 1, validade: '10/12/2027' }, { quantidade: 1, custo_unitario_centavos: -5 }, { quantidade: 1, custo_unitario_centavos: 1.5 }]) {
    assert.equal((await entrada(a, p.id, ruim)).status, 400, JSON.stringify(ruim));
  }
  const semControle = await criarProduto(a, { controla_estoque: false });
  assert.equal((await entrada(a, semControle.id, { quantidade: 1 })).status, 409);
  assert.equal((await entrada(a, 9999, { quantidade: 1 })).status, 404);
  // Produto vem na lista de estoque e no catálogo com o total.
  const lista = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados;
  assert.deepEqual(lista.itens.map((i) => [i.nome, i.total]), [['Amoxicilina 250 mg', 6]]); // só entram produtos que controlam estoque
  assert.equal((await chamar(a.env, 'GET', '/api/catalogo?q=amoxicilina', { cookie: a.recepcao })).dados.itens[0].estoque_total, 6);
  assert.equal((await chamar(a.env, 'GET', '/api/estoque?q=250%20mg', { cookie: a.recepcao })).dados.itens.length, 1); // busca também pela apresentação
});

test('estoque: ajuste exige motivo; para menos tira do lote que vence antes; para mais cria lote; nunca abaixo de zero', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 3, validade: dataEm(a, 60) });
  await entrada(a, p.id, { quantidade: 5, validade: dataEm(a, 20) });
  const aj = (corpo, cookie = a.recepcao) => chamar(a.env, 'POST', `/api/estoque/${p.id}/ajustes`, { cookie, corpo });
  assert.equal((await aj({ delta: -1 })).status, 400); // sem motivo
  assert.equal((await aj({ delta: -1, nova_quantidade: 3, motivo: 'x' })).status, 400); // só um dos dois
  assert.equal((await aj({ delta: -9, motivo: 'perda' })).status, 400); // abaixo de zero
  assert.equal((await aj({ nova_quantidade: 8, motivo: 'igual' })).status, 400); // nada a ajustar
  const menos = await aj({ delta: -2, motivo: 'Frasco quebrou' }, a.filipe);
  assert.equal(menos.status, 200);
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 60), 3], [dataEm(a, 20), 3]]); // saiu do lote que vence antes
  const mais = await aj({ nova_quantidade: 10, motivo: 'Contagem do inventário' }, a.suporte);
  assert.equal(mais.dados.delta, 4);
  assert.equal((await estoqueDe(a, p.id)).item.total, 10);
  assert.equal(saldo(a, p.id).length, 3); // lote novo (sem validade) com +4
  const movs = (await estoqueDe(a, p.id)).movimentos;
  assert.deepEqual(movs.filter((m) => m.tipo === 'ajuste').map((m) => [m.quantidade, m.motivo]).sort(), [[-2, 'Frasco quebrou'], [4, 'Contagem do inventário']].sort());
  // Ajuste de um lote específico.
  const lote = (await estoqueDe(a, p.id)).lotes.find((l) => l.validade === dataEm(a, 60));
  const r = await chamar(a.env, 'POST', `/api/estoque/${p.id}/ajustes`, { cookie: a.recepcao, corpo: { lote_id: lote.id, nova_quantidade: 1, motivo: 'Conferência' } });
  assert.equal(r.status, 200);
  assert.equal((await estoqueDe(a, p.id)).lotes.find((l) => l.id === lote.id).quantidade_atual, 1);
  assert.equal((await chamar(a.env, 'POST', `/api/estoque/${p.id}/ajustes`, { cookie: a.recepcao, corpo: { lote_id: 99999, delta: 1, motivo: 'x' } })).status, 404);
  assert.equal(bruto(a).prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao = 'ajuste_estoque'`).get().n, 3);
});

test('estoque: ao pagar, baixa pelo lote que vence antes (FEFO), sem validade por último, e não baixa duas vezes', async () => {
  const a = await ambiente();
  const p = await criarProduto(a, { preco_centavos: 3000 });
  await entrada(a, p.id, { quantidade: 3 }); // sem validade
  await entrada(a, p.id, { quantidade: 5, validade: dataEm(a, 30) });
  await entrada(a, p.id, { quantidade: 2, validade: dataEm(a, 10) });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Zeca'));
  const conta = await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 4, origem: 'manual' }], { pagar: false });
  assert.deepEqual(saldo(a, p.id), [[null, 3], [dataEm(a, 30), 5], [dataEm(a, 10), 2]]); // conta aberta: nada baixa ainda
  const pg = await chamar(a.env, 'POST', `/api/pedidos/${conta.pedidoId}/pagamentos`, { cookie: a.recepcao, corpo: { forma: 'dinheiro', valor_centavos: conta.total } });
  assert.equal(pg.status, 201);
  assert.deepEqual(saldo(a, p.id), [[null, 3], [dataEm(a, 30), 3], [dataEm(a, 10), 0]]);
  const saidas = bruto(a).prepare(`SELECT lote_id, quantidade, pedido_id, item_pedido_id FROM estoque_movimentos WHERE tipo = 'saida' ORDER BY id`).all();
  assert.deepEqual(saidas.map((s) => [s.quantidade, s.pedido_id]), [[-2, conta.pedidoId], [-2, conta.pedidoId]]);
  assert.ok(saidas.every((s) => s.item_pedido_id > 0));
  // Idempotência: chamar de novo (retry, duas abas) não baixa outra vez.
  await sincronizarEstoquePedido(a.env, conta.pedidoId, 1);
  await sincronizarEstoquePedido(a.env, conta.pedidoId, 1);
  assert.deepEqual(saldo(a, p.id), [[null, 3], [dataEm(a, 30), 3], [dataEm(a, 10), 0]]);
  assert.equal(bruto(a).prepare(`SELECT COUNT(*) AS n FROM estoque_movimentos WHERE tipo = 'saida'`).get().n, 2);
  // O banco também recusa baixar duas vezes o mesmo item no mesmo lote.
  assert.throws(() => bruto(a).prepare(`INSERT INTO estoque_movimentos (catalogo_id, lote_id, tipo, quantidade, pedido_id, item_pedido_id, criado_em) VALUES (?, ?, 'saida', -1, ?, ?, 'x')`).run(p.id, saidas[0].lote_id, saidas[0].pedido_id, saidas[0].item_pedido_id), /UNIQUE/);
  // Segunda venda: acaba o lote de 30 dias e entra no sem validade.
  const at2 = await atendimentoEmAndamento(a, await novoPet(a, 'Pipoca'));
  await contaPaga(a, at2, [{ catalogo_id: p.id, quantidade: 4, origem: 'manual' }]);
  assert.deepEqual(saldo(a, p.id), [[null, 2], [dataEm(a, 30), 0], [dataEm(a, 10), 0]]);
});

test('estoque: estorno do pagamento devolve aos mesmos lotes; pagar de novo baixa uma vez só', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 1, validade: dataEm(a, 5) });
  await entrada(a, p.id, { quantidade: 4, validade: dataEm(a, 50) });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Dudu'));
  const conta = await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 3, origem: 'manual' }]);
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 5), 0], [dataEm(a, 50), 2]]);
  const est = await chamar(a.env, 'POST', `/api/pagamentos/${conta.pagamentoId}/estornar`, { cookie: a.elizabeth, corpo: { motivo: 'Cliente desistiu' } });
  assert.equal(est.status, 200);
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 5), 1], [dataEm(a, 50), 4]]);
  const tipos = bruto(a).prepare(`SELECT tipo, quantidade, revertido FROM estoque_movimentos WHERE pedido_id IS NOT NULL ORDER BY id`).all().map((m) => [m.tipo, m.quantidade, m.revertido]);
  assert.deepEqual(tipos, [['saida', -1, 1], ['saida', -2, 1], ['estorno', 1, 0], ['estorno', 2, 0]]);
  await sincronizarEstoquePedido(a.env, conta.pedidoId, 1); // de novo: nada muda
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 5), 1], [dataEm(a, 50), 4]]);
  // Paga outra vez: baixa de novo, uma vez só.
  const pg = await chamar(a.env, 'POST', `/api/pedidos/${conta.pedidoId}/pagamentos`, { cookie: a.recepcao, corpo: { forma: 'pix', valor_centavos: conta.total } });
  assert.equal(pg.status, 201);
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 5), 0], [dataEm(a, 50), 2]]);
});

test('estoque: sem produto suficiente a venda segue, o lote não fica negativo e a falta é registrada e devolvida no estorno', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 2, validade: dataEm(a, 40) });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Fred'));
  const conta = await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 5, origem: 'manual' }]);
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 40), 0]]);
  const d = await estoqueDe(a, p.id);
  const falta = d.movimentos.find((m) => m.sem_estoque);
  assert.deepEqual([falta.tipo, falta.quantidade, falta.lote_id], ['saida', -3, null]);
  assert.equal(d.item.sem_estoque_qtd, 3);
  assert.equal(bruto(a).prepare(`SELECT status FROM pedidos WHERE id = ?`).get(conta.pedidoId).status, 'pago');
  const lista = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados;
  assert.equal(lista.itens[0].sem_estoque_qtd, 3);
  assert.equal(lista.resumo.sem_estoque, 1);
  // Estorno: o que existia volta ao lote; a falta deixa de contar.
  await chamar(a.env, 'POST', `/api/pagamentos/${conta.pagamentoId}/estornar`, { cookie: a.elizabeth, corpo: { motivo: 'Erro' } });
  assert.deepEqual(saldo(a, p.id), [[dataEm(a, 40), 2]]);
  assert.equal((await estoqueDe(a, p.id)).item.sem_estoque_qtd, 0);
});

test('estoque: produto sem controle de estoque não gera baixa; consulta e itens livres também não', async () => {
  const a = await ambiente();
  const livre = await criarProduto(a, { controla_estoque: false });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Nick'));
  await contaPaga(a, at, [{ catalogo_id: livre.id, quantidade: 2, origem: 'manual' }, { descricao: 'Taxa', quantidade: 1, preco_unitario_centavos: 500, origem: 'manual' }]);
  assert.equal(bruto(a).prepare('SELECT COUNT(*) AS n FROM estoque_movimentos').get().n, 0);
});

test('estoque: média de validade (ponderada), próxima validade, vencidos, consumo de 30 dias e "dura N dias" com relógio de teste', async () => {
  const a = await ambiente(); // relógio: 2026-11-10 12:00 UTC (09:00 em Bahia)
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 2, validade: dataEm(a, 10) });
  await entrada(a, p.id, { quantidade: 6, validade: dataEm(a, 30) });
  await entrada(a, p.id, { quantidade: 1, validade: dataEm(a, -3) }); // já venceu
  await entrada(a, p.id, { quantidade: 4 }); // sem validade: só entra no total
  let it = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados.itens[0];
  assert.equal(it.total, 13);
  assert.equal(it.proxima_validade, dataEm(a, -3));
  assert.equal(it.dias_para_vencer, -3);
  assert.equal(it.vencidos, 1);
  assert.equal(it.media_validade_dias, 25); // (2*10 + 6*30) / 8
  assert.equal(it.dura_dias, null); // sem vendas ainda
  assert.equal(it.consumo_medio_dia, 0);
  // Vende 6 unidades hoje (sai primeiro o lote vencido? não: o lote vencido também é o de validade mais próxima).
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Max'));
  await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 6, origem: 'manual' }]);
  a.relogio.agora = new Date(a.relogio.agora.getTime() + 10 * umDia); // 10 dias depois
  it = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados.itens[0];
  assert.equal(it.consumo_medio_dia, 0.2); // 6 un em 30 dias
  assert.equal(it.total, 7);
  assert.equal(it.dura_dias, 35); // 7 / 0.2
  // 31 dias depois da venda ela sai da janela de 30 dias.
  a.relogio.agora = new Date(a.relogio.agora.getTime() + 21 * umDia);
  it = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados.itens[0];
  assert.equal(it.consumo_medio_dia, 0);
  assert.equal(it.dura_dias, null);
  assert.equal(it.dias_para_vencer < 0, true);
});

test('estoque: a média de validade ignora lotes vazios e o estorno não conta como venda', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 1, validade: dataEm(a, 10) });
  await entrada(a, p.id, { quantidade: 3, validade: dataEm(a, 40) });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Bia'));
  const conta = await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 1, origem: 'manual' }]);
  let it = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados.itens[0];
  assert.equal(it.media_validade_dias, 40); // o lote de 10 dias esvaziou
  assert.equal(it.proxima_validade, dataEm(a, 40));
  assert.equal(Math.round(it.consumo_medio_dia * 30), 1);
  await chamar(a.env, 'POST', `/api/pagamentos/${conta.pagamentoId}/estornar`, { cookie: a.elizabeth, corpo: { motivo: 'Erro' } });
  it = (await chamar(a.env, 'GET', '/api/estoque', { cookie: a.recepcao })).dados.itens[0];
  assert.equal(it.consumo_medio_dia, 0); // venda e estorno se anulam
  assert.equal(it.media_validade_dias, 32.5); // (1*10 + 3*40) / 4 de novo
});

test('estoque: permissões — recepção cria entrada; finalizar continua só de veterinário/suporte; lista exige login', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  assert.equal((await chamar(a.env, 'GET', '/api/estoque')).status, 401);
  assert.equal((await entrada(a, p.id, { quantidade: 5, validade: dataEm(a, 90) }, a.recepcao)).status, 201);
  assert.equal((await chamar(a.env, 'POST', `/api/estoque/${p.id}/ajustes`, { cookie: a.recepcao, corpo: { delta: -1, motivo: 'Uso interno' } })).status, 200);
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Ana'));
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at}/finalizar`, { cookie: a.recepcao })).status, 200); // recepção pode finalizar
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at}/finalizar`, { cookie: a.filipe })).status, 409);
  // Detalhe: lotes e histórico com quem fez.
  const d = await estoqueDe(a, p.id);
  assert.equal(d.lotes.length, 1);
  assert.deepEqual(d.movimentos.map((m) => [m.tipo, m.usuario_nome]), [['ajuste', 'Recep'], ['entrada', 'Recep']]);
});

test('estoque: o registro de ações nunca guarda senha e todas as ações de estoque são registradas', async () => {
  const a = await ambiente();
  const p = await criarProduto(a);
  await entrada(a, p.id, { quantidade: 2 });
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Lia'));
  await contaPaga(a, at, [{ catalogo_id: p.id, quantidade: 1, origem: 'manual' }]);
  const acoes = bruto(a).prepare(`SELECT acao FROM registro_acoes WHERE acao LIKE '%estoque%' ORDER BY id`).all().map((x) => x.acao);
  assert.deepEqual(acoes, ['entrada_estoque', 'baixar_estoque_pedido']);
  assert.ok(!JSON.stringify(bruto(a).prepare('SELECT * FROM registro_acoes').all()).includes('pbkdf2'));
});

// ================= CONSULTA (tela cheia do veterinário) =================
test('consulta: veterinário recebe tudo o que a recepção preencheu; recepção não acessa', async () => {
  const a = await ambiente();
  const r = await chamar(a.env, 'POST', '/api/cadastro-rapido', { cookie: a.recepcao, corpo: { tutor: { nome: 'Carla', whatsapp: '(71) 97777-1234' }, pet: { nome: 'Pituca', especie: 'cao', raca: 'Poodle', sexo: 'femea', idade_anos: 4 }, chegada: { peso_kg: 7.3, motivo: 'Coceira', tipo: 'retorno', urgente: true, para_veterinario_id: a.ids.filipe } } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  const id = r.dados.atendimento.id;
  assert.equal((await chamar(a.env, 'GET', `/api/atendimentos/${id}/consulta`, { cookie: a.recepcao })).status, 403);
  const c = (await chamar(a.env, 'GET', `/api/atendimentos/${id}/consulta`, { cookie: a.filipe })).dados;
  assert.deepEqual([c.pet.nome, c.pet.raca, c.pet.sexo, c.tutor.nome, c.tutor.whatsapp], ['Pituca', 'Poodle', 'femea', 'Carla', '+5571977771234']);
  assert.deepEqual([c.atendimento.tipo, c.atendimento.urgente, c.atendimento.motivo, c.atendimento.para_veterinario.id], ['retorno', true, 'Coceira', a.ids.filipe]);
  assert.equal(c.peso.kg, 7.3);
  assert.ok(c.peso.em);
  assert.deepEqual([c.visitas_anteriores, c.internacao_atual, c.receita_desta_consulta], [[], null, null]);
  // Segunda visita: a primeira aparece no histórico.
  await chamar(a.env, 'POST', `/api/atendimentos/${id}/iniciar`, { cookie: a.filipe });
  await chamar(a.env, 'POST', `/api/atendimentos/${id}/finalizar`, { cookie: a.filipe });
  const at2 = await chegar(a, { id: r.dados.pet.id }, { peso_kg: 7.1 });
  const c2 = (await chamar(a.env, 'GET', `/api/atendimentos/${at2.id}/consulta`, { cookie: a.suporte })).dados;
  assert.deepEqual(c2.visitas_anteriores.map((v) => [v.id, v.tipo, v.peso_kg]), [[id, 'retorno', 7.3]]);
});

// ================= CARRINHO -> RECEITA =================
async function carrinhoComProdutos(a) {
  const at = await atendimentoEmAndamento(a, await novoPet(a, 'Toby'));
  const amox = await criarProduto(a, { nome: 'Amoxicilina', apresentacao: '250 mg · caixa com 10 comprimidos', preco_centavos: 4500 });
  const gotas = await criarProduto(a, { nome: 'Dipirona gotas', apresentacao: 'frasco 20 ml', preco_centavos: 1800, unidade: 'fr' });
  const salvo = await chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [
    { catalogo_id: amox.id, quantidade: 2, origem: 'manual' }, { catalogo_id: gotas.id, quantidade: 1, origem: 'manual' },
  ] } });
  assert.equal(salvo.status, 201);
  return { at, amox, gotas, totalConta: salvo.dados.pedido.total_centavos };
}

test('receita do carrinho: uma linha por produto, dose pela apresentação, valores marcados do_carrinho e sem cobrança em dobro', async () => {
  const a = await ambiente();
  const { at, amox, gotas, totalConta } = await carrinhoComProdutos(a);
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.recepcao })).status, 403);
  const r = await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  const rec = r.dados.receita;
  assert.deepEqual(rec.linhas.map((l) => [l.remedio, l.dose, l.do_carrinho, l.catalogo_id]), [['Amoxicilina', '250 mg', true, amox.id], ['Dipirona gotas', '20 ml', true, gotas.id]]);
  assert.deepEqual(rec.itens.map((i) => [i.temos, i.quantidade, i.valor_unitario_centavos, i.do_carrinho]), [[true, 2, 4500, true], [true, 1, 1800, true]]);
  assert.match(rec.texto, /Amoxicilina 250 mg/);
  // A conta não soma de novo os produtos da receita.
  const conta = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados;
  assert.deepEqual(conta.automaticos.receita, []);
  assert.equal(conta.pedido.total_centavos, totalConta);
  const hoje = (await chamar(a.env, 'GET', '/api/hoje', { cookie: a.filipe })).dados;
  assert.equal(hoje.em_atendimento.find((x) => x.id === at).produtos_centavos, 0); // "Produtos: R$" do cartão também não duplica
  // O veterinário escreve os detalhes e acrescenta uma linha fora do carrinho (essa continua cobrando).
  const linhas = rec.linhas.map((l, i) => ({ ...l, como: i ? '5 gotas' : '1 comprimido', intervalo: '12 h', duracao: '7 dias' }));
  linhas.push({ remedio: 'Probiótico', dose: '', como: '1 sachê', intervalo: '24 h', duracao: '5 dias', via: 'Uso oral', comprar: '1 CX', aplicado: false });
  const patch = await chamar(a.env, 'PATCH', `/api/receitas/${rec.id}`, { cookie: a.filipe, corpo: { linhas_json: linhas, texto: 'x' } });
  assert.equal(patch.status, 200);
  const itens = [
    { descricao: 'Amoxicilina 250 mg', temos: true, quantidade: 2, valor_unitario_centavos: 4500, do_carrinho: true, catalogo_id: amox.id },
    { descricao: 'Dipirona gotas 20 ml', temos: true, quantidade: 1, valor_unitario_centavos: 1800, do_carrinho: true, catalogo_id: gotas.id },
    { descricao: 'Probiótico', temos: true, quantidade: 1, valor_unitario_centavos: 3000 },
  ];
  assert.equal((await chamar(a.env, 'PUT', `/api/receitas/${rec.id}/itens`, { cookie: a.filipe, corpo: { itens } })).status, 200);
  const conta2 = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados;
  assert.deepEqual(conta2.automaticos.receita.map((i) => [i.descricao, i.quantidade, i.preco_unitario_centavos]), [['Probiótico', 1, 3000]]);
  // Mesmo que alguém envie a linha sem a marca do_carrinho, o produto do catálogo que já está na conta não é cobrado de novo.
  const sem = itens.map((i) => ({ ...i, do_carrinho: false }));
  await chamar(a.env, 'PUT', `/api/receitas/${rec.id}/itens`, { cookie: a.filipe, corpo: { itens: sem } });
  const conta3 = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados;
  assert.deepEqual(conta3.automaticos.receita.map((i) => i.descricao), ['Probiótico']);
  // Conta final: consulta + carrinho + probiótico (uma vez cada).
  const consulta = conta3.automaticos.consulta.preco_unitario_centavos;
  const atualizada = await chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [
    { descricao: 'c', quantidade: 1, preco_unitario_centavos: consulta, catalogo_id: conta3.automaticos.consulta.catalogo_id, origem: 'consulta' },
    ...conta3.pedido.itens.filter((i) => i.origem === 'manual').map((i) => ({ catalogo_id: i.catalogo_id, quantidade: i.quantidade, origem: 'manual' })),
    ...conta3.automaticos.receita,
  ] } });
  assert.equal(atualizada.dados.pedido.total_centavos, consulta + 2 * 4500 + 1800 + 3000);
});

test('receita do carrinho: chamar de novo não duplica, atualiza quantidade, acrescenta produto novo e tira o que saiu; texto livre e carrinho vazio são recusados', async () => {
  const a = await ambiente();
  const { at, amox, gotas } = await carrinhoComProdutos(a);
  const primeira = (await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe })).dados.receita;
  const de_novo = await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe });
  assert.equal(de_novo.status, 200);
  assert.equal(de_novo.dados.receita.id, primeira.id);
  assert.equal(de_novo.dados.receita.linhas.length, 2);
  // O veterinário já escreveu a posologia da primeira linha; ela é preservada.
  const linhas = primeira.linhas.map((l, i) => (i === 0 ? { ...l, como: '1 comprimido', intervalo: '12 h' } : l));
  await chamar(a.env, 'PATCH', `/api/receitas/${primeira.id}`, { cookie: a.filipe, corpo: { linhas_json: linhas } });
  const vacina = await criarProduto(a, { nome: 'Vacina V10', categoria: 'vacina', preco_centavos: 9000, controla_estoque: false });
  // Carrinho muda: amoxicilina 3, gotas sai, vacina entra.
  await chamar(a.env, 'PUT', `/api/atendimentos/${at}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [
    { catalogo_id: amox.id, quantidade: 3, origem: 'manual' }, { catalogo_id: vacina.id, quantidade: 1, origem: 'manual' }] } });
  const r3 = (await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe })).dados.receita;
  assert.deepEqual(r3.linhas.map((l) => [l.remedio, l.como, l.via]), [['Amoxicilina', '1 comprimido', 'Uso oral'], ['Vacina V10', '', 'Uso injetável']]);
  assert.deepEqual(r3.itens.map((i) => [i.descricao.slice(0, 11), i.quantidade, i.valor_unitario_centavos]), [['Amoxicilina', 3, 4500], ['Vacina V10', 1, 9000]]);
  assert.ok(!r3.linhas.some((l) => l.catalogo_id === gotas.id));
  // Carrinho vazio.
  const at2 = await atendimentoEmAndamento(a, await novoPet(a, 'Sem carrinho'));
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at2}/receita-do-carrinho`, { cookie: a.filipe })).status, 409);
  // Receita em texto livre (colada do WhatsApp) no mesmo atendimento: recusa em vez de misturar.
  const at3 = await atendimentoEmAndamento(a, await novoPet(a, 'Texto livre'));
  await chamar(a.env, 'PUT', `/api/atendimentos/${at3}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [{ catalogo_id: amox.id, quantidade: 1, origem: 'manual' }] } });
  const pet3 = bruto(a).prepare('SELECT pet_id FROM atendimentos WHERE id = ?').get(at3).pet_id;
  await chamar(a.env, 'POST', '/api/receitas', { cookie: a.filipe, corpo: { pet_id: pet3, atendimento_id: at3, texto: 'Dipirona 500 mg' } });
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at3}/receita-do-carrinho`, { cookie: a.filipe })).status, 409);
  // Exame no carrinho não vira linha de remédio.
  const ex = await criarProduto(a, { nome: 'Hemograma', categoria: 'exame', preco_centavos: 6000, controla_estoque: false });
  const at4 = await atendimentoEmAndamento(a, await novoPet(a, 'Exame'));
  await chamar(a.env, 'PUT', `/api/atendimentos/${at4}/pedido/itens`, { cookie: a.filipe, corpo: { itens: [{ catalogo_id: ex.id, quantidade: 1, origem: 'manual' }] } });
  assert.equal((await chamar(a.env, 'POST', `/api/atendimentos/${at4}/receita-do-carrinho`, { cookie: a.filipe })).status, 409);
});

test('receita do carrinho: salvar os produtos sem as marcas (tela antiga) não tira a marca do carrinho', async () => {
  const a = await ambiente();
  const { at } = await carrinhoComProdutos(a);
  const rec = (await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe })).dados.receita;
  const semMarcas = rec.itens.map((i) => ({ descricao: i.descricao, temos: true, quantidade: i.quantidade, valor_unitario_centavos: 9999 }));
  assert.equal((await chamar(a.env, 'PUT', `/api/receitas/${rec.id}/itens`, { cookie: a.filipe, corpo: { itens: semMarcas } })).status, 200);
  const depois = (await chamar(a.env, 'GET', `/api/receitas/${rec.id}`, { cookie: a.filipe })).dados.receita;
  assert.deepEqual(depois.itens.map((i) => i.do_carrinho), [true, true]);
  assert.deepEqual((await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados.automaticos.receita, []);
});

test('receita do carrinho: nova versão da receita mantém as marcas e continua sem cobrar em dobro', async () => {
  const a = await ambiente();
  const { at } = await carrinhoComProdutos(a);
  const rec = (await chamar(a.env, 'POST', `/api/atendimentos/${at}/receita-do-carrinho`, { cookie: a.filipe })).dados.receita;
  assert.equal((await chamar(a.env, 'POST', `/api/receitas/${rec.id}/liberar`, { cookie: a.filipe })).status, 200);
  const nova = await chamar(a.env, 'POST', `/api/receitas/${rec.id}/nova-versao`, { cookie: a.filipe });
  assert.equal(nova.status, 201);
  assert.deepEqual(nova.dados.receita.itens.map((i) => i.do_carrinho), [true, true]);
  assert.deepEqual((await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados.automaticos.receita, []);
});

test('doseDaApresentacao: pega a parte mg/ml da apresentação', async () => {
  const { doseDaApresentacao } = await import('../public/receita-linhas.js');
  assert.equal(doseDaApresentacao('250 mg · caixa com 10 comprimidos'), '250 mg');
  assert.equal(doseDaApresentacao('frasco 20 ml'), '20 ml');
  assert.equal(doseDaApresentacao('Solução 0,5 mg/ml · frasco'), '0,5 mg/ml');
  assert.equal(doseDaApresentacao('caixa com 10 comprimidos'), '');
  assert.equal(doseDaApresentacao(null), '');
  assert.equal(doseDaApresentacao('Pomada 15 g'), '15 g');
});
