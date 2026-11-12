// Testes do carrinho de produtos da conta: regras puras (public/carrinho.js) e a conta pela API de itens que o app usa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adicionarProduto, filtrarProdutos, produtosDoCarrinho, quantidadeNoCarrinho, removerUmProduto, resumoCarrinho } from '../public/carrinho.js';
import { formatarDuracao, inicioBahiaParaISO, isoParaCampoBahia, pilulaProxima, resumoInternados, tempoInternado, textoIntervalo, textoStatusMedicacao } from '../public/internacao-regras.js';
import { ambiente, atendimentoEmAndamento, chamar, novoPet } from './apoio-clinico.js';

const v10 = { id: 5, nome: 'Vacina V10', preco_centavos: 9000 };
const consulta = { descricao: 'Consulta', quantidade: 1, preco_unitario_centavos: 10000, catalogo_id: 1, origem: 'consulta' };

test('carrinho: tocar soma 1 (cria a linha, depois soma na mesma) e não altera a lista original', () => {
  const vazio = [consulta];
  const um = adicionarProduto(vazio, v10);
  assert.equal(vazio.length, 1); // original intacto
  assert.deepEqual(um[1], { descricao: 'Vacina V10', quantidade: 1, preco_unitario_centavos: 9000, catalogo_id: 5, origem: 'manual' });
  const dois = adicionarProduto(um, v10);
  assert.equal(dois.length, 2);
  assert.equal(dois[1].quantidade, 2);
  assert.equal(um[1].quantidade, 1);
  assert.equal(quantidadeNoCarrinho(dois, 5), 2);
  assert.equal(quantidadeNoCarrinho(dois, 99), 0);
  // A consulta (origem "consulta", mesmo com catalogo_id) nunca é confundida com um produto.
  assert.equal(quantidadeNoCarrinho(dois, 1), 0);
  assert.deepEqual(resumoCarrinho(dois), { quantidade: 3, total_centavos: 10000 + 2 * 9000 });
  assert.deepEqual(resumoCarrinho([]), { quantidade: 0, total_centavos: 0 });
  // Limite de 999 unidades (igual à API).
  assert.equal(adicionarProduto([{ ...um[1], quantidade: 999 }], v10)[0].quantidade, 999);
});

test('carrinho: "−" tira 1; na última unidade a linha sai; produto que não está na conta não muda nada', () => {
  let itens = adicionarProduto(adicionarProduto([consulta], v10), v10);
  itens = removerUmProduto(itens, 5);
  assert.equal(quantidadeNoCarrinho(itens, 5), 1);
  itens = removerUmProduto(itens, 5);
  assert.deepEqual(itens, [consulta]);
  assert.deepEqual(removerUmProduto(itens, 5), [consulta]);
  // Item digitado à mão (sem catálogo) não é tocado.
  const livre = { descricao: 'Taxa', quantidade: 2, preco_unitario_centavos: 500, catalogo_id: null, origem: 'manual' };
  assert.deepEqual(removerUmProduto([livre], 5), [livre]);
});

test('carrinho: a consulta fica fora dos botões; filtro por categoria e busca sem acento', () => {
  const cat = [
    { id: 1, nome: 'Consulta (até o horário de corte)', categoria: 'consulta', preco_centavos: 10000, ativo: true },
    { id: 2, nome: 'Vacina V10', categoria: 'vacina', preco_centavos: 9000, ativo: true },
    { id: 3, nome: 'Vacina Antirrábica', categoria: 'vacina', preco_centavos: 6000, ativo: true },
    { id: 4, nome: 'Ração Sênior 1 kg', categoria: 'produto', preco_centavos: 3500, ativo: true },
    { id: 5, nome: 'Antigo', categoria: 'produto', preco_centavos: 100, ativo: false },
  ];
  const p = produtosDoCarrinho(cat);
  assert.deepEqual(p.map((x) => x.id), [2, 3, 4]);
  assert.deepEqual(filtrarProdutos(p, { categoria: 'vacina' }).map((x) => x.id), [2, 3]);
  assert.deepEqual(filtrarProdutos(p, { busca: 'racao senior' }).map((x) => x.id), [4]);
  assert.deepEqual(filtrarProdutos(p, { busca: 'ANTIRRABICA', categoria: 'vacina' }).map((x) => x.id), [3]);
  assert.deepEqual(filtrarProdutos(p, { busca: 'zzz' }), []);
  assert.deepEqual(filtrarProdutos(p).map((x) => x.id), [2, 3, 4]);
});

// ---------- pela API de itens que o app usa (PUT .../pedido/itens) ----------
async function catalogar(a, nome, categoria, preco) {
  const r = await chamar(a.env, 'POST', '/api/catalogo', { cookie: a.filipe, corpo: { nome, categoria, preco_centavos: preco } });
  assert.equal(r.status, 201);
  return r.dados;
}
const paraEnvio = (lista) => lista.map(({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }) => ({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }));

