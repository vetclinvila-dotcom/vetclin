// Testes das regras puras da receita em colunas (public/receita-linhas.js, o mesmo código do app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gruposDasLinhas, instrucaoDaLinha, linhaDaReceita, linhaVazia, separarRemedioDose, textoDasLinhas } from '../public/receita-linhas.js';

const amox = { remedio: 'Amoxicilina', dose: '250 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias' };

test('linha completa: negrito no remédio + dose e a posologia', () => {
  assert.equal(linhaDaReceita(amox), '*Amoxicilina 250 mg* — 1 comprimido a cada 12 h por 7 dias');
});

test('sem marcas: igual, mas sem asteriscos (descrição do produto)', () => {
  assert.equal(linhaDaReceita(amox, { marcas: false }), 'Amoxicilina 250 mg — 1 comprimido a cada 12 h por 7 dias');
});

test('partes que faltam são puladas sem sobrar espaço ou traço', () => {
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'Dipirona', como: '10 gotas' }), '*Dipirona* — 10 gotas');
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'Dipirona', dose: '500 mg' }), '*Dipirona 500 mg*');
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'Dipirona', intervalo: '8 h', duracao: '3 dias' }), '*Dipirona* — a cada 8 h por 3 dias');
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'Dipirona', duracao: '3 dias' }), '*Dipirona* — por 3 dias');
});

test('sem remédio mas com posologia: sai só a posologia, sem negrito', () => {
  assert.equal(linhaDaReceita({ ...linhaVazia(), como: 'Dar ração úmida', duracao: '5 dias' }), 'Dar ração úmida por 5 dias');
});

test('linha vazia (ou só espaços) vira texto vazio', () => {
  assert.equal(linhaDaReceita(linhaVazia()), '');
  assert.equal(linhaDaReceita({ remedio: '  ', dose: ' ' }), '');
  assert.equal(linhaDaReceita(undefined), '');
});

test('intervalo e duração em palavras não ganham "a cada"/"por"', () => {
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'X', intervalo: 'manhã e noite', duracao: 'uso contínuo' }), '*X* — manhã e noite uso contínuo');
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: 'X', intervalo: 'a cada 12 h' }), '*X* — a cada 12 h');
});

test('asteriscos e quebras de linha digitados não quebram o negrito', () => {
  assert.equal(linhaDaReceita({ ...linhaVazia(), remedio: '*Amox*\nicilina', dose: ' 250   mg ' }), '*Amox icilina 250 mg*');
});

test('texto da receita: agrupado por via, numerado, com "comprar" e a instrução; linhas vazias puladas', () => {
  const t = textoDasLinhas([
    { ...amox, via: 'Uso oral', comprar: '1 CX' },
    linhaVazia(),
    { ...linhaVazia(), remedio: 'Otomax', como: 'Aplicar 5 gotas em cada ouvido', intervalo: '12 h', duracao: '10 dias', via: 'Uso otológico', comprar: '1 FR' },
    { ...linhaVazia(), remedio: 'Dipirona', dose: '500 mg', como: '10 gotas', intervalo: '8 h', duracao: '3 dias' },
  ]);
  assert.equal(t, [
    'USO ORAL',
    '1 - *Amoxicilina 250 mg* ... 1 CX',
    'Administrar 1 comprimido a cada 12 h, durante 7 dias.',
    '2 - *Dipirona 500 mg*',
    'Administrar 10 gotas a cada 8 h, durante 3 dias.',
    '',
    'USO OTOLÓGICO',
    '1 - *Otomax* ... 1 FR',
    'Aplicar 5 gotas em cada ouvido a cada 12 h, durante 10 dias.',
  ].join('\n'));
  assert.equal(textoDasLinhas([]), '');
  assert.equal(textoDasLinhas(null), '');
});

