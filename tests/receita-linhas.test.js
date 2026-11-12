// Testes das regras puras da receita em colunas (public/receita-linhas.js, o mesmo código do app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linhaDaReceita, linhaVazia, separarRemedioDose, textoDasLinhas } from '../public/receita-linhas.js';

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

test('texto da receita: uma linha por remédio, pulando as vazias', () => {
  const t = textoDasLinhas([amox, linhaVazia(), { ...linhaVazia(), remedio: 'Dipirona', dose: '500 mg', como: '10 gotas', intervalo: '8 h', duracao: '3 dias' }]);
  assert.equal(t, '*Amoxicilina 250 mg* — 1 comprimido a cada 12 h por 7 dias\n*Dipirona 500 mg* — 10 gotas a cada 8 h por 3 dias');
  assert.equal(textoDasLinhas([]), '');
  assert.equal(textoDasLinhas(null), '');
});

test('separar sugestão em remédio e dose', () => {
  assert.deepEqual(separarRemedioDose('Amoxicilina 250 mg'), { remedio: 'Amoxicilina', dose: '250 mg' });
  assert.deepEqual(separarRemedioDose('Dipirona 500mg'), { remedio: 'Dipirona', dose: '500mg' });
  assert.deepEqual(separarRemedioDose('Meloxicam 0,5 mg/ml'), { remedio: 'Meloxicam', dose: '0,5 mg/ml' });
  assert.deepEqual(separarRemedioDose('Omeprazol'), { remedio: 'Omeprazol', dose: '' });
  assert.deepEqual(separarRemedioDose('Vitamina C 2 vezes'), { remedio: 'Vitamina C 2 vezes', dose: '' });
});
