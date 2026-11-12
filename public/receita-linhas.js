// Regras (sem tela) da receita em colunas: cada remédio é uma linha com 5 campos
// (remédio, dose, como dar, a cada, por quanto tempo). Daqui sai o texto da receita.
// Fica num arquivo à parte para os testes poderem usar o mesmo código do app.

export const CAMPOS = ['remedio', 'dose', 'como', 'intervalo', 'duracao'];

export function linhaVazia() {
  return { remedio: '', dose: '', como: '', intervalo: '', duracao: '' };
}

// Limpa um campo: sem asteriscos (para não quebrar o negrito do WhatsApp), sem quebras de linha, sem espaços sobrando.
function campo(v) {
  return String(v ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

// "12 h" -> "a cada 12 h"; "manhã e noite" fica como está (só começa com "a cada" se for número).
function comPrefixo(valor, prefixo) {
  const t = campo(valor);
  return t && /^\d/.test(t) ? `${prefixo} ${t}` : t;
}

// Uma linha de remédio vira texto. Exemplo:
// "*Amoxicilina 250 mg* — 1 comprimido a cada 12 h por 7 dias"
// Partes vazias são simplesmente puladas. Linha totalmente vazia vira ''.
// Com { marcas: false } sai sem os asteriscos (usado na descrição do produto).
export function linhaDaReceita(l, { marcas = true } = {}) {
  const nome = [campo(l?.remedio), campo(l?.dose)].filter(Boolean).join(' ');
  const modo = [campo(l?.como), comPrefixo(l?.intervalo, 'a cada'), comPrefixo(l?.duracao, 'por')].filter(Boolean).join(' ');
  const cabeca = nome && marcas ? `*${nome}*` : nome;
  return [cabeca, modo].filter(Boolean).join(' — ');
}

// A lista inteira vira o texto da receita: uma linha por remédio, sem as linhas vazias.
export function textoDasLinhas(linhas) {
  return (linhas ?? []).map((l) => linhaDaReceita(l)).filter(Boolean).join('\n');
}

// Dá para a sugestão "Amoxicilina 250 mg" virar remédio "Amoxicilina" + dose "250 mg".
// Se não achar a dose no final, tudo fica no remédio.
export function separarRemedioDose(textoSugestao) {
  const t = campo(textoSugestao);
  const m = /^(.+?)\s+(\d[\d.,]*\s?(?:mg|mcg|µg|g|ml|ui|%)(?:\s?\/\s?\w+)?)$/i.exec(t);
  return m ? { remedio: m[1].trim(), dose: m[2].trim() } : { remedio: t, dose: '' };
}
