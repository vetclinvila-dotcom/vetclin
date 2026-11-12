// Testes da internação: baias, uma internação por baia/pet, quadro, dias (meia-noite em Bahia),
// medicações (próxima / atrasada com relógio fixo), "Dei agora", encerrar, mover e dados de teste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularMedicacao, diaDaInternacao, horasInternado, proximaMedicacao } from '../src/internacao.js';
import { ambiente, atendimentoEmAndamento, chamar, minutosDepois, novoPet } from './apoio-clinico.js';

// Referência: 2026-11-10 12:00 UTC = 09:00 em Bahia.
const T0 = '2026-11-10T12:00:00.000Z';
const hmais = (h) => new Date(new Date(T0).getTime() + h * 3600000);

async function internar(a, pet, baia = 1, extra = {}, cookie = a.filipe) {
  const r = await chamar(a.env, 'POST', '/api/internacoes', { cookie, corpo: { pet_id: pet.id, baia_id: baia, motivo: 'Gastroenterite', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}
async function medicar(a, internacaoId, corpo, cookie = a.filipe) {
  const r = await chamar(a.env, 'POST', `/api/internacoes/${internacaoId}/medicacoes`, { cookie, corpo: { remedio: 'Dipirona', dose: '500 mg', intervalo_horas: 8, ...corpo } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}
const quadro = async (a, cookie = a.filipe) => (await chamar(a.env, 'GET', '/api/internacao', { cookie })).dados;

// ---------- regras de tempo (puras) ----------
test('dias internado: dia da entrada é o 1º; vira o 2º à meia-noite de Bahia (03:00 UTC)', () => {
  const inicio = '2026-11-10T23:30:00.000Z'; // 20:30 em Bahia, dia 10
  assert.equal(diaDaInternacao(inicio, new Date('2026-11-10T23:59:00.000Z')), 1);
  assert.equal(diaDaInternacao(inicio, new Date('2026-11-11T02:59:59.000Z')), 1); // 23:59:59 do dia 10 em Bahia
  assert.equal(diaDaInternacao(inicio, new Date('2026-11-11T03:00:00.000Z')), 2); // 00:00 do dia 11 em Bahia
  assert.equal(diaDaInternacao(inicio, new Date('2026-11-13T03:00:00.000Z')), 4);
  // Mesmo instante, só 40 minutos depois, já é outro dia; e as horas contam o tempo corrido.
  assert.equal(horasInternado(inicio, new Date('2026-11-11T03:10:00.000Z')), 3);
  assert.equal(diaDaInternacao('2026-11-10T03:00:00.000Z', new Date('2026-11-10T03:00:00.000Z')), 1); // meia-noite exata
  assert.equal(diaDaInternacao('2026-11-10T02:59:00.000Z', new Date('2026-11-10T03:00:00.000Z')), 2); // 23:59 do dia 9 -> 00:00 do dia 10
});

test('próxima dose: sem dose = início + intervalo; com dose = última + intervalo; ±15 min é "agora"', () => {
  const m = { inicio_em: T0, intervalo_horas: 8, duracao_dias: null, encerrada_em: null };
  const a = (min) => calcularMedicacao(m, null, minutosDepois(T0, min));
  const proxima = minutosDepois(T0, 480);
  assert.equal(a(0).proxima_em, proxima.toISOString());
  assert.equal(a(0).status, 'futura');
  assert.equal(a(0).minutos_ate_proxima, 480);
  assert.equal(a(480 - 16).status, 'futura'); // faltam 16 min
  assert.equal(a(480 - 15).status, 'agora'); // exatamente 15 min antes
  assert.equal(a(480).status, 'agora');
  assert.equal(a(480 + 15).status, 'agora'); // exatamente 15 min depois ainda é "agora"
  assert.equal(a(480 + 16).status, 'atrasada');
  assert.equal(a(480 + 16).minutos_ate_proxima, -16);
  // Com uma dose dada, a conta parte dela.
  const dada = minutosDepois(T0, 500).toISOString();
  const c = calcularMedicacao(m, dada, minutosDepois(T0, 600));
  assert.equal(c.proxima_em, minutosDepois(T0, 500 + 480).toISOString());
  assert.equal(c.status, 'futura');
  assert.equal(c.ultima_em, dada);
  // Intervalo fracionado.
  assert.equal(calcularMedicacao({ ...m, intervalo_horas: 0.5 }, null, minutosDepois(T0, 30)).status, 'agora');
});

test('duração: "dia 3 de 7"; passou da duração (ou não cabe mais dose) = concluída; encerrada à mão', () => {
  const m = { inicio_em: T0, intervalo_horas: 12, duracao_dias: 7, encerrada_em: null };
  const em = (h, ultima = null) => calcularMedicacao(m, ultima, hmais(h));
  assert.equal(em(1).dia_tratamento, 1);
  assert.equal(em(24).dia_tratamento, 2);
  assert.equal(em(2 * 24 + 5).dia_tratamento, 3);
  assert.equal(em(2 * 24 + 5).duracao_dias, 7);
  assert.equal(em(2 * 24 + 5).situacao, 'ativa');
  const fim = 7 * 24;
  assert.equal(em(fim - 20, hmais(fim - 30)).situacao, 'ativa'); // próxima dose (+12 h) ainda cabe dentro dos 7 dias
  assert.equal(em(fim - 1, hmais(fim - 3)).situacao, 'concluida'); // a próxima (+12 h) já passaria do fim: não há mais dose
  assert.equal(em(fim, null).situacao, 'concluida');
  assert.equal(em(fim + 100).situacao, 'concluida');
  assert.equal(calcularMedicacao({ ...m, duracao_dias: null }, null, hmais(fim * 3)).situacao, 'ativa'); // sem duração, nunca termina sozinha
  assert.equal(calcularMedicacao({ ...m, encerrada_em: T0 }, null, hmais(1)).situacao, 'encerrada');
  assert.equal(calcularMedicacao({ ...m, duracao_dias: null }, null, hmais(1)).dia_tratamento, null);
});

test('proximaMedicacao: a que vence primeiro entre as ativas', () => {
  const ags = hmais(0);
  const m = (id, intervalo, extra = {}) => ({ id, remedio: 'R' + id, ...calcularMedicacao({ inicio_em: T0, intervalo_horas: intervalo, duracao_dias: null, encerrada_em: null, ...extra }, null, ags) });
  assert.equal(proximaMedicacao([m(1, 12), m(2, 8), m(3, 24)]).medicacao_id, 2);
  assert.equal(proximaMedicacao([m(1, 12, { encerrada_em: T0 }), m(2, 24)]).medicacao_id, 2);
  assert.equal(proximaMedicacao([m(1, 12, { encerrada_em: T0 })]), null);
  assert.equal(proximaMedicacao([]), null);
});

// ---------- baias ----------
test('baias: só administrador cria e altera; nomes não repetem; baia ocupada não desativa (409)', async () => {
  const a = await ambiente(T0);
  let q = await quadro(a);
  assert.deepEqual(q.baias.map((b) => b.nome), ['Baia 1', 'Baia 2']); // as duas da migração
  assert.ok(q.baias.every((b) => b.ocupante === null));

  for (const cookie of [a.filipe, a.suporte, a.recepcao]) {
    assert.equal((await chamar(a.env, 'POST', '/api/baias', { cookie, corpo: { nome: 'Baia 3' } })).status, 403);
    assert.equal((await chamar(a.env, 'PATCH', '/api/baias/1', { cookie, corpo: { nome: 'X' } })).status, 403);
  }
  const nova = await chamar(a.env, 'POST', '/api/baias', { cookie: a.elizabeth, corpo: { nome: 'Baia 3' } });
  assert.equal(nova.status, 201);
  assert.equal(nova.dados.ordem, 3);
  assert.equal((await chamar(a.env, 'POST', '/api/baias', { cookie: a.elizabeth, corpo: { nome: ' baia 3 ' } })).status, 409);
  assert.equal((await chamar(a.env, 'POST', '/api/baias', { cookie: a.elizabeth, corpo: { nome: '' } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', '/api/baias/2', { cookie: a.elizabeth, corpo: { nome: 'Baia 3' } })).status, 409);
  const ren = await chamar(a.env, 'PATCH', `/api/baias/${nova.dados.id}`, { cookie: a.elizabeth, corpo: { nome: 'UTI' } });
  assert.equal(ren.dados.nome, 'UTI');
  assert.equal((await chamar(a.env, 'PATCH', '/api/baias/999', { cookie: a.elizabeth, corpo: { nome: 'Z' } })).status, 404);

  const thor = await novoPet(a, 'Thor');
  await internar(a, thor, 1);
  const ocupada = await chamar(a.env, 'PATCH', '/api/baias/1', { cookie: a.elizabeth, corpo: { ativa: false } });
  assert.equal(ocupada.status, 409);
  const livre = await chamar(a.env, 'PATCH', '/api/baias/2', { cookie: a.elizabeth, corpo: { ativa: false } });
  assert.equal(livre.status, 200);
  q = await quadro(a, a.elizabeth);
  assert.deepEqual(q.baias.map((b) => b.nome), ['Baia 1', 'UTI']);
  assert.deepEqual(q.desativadas, [{ id: 2, nome: 'Baia 2' }]);
  assert.deepEqual((await quadro(a, a.filipe)).desativadas, []); // só administrador vê as desativadas
  // Baia desativada não recebe paciente; reativar funciona.
  const rex = await novoPet(a, 'Rex');
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: rex.id, baia_id: 2, motivo: 'x' } })).status, 409);
  await chamar(a.env, 'PATCH', '/api/baias/2', { cookie: a.elizabeth, corpo: { ativa: true } });
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: rex.id, baia_id: 2, motivo: 'x' } })).status, 201);
  assert.equal(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE entidade = 'baias'`).get().n, 4); // criar, renomear, desativar, reativar
});

// ---------- internar ----------
test('internar: uma por baia e uma por pet (o banco também garante); recepção não interna', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const rex = await novoPet(a, 'Rex');
  const mel = await novoPet(a, 'Mel');
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.recepcao, corpo: { pet_id: thor.id, baia_id: 1, motivo: 'x' } })).status, 403);
  const d = await internar(a, thor, 1, { motivo: ' Vômito e diarreia ' }, a.suporte);
  assert.equal(d.internacao.status, 'internado');
  assert.equal(d.internacao.motivo, 'Vômito e diarreia');
  assert.equal(d.internacao.baia.nome, 'Baia 1');
  assert.equal(d.internacao.dias, 1);
  assert.equal(d.internacao.inicio_em, T0);
  assert.deepEqual(d.medicacoes, []);

  const baiaOcupada = await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: rex.id, baia_id: 1, motivo: 'x' } });
  assert.equal(baiaOcupada.status, 409);
  assert.match(baiaOcupada.dados.erro, /ocupada/);
  const petInternado = await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: thor.id, baia_id: 2, motivo: 'x' } });
  assert.equal(petInternado.status, 409);
  assert.match(petInternado.dados.erro, /já está internado/);
  // Validações.
  for (const corpo of [{ baia_id: 2, motivo: 'x' }, { pet_id: rex.id, motivo: 'x' }, { pet_id: rex.id, baia_id: 2 }, { pet_id: rex.id, baia_id: 2, motivo: ' ' }]) {
    assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo })).status, 400);
  }
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: 9999, baia_id: 2, motivo: 'x' } })).status, 404);
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: rex.id, baia_id: 99, motivo: 'x' } })).status, 404);
  // Regra do banco (sem passar pela API): duas internações abertas na mesma baia/pet são barradas.
  const bruto = a.env.DB.bruto;
  assert.throws(() => bruto.prepare(`INSERT INTO internacoes (pet_id, baia_id, inicio_em, motivo, criado_por) VALUES (?, 1, ?, 'x', 1)`).run(rex.id, T0), /UNIQUE/);
  assert.throws(() => bruto.prepare(`INSERT INTO internacoes (pet_id, baia_id, inicio_em, motivo, criado_por) VALUES (?, 2, ?, 'x', 1)`).run(thor.id, T0), /UNIQUE/);
  // Mel entra na baia 2 normalmente.
  await internar(a, mel, 2);
  assert.equal((await chamar(a.env, 'GET', `/api/internacoes/${d.internacao.id}`, { cookie: a.recepcao })).status, 403);
});

test('internar ligado a um atendimento; atendimento de outro pet é recusado', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const rex = await novoPet(a, 'Rex');
  const atRex = await atendimentoEmAndamento(a, rex);
  const atThor = await atendimentoEmAndamento(a, thor);
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: thor.id, baia_id: 1, motivo: 'x', atendimento_id: atRex } })).status, 400);
  const d = await internar(a, thor, 1, { atendimento_id: atThor });
  assert.equal(d.internacao.atendimento_id, atThor);
});

// ---------- quadro ----------
test('quadro: veterinário vê remédio e motivo; recepção só pet, tutor e dias', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor', 'TESTE Maria');
  const d = await internar(a, thor, 1);
  await medicar(a, d.internacao.id, { remedio: 'Dipirona', intervalo_horas: 8 });
  const vet = await quadro(a);
  const b1 = vet.baias[0];
  assert.equal(b1.ocupante.pet.nome, 'Thor');
  assert.equal(b1.ocupante.tutor.nome, 'TESTE Maria');
  assert.equal(b1.ocupante.dias, 1);
  assert.equal(b1.ocupante.motivo, 'Gastroenterite');
  assert.equal(b1.ocupante.proxima_medicacao.remedio, 'Dipirona');
  assert.equal(b1.ocupante.proxima_medicacao.status, 'futura');
  assert.equal(vet.baias[1].ocupante, null);
  assert.deepEqual(vet.resumo, { internados: 1, medicacoes_atrasadas: 0, medicacoes_agora: 0 });

  const rec = await quadro(a, a.recepcao);
  assert.equal(rec.baias[0].ocupante.pet.nome, 'Thor');
  assert.equal(rec.baias[0].ocupante.dias, 1);
  assert.ok(!('motivo' in rec.baias[0].ocupante));
  assert.ok(!('proxima_medicacao' in rec.baias[0].ocupante));
  assert.deepEqual(rec.resumo, { internados: 1 });
  assert.ok(!JSON.stringify(rec).includes('Dipirona'));
  assert.ok(!JSON.stringify(rec).includes('Gastroenterite'));
  assert.equal((await chamar(a.env, 'GET', '/api/internacao')).status, 401);

  // Dois dias depois (meia-noite de Bahia no meio): "3º dia".
  a.relogio.agora = new Date('2026-11-12T15:00:00.000Z');
  assert.equal((await quadro(a)).baias[0].ocupante.dias, 3);
  assert.equal((await quadro(a, a.recepcao)).baias[0].ocupante.dias, 3);
});

test('quadro: remédio atrasado e na hora entram no resumo (relógio fixo)', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const rex = await novoPet(a, 'Rex');
  const i1 = (await internar(a, thor, 1)).internacao.id;
  const i2 = (await internar(a, rex, 2)).internacao.id;
  // Thor: começou há 9 h com intervalo de 8 h -> atrasada há 1 h. Outra de 12 h -> futura.
  await medicar(a, i1, { remedio: 'Amoxicilina', intervalo_horas: 8, inicio_em: hmais(-9).toISOString() });
  await medicar(a, i1, { remedio: 'Omeprazol', intervalo_horas: 12 });
  // Rex: começou há 8 h com intervalo de 8 h -> está na hora.
  await medicar(a, i2, { remedio: 'Dipirona', intervalo_horas: 8, inicio_em: hmais(-8).toISOString() });
  const q = await quadro(a);
  const p1 = q.baias[0].ocupante.proxima_medicacao;
  assert.equal(p1.remedio, 'Amoxicilina');
  assert.equal(p1.status, 'atrasada');
  assert.equal(p1.minutos_ate_proxima, -60);
  assert.equal(q.baias[1].ocupante.proxima_medicacao.status, 'agora');
  assert.deepEqual(q.resumo, { internados: 2, medicacoes_atrasadas: 1, medicacoes_agora: 1 });
  // Passam 8 horas: Amoxicilina e Dipirona ficam atrasadas; encerrar uma tira do resumo.
  a.relogio.agora = hmais(8);
  assert.equal((await quadro(a)).resumo.medicacoes_atrasadas, 2);
});

// ---------- detalhes e medicações ----------
test('detalhes: medicações com status, dia do tratamento, última dose e quem deu', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const d = await internar(a, thor, 1);
  const id = d.internacao.id;
  const r = await medicar(a, id, { remedio: 'Amoxicilina', dose: '250 mg', via: 'Uso oral', quantidade: '1 comprimido', intervalo_horas: 12, duracao_dias: 5, observacao: 'Com comida' });
  const m = r.medicacoes[0];
  assert.deepEqual([m.remedio, m.dose, m.via, m.quantidade, m.intervalo_horas, m.duracao_dias, m.observacao], ['Amoxicilina', '250 mg', 'Uso oral', '1 comprimido', 12, 5, 'Com comida']);
  assert.equal(m.inicio_em, T0);
  assert.equal(m.status, 'futura');
  assert.equal(m.dia_tratamento, 1);
  assert.equal(m.ultima_em, null);
  assert.equal(m.proxima_em, hmais(12).toISOString());

  // "Dei agora" às 21:10 UTC por outro profissional.
  a.relogio.agora = minutosDepois(T0, 12 * 60 + 10);
  const adm = await chamar(a.env, 'POST', `/api/internacao-medicacoes/${m.id}/administrar`, { cookie: a.suporte, corpo: { observacao: 'Aceitou bem' } });
  assert.equal(adm.status, 201);
  const m2 = adm.dados.medicacoes[0];
  assert.equal(m2.ultima_em, a.relogio.agora.toISOString());
  assert.equal(m2.ultima_por, 'Sup');
  assert.equal(m2.proxima_em, minutosDepois(a.relogio.agora, 12 * 60).toISOString());
  assert.equal(m2.status, 'futura');
  assert.equal(m2.doses.length, 1);
  assert.equal(m2.doses[0].observacao, 'Aceitou bem');
  assert.equal(m2.doses[0].feita_por.nome, 'Sup');
  // No dia seguinte o tratamento está no "dia 2 de 5".
  a.relogio.agora = hmais(25);
  const det = (await chamar(a.env, 'GET', `/api/internacoes/${id}`, { cookie: a.filipe })).dados;
  assert.equal(det.medicacoes[0].dia_tratamento, 2);
  assert.equal(det.internacao.dias, 2);
  assert.equal(det.internacao.horas, 25);
});

test('medicação: valida campos, intervalo de 0,5 a 168 h, duração e início', async () => {
  const a = await ambiente(T0);
  const d = await internar(a, await novoPet(a, 'Thor'), 1);
  const url = `/api/internacoes/${d.internacao.id}/medicacoes`;
  const post = (corpo, cookie = a.filipe) => chamar(a.env, 'POST', url, { cookie, corpo });
  assert.equal((await post({ intervalo_horas: 8 })).status, 400); // sem remédio
  assert.equal((await post({ remedio: 'X' })).status, 400); // sem intervalo
  for (const iv of [0, 0.4, 169, -1, 'abc', null, NaN]) assert.equal((await post({ remedio: 'X', intervalo_horas: iv })).status, 400, String(iv));
  for (const iv of [0.5, 4, '0,5', 168, 36]) assert.equal((await post({ remedio: 'X', intervalo_horas: iv })).status, 201, String(iv));
  for (const du of [0, -1, 1.5, 366, 'x']) assert.equal((await post({ remedio: 'X', intervalo_horas: 8, duracao_dias: du })).status, 400, String(du));
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8, duracao_dias: 365 })).status, 201);
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8, duracao_dias: '' })).status, 201);
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8, inicio_em: 'ontem' })).status, 400);
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8, inicio_em: '2020-01-01T00:00:00.000Z' })).status, 400);
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8, inicio_em: '2027-01-01T00:00:00.000Z' })).status, 400);
  assert.equal((await post({ remedio: 'X'.repeat(121), intervalo_horas: 8 })).status, 400);
  assert.equal((await post({ remedio: 'X', intervalo_horas: 8 }, a.recepcao)).status, 403);
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes/999/medicacoes', { cookie: a.filipe, corpo: { remedio: 'X', intervalo_horas: 8 } })).status, 404);
});

test('editar e encerrar medicação; medicação encerrada não aceita dose nem edição', async () => {
  const a = await ambiente(T0);
  const d = await internar(a, await novoPet(a, 'Thor'), 1);
  const med = (await medicar(a, d.internacao.id, { remedio: 'Dipirona', intervalo_horas: 8 })).medicacoes[0];
  const ed = await chamar(a.env, 'PATCH', `/api/internacao-medicacoes/${med.id}`, { cookie: a.suporte, corpo: { intervalo_horas: 6, dose: '300 mg', duracao_dias: 3 } });
  assert.equal(ed.status, 200);
  assert.deepEqual([ed.dados.medicacoes[0].intervalo_horas, ed.dados.medicacoes[0].dose, ed.dados.medicacoes[0].duracao_dias], [6, '300 mg', 3]);
  assert.equal((await chamar(a.env, 'PATCH', `/api/internacao-medicacoes/${med.id}`, { cookie: a.filipe, corpo: { intervalo_horas: 500 } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/internacao-medicacoes/${med.id}`, { cookie: a.recepcao, corpo: { dose: 'x' } })).status, 403);
  const fim = await chamar(a.env, 'PATCH', `/api/internacao-medicacoes/${med.id}`, { cookie: a.filipe, corpo: { encerrar: true } });
  assert.equal(fim.status, 200);
  assert.equal(fim.dados.medicacoes[0].situacao, 'encerrada');
  assert.ok(fim.dados.medicacoes[0].encerrada_em);
  assert.equal((await chamar(a.env, 'PATCH', `/api/internacao-medicacoes/${med.id}`, { cookie: a.filipe, corpo: { dose: 'y' } })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} })).status, 409);
  // Encerrada some do "próxima medicação" do quadro.
  assert.equal((await quadro(a)).baias[0].ocupante.proxima_medicacao, null);
  assert.equal((await chamar(a.env, 'PATCH', '/api/internacao-medicacoes/999', { cookie: a.filipe, corpo: { dose: 'y' } })).status, 404);
});

