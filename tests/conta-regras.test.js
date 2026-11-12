// Testes das regras da tela da conta (sem tela).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atualizarDaReceita, estadoDaConta, receitaDesatualizada, totalDosItens, trocoDe } from '../public/conta-regras.js';

const consulta = { descricao: 'Consulta (até 18h)', quantidade: 1, preco_unitario_centavos: 10000, catalogo_id: 1, origem: 'consulta' };
const dipirona = { descricao: 'Dipirona', quantidade: 2, preco_unitario_centavos: 4500, catalogo_id: null, origem: 'receita' };

test('troco: só em dinheiro com valor recebido que cobre o valor', () => {
  assert.equal(trocoDe(5000, 10000), 5000);
  assert.equal(trocoDe(5000, 5000), 0);
  assert.equal(trocoDe(5000, 4000), null);
  assert.equal(trocoDe(5000, null), null);
  assert.equal(trocoDe(null, 100), null);
});

test('estado da conta e total', () => {
  assert.deepEqual(estadoDaConta({ status: 'aberto' }), { tipo: 'aberta', texto: 'aberta' });
  assert.equal(estadoDaConta({ status: 'aguardando_pagamento' }).tipo, 'aguardando');
  assert.equal(estadoDaConta({ status: 'pago' }).texto, 'Pago ✓');
  assert.equal(totalDosItens([consulta, dipirona]), 19000);
});

test('atualizar da receita: troca consulta e produtos da receita, mantém os itens manuais', () => {
  const manual = { descricao: 'Vacina', quantidade: 1, preco_unitario_centavos: 9000, catalogo_id: 5, origem: 'manual' };
  const antigos = [{ ...consulta, preco_unitario_centavos: 99 }, { ...dipirona, descricao: 'Antiga' }, manual];
  const novos = atualizarDaReceita(antigos, { consulta, receita: [dipirona] });
  assert.deepEqual(novos.map((i) => [i.descricao, i.origem]), [['Consulta (até 18h)', 'consulta'], ['Dipirona', 'receita'], ['Vacina', 'manual']]);
  assert.equal(novos[0].preco_unitario_centavos, 10000);
});

test('receita desatualizada: detecta produto novo, valor mudado ou consulta com outro preço', () => {
  const auto = { consulta, receita: [dipirona] };
  assert.equal(receitaDesatualizada([consulta, dipirona], auto), false);
  assert.equal(receitaDesatualizada([consulta], auto), true);
  assert.equal(receitaDesatualizada([consulta, { ...dipirona, preco_unitario_centavos: 1 }], auto), true);
  assert.equal(receitaDesatualizada([{ ...consulta, preco_unitario_centavos: 20000 }, dipirona], auto), true);
  assert.equal(receitaDesatualizada([dipirona], auto), false); // consulta removida de propósito não incomoda
});
