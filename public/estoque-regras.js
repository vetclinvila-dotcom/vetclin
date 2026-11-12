// Regras (sem tela) do estoque: textos, cores e leitura de números digitados.
// Ficam num arquivo à parte para os testes usarem o mesmo código do app.

// Unidades de medida dos produtos: [valor guardado, nome na tela].
export const UNIDADES = [['un', 'unidade'], ['cx', 'caixa'], ['fr', 'frasco'], ['ml', 'ml'], ['comp', 'comprimido'], ['amp', 'ampola'], ['dose', 'dose'], ['g', 'g'], ['tubo', 'tubo']];

const plural = (n, um, varios) => (Math.abs(n) === 1 ? um : varios);

// "vence em 12 dias" (laranja quando faltam 30 dias ou menos) / "vencido há 3 dias" (vermelho).
// classe: 'vencido' (vermelho), 'perto' (laranja), 'ok' (normal) ou 'sem' (sem validade).
export function textoValidade(dias) {
  if (dias === null || dias === undefined) return { texto: 'sem validade', classe: 'sem' };
  if (dias < 0) return { texto: `vencido há ${-dias} ${plural(dias, 'dia', 'dias')}`, classe: 'vencido' };
  if (dias === 0) return { texto: 'vence hoje', classe: 'perto' };
  return { texto: `vence em ${dias} ${plural(dias, 'dia', 'dias')}`, classe: dias <= 30 ? 'perto' : 'ok' };
}

// "2027-01-31" -> "31/01/2027"
export function formatarDataIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Número digitado (aceita vírgula): até 3 casas decimais, maior que zero. null se inválido.
export function lerQuantidadeDigitada(texto) {
  const t = String(texto ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 1_000_000 ? n : null;
}

// 12 -> "12"; 2.5 -> "2,5" (sem zeros sobrando)
export function formatarQuantidade(n) {
  const v = Math.round(Number(n) * 1000) / 1000;
  return Number.isFinite(v) ? String(v).replace('.', ',') : '';
}

// "dura cerca de 35 dias" (vazio se não houve vendas nos últimos 30 dias).
export function textoDura(item) {
  if (item.dura_dias === null || item.dura_dias === undefined) return item.total > 0 ? 'sem vendas nos últimos 30 dias' : '';
  if (item.dura_dias < 1) return 'dura menos de 1 dia';
  return `dura cerca de ${item.dura_dias} ${plural(item.dura_dias, 'dia', 'dias')}`;
}

// "média de validade: 25 dias" (média, ponderada pela quantidade, dos lotes que ainda não venceram).
export function textoMedia(item) {
  if (item.media_validade_dias === null || item.media_validade_dias === undefined) return '';
  const n = Math.round(item.media_validade_dias);
  return `média de validade: ${n} ${plural(n, 'dia', 'dias')}`;
}

// "restam 7" no cartão do produto do carrinho; vermelho "sem estoque" quando acabou (mas ainda dá para vender).
// Devolve null se o produto não controla estoque.
export function textoRestam(produto) {
  if (!produto.controla_estoque) return null;
  const n = produto.estoque_total ?? 0;
  if (n <= 0) return { texto: 'sem estoque', classe: 'zerado' };
  return { texto: `restam ${formatarQuantidade(n)}`, classe: n <= 3 ? 'pouco' : 'ok' };
}

// Link do WhatsApp a partir do telefone guardado ("+5571999998888"); só números entram no endereço.
export function linkWhatsappDe(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `https://wa.me/${d}` : '';
}
export function linkTelefoneDe(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `tel:+${d}` : '';
}
