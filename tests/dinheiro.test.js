// Testes do dinheiro (digitar/mostrar valores) e da lista de produtos montada a partir do texto da receita.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatarReais, lerReais, reaisParaCampo } from '../public/dinheiro.js';
import { itensDoTexto, rotuloDaLinha } from '../public/produtos-receita.js';

test('lerReais: aceita os jeitos comuns de digitar', () => {
  assert.equal(lerReais('85'), 8500);
  assert.equal(lerReais('85,00'), 8500);
  assert.equal(lerReais('85,5'), 8550);
  assert.equal(lerReais('85.5'), 8550);
  assert.equal(lerReais('1.234,50'), 123450);
  assert.equal(lerReais('1234.50'), 123450);
  assert.equal(lerReais('R$ 85,00'), 8500);
  assert.equal(lerReais(' 0,99 '), 99);
  assert.equal(lerReais('0'), 0);
});

test('lerReais: vazio e inválido viram null', () => {
  for (const t of ['abc', '', '   ', '-5', '1,234,5', '85,555', ',5', '.5', '1.2.3', '8 5x', null, undefined, 85]) assert.equal(lerReais(t), null, String(t));
});

test('formatarReais e reaisParaCampo', () => {
  assert.equal(formatarReais(123450), 'R$ 1.234,50');
  assert.equal(formatarReais(0), 'R$ 0,00');
  assert.equal(formatarReais(8500), 'R$ 85,00');
  assert.equal(reaisParaCampo(8550), '85,50');
  assert.equal(reaisParaCampo(null), '');
  assert.equal(lerReais(reaisParaCampo(123450)), 123450);
});

test('rotuloDaLinha tira marcadores de lista e marcas do WhatsApp', () => {
  assert.equal(rotuloDaLinha('- *Dipirona* 500 mg _(1 cp)_'), 'Dipirona 500 mg (1 cp)');
  assert.equal(rotuloDaLinha('1. Amoxicilina 250 mg'), 'Amoxicilina 250 mg');
  assert.equal(rotuloDaLinha('1.5 mL de xarope'), '1.5 mL de xarope');
  assert.equal(rotuloDaLinha('nome_do_arquivo ok'), 'nome_do_arquivo ok');
});

test('itensDoTexto: uma linha por produto, guarda escolhas, linhas novas começam como Não', () => {
  const vazio = itensDoTexto('Dipirona\n\n  \n- Cefalexina\n*Omeprazol*');
  assert.deepEqual(vazio.map((x) => [x.descricao, x.temos]), [['Dipirona', false], ['Cefalexina', false], ['Omeprazol', false]]);
  const antes = vazio.map((x) => ({ ...x }));
  antes[0].temos = true; antes[0].valor = '85'; antes[0].qtd = '2';
  const depois = itensDoTexto('Novo remédio\nDIPIRONA\nCefalexina', antes); // outra ordem, maiúsculas
  assert.deepEqual(depois[1], { descricao: 'DIPIRONA', temos: true, qtd: '2', valor: '85' });
  assert.equal(depois[0].temos, false);
  // Erro de digitação corrigido na mesma linha mantém a escolha; linha trocada por outro produto não.
  const base = [{ descricao: 'Dipiron', temos: true, qtd: '1', valor: '85' }];
  assert.equal(itensDoTexto('Dipirona', base)[0].valor, '85');
  assert.equal(itensDoTexto('Cefalexina 500 mg', base)[0].temos, false);
});
