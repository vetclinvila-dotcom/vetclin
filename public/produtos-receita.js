// Regras (sem tela) para montar a lista de produtos a partir do texto da receita.
// Fica num arquivo à parte para os testes poderem usar o mesmo código do app.

// Tira do começo da linha o marcador de lista ("- ", "1. ") e do texto as marcas do WhatsApp (*negrito*, _itálico_).
export function rotuloDaLinha(linha) {
  let t = String(linha).trim().replace(/^(?:[-–—•]\s+|\*\s+|\d+[.)]\s+)/, '');
  t = t.replace(/\*/g, '').replace(/(^|[\s(])_(\S(?:[^_]*\S)?)_(?=$|[\s.,;:)!?])/g, '$1$2');
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const chaveDoRotulo = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Distância de edição (quantas letras trocar/apagar/incluir), com teto para ser rápida.
function distancia(a, b, teto = 3) {
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  let antes = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) atual[j] = Math.min(antes[j] + 1, atual[j - 1] + 1, antes[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    antes = atual;
  }
  return antes[b.length];
}

// Monta a lista de produtos a partir do texto da receita, guardando as escolhas já feitas:
// 1) linha igual a uma anterior (sem acento/maiúsculas) herda a escolha;
// 2) linha que foi só um pouco editada na mesma posição (erro de digitação) também herda.
// Linhas novas começam como "Não". Exportada para teste.
export function itensDoTexto(textoReceita, anteriores = []) {
  const rotulos = String(textoReceita ?? '').split('\n').map(rotuloDaLinha).filter(Boolean).slice(0, 100);
  const usados = new Set();
  const novos = rotulos.map((descricao) => {
    const chave = chaveDoRotulo(descricao);
    const i = anteriores.findIndex((x, n) => !usados.has(n) && chaveDoRotulo(x.descricao) === chave);
    if (i >= 0) usados.add(i);
    return { descricao, chave, achou: i >= 0 ? anteriores[i] : null };
  });
  const ocupadosDepois = new Set(novos.filter((n) => n.achou).map((n) => anteriores.indexOf(n.achou)));
  return novos.map((n, pos) => {
    let base = n.achou;
    const velho = anteriores[pos];
    if (!base && velho && !ocupadosDepois.has(pos)) {
      const a = chaveDoRotulo(velho.descricao);
      if (a.startsWith(n.chave) || n.chave.startsWith(a) || distancia(a, n.chave) <= 2) { base = velho; ocupadosDepois.add(pos); }
    }
    return { descricao: n.descricao, temos: base ? !!base.temos : false, qtd: base ? base.qtd : '1', valor: base ? base.valor : '' };
  });
}
