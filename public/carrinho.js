// Regras (sem tela) do carrinho de produtos da conta: tocar num produto soma 1 na conta.
// "itens" é a lista de itens da conta, do mesmo formato da API:
//   { descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }
// Dinheiro sempre em centavos inteiros. As funções não alteram a lista recebida: devolvem uma nova.

const ehDoCarrinho = (i, catalogoId) => i.catalogo_id === catalogoId && i.origem === 'manual';
export const MAX_QUANTIDADE = 999;

// Quantas unidades deste produto já estão na conta.
export function quantidadeNoCarrinho(itens, catalogoId) {
  return itens.filter((i) => ehDoCarrinho(i, catalogoId)).reduce((s, i) => s + i.quantidade, 0);
}

// +1 do produto { id, nome, preco_centavos }: se já está na conta soma na mesma linha; senão cria a linha.
export function adicionarProduto(itens, produto) {
  const pos = itens.findIndex((i) => ehDoCarrinho(i, produto.id));
  if (pos >= 0) {
    if (itens[pos].quantidade >= MAX_QUANTIDADE) return itens.map((i) => ({ ...i }));
    return itens.map((i, p) => (p === pos ? { ...i, quantidade: i.quantidade + 1 } : { ...i }));
  }
  return [...itens.map((i) => ({ ...i })), { descricao: produto.nome, quantidade: 1, preco_unitario_centavos: produto.preco_centavos, catalogo_id: produto.id, origem: 'manual' }];
}

// -1 do produto; ao chegar em zero a linha sai da conta. Se o produto não está na conta, nada muda.
export function removerUmProduto(itens, catalogoId) {
  const pos = itens.findIndex((i) => ehDoCarrinho(i, catalogoId));
  if (pos < 0) return itens.map((i) => ({ ...i }));
  if (itens[pos].quantidade <= 1) return itens.filter((_, p) => p !== pos).map((i) => ({ ...i }));
  return itens.map((i, p) => (p === pos ? { ...i, quantidade: i.quantidade - 1 } : { ...i }));
}

// "3 itens · R$ 145,00": quantidade de unidades e total da conta inteira.
export function resumoCarrinho(itens) {
  return {
    quantidade: itens.reduce((s, i) => s + i.quantidade, 0),
    total_centavos: itens.reduce((s, i) => s + i.quantidade * i.preco_unitario_centavos, 0),
  };
}

// Itens do catálogo que viram "botões" do carrinho. A consulta fica de fora: ela já entra
// sozinha na conta (pelo horário), e somar de novo cobraria duas vezes.
export function produtosDoCarrinho(catalogo) {
  return catalogo.filter((c) => c.ativo !== false && c.categoria !== 'consulta');
}

// Filtra por categoria e busca (sem acento, sem diferença de maiúsculas; todas as palavras precisam aparecer).
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function filtrarProdutos(produtos, { categoria = '', busca = '' } = {}) {
  const partes = semAcento(busca).split(/\s+/).filter(Boolean);
  return produtos.filter((p) => (!categoria || p.categoria === categoria) && partes.every((x) => semAcento(p.nome).includes(x)));
}
