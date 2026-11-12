// Testes do gerador de QR Code: estrutura da matriz, bits de formato/versão e códigos Reed-Solomon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitsDeFormato, bitsDeVersao, gerarQr, qrParaSvg, reedSolomon } from '../public/qr.js';
import { payloadPix } from '../public/pix.js';

// Referência independente: divisão de polinômios no GF(256) feita "na unha" (multiplicação bit a bit, sem tabelas).
function mulGF(a, b) {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11D; b >>= 1; }
  return r;
}
function referenciaRS(dados, grau) {
  // gerador = (x - 1)(x - 2)(x - 4)... com coeficientes do maior grau para o menor
  let gerador = [1];
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    const prox = new Array(gerador.length + 1).fill(0);
    gerador.forEach((c, j) => { prox[j] ^= c; prox[j + 1] ^= mulGF(c, raiz); });
    gerador = prox;
    raiz = mulGF(raiz, 2);
  }
  // divide (dados · x^grau) pelo gerador e devolve o resto
  const poli = [...dados, ...new Array(grau).fill(0)];
  for (let i = 0; i < dados.length; i++) {
    const f = poli[i];
    if (f) gerador.forEach((c, j) => { poli[i + j] ^= mulGF(c, f); });
  }
  return poli.slice(dados.length);
}

