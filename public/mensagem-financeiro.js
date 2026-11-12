// Mensagem do comprovante para o grupo do financeiro (WhatsApp), feita só com texto.
// Arquivo de JavaScript puro, sem tela: o app e os testes usam o mesmo código.
// Dinheiro sempre em centavos inteiros; horário sempre o de Salvador/Bahia (UTC-03:00, sem horário de verão).
import { formatarReais } from './dinheiro.js';
import { ROTULO_FORMA } from './conta-regras.js';

const BAHIA_MS = 3 * 60 * 60 * 1000;

// "2026-11-12T11:12:00.000Z" -> { data: '12/11/2026', hora: '08:12', dia: '2026-11-12' } (hora da Bahia)
export function dataHoraBahia(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { data: '', hora: '', dia: '' };
  const d = new Date(t - BAHIA_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    data: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    hora: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    dia: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  };
}

// 12.4 -> "12,4"; 12 -> "12"; 0.35 -> "0,35"
export function formatarPeso(kg) {
  if (typeof kg !== 'number' || !Number.isFinite(kg) || kg <= 0) return '';
  return String(Math.round(kg * 100) / 100).replace('.', ',');
}

// Texto do WhatsApp (com *negrito*). Usa os itens da conta, o total, os pagamentos que NÃO foram desfeitos,
// o último peso do atendimento e quem recebeu.
// pedido = { itens, total_centavos, pagamentos }, atendimento = { peso_kg }, pet = { nome }, tutor = { nome }.
export function montarMensagemFinanceiro({ pedido, atendimento = {}, pet, tutor }) {
  const pagamentos = (pedido.pagamentos || []).filter((g) => !g.estornado);
  const peso = formatarPeso(atendimento.peso_kg);
  const linhas = ['*Pagamento recebido* ✅'];
  linhas.push(`Pet: ${pet.nome}${peso ? ` (${peso} kg)` : ''} — Tutor: ${tutor.nome}`);
  linhas.push('Procedimentos:');
  for (const i of pedido.itens || []) {
    const subtotal = i.subtotal_centavos ?? i.quantidade * i.preco_unitario_centavos;
    linhas.push(`• ${i.quantidade > 1 ? `${i.quantidade}× ` : ''}${i.descricao} — ${formatarReais(subtotal)}`);
  }
  linhas.push(`*Total: ${formatarReais(pedido.total_centavos)}*`);
  const pago = pagamentos.reduce((s, g) => s + g.valor_centavos, 0);
  if (pagamentos.length) linhas.push(`Pago: ${pagamentos.map((g) => `${ROTULO_FORMA[g.forma] || g.forma} ${formatarReais(g.valor_centavos)}`).join(' + ')}`);
  if (pago < pedido.total_centavos) linhas.push(`Falta receber: ${formatarReais(pedido.total_centavos - pago)}`);
  if (pagamentos.length) {
    const nomes = [...new Set(pagamentos.map((g) => g.recebido_por && g.recebido_por.nome).filter(Boolean))];
    const ultimo = pagamentos.reduce((a, g) => (g.recebido_em > a ? g.recebido_em : a), '');
    const { data, hora } = dataHoraBahia(ultimo);
    linhas.push(`Recebido por: ${nomes.join(', ')} — ${data} ${hora}`);
  }
  return linhas.join('\n');
}

// Link do WhatsApp com a mensagem pronta. O wa.me NÃO leva foto e NÃO abre grupo: só conversa com um número
// (ou abre a lista de contatos quando não há número). Por isso é só o plano B.
export function linkWhatsapp(numero, texto) {
  const d = String(numero || '').replace(/\D/g, '');
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}

// "comprovante-thor-2026-11-12.jpg" (sem acentos nem símbolos no nome do arquivo).
export function nomeArquivoComprovante(petNome, iso) {
  const nome = String(petNome || 'pet').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pet';
  return `comprovante-${nome}-${dataHoraBahia(iso).dia}.jpg`;
}
