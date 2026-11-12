// Gerador de QR Code (ISO/IEC 18004), escrito do zero, sem bibliotecas.
// Modo "bytes" (UTF-8), correção de erros nível M, versões 1 a 15 (escolhida sozinha),
// as 8 máscaras (fica com a de menor penalidade), 4 módulos de margem no SVG.
// Serve para mostrar o QR do Pix na tela, sem internet.

// Nível M, por versão: [códigos de correção por bloco, blocos pequenos, dados por bloco pequeno, blocos grandes, dados por bloco grande].
const BLOCOS_M = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
];
export const VERSAO_MAXIMA = 15;

// Posições dos quadradinhos de alinhamento, por versão.
const ALINHAMENTO = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

const dadosDaVersao = (v) => { const [, n1, d1, n2, d2] = BLOCOS_M[v]; return n1 * d1 + n2 * d2; };

// ---------- Reed-Solomon (correção de erros) no campo GF(256), polinômio 0x11D ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const multiplicar = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Polinômio gerador de grau "grau" (coeficientes sem o termo líder).
function geradorRS(grau) {
  let g = [1];
  for (let i = 0; i < grau; i++) {
    const novo = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      novo[j] ^= g[j];
      novo[j + 1] ^= multiplicar(g[j], EXP[i]);
    }
    g = novo;
  }
  return g.slice(1);
}

// Códigos de correção (resto da divisão de dados·x^grau pelo gerador). Exportado para os testes.
export function reedSolomon(dados, grau) {
  const g = geradorRS(grau);
  const resto = new Array(grau).fill(0);
  for (const b of dados) {
    const fator = b ^ resto.shift();
    resto.push(0);
    for (let i = 0; i < grau; i++) resto[i] ^= multiplicar(g[i], fator);
  }
  return resto;
}

// ---------- Dados: bytes -> bits -> códigos de dados + correção intercalados ----------
function bitsDosDados(bytes, versao) {
  const bits = [];
  const poe = (valor, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >>> i) & 1); };
  poe(0b0100, 4); // modo bytes
  poe(bytes.length, versao <= 9 ? 8 : 16);
  for (const b of bytes) poe(b, 8);
  const capacidade = dadosDaVersao(versao) * 8;
  poe(0, Math.min(4, capacidade - bits.length)); // terminador
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xEC; bits.length < capacidade; pad ^= 0xEC ^ 0x11) poe(pad, 8);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return cw;
}

function codigosFinais(dados, versao) {
  const [ec, n1, d1, n2, d2] = BLOCOS_M[versao];
  const blocos = [];
  let pos = 0;
  for (let i = 0; i < n1 + n2; i++) {
    const tam = i < n1 ? d1 : d2;
    const parte = dados.slice(pos, pos + tam);
    pos += tam;
    blocos.push({ dados: parte, ec: reedSolomon(parte, ec) });
  }
  const saida = [];
  for (let i = 0; i < d2 || i < d1; i++) for (const b of blocos) if (i < b.dados.length) saida.push(b.dados[i]);
  for (let i = 0; i < ec; i++) for (const b of blocos) saida.push(b.ec[i]);
  return saida;
}

// ---------- Desenho da matriz ----------
const MASCARAS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

// Bits de formato: nível M (00) + máscara, com correção BCH(15,5) e xor 0x5412.
export function bitsDeFormato(mascara) {
  const dados = (0b00 << 3) | mascara;
  let r = dados;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((dados << 10) | r) ^ 0x5412;
}

// Bits de versão (18 bits, versões 7 em diante): versão + BCH(18,6).
export function bitsDeVersao(versao) {
  let r = versao;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
  return (versao << 12) | r;
}

function matrizVazia(versao) {
  const n = 17 + 4 * versao;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixo = Array.from({ length: n }, () => new Array(n).fill(false));
  const poe = (x, y, escuro) => { if (x >= 0 && y >= 0 && x < n && y < n) { m[y][x] = escuro; fixo[y][x] = true; } };
  // Faixas de temporização
  for (let i = 0; i < n; i++) { poe(6, i, i % 2 === 0); poe(i, 6, i % 2 === 0); }
  // Três cantos de localização (com a linha clara em volta)
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      poe(cx + dx, cy + dy, d !== 4 && d !== 2);
    }
  }
  // Alinhamento
  const a = ALINHAMENTO[versao];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) poe(a[i] + dx, a[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  return { n, m, fixo, poe };
}

function desenharFormato(base, mascara) {
  const { n, poe } = base;
  const bits = bitsDeFormato(mascara);
  const b = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) poe(8, i, b(i));
  poe(8, 7, b(6)); poe(8, 8, b(7)); poe(7, 8, b(8));
  for (let i = 9; i < 15; i++) poe(14 - i, 8, b(i));
  for (let i = 0; i < 8; i++) poe(n - 1 - i, 8, b(i));
  for (let i = 8; i < 15; i++) poe(8, n - 15 + i, b(i));
  poe(8, n - 8, true); // módulo escuro fixo
}

