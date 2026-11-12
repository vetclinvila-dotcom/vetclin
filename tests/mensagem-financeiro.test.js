// Testes da mensagem do financeiro (texto do WhatsApp), do link e do nome do arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataHoraBahia, formatarPeso, linkWhatsapp, montarMensagemFinanceiro, nomeArquivoComprovante } from '../public/mensagem-financeiro.js';

const pedido = {
  total_centavos: 14500,
  itens: [
    { descricao: 'Consulta (até 18h)', quantidade: 1, preco_unitario_centavos: 10000 },
    { descricao: 'Dipirona 500 mg', quantidade: 1, preco_unitario_centavos: 4500, subtotal_centavos: 4500 },
  ],
  pagamentos: [
    { forma: 'pix', valor_centavos: 5000, estornado: false, recebido_por: { nome: 'Recepção' }, recebido_em: '2026-11-12T11:00:00.000Z' },
    { forma: 'dinheiro', valor_centavos: 9500, estornado: false, recebido_por: { nome: 'Recepção' }, recebido_em: '2026-11-12T11:12:00.000Z' },
  ],
};

test('mensagem igual ao modelo do financeiro', () => {
  const m = montarMensagemFinanceiro({ pedido, atendimento: { peso_kg: 12.4 }, pet: { nome: 'Thor' }, tutor: { nome: 'Maria' } });
  assert.equal(m, [
    '*Pagamento recebido* ✅',
    'Pet: Thor (12,4 kg) — Tutor: Maria',
    'Procedimentos:',
    '• Consulta (até 18h) — R$ 100,00',
    '• Dipirona 500 mg — R$ 45,00',
    '*Total: R$ 145,00*',
    'Pago: Pix R$ 50,00 + Dinheiro R$ 95,00',
    'Recebido por: Recepção — 12/11/2026 08:12',
  ].join('\n'));
});

test('pagamento desfeito não entra; sem peso omite o peso; quantidade maior que 1 aparece', () => {
  const p = {
    total_centavos: 9000,
    itens: [{ descricao: 'Vacina', quantidade: 2, preco_unitario_centavos: 4500 }],
    pagamentos: [
      { forma: 'cartao', valor_centavos: 9000, estornado: true, recebido_por: { nome: 'Ana' }, recebido_em: '2026-11-12T12:00:00Z' },
      { forma: 'pix', valor_centavos: 4000, estornado: false, recebido_por: { nome: 'Bia' }, recebido_em: '2026-11-12T13:30:00Z' },
    ],
  };
  const m = montarMensagemFinanceiro({ pedido: p, atendimento: { peso_kg: null }, pet: { nome: 'Mel' }, tutor: { nome: 'José' } });
  assert.ok(m.includes('Pet: Mel — Tutor: José'));
  assert.ok(m.includes('• 2× Vacina — R$ 90,00'));
  assert.ok(m.includes('Pago: Pix R$ 40,00\n'));
  assert.ok(!m.includes('Cartão'));
  assert.ok(m.includes('Falta receber: R$ 50,00'));
  assert.ok(m.includes('Recebido por: Bia — 12/11/2026 10:30'));
});

test('vários recebedores, e só um emoji (o ✅) no texto', () => {
  const p = { ...pedido, pagamentos: [{ ...pedido.pagamentos[0], recebido_por: { nome: 'Ana' } }, { ...pedido.pagamentos[1], recebido_por: { nome: 'Bia' } }] };
  const m = montarMensagemFinanceiro({ pedido: p, atendimento: {}, pet: { nome: 'Thor' }, tutor: { nome: 'Maria' } });
  assert.ok(m.includes('Recebido por: Ana, Bia — 12/11/2026 08:12'));
  assert.equal((m.match(/\p{Extended_Pictographic}/gu) || []).length, 1);
});

test('hora da Bahia, peso e link', () => {
  assert.deepEqual(dataHoraBahia('2026-11-12T02:30:00Z'), { data: '11/11/2026', hora: '23:30', dia: '2026-11-11' });
  assert.equal(formatarPeso(12), '12');
  assert.equal(formatarPeso(0.35), '0,35');
  assert.equal(formatarPeso(null), '');
  assert.equal(linkWhatsapp('+55 (71) 99999-8888', 'Olá *oi*\nok'), 'https://wa.me/5571999998888?text=Ol%C3%A1%20*oi*%0Aok');
  assert.equal(linkWhatsapp('', 'a b'), 'https://wa.me/?text=a%20b');
  assert.equal(nomeArquivoComprovante('Thor Ção!', '2026-11-12T11:00:00Z'), 'comprovante-thor-cao-2026-11-12.jpg');
  assert.equal(nomeArquivoComprovante('', '2026-11-12T11:00:00Z'), 'comprovante-pet-2026-11-12.jpg');
});
