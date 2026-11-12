// Conversor "colar do WhatsApp" → receita em colunas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrucaoDaLinha, linhasDoWhatsapp } from '../public/receita-linhas.js';

// Exemplo real enviado pela clínica (Dr. Filipe).
const EXEMPLO = `Uso oral
1 - Petsporin 300 mg
Administrar 1 comprimido a cada 12 horas, durante 7 dias. Após refeições.

2 - Carprofeno 75 mg
Administrar MEIO comprimido a cada 12 horas, durante 14 dias. Após refeições. 

3 - Sindolor 60/750 mg
Administrar MEIO comprimido a cada 8 horas, durante 5 dias.

4 - Megaton Artro
Administrar 1 comprimido a cada 24 horas, durante 30 dias.`;

test('whatsapp: exemplo real da clínica vira 4 linhas certinhas', () => {
  const { linhas, orientacoes } = linhasDoWhatsapp(EXEMPLO);
  const simples = linhas.map(({ remedio, dose, como, intervalo, duracao, via }) => ({ remedio, dose, como, intervalo, duracao, via }));
  assert.deepEqual(simples, [
    { remedio: 'Petsporin', dose: '300 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias. Após refeições', via: 'Uso oral' },
    { remedio: 'Carprofeno', dose: '75 mg', como: 'meio comprimido', intervalo: '12 h', duracao: '14 dias. Após refeições', via: 'Uso oral' },
    { remedio: 'Sindolor', dose: '60/750 mg', como: 'meio comprimido', intervalo: '8 h', duracao: '5 dias', via: 'Uso oral' },
    { remedio: 'Megaton Artro', dose: '', como: '1 comprimido', intervalo: '24 h', duracao: '30 dias', via: 'Uso oral' },
  ]);
  assert.equal(orientacoes, '');
  // No papel fica igual à mensagem do doutor.
  assert.equal(instrucaoDaLinha(linhas[0]), 'Administrar 1 comprimido a cada 12 h, durante 7 dias. Após refeições.');
});

test('whatsapp: via grudada na primeira linha e marcas do WhatsApp', () => {
  const { linhas } = linhasDoWhatsapp('Uso oral 1 - *Petsporin 300 mg*\nAdministrar 1 comprimido a cada 12 horas, durante 7 dias.');
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].remedio, 'Petsporin');
  assert.equal(linhas[0].dose, '300 mg');
});

test('whatsapp: formato do Word com quantidade a comprar e várias vias', () => {
  const { linhas } = linhasDoWhatsapp(`USO ORAL
1 - Doxiciclina 100 mg __________ 1 CX
Administrar 1 comprimido e meio a cada 12 horas, durante 28 dias.
USO INJETÁVEL
1 - Dexametasona 2 mg/ml ____ 1 FR
Aplicar 0,5 ml a cada 24 horas, durante 3 dias.`);
  assert.equal(linhas.length, 2);
  assert.deepEqual([linhas[0].remedio, linhas[0].dose, linhas[0].comprar, linhas[0].como, linhas[0].via], ['Doxiciclina', '100 mg', '1 CX', '1 comprimido e meio', 'Uso oral']);
  assert.deepEqual([linhas[1].remedio, linhas[1].dose, linhas[1].comprar, linhas[1].como, linhas[1].via], ['Dexametasona', '2 mg/ml', '1 FR', '0,5 ml', 'Uso injetável']);
});

test('whatsapp: tudo numa linha e jeitos curtos de escrever', () => {
  const { linhas } = linhasDoWhatsapp('- Amoxicilina 250mg - 1 comprimido 12/12h por 10 dias\n- Dipirona 500 mg 5 gotas 3x ao dia por 3 dias');
  assert.deepEqual(linhas.map((l) => [l.remedio, l.dose, l.como, l.intervalo, l.duracao]), [
    ['Amoxicilina', '250mg', '1 comprimido', '12 h', '10 dias'],
    ['Dipirona', '500 mg', '5 gotas', '8 h', '3 dias'],
  ]);
});

test('whatsapp: conversa e títulos viram orientações, nada se perde', () => {
  const { linhas, orientacoes } = linhasDoWhatsapp('Receita do Thor:\nOi, segue a receita\n1 - Petsporin 300 mg\nAdministrar 1 comprimido a cada 12 horas, durante 7 dias.\nRetorno em 10 dias');
  assert.equal(linhas.length, 1);
  assert.ok(orientacoes.includes('Receita do Thor:'));
  assert.ok(orientacoes.includes('Retorno em 10 dias'));
});
