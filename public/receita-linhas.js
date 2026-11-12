// Regras (sem tela) da receita em colunas: cada remédio é uma linha com 5 campos
// (remédio, dose, como dar, a cada, por quanto tempo). Daqui sai o texto da receita.
// Fica num arquivo à parte para os testes poderem usar o mesmo código do app.

export const CAMPOS = ['remedio', 'dose', 'como', 'intervalo', 'duracao'];

// Vias (jeitos de dar o remédio). A primeira é a padrão; "Outro" deixa escrever o nome da via.
export const VIAS = ['Uso oral', 'Uso injetável', 'Uso tópico', 'Uso otológico', 'Uso oftálmico'];
export const VIA_PADRAO = VIAS[0];

export function linhaVazia() {
  return { remedio: '', dose: '', como: '', intervalo: '', duracao: '', via: VIA_PADRAO, comprar: '' };
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

// Frase de instrução: "Administrar 1 comprimido e meio a cada 12 horas, durante 28 dias."
// Partes que faltam são puladas. Se o "como dar" já começa com um verbo (Aplicar, Dar, Pingar…),
// não coloca "Administrar" na frente.
const COMECA_COM_VERBO = /^(administrar|aplicar|dar|pingar|ministrar|oferecer|ofertar|usar|passar|lavar|limpar|instilar|borrifar|misturar|diluir|fornecer|esfregar|banhar|colocar)\b/i;
export function instrucaoDaLinha(l) {
  const como = campo(l?.como);
  const intervalo = comPrefixo(l?.intervalo, 'a cada');
  const duracao = comPrefixo(l?.duracao, 'durante');
  if (!como && !intervalo && !duracao) return '';
  const inicio = como && COMECA_COM_VERBO.test(como) ? como.replace(/[.;,\s]+$/, '') : ['Administrar', como].filter(Boolean).join(' ');
  const frase = [inicio, intervalo].filter(Boolean).join(' ');
  return `${frase}${duracao ? ', ' + duracao : ''}.`;
}

// O nome do grupo no papel: "Uso oral" -> "USO ORAL". Vazio vale "Uso oral" (receitas antigas).
export function viaDaLinha(l) {
  return (campo(l?.via) || VIA_PADRAO).toLocaleUpperCase('pt-BR');
}

// Agrupa os remédios por via (na ordem em que aparecem) e numera dentro de cada grupo.
// Linhas totalmente vazias são puladas. Serve para o papel e para o texto da receita.
// -> [{ via: 'USO ORAL', itens: [{ n, titulo, comprar, instrucao }] }]
export function gruposDasLinhas(linhas) {
  const grupos = [];
  for (const l of linhas ?? []) {
    const titulo = [campo(l?.remedio), campo(l?.dose)].filter(Boolean).join(' ');
    const comprar = campo(l?.comprar);
    const instrucao = instrucaoDaLinha(l);
    if (!titulo && !comprar && !instrucao) continue;
    const via = viaDaLinha(l);
    let g = grupos.find((x) => x.via === via);
    if (!g) { g = { via, itens: [] }; grupos.push(g); }
    g.itens.push({ n: g.itens.length + 1, titulo, comprar, instrucao });
  }
  return grupos;
}

// A lista inteira vira o texto da receita (também usado nas sugestões e no WhatsApp):
// USO ORAL
// 1 - *Doxiciclina 100 mg* ... 1 CX
// Administrar 1 comprimido e meio a cada 12 horas, durante 28 dias.
// (uma linha em branco entre os grupos; linhas vazias são puladas)
export function textoDasLinhas(linhas) {
  return gruposDasLinhas(linhas).map((g) => [
    g.via,
    ...g.itens.flatMap((i) => [
      i.titulo || i.comprar ? `${i.n} - ${[i.titulo ? `*${i.titulo}*` : '', i.comprar].filter(Boolean).join(' ... ')}` : '',
      i.instrucao,
    ]).filter(Boolean),
  ].join('\n')).join('\n\n');
}

// Dá para a sugestão "Amoxicilina 250 mg" virar remédio "Amoxicilina" + dose "250 mg".
// Se não achar a dose no final, tudo fica no remédio.
export function separarRemedioDose(textoSugestao) {
  const t = campo(textoSugestao);
  const m = /^(.+?)\s+(\d[\d.,]*\s?(?:mg|mcg|µg|g|ml|ui|%)(?:\s?\/\s?\w+)?)$/i.exec(t);
  return m ? { remedio: m[1].trim(), dose: m[2].trim() } : { remedio: t, dose: '' };
}