test('carrinho pela API: tocar duas vezes vira quantidade 2 e o total acompanha; pago não aceita mais', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const at = await atendimentoEmAndamento(a, pet);
  const v = await catalogar(a, 'Vacina V10', 'vacina', 9000);
  const r = await catalogar(a, 'Ração 1 kg', 'produto', 3500);
  const url = `/api/atendimentos/${at}/pedido/itens`;

  // Abre a conta (rascunho calculado: já traz a consulta) e vai tocando nos produtos.
  const rascunho = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados;
  assert.equal(rascunho.pedido.rascunho, true);
  let itens = rascunho.pedido.itens;
  const consultaValor = itens[0].subtotal_centavos;
  itens = adicionarProduto(itens, { id: v.id, nome: v.nome, preco_centavos: v.preco_centavos });
  itens = adicionarProduto(itens, { id: r.id, nome: r.nome, preco_centavos: r.preco_centavos });
  let put = await chamar(a.env, 'PUT', url, { cookie: a.filipe, corpo: { itens: paraEnvio(itens) } });
  assert.equal(put.status, 201);
  assert.equal(put.dados.pedido.total_centavos, consultaValor + 9000 + 3500);
  itens = adicionarProduto(put.dados.pedido.itens, { id: v.id, nome: v.nome, preco_centavos: v.preco_centavos });
  put = await chamar(a.env, 'PUT', url, { cookie: a.filipe, corpo: { itens: paraEnvio(itens) } });
  assert.equal(put.status, 200);
  const linha = put.dados.pedido.itens.find((i) => i.catalogo_id === v.id);
  assert.equal(linha.quantidade, 2);
  assert.equal(put.dados.pedido.itens.length, 3);
  assert.equal(put.dados.pedido.total_centavos, consultaValor + 2 * 9000 + 3500);
  // "−": tira uma vacina; tira a ração de vez.
  itens = removerUmProduto(removerUmProduto(put.dados.pedido.itens, v.id), r.id);
  put = await chamar(a.env, 'PUT', url, { cookie: a.filipe, corpo: { itens: paraEnvio(itens) } });
  assert.equal(put.dados.pedido.total_centavos, consultaValor + 9000);
  assert.deepEqual(put.dados.pedido.itens.map((i) => [i.descricao, i.quantidade]).slice(1), [['Vacina V10', 1]]);
  // A recepção também pode abrir o carrinho (qualquer pessoa da equipe edita a conta).
  assert.equal((await chamar(a.env, 'PUT', url, { cookie: a.recepcao, corpo: { itens: paraEnvio(adicionarProduto(put.dados.pedido.itens, { id: r.id, nome: r.nome, preco_centavos: 3500 })) } })).status, 200);

  // Depois de paga, a conta não aceita mais itens (a tela mostra os botões desativados).
  const ped = put.dados.pedido.id;
  const total = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados.pedido.total_centavos;
  assert.equal((await chamar(a.env, 'POST', `/api/pedidos/${ped}/pagamentos`, { cookie: a.recepcao, corpo: { forma: 'pix', valor_centavos: total } })).status, 201);
  const depois = await chamar(a.env, 'PUT', url, { cookie: a.filipe, corpo: { itens: paraEnvio(adicionarProduto(put.dados.pedido.itens, v)) } });
  assert.equal(depois.status, 409);
  const ver = (await chamar(a.env, 'GET', `/api/atendimentos/${at}/pedido`, { cookie: a.filipe })).dados;
  assert.equal(ver.pedido.pode_editar, false);
});

// ---------- textos da internação ----------
test('textos da internação: duração, dias, intervalo e pílulas de cor', () => {
  assert.equal(formatarDuracao(20), '20 min');
  assert.equal(formatarDuracao(60), '1 h');
  assert.equal(formatarDuracao(125), '2 h 05 min');
  assert.equal(formatarDuracao(-5), '0 min');
  assert.equal(tempoInternado(0), 'há menos de 1 h');
  assert.equal(tempoInternado(5), 'há 5 h');
  assert.equal(tempoInternado(24), 'há 1 dia');
  assert.equal(tempoInternado(51), 'há 2 dias e 3 h');
  assert.equal(textoIntervalo(8), 'a cada 8 h');
  assert.equal(textoIntervalo(0.5), 'a cada 30 min');
  assert.equal(textoIntervalo(1.5), 'a cada 1,5 h');
  const hora = () => '14:00';
  assert.deepEqual(pilulaProxima({ remedio: 'Dipirona', status: 'atrasada', minutos_ate_proxima: -20 }, hora), { classe: 'atrasada', texto: 'Atrasada: Dipirona há 20 min' });
  assert.deepEqual(pilulaProxima({ remedio: 'Dipirona', status: 'agora', minutos_ate_proxima: 3 }, hora), { classe: 'agora', texto: 'Agora: Dipirona' });
  assert.deepEqual(pilulaProxima({ remedio: 'Dipirona', status: 'futura', minutos_ate_proxima: 130 }, hora), { classe: 'futura', texto: 'Próxima 14:00 — Dipirona' });
  assert.equal(textoStatusMedicacao({ situacao: 'ativa', status: 'futura', minutos_ate_proxima: 250 }, hora).texto, '14:00 · em 4 h 10 min');
  assert.equal(textoStatusMedicacao({ situacao: 'concluida' }, hora).texto, 'Tratamento concluído');
  assert.equal(resumoInternados({ internados: 2, medicacoes_atrasadas: 1, medicacoes_agora: 0 }), 'Internados: 2 · 1 medicação atrasada');
  assert.equal(resumoInternados({ internados: 3, medicacoes_atrasadas: 2, medicacoes_agora: 1 }), 'Internados: 3 · 2 medicações atrasadas · 1 medicação na hora');
  assert.equal(resumoInternados({ internados: 1 }), 'Internados: 1');
});

test('horário digitado vale no relógio de Bahia (UTC-03:00) e volta igual', () => {
  assert.equal(inicioBahiaParaISO('2026-11-10T09:30'), '2026-11-10T12:30:00.000Z');
  assert.equal(inicioBahiaParaISO('2026-11-10T23:30'), '2026-11-11T02:30:00.000Z');
  assert.equal(isoParaCampoBahia('2026-11-11T02:30:00.000Z'), '2026-11-10T23:30');
  assert.equal(inicioBahiaParaISO(''), null);
  assert.equal(inicioBahiaParaISO('10/11/2026 09:30'), null);
});