test('"Dei agora": registra quem e quando; toque duplo em menos de 1 min é barrado; dá para desfazer em 1 min', async () => {
  const a = await ambiente(T0);
  const d = await internar(a, await novoPet(a, 'Thor'), 1);
  const med = (await medicar(a, d.internacao.id, { remedio: 'Dipirona', intervalo_horas: 8, inicio_em: hmais(-9).toISOString() })).medicacoes[0];
  assert.equal(med.status, 'atrasada');
  assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.recepcao, corpo: {} })).status, 403);

  const r = await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} });
  assert.equal(r.status, 201);
  assert.equal(r.dados.medicacoes[0].status, 'futura'); // já não está atrasada
  assert.equal(r.dados.medicacoes[0].proxima_em, hmais(8).toISOString());
  assert.equal(r.dados.medicacoes[0].ultima_por, 'Dr. Filipe');
  // Segundo toque 30 s depois: barrado.
  a.relogio.agora = new Date(a.relogio.agora.getTime() + 30000);
  assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} })).status, 409);
  assert.equal(a.env.DB.bruto.prepare('SELECT COUNT(*) AS n FROM administracoes').get().n, 1);
  // Desfazer: só quem deu, só em 1 min.
  const dose = r.dados.administracao_id;
  assert.equal((await chamar(a.env, 'POST', `/api/administracoes/${dose}/desfazer`, { cookie: a.suporte, corpo: {} })).status, 403);
  const desf = await chamar(a.env, 'POST', `/api/administracoes/${dose}/desfazer`, { cookie: a.filipe, corpo: {} });
  assert.equal(desf.status, 200);
  assert.equal(desf.dados.medicacoes[0].status, 'atrasada'); // voltou ao que era
  assert.equal(desf.dados.medicacoes[0].doses.length, 0);
  // Nova dose, e depois de mais de 1 min já não desfaz.
  const r2 = await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} });
  assert.equal(r2.status, 201);
  a.relogio.agora = new Date(a.relogio.agora.getTime() + 61000);
  assert.equal((await chamar(a.env, 'POST', `/api/administracoes/${r2.dados.administracao_id}/desfazer`, { cookie: a.filipe, corpo: {} })).status, 409);
  assert.equal((await chamar(a.env, 'POST', '/api/administracoes/999/desfazer', { cookie: a.filipe, corpo: {} })).status, 404);
  // Depois de 1 min um novo "Dei agora" é aceito.
  assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} })).status, 201);
  const acoes = a.env.DB.bruto.prepare(`SELECT acao FROM registro_acoes WHERE entidade = 'administracoes' ORDER BY id`).all().map((x) => x.acao);
  assert.deepEqual(acoes, ['administrar_medicacao', 'desfazer_administracao', 'administrar_medicacao', 'administrar_medicacao']);
});

