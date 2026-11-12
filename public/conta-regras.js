// Regras (sem tela) da conta do atendimento. Ficam num arquivo à parte para os testes
// usarem o mesmo código do app. Dinheiro sempre em centavos inteiros.

export const ROTULO_FORMA = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
export const ROTULO_CATEGORIA = { consulta: 'Consulta', exame: 'Exames', vacina: 'Vacinas', procedimento: 'Procedimentos', produto: 'Produtos', outro: 'Outros' };

// Troco de um pagamento em dinheiro. null se não informou o recebido ou se ele não cobre o valor.
export function trocoDe(valorCentavos, recebidoCentavos) {
  if (!Number.isInteger(valorCentavos) || !Number.isInteger(recebidoCentavos)) return null;
  return recebidoCentavos >= valorCentavos ? recebidoCentavos - valorCentavos : null;
}

export const totalDosItens = (itens) => itens.reduce((s, i) => s + i.quantidade * i.preco_unitario_centavos, 0);

// Como a conta aparece na tela Hoje: { tipo: 'aberta' | 'aguardando' | 'pago', texto }.
export function estadoDaConta(pedido) {
  if (pedido.status === 'pago') return { tipo: 'pago', texto: 'Pago ✓' };
  if (pedido.status === 'aguardando_pagamento') return { tipo: 'aguardando', texto: 'aguardando pagamento' };
  return { tipo: 'aberta', texto: 'aberta' };
}

const chave = (i) => `${i.descricao}|${i.quantidade}|${i.preco_unitario_centavos}`;
const copiar = (i) => ({ descricao: i.descricao, quantidade: i.quantidade, preco_unitario_centavos: i.preco_unitario_centavos, catalogo_id: i.catalogo_id ?? null, origem: i.origem ?? 'manual' });

// Monta a lista "atualizada da receita": tira os itens que vieram da receita e a consulta antiga,
// e põe de novo a consulta (pelo horário) e os produtos da receita. Itens digitados à mão ficam.
export function atualizarDaReceita(itens, automaticos) {
  const manuais = itens.filter((i) => i.origem !== 'receita' && i.origem !== 'consulta').map(copiar);
  const consulta = automaticos.consulta ? [copiar(automaticos.consulta)] : [];
  return [...consulta, ...(automaticos.receita || []).map(copiar), ...manuais];
}

// true se os produtos da receita (ou o valor da consulta) mudaram desde que foram para a conta.
export function receitaDesatualizada(itens, automaticos) {
  const daReceita = itens.filter((i) => i.origem === 'receita').map(chave).sort();
  const novos = (automaticos.receita || []).map(chave).sort();
  if (daReceita.length !== novos.length || daReceita.some((x, n) => x !== novos[n])) return true;
  const consulta = itens.find((i) => i.origem === 'consulta');
  return !!(consulta && automaticos.consulta && chave(consulta) !== chave(automaticos.consulta));
}
