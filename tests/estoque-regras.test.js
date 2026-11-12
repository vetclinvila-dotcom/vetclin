import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatarDataIso, formatarQuantidade, lerQuantidadeDigitada, linkTelefoneDe, linkWhatsappDe, textoDura, textoMedia, textoRestam, textoValidade } from '../public/estoque-regras.js';

test('validade: laranja com 30 dias ou menos, vermelho vencido, normal acima', () => {
  assert.deepEqual(textoValidade(12), { texto: 'vence em 12 dias', classe: 'perto' });
  assert.deepEqual(textoValidade(30), { texto: 'vence em 30 dias', classe: 'perto' });
  assert.deepEqual(textoValidade(31), { texto: 'vence em 31 dias', classe: 'ok' });
  assert.deepEqual(textoValidade(1), { texto: 'vence em 1 dia', classe: 'perto' });
  assert.deepEqual(textoValidade(0), { texto: 'vence hoje', classe: 'perto' });
  assert.deepEqual(textoValidade(-1), { texto: 'vencido há 1 dia', classe: 'vencido' });
  assert.deepEqual(textoValidade(-5), { texto: 'vencido há 5 dias', classe: 'vencido' });
  assert.deepEqual(textoValidade(null), { texto: 'sem validade', classe: 'sem' });
});

test('quantidade digitada: vírgula, 3 casas, maior que zero', () => {
  assert.equal(lerQuantidadeDigitada('2,5'), 2.5);
  assert.equal(lerQuantidadeDigitada(' 10 '), 10);
  assert.equal(lerQuantidadeDigitada('0'), null);
  assert.equal(lerQuantidadeDigitada('-1'), null);
  assert.equal(lerQuantidadeDigitada('1,2345'), null);
  assert.equal(lerQuantidadeDigitada('abc'), null);
  assert.equal(lerQuantidadeDigitada(''), null);
  assert.equal(formatarQuantidade(2.5), '2,5');
  assert.equal(formatarQuantidade(7), '7');
});

test('textos do estoque: dura, média, restam, data e links', () => {
  assert.equal(textoDura({ dura_dias: 35, total: 7 }), 'dura cerca de 35 dias');
  assert.equal(textoDura({ dura_dias: 1, total: 1 }), 'dura cerca de 1 dia');
  assert.equal(textoDura({ dura_dias: null, total: 7 }), 'sem vendas nos últimos 30 dias');
  assert.equal(textoDura({ dura_dias: null, total: 0 }), '');
  assert.equal(textoMedia({ media_validade_dias: 25 }), 'média de validade: 25 dias');
  assert.equal(textoMedia({ media_validade_dias: null }), '');
  assert.equal(textoRestam({ controla_estoque: false }), null);
  assert.deepEqual(textoRestam({ controla_estoque: true, estoque_total: 0 }), { texto: 'sem estoque', classe: 'zerado' });
  assert.deepEqual(textoRestam({ controla_estoque: true, estoque_total: 8 }), { texto: 'restam 8', classe: 'ok' });
  assert.deepEqual(textoRestam({ controla_estoque: true, estoque_total: 2.5 }), { texto: 'restam 2,5', classe: 'pouco' });
  assert.equal(formatarDataIso('2027-01-31'), '31/01/2027');
  assert.equal(formatarDataIso(null), '');
  assert.equal(linkWhatsappDe('+5571999998888'), 'https://wa.me/5571999998888');
  assert.equal(linkTelefoneDe('+5571999998888'), 'tel:+5571999998888');
  assert.equal(linkWhatsappDe(null), '');
});
