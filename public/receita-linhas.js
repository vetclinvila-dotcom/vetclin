// Regras (sem tela) da receita em colunas: cada remédio é uma linha com 5 campos
// (remédio, dose, como dar, a cada, por quanto tempo). Daqui sai o texto da receita.
// Fica num arquivo à parte para os testes poderem usar o mesmo código do app.

// Junta remédio + dose sem repetir: "Amoxicilina 250 mg" + "250 mg" vira "Amoxicilina 250 mg".
export function nomeComDose(remedio, dose) {
  const r = String(remedio ?? '').trim();
  const d = String(dose ?? '').trim();
  if (!d) return r;
  const sem = (x) => x.toLowerCase().replace(/\s+/g, '');
  return sem(r).includes(sem(d)) ? r : [r, d].filter(Boolean).join(' ');
}

export const CAMPOS = ['remedio', 'dose', 'como', 'intervalo', 'duracao'];

// Vias (jeitos de dar o remédio). A primeira é a padrão; "Outro" deixa escrever o nome da via.
export const VIAS = ['Uso oral', 'Uso injetável', 'Uso tópico', 'Uso otológico', 'Uso oftálmico'];
export const VIA_PADRAO = VIAS[0];

export function linhaVazia() {
  return { remedio: '', dose: '', como: '', intervalo: '', duracao: '', via: VIA_PADRAO, comprar: '', aplicado: false };
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
  const nome = nomeComDose(campo(l?.remedio), campo(l?.dose));
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

// Nome do grupo dos remédios aplicados na própria clínica (o tutor não compra).
export const VIA_APLICADO = 'APLICADO NA CLÍNICA';

// Detalhe de um remédio aplicado na clínica. Exemplo: "Aplicado por via subcutânea, 0,75 ml."
// (usa a via e o "como dar"; a via padrão "Uso injetável" não precisa repetir. Sem nada, fica vazio.)
function detalheAplicado(l) {
  const como = campo(l?.como).replace(/[.;,\s]+$/, '');
  const via = campo(l?.via);
  const viaTexto = via && via.toLocaleLowerCase('pt-BR') !== 'uso injetável' ? via.replace(/^uso\s+/i, '').toLocaleLowerCase('pt-BR') : '';
  if (viaTexto) return `Aplicado por via ${viaTexto}${como ? ', ' + como : ''}.`;
  return como ? `Aplicado: ${como}.` : '';
}

// Agrupa os remédios por via (na ordem em que aparecem) e numera dentro de cada grupo.
// Linhas totalmente vazias são puladas. Serve para o papel e para o texto da receita.
// Remédios "aplicado" (aplicados na clínica) NÃO entram nos grupos normais: vão num grupo
// à parte, sempre por último: { via: 'APLICADO NA CLÍNICA', aplicado: true, itens }.
// -> [{ via: 'USO ORAL', itens: [{ n, titulo, comprar, instrucao }] }]
export function gruposDasLinhas(linhas) {
  const grupos = [];
  const aplicados = [];
  for (const l of linhas ?? []) {
    const titulo = nomeComDose(campo(l?.remedio), campo(l?.dose));
    if (l?.aplicado === true) {
      if (!titulo) continue;
      const detalhe = detalheAplicado(l);
      aplicados.push({ n: aplicados.length + 1, titulo, comprar: '', detalhe, instrucao: `${titulo} — aplicado na clínica${detalhe ? '. ' + detalhe : ''}` });
      continue;
    }
    const comprar = campo(l?.comprar);
    const instrucao = instrucaoDaLinha(l);
    if (!titulo && !comprar && !instrucao) continue;
    const via = viaDaLinha(l);
    let g = grupos.find((x) => x.via === via);
    if (!g) { g = { via, itens: [] }; grupos.push(g); }
    g.itens.push({ n: g.itens.length + 1, titulo, comprar, instrucao });
  }
  if (aplicados.length) grupos.push({ via: VIA_APLICADO, aplicado: true, itens: aplicados });
  return grupos;
}

// A lista inteira vira o texto da receita (também usado nas sugestões e no WhatsApp):
// USO ORAL
// 1 - *Doxiciclina 100 mg* ... 1 CX
// Administrar 1 comprimido e meio a cada 12 horas, durante 28 dias.
// (uma linha em branco entre os grupos; linhas vazias são puladas)
// Os aplicados na clínica vão no fim, em "APLICADO NA CLÍNICA (não precisa comprar)".
export function textoDasLinhas(linhas) {
  return gruposDasLinhas(linhas).map((g) => g.aplicado
    ? [`${g.via} (não precisa comprar)`, ...g.itens.flatMap((i) => [`${i.n} - *${i.titulo}* — aplicado na clínica`, i.detalhe])].filter(Boolean).join('\n')
    : [
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

// "250 mg · caixa com 10 comprimidos" -> "250 mg"; "frasco 20 ml" -> "20 ml".
// Pega a primeira parte com número + mg/mcg/g/ml/UI/%; sem ela, devolve '' (a dose fica para o veterinário escrever).
export function doseDaApresentacao(apresentacao) {
  const m = /(\d[\d.,]*\s?(?:mg|mcg|µg|g|ml|ui|%)(?:\s?\/\s?\w+)?)(?![\p{L}\d])/iu.exec(campo(apresentacao));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// ---------- Converter mensagem do WhatsApp em linhas (colunas) ----------
// Entende o formato da clínica:
//   Uso oral
//   1 - Petsporin 300 mg            (____ 1 CX opcional no fim)
//   Administrar 1 comprimido a cada 12 horas, durante 7 dias. Após refeições.
// e variações comuns: "12/12h", "2x ao dia", "por 7 dias", "uso injetável", "1 cx".
// O que não for entendido vai para "orientacoes" (não se perde).

const RE_VIA = /^\s*uso\s+(oral|injet[aá]vel|t[oó]pico|otol[oó]gico|oft[aá]lmico|retal|nasal|inalat[oó]rio|subcut[aâ]neo|intramuscular|endovenoso)\s*:?\s*$/i;
const NOMES_VIA = { oral: 'Uso oral', injetavel: 'Uso injetável', topico: 'Uso tópico', otologico: 'Uso otológico', oftalmico: 'Uso oftálmico' };
const RE_VERBO = /^\s*(administrar|dar|aplicar|pingar|oferecer|usar|passar|tomar|fornecer|instilar|colocar|limpar)\b/i;
const RE_DOSE = /(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?\s*(?:mg\/kg|mg\/ml|mcg|mg|g|ml|ui|%))(?![a-z])/i;
const RE_COMPRAR = /(?:[_.\-–—\s]{2,}|\s[-–—]\s|^)\s*(\d+\s*(?:cx|caixas?|fr|frascos?|un|unid(?:ades?)?|tubos?|bisnagas?|amp(?:olas?)?|blisters?|cartelas?)\.?)\s*$/i;

function limparMarcas(t) {
  return String(t ?? '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[*~]/g, '')
    .replace(/(^|\s)_(\S)/g, '$1$2').replace(/(\S)_(\s|$)/g, '$1$2')
    .trim();
}
function semAcento(t) { return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function tirarNumeracao(t) { return t.replace(/^\s*(?:\d{1,2}\s*[-–—.)]\s*|[•·▪●-]\s+)/, '').trim(); }

// "MEIO comprimido" → "meio comprimido"; tira "Administrar".
function extrairComo(frase) {
  const m = frase.match(/^\s*(?:administrar|dar|aplicar|pingar|oferecer|usar|passar|tomar|fornecer|instilar|colocar)\s+(.*?)(?=\s*(?:,\s|,$|\ba cada\b|\bde\s+\d+\s*(?:\/\s*\d+\s*)?(?:h|hs|horas?)\b|\d+\s*\/\s*\d+\s*h|\b\d+\s*x\b|\bpor\b|\bdurante\b|\.|$))/i);
  if (!m) return '';
  return m[1].trim().replace(/\b[A-ZÁÉÍÓÚÃÕÇ]{3,}\b/g, (w) => w.toLowerCase());
}
function extrairIntervalo(frase) {
  let m = frase.match(/a cada\s+(\d+(?:[.,]\d+)?)\s*(?:h|hs|horas?)\b/i) || frase.match(/\bde\s+(\d+)\s*(?:em\s+\d+\s*)?(?:h|hs|horas?)\b/i) || frase.match(/\b(\d+)\s*\/\s*\d+\s*h/i);
  if (m) return `${m[1].replace('.', ',')} h`;
  m = frase.match(/\b(\d)\s*x\s*(?:ao|por)\s*dia\b/i) || frase.match(/\b(\d)\s*vez(?:es)?\s*(?:ao|por)\s*dia\b/i);
  if (m) { const n = Number(m[1]); return n > 0 ? `${String(24 / n).replace('.', ',')} h` : ''; }
  m = frase.match(/a cada\s+(\d+)\s*dias?\b/i);
  if (m) return `${m[1]} dias`;
  return '';
}
function extrairDuracao(frase) {
  const m = frase.match(/(?:durante|por)\s+(\d+)\s*(dias?|semanas?|mes(?:es)?|m[eê]s)\b/i);
  if (m) return `${m[1]} ${m[2].toLowerCase()}`;
  if (/uso\s+cont[ií]nuo/i.test(frase)) return 'uso contínuo';
  return '';
}
// O que sobra da frase depois de como/intervalo/duração (ex.: "Após refeições.").
function extrairResto(frase) {
  const partes = frase.split(/(?<=\.)\s+/);
  return partes.slice(1).join(' ').trim();
}

/**
 * Converte o texto colado em { linhas, orientacoes }.
 * linhas: [{ remedio, dose, como, intervalo, duracao, via, comprar, aplicado:false }]
 */
export function linhasDoWhatsapp(texto) {
  const linhas = [];
  const sobras = [];
  let via = VIA_PADRAO;
  const brutas = String(texto ?? '').split(/\r?\n/).map(limparMarcas);
  const ehInstrucao = (t) => RE_VERBO.test(t);
  for (let i = 0; i < brutas.length; i++) {
    const t = brutas[i];
    if (!t) continue;
    const mv = t.match(RE_VIA);
    if (mv) { const k = semAcento(mv[1]); via = NOMES_VIA[k] || `Uso ${mv[1].toLowerCase()}`; continue; }
    // linha "Uso oral 1 - Remédio" (via e remédio juntos, ex.: copiado sem quebra)
    const viaGrudada = t.match(/^\s*uso\s+(oral|injet[aá]vel|t[oó]pico|otol[oó]gico|oft[aá]lmico)\s+(.+)$/i);
    let corpo = t;
    if (viaGrudada && /^\d{1,2}\s*[-–—.)]/.test(viaGrudada[2])) { via = NOMES_VIA[semAcento(viaGrudada[1])]; corpo = viaGrudada[2]; }

    if (ehInstrucao(corpo)) {
      const alvo = linhas.at(-1);
      if (alvo && !alvo._comInstrucao) {
        alvo.como = extrairComo(corpo) || alvo.como;
        alvo.intervalo = extrairIntervalo(corpo) || alvo.intervalo;
        alvo.duracao = extrairDuracao(corpo) || alvo.duracao;
        const resto = extrairResto(corpo);
        if (resto) alvo._obs.push(resto);
        alvo._comInstrucao = true;
      } else sobras.push(corpo);
      continue;
    }
    const numerada = /^\s*\d{1,2}\s*[-–—.)]\s*\S/.test(corpo) || /^\s*[•·▪●-]\s+\S/.test(corpo);
    let s = tirarNumeracao(corpo);
    let comprar = '';
    const mc = s.match(RE_COMPRAR);
    if (mc && mc.index > 0) { comprar = mc[1].toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, ''); s = s.slice(0, mc.index).trim(); }
    s = s.replace(/[_.\-–—\s]+$/, '').trim();
    const md = s.match(RE_DOSE);
    const proximaEhInstrucao = ehInstrucao(brutas.slice(i + 1).find((x) => x) || '');
    const pareceRemedio = numerada || !!md || !!comprar || proximaEhInstrucao;
    // Linha de título ("Receita do Thor:") ou conversa vira orientação.
    if (!pareceRemedio || /:\s*$/.test(s)) { sobras.push(corpo); continue; }
    let remedio = s, dose = '', resto = '';
    if (md) {
      remedio = s.slice(0, md.index).trim();
      dose = md[1].replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/');
      resto = s.slice(md.index + md[0].length).replace(/^[\s,;\-–—]+/, '').trim();
    }
    const nova = { ...linhaVazia(), remedio: remedio.replace(/[\s,;\-–—]+$/, ''), dose, via, comprar, _obs: [], _comInstrucao: false };
    // Tudo na mesma linha: "Amoxicilina 250 mg - 1 comprimido a cada 12h por 7 dias"
    if (resto) {
      const frase = /^\d|^meio|^1\/2|^½|^uma?\b/i.test(resto) ? `Administrar ${resto}` : resto;
      nova.como = extrairComo(frase);
      nova.intervalo = extrairIntervalo(frase);
      nova.duracao = extrairDuracao(frase);
      if (nova.como || nova.intervalo || nova.duracao) nova._comInstrucao = true;
      else nova._obs.push(resto);
    }
    linhas.push(nova);
  }
  const orientacoes = [];
  for (const l of linhas) {
    // "Após refeições." fica junto da instrução do remédio (como o doutor escreveu),
    // indo no fim da Duração; sem duração, vai para as orientações.
    const obs = l._obs.join(' ').replace(/[.\s]+$/, '');
    if (obs && l.duracao) l.duracao = `${l.duracao}. ${obs}`;
    else if (obs) orientacoes.push(`${nomeComDose(l.remedio, l.dose)}: ${obs}.`);
    delete l._obs; delete l._comInstrucao;
  }
  orientacoes.push(...sobras);
  return { linhas, orientacoes: orientacoes.join('\n') };
}