// ---------- mover e encerrar ----------
test('mover: baia livre e ativa; ocupada = 409; a baia antiga fica livre', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const rex = await novoPet(a, 'Rex');
  const i1 = (await internar(a, thor, 1)).internacao.id;
  await internar(a, rex, 2);
  const mover = (id, baia, cookie = a.filipe) => chamar(a.env, 'POST', `/api/internacoes/${id}/mover`, { cookie, corpo: { baia_id: baia } });
  assert.equal((await mover(i1, 2)).status, 409);
  assert.equal((await mover(i1, 1)).status, 400);
  assert.equal((await mover(i1, 99)).status, 404);
  assert.equal((await mover(i1, 'x')).status, 400);
  assert.equal((await mover(i1, 2, a.recepcao)).status, 403);
  const nova = (await chamar(a.env, 'POST', '/api/baias', { cookie: a.elizabeth, corpo: { nome: 'Baia 3' } })).dados.id;
  const ok = await mover(i1, nova);
  assert.equal(ok.status, 200);
  assert.equal(ok.dados.internacao.baia.nome, 'Baia 3');
  const q = await quadro(a);
  assert.equal(q.baias.find((b) => b.id === 1).ocupante, null);
  assert.equal(q.baias.find((b) => b.id === nova).ocupante.pet.nome, 'Thor');
  // A baia 1 liberou: o Rex pode ir para lá.
  assert.equal((await mover(a.env.DB.bruto.prepare(`SELECT id FROM internacoes WHERE pet_id = ?`).get(rex.id).id, 1)).status, 200);
  // Desativada não serve de destino.
  await chamar(a.env, 'PATCH', '/api/baias/2', { cookie: a.elizabeth, corpo: { ativa: false } });
  assert.equal((await mover(i1, 2)).status, 409);
});

