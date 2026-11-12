// Dinheiro no Vetclin: sempre em centavos inteiros (R$ 100,00 = 10000).
// Este arquivo é só JavaScript puro, por isso o app e os testes usam o mesmo código.

// Maior valor aceito por unidade (R$ 100.000,00), igual ao limite do servidor.
export const MAX_VALOR_CENTAVOS = 10_000_000;

// 123450 -> "R$ 1.234,50"
export function formatarReais(centavos) {
  const n = Number.isFinite(centavos) ? centavos : 0;
  // O Intl usa um espaço "especial" depois do R$; trocamos por um espaço comum.
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n / 100).replace(/\s/g, ' ');
}

// Lê o que a pessoa digitou e devolve centavos (número inteiro), ou null se estiver vazio ou inválido.
// Aceita: "85", "85,00", "85.5", "85,5", "1.234,50", "1234.50", "R$ 85,00".
// Ponto seguido de exatamente 3 números ("1.234") é lido como separador de milhar.
export function lerReais(texto) {
  if (typeof texto !== 'string') return null;
  let t = texto.replace(/R\$/gi, '').replace(/\s/g, '');
  if (!t) return null;
  let inteira; let decimal = '';
  if (t.includes(',')) {
    const partes = t.split(',');
    if (partes.length !== 2) return null;
    [inteira, decimal] = partes;
    if (!/^\d{1,3}(\.\d{3})+$|^\d+$/.test(inteira)) return null;
    inteira = inteira.replace(/\./g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    inteira = t.replace(/\./g, '');
  } else {
    const partes = t.split('.');
    if (partes.length > 2) return null;
    [inteira, decimal = ''] = partes;
    if (!/^\d+$/.test(inteira)) return null;
  }
  if (!/^\d{0,2}$/.test(decimal)) return null;
  const centavos = Number(inteira) * 100 + Number(decimal.padEnd(2, '0') || 0);
  return Number.isSafeInteger(centavos) ? centavos : null;
}

// Texto de um valor em centavos para pôr num campo de digitar: 8550 -> "85,50".
export function reaisParaCampo(centavos) {
  if (centavos === null || centavos === undefined) return '';
  return (centavos / 100).toFixed(2).replace('.', ',');
}