test('Reed-Solomon: exemplo conhecido (HELLO WORLD, versão 1-M)', () => {
  const dados = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(dados, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.deepEqual(referenciaRS(dados, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('Reed-Solomon: igual à divisão de polinômios independente para vários tamanhos', () => {
  let semente = 7;
  const aleatorio = () => (semente = (semente * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  for (const grau of [10, 16, 18, 22, 24, 26, 30]) {
    for (const n of [1, 16, 28, 44, 51]) {
      const dados = Array.from({ length: n }, aleatorio);
      assert.deepEqual(reedSolomon(dados, grau), referenciaRS(dados, grau), `grau ${grau}, ${n} bytes`);
    }
  }
});

// Confere o BCH de um código de formato/versão: o resto da divisão pelo polinômio gerador tem que ser 0.
function restoBCH(valor, gerador, bitsGerador) {
  let r = valor;
  for (let i = 31; i >= bitsGerador - 1; i--) if ((r >>> i) & 1) r ^= gerador << (i - (bitsGerador - 1));
  return r;
}

test('bits de formato (nível M) e de versão: BCH válido e valores conhecidos', () => {
  for (let m = 0; m < 8; m++) assert.equal(restoBCH(bitsDeFormato(m) ^ 0x5412, 0x537, 11), 0, `máscara ${m}`);
  assert.equal(bitsDeFormato(0), 0b101010000010010); // nível M, máscara 0 (tabela da norma)
  for (let v = 7; v <= 15; v++) assert.equal(restoBCH(bitsDeVersao(v), 0x1F25, 13), 0, `versão ${v}`);
  assert.equal(bitsDeVersao(7), 0b000111110010010100); // tabela da norma
  assert.equal(bitsDeVersao(8), 0b001000010110111100);
});

const escuro = (q, x, y) => q.modulos[y][x];

function conferirLocalizador(q, ox, oy) {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const borda = dx === 0 || dx === 6 || dy === 0 || dy === 6;
    const centro = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
    assert.equal(escuro(q, ox + dx, oy + dy), borda || centro, `localizador em ${ox},${oy} (${dx},${dy})`);
  }
}

test('estrutura: tamanho = 17 + 4·versão, localizadores, temporização e módulo escuro', () => {
  const textos = ['A', 'HELLO WORLD', 'x'.repeat(30), 'y'.repeat(100), 'z'.repeat(200), payloadPix({ chave: '52998224725', nome: 'VETCLIN', cidade: 'BARCARENA', valorCentavos: 9500, txid: 'VC1P1' }), 'w'.repeat(400)];
  const versoes = new Set();
  for (const t of textos) {
    const q = gerarQr(t);
    versoes.add(q.versao);
    assert.equal(q.tamanho, 17 + 4 * q.versao);
    assert.equal(q.modulos.length, q.tamanho);
    assert.ok(q.modulos.every((l) => l.length === q.tamanho));
    conferirLocalizador(q, 0, 0);
    conferirLocalizador(q, q.tamanho - 7, 0);
    conferirLocalizador(q, 0, q.tamanho - 7);
    for (let i = 8; i < q.tamanho - 8; i++) {
      assert.equal(escuro(q, i, 6), i % 2 === 0, 'temporização horizontal');
      assert.equal(escuro(q, 6, i), i % 2 === 0, 'temporização vertical');
    }
    assert.equal(escuro(q, 8, q.tamanho - 8), true, 'módulo escuro fixo');
    // faixa clara em volta dos localizadores
    for (let i = 0; i < 8; i++) { assert.equal(escuro(q, 7, i), false); assert.equal(escuro(q, i, 7), false); }
  }
  assert.ok(versoes.size >= 5);
});

test('versão escolhida é a menor que cabe (nível M, modo bytes)', () => {
  assert.equal(gerarQr('a'.repeat(14)).versao, 1); // 1-M leva 14 bytes
  assert.equal(gerarQr('a'.repeat(15)).versao, 2);
  assert.equal(gerarQr('a'.repeat(26)).versao, 2); // 2-M leva 26
  assert.equal(gerarQr('a'.repeat(27)).versao, 3);
  assert.equal(gerarQr('a'.repeat(213)).versao, 10); // 10-M leva 213
  assert.equal(gerarQr('a'.repeat(412)).versao, 15); // 15-M leva 412
  assert.throws(() => gerarQr('a'.repeat(413)), /grande demais/);
});

test('informação de formato gravada nas duas cópias e com a máscara escolhida', () => {
  for (const t of ['abc', 'Pix 123', 'k'.repeat(120)]) {
    const q = gerarQr(t);
    const n = q.tamanho;
    const esperado = bitsDeFormato(q.mascara);
    let a = 0; let b = 0;
    const posA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    posA.forEach(([x, y], i) => { if (escuro(q, x, y)) a |= 1 << i; });
    for (let i = 0; i < 15; i++) {
      const [x, y] = i < 8 ? [n - 1 - i, 8] : [8, n - 15 + i];
      if (escuro(q, x, y)) b |= 1 << i;
    }
    assert.equal(a, esperado, 'cópia 1');
    assert.equal(b, esperado, 'cópia 2');
    assert.ok(q.mascara >= 0 && q.mascara < 8);
  }
});

test('informação de versão (7 em diante) gravada nos dois cantos', () => {
  const q = gerarQr('v'.repeat(150));
  assert.ok(q.versao >= 7);
  const bits = bitsDeVersao(q.versao);
  for (let i = 0; i < 18; i++) {
    const esperado = ((bits >>> i) & 1) === 1;
    assert.equal(escuro(q, q.tamanho - 11 + (i % 3), Math.floor(i / 3)), esperado);
    assert.equal(escuro(q, Math.floor(i / 3), q.tamanho - 11 + (i % 3)), esperado);
  }
});

test('é determinístico e textos diferentes dão QRs diferentes', () => {
  assert.deepEqual(gerarQr('igual').modulos, gerarQr('igual').modulos);
  assert.notDeepEqual(gerarQr('um').modulos, gerarQr('dois').modulos);
});

test('qrParaSvg: SVG com margem de 4 módulos, um só path e tamanho pedido', () => {
  const q = gerarQr('HELLO WORLD');
  const svg = qrParaSvg('HELLO WORLD', { tamanhoPx: 300 });
  const total = q.tamanho + 8;
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes(`viewBox="0 0 ${total} ${total}"`));
  assert.ok(svg.includes('width="300"') && svg.includes('height="300"'));
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.ok(svg.includes('<rect') && svg.includes('fill="#fff"'));
  // soma dos comprimentos das corridas do path = total de módulos escuros
  const d = svg.match(/ d="([^"]+)"/)[1];
  const soma = [...d.matchAll(/h(\d+)v1/g)].reduce((s, m) => s + Number(m[1]), 0);
  assert.equal(soma, q.modulos.flat().filter(Boolean).length);
  // nada de módulo escuro na margem
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    assert.ok(Number(m[1]) >= 4 && Number(m[2]) >= 4 && Number(m[1]) + Number(m[3]) <= total - 4 && Number(m[2]) <= total - 5);
  }
});