test('gruposDasLinhas: separa por via na ordem de aparição e numera dentro de cada grupo', () => {
  const g = gruposDasLinhas([
    { remedio: 'Doxiciclina', dose: '100 mg', como: '1 comprimido e meio', intervalo: '12 horas', duracao: '28 dias', via: 'Uso oral', comprar: '1 CX' },
    { remedio: 'Ceftriaxona', via: 'Uso injetável', comprar: '1 FR' },
    { remedio: 'Prednisolona', dose: '20 mg', como: 'meio comprimido', intervalo: '24 horas', duracao: '10 dias', via: 'uso oral', comprar: '1 CX' },
  ]);
  assert.deepEqual(g, [
    { via: 'USO ORAL', itens: [
      { n: 1, titulo: 'Doxiciclina 100 mg', comprar: '1 CX', instrucao: 'Administrar 1 comprimido e meio a cada 12 horas, durante 28 dias.' },
      { n: 2, titulo: 'Prednisolona 20 mg', comprar: '1 CX', instrucao: 'Administrar meio comprimido a cada 24 horas, durante 10 dias.' },
    ] },
    { via: 'USO INJETÁVEL', itens: [{ n: 1, titulo: 'Ceftriaxona', comprar: '1 FR', instrucao: '' }] },
  ]);
});

test('via ausente (receita antiga) vale "Uso oral"; "Outro" usa o texto livre em maiúsculas', () => {
  assert.equal(gruposDasLinhas([{ remedio: 'X', como: '1 cp' }])[0].via, 'USO ORAL');
  assert.equal(gruposDasLinhas([{ remedio: 'X', via: '   ' }])[0].via, 'USO ORAL');
  assert.equal(gruposDasLinhas([{ remedio: 'Shampoo', via: 'Banho' }])[0].via, 'BANHO');
  assert.deepEqual(gruposDasLinhas([linhaVazia(), { ...linhaVazia(), via: 'Uso tópico' }]), []);
});

test('instrução: pula partes que faltam e não repete o verbo', () => {
  assert.equal(instrucaoDaLinha({ como: '1 comprimido' }), 'Administrar 1 comprimido.');
  assert.equal(instrucaoDaLinha({ como: '1 comprimido', duracao: '5 dias' }), 'Administrar 1 comprimido, durante 5 dias.');
  assert.equal(instrucaoDaLinha({ intervalo: '12 h', duracao: '5 dias' }), 'Administrar a cada 12 h, durante 5 dias.');
  assert.equal(instrucaoDaLinha({ como: 'Dar 1 sachê', intervalo: '24 h' }), 'Dar 1 sachê a cada 24 h.');
  assert.equal(instrucaoDaLinha({ como: 'Pingar 3 gotas.' }), 'Pingar 3 gotas.');
  assert.equal(instrucaoDaLinha({ como: 'aplicar fina camada', duracao: 'uso contínuo' }), 'aplicar fina camada, uso contínuo.');
  assert.equal(instrucaoDaLinha({ remedio: 'X' }), '');
});

test('separar sugestão em remédio e dose', () => {
  assert.deepEqual(separarRemedioDose('Amoxicilina 250 mg'), { remedio: 'Amoxicilina', dose: '250 mg' });
  assert.deepEqual(separarRemedioDose('Dipirona 500mg'), { remedio: 'Dipirona', dose: '500mg' });
  assert.deepEqual(separarRemedioDose('Meloxicam 0,5 mg/ml'), { remedio: 'Meloxicam', dose: '0,5 mg/ml' });
  assert.deepEqual(separarRemedioDose('Omeprazol'), { remedio: 'Omeprazol', dose: '' });
  assert.deepEqual(separarRemedioDose('Vitamina C 2 vezes'), { remedio: 'Vitamina C 2 vezes', dose: '' });
});

test('nomeComDose não repete a dose que já está no nome do produto', async () => {
  const { nomeComDose, gruposDasLinhas } = await import('../public/receita-linhas.js');
  assert.equal(nomeComDose('Amoxicilina 250 mg', '250 mg'), 'Amoxicilina 250 mg');
  assert.equal(nomeComDose('Amoxicilina 250mg', '250 mg'), 'Amoxicilina 250mg');
  assert.equal(nomeComDose('Amoxicilina', '250 mg'), 'Amoxicilina 250 mg');
  assert.equal(nomeComDose('Dipirona', ''), 'Dipirona');
  const g = gruposDasLinhas([{ remedio: 'Amoxicilina 250 mg', dose: '250 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias' }]);
  assert.equal(g[0].itens[0].titulo, 'Amoxicilina 250 mg');
});