test('encerrar: alta/óbito/transferido libera a baia e encerra as medicações; não repete', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const d = await internar(a, thor, 1);
  const id = d.internacao.id;
  const med = (await medicar(a, id, { remedio: 'Dipirona', intervalo_horas: 8 })).medicacoes[0];
  const encerrar = (corpo, cookie = a.filipe, alvo = id) => chamar(a.env, 'POST', `/api/internacoes/${alvo}/encerrar`, { cookie, corpo });
  assert.equal((await encerrar({ status: 'alta' }, a.recepcao)).status, 403);
  assert.equal((await encerrar({ status: 'internado' })).status, 400);
  assert.equal((await encerrar({})).status, 400);
  assert.equal((await encerrar({ status: 'obito' })).status, 400); // óbito pede observação
  assert.equal((await encerrar({ status: 'transferido', observacao: ' ' })).status, 400);
  a.relogio.agora = hmais(30);
  const r = await encerrar({ status: 'alta', observacao: 'Voltou a comer.' });
  assert.equal(r.status, 200);
  assert.equal(r.dados.internacao.status, 'alta');
  assert.equal(r.dados.internacao.alta_em, hmais(30).toISOString());
  assert.equal(r.dados.internacao.observacao_alta, 'Voltou a comer.');
  assert.equal(r.dados.internacao.encerrado_por_nome, 'Dr. Filipe');
  assert.equal(r.dados.medicacoes[0].situacao, 'encerrada');
  // Baia livre; some do quadro e permite novo paciente.
  assert.equal((await quadro(a)).baias[0].ocupante, null);
  assert.equal((await quadro(a)).resumo.internados, 0);
  const rex = await novoPet(a, 'Rex');
  const d2 = await internar(a, rex, 1);
  // O Thor (que teve alta) pode ser internado de novo.
  assert.equal((await chamar(a.env, 'POST', '/api/internacoes', { cookie: a.filipe, corpo: { pet_id: thor.id, baia_id: 2, motivo: 'Recaída' } })).status, 201);
  // Já encerrada: nada mais funciona nela.
  assert.equal((await encerrar({ status: 'alta' })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/internacoes/${id}/mover`, { cookie: a.filipe, corpo: { baia_id: 1 } })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/internacoes/${id}/medicacoes`, { cookie: a.filipe, corpo: { remedio: 'X', intervalo_horas: 8 } })).status, 409);
  assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${med.id}/administrar`, { cookie: a.filipe, corpo: {} })).status, 409);
  // Histórico continua legível (dias param de contar na alta).
  const ver = await chamar(a.env, 'GET', `/api/internacoes/${id}`, { cookie: a.filipe });
  assert.equal(ver.dados.internacao.dias, 2); // entrou 09:00 do dia 10; alta 15:00 do dia 11 (Bahia)
  // Óbito e transferido também liberam.
  assert.equal((await encerrar({ status: 'obito', observacao: 'Parada cardiorrespiratória.' }, a.suporte, d2.internacao.id)).status, 200);
  assert.equal(a.env.DB.bruto.prepare(`SELECT status FROM internacoes WHERE id = ?`).get(d2.internacao.id).status, 'obito');
  const acoes = a.env.DB.bruto.prepare(`SELECT acao FROM registro_acoes WHERE entidade = 'internacoes' ORDER BY id`).all().map((x) => x.acao);
  assert.deepEqual(acoes, ['criar_internacao', 'encerrar_internacao', 'criar_internacao', 'criar_internacao', 'encerrar_internacao']);
});

// ---------- prontuário na internação ----------
test('anotações da internação (evolução) aparecem na baia e no prontuário do pet', async () => {
  const a = await ambiente(T0);
  const thor = await novoPet(a, 'Thor');
  const d = await internar(a, thor, 1);
  const n = await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.suporte, corpo: { pet_id: thor.id, internacao_id: d.internacao.id, texto: 'Evolução: comeu um pouco.' } });
  assert.equal(n.status, 201);
  assert.equal(n.dados.internacao.baia_nome, 'Baia 1');
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: thor.id, texto: 'Anotação solta' } });
  const det = (await chamar(a.env, 'GET', `/api/internacoes/${d.internacao.id}`, { cookie: a.filipe })).dados;
  assert.deepEqual(det.notas.map((x) => x.texto), ['Evolução: comeu um pouco.']);
  const pront = (await chamar(a.env, 'GET', `/api/pets/${thor.id}/prontuario`, { cookie: a.filipe })).dados;
  assert.equal(pront.notas.length, 2);
  assert.deepEqual(pront.internacao_atual, { id: d.internacao.id, baia_nome: 'Baia 1', inicio_em: T0 });
});

// ---------- dados de teste ----------
test('apagar dados de teste leva junto internações, medicações, doses e anotações dos pets de teste', async () => {
  const a = await ambiente(T0);
  const teste = await novoPet(a, 'Thor', 'TESTE Maria');
  const real = await novoPet(a, 'Fido', 'Ana Real');
  const at = await atendimentoEmAndamento(a, teste);
  const i1 = (await internar(a, teste, 1, { atendimento_id: at })).internacao.id;
  const i2 = (await internar(a, real, 2)).internacao.id;
  const m1 = (await medicar(a, i1, { remedio: 'Teste' })).medicacoes[0].id;
  const m2 = (await medicar(a, i2, { remedio: 'Real' })).medicacoes[0].id;
  for (const m of [m1, m2]) assert.equal((await chamar(a.env, 'POST', `/api/internacao-medicacoes/${m}/administrar`, { cookie: a.filipe, corpo: {} })).status, 201);
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: teste.id, atendimento_id: at, texto: 'nota de teste' } });
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: teste.id, internacao_id: i1, texto: 'evolução de teste' } });
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: real.id, internacao_id: i2, texto: 'nota real' } });

  const previa = await chamar(a.env, 'GET', '/api/admin/dados-teste', { cookie: a.elizabeth });
  assert.equal(previa.dados.internacoes, 1);
  assert.equal(previa.dados.anotacoes, 2);
  const r = await chamar(a.env, 'POST', '/api/admin/apagar-dados-teste', { cookie: a.elizabeth, corpo: { confirmacao: 'APAGAR' } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const conta = (t) => a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([conta('internacoes'), conta('internacao_medicacoes'), conta('administracoes'), conta('prontuario')], [1, 1, 1, 1]);
  assert.equal(a.env.DB.bruto.prepare('SELECT texto FROM prontuario').get().texto, 'nota real');
  assert.equal(a.env.DB.bruto.prepare('SELECT remedio FROM internacao_medicacoes').get().remedio, 'Real');
  assert.equal(conta('baias'), 2); // as baias ficam
  const q = await quadro(a);
  assert.equal(q.baias[0].ocupante, null); // a baia do pet de teste ficou livre
  assert.equal(q.baias[1].ocupante.pet.nome, 'Fido');
});

// ---------- migração sobre dados existentes ----------
test('migração 0010 roda sobre um banco com dados das migrações 0001-0009 e não mexe neles', async () => {
  const { criarBancoLocal } = await import('./d1-local.js');
  const db = criarBancoLocal({ ate: '0009' });
  const b = db.bruto;
  const t = '2026-01-01T00:00:00.000Z';
  b.prepare(`INSERT INTO usuarios (nome, login, senha_hash, papel, admin, ativo, criado_em, atualizado_em) VALUES ('Vet', 'vet', 'x', 'veterinario', 1, 1, ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO tutores (codigo, nome, origem, criado_em, atualizado_em) VALUES ('T-000001', 'Ana', 'recepcao', ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO pets (codigo, tutor_id, nome, especie, origem, criado_em, atualizado_em) VALUES ('P-000001', 1, 'Rex', 'cao', 'recepcao', ?, ?)`).run(t, t);
  b.prepare(`INSERT INTO atendimentos (pet_id, chegada_em, status, registrado_por, criado_em, atualizado_em) VALUES (1, ?, 'finalizado', 1, ?, ?)`).run(t, t, t);
  b.prepare(`INSERT INTO receitas (pet_id, criado_por, texto, criado_em, atualizado_em) VALUES (1, 1, 'Dipirona', ?, ?)`).run(t, t);
  const antes = JSON.stringify(['usuarios', 'tutores', 'pets', 'atendimentos', 'receitas', 'catalogo', 'configuracoes'].map((x) => b.prepare(`SELECT * FROM ${x}`).all()));
  assert.throws(() => b.prepare('SELECT 1 FROM prontuario').get(), /no such table/);
  db.migrarRestante();
  // A coluna nova iniciado_por (migração 0011) nasce vazia nos atendimentos antigos; fora ela, nada muda.
  const semNova = (linhas) => linhas.map((l) => { const { iniciado_por: nova, ...resto } = l; assert.ok(nova === undefined || nova === null); return resto; });
  assert.equal(JSON.stringify(['usuarios', 'tutores', 'pets', 'atendimentos', 'receitas', 'catalogo', 'configuracoes'].map((x) => semNova(b.prepare(`SELECT * FROM ${x}`).all()))), antes);
  assert.deepEqual(b.prepare('SELECT nome, ordem, ativa FROM baias ORDER BY ordem').all().map((x) => ({ ...x })), [{ nome: 'Baia 1', ordem: 1, ativa: 1 }, { nome: 'Baia 2', ordem: 2, ativa: 1 }]);
  assert.deepEqual(b.prepare('PRAGMA foreign_key_check').all(), []);
  // As tabelas novas funcionam sobre os dados antigos.
  b.prepare(`INSERT INTO internacoes (pet_id, atendimento_id, baia_id, inicio_em, motivo, criado_por) VALUES (1, 1, 1, ?, 'x', 1)`).run(t);
  b.prepare(`INSERT INTO prontuario (pet_id, atendimento_id, internacao_id, texto, criado_por, criado_em) VALUES (1, 1, 1, 'nota', 1, ?)`).run(t);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM prontuario WHERE pet_id = 1').get().n, 1);
  assert.throws(() => b.prepare(`INSERT INTO prontuario (pet_id, texto, criado_por, criado_em) VALUES (1, ?, 1, ?)`).run('a'.repeat(10001), t), /CHECK/);
  assert.throws(() => b.prepare(`INSERT INTO internacao_medicacoes (internacao_id, remedio, intervalo_horas, inicio_em, criado_por, criado_em) VALUES (1, 'x', 0.4, ?, 1, ?)`).run(t, t), /CHECK/);
  assert.throws(() => b.prepare(`INSERT INTO internacoes (pet_id, baia_id, inicio_em, motivo, status, criado_por) VALUES (1, 2, ?, 'x', 'desconhecido', 1)`).run(t), /CHECK/);
});