function desenharVersao(base, versao) {
  if (versao < 7) return;
  const { n, poe } = base;
  const bits = bitsDeVersao(versao);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = n - 11 + (i % 3); const b = Math.floor(i / 3);
    poe(a, b, bit); poe(b, a, bit);
  }
}

function colocarDados(base, codigos) {
  const { n, m, fixo } = base;
  let i = 0;
  for (let direita = n - 1; direita >= 1; direita -= 2) {
    if (direita === 6) direita = 5; // a coluna 6 é só temporização
    for (let v = 0; v < n; v++) {
      for (let j = 0; j < 2; j++) {
        const x = direita - j;
        const sobe = ((direita + 1) & 2) === 0;
        const y = sobe ? n - 1 - v : v;
        if (!fixo[y][x] && i < codigos.length * 8) {
          m[y][x] = ((codigos[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

// Pontos de penalidade (regras 1 a 4 da norma) — quanto menor, mais fácil de ler.
function penalidade(m) {
  const n = m.length;
  let p = 0;
  const linhas = [];
  for (let y = 0; y < n; y++) linhas.push(m[y].map((v) => (v ? '1' : '0')).join(''));
  for (let x = 0; x < n; x++) linhas.push(m.map((l) => (l[x] ? '1' : '0')).join(''));
  for (const s of linhas) {
    let corrida = 1;
    for (let i = 1; i <= s.length; i++) {
      if (i < s.length && s[i] === s[i - 1]) corrida++;
      else { if (corrida >= 5) p += 3 + (corrida - 5); corrida = 1; }
    }
    for (const padrao of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(padrao); i !== -1; i = s.indexOf(padrao, i + 1)) p += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let escuros = 0;
  for (const l of m) for (const v of l) if (v) escuros++;
  const pct = (escuros * 100) / (n * n);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

// ---------- Uso ----------

// Gera o QR. Devolve { versao, mascara, tamanho, modulos } — modulos[linha][coluna] é true se o quadradinho é escuro.
// "tamanho" não inclui a margem.
export function gerarQr(texto) {
  const bytes = new TextEncoder().encode(String(texto));
  let versao = 0;
  for (let v = 1; v <= VERSAO_MAXIMA; v++) {
    const cabecalho = 4 + (v <= 9 ? 8 : 16);
    if (cabecalho + bytes.length * 8 <= dadosDaVersao(v) * 8) { versao = v; break; }
  }
  if (!versao) throw new Error('Texto grande demais para o QR Code.');
  const codigos = codigosFinais(bitsDosDados(bytes, versao), versao);
  let melhor = null;
  for (let mascara = 0; mascara < 8; mascara++) {
    const base = matrizVazia(versao);
    desenharFormato(base, mascara);
    desenharVersao(base, versao);
    colocarDados(base, codigos);
    for (let y = 0; y < base.n; y++) for (let x = 0; x < base.n; x++) if (!base.fixo[y][x] && MASCARAS[mascara](x, y)) base.m[y][x] = !base.m[y][x];
    const pen = penalidade(base.m);
    if (!melhor || pen < melhor.pen) melhor = { pen, mascara, m: base.m };
  }
  return { versao, mascara: melhor.mascara, tamanho: melhor.m.length, modulos: melhor.m };
}

// QR como texto SVG: fundo branco com margem de 4 módulos e um único <path> com os módulos escuros.
// O conteúdo é só o que nós mesmos geramos (números), nunca texto digitado por alguém.
export function qrParaSvg(texto, { tamanhoPx = 256 } = {}) {
  const { tamanho, modulos } = gerarQr(texto);
  const margem = 4;
  const total = tamanho + 2 * margem;
  let d = '';
  for (let y = 0; y < tamanho; y++) {
    let x = 0;
    while (x < tamanho) {
      if (!modulos[y][x]) { x++; continue; }
      const ini = x;
      while (x < tamanho && modulos[y][x]) x++;
      d += `M${ini + margem} ${y + margem}h${x - ini}v1h-${x - ini}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${tamanhoPx}" height="${tamanhoPx}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
