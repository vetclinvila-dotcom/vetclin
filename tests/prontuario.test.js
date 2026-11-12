// Testes do prontuário: permissões, regra das 24 horas, só o autor edita e registro sem o texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { ORIGEM, ambiente, atendimentoEmAndamento, chamar, minutosDepois, novoPet } from './apoio-clinico.js';

const HORA = 60;

test('recepção não lê nem escreve no prontuário (403); veterinário e suporte sim', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  assert.equal((await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`, { cookie: a.recepcao })).status, 403);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.recepcao, corpo: { pet_id: pet.id, texto: 'x' } })).status, 403);
  assert.equal((await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`)).status, 401);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: 'Vômito há 2 dias.' } })).status, 201);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.suporte, corpo: { pet_id: pet.id, texto: 'Aferida a temperatura.' } })).status, 201);
  // Recepção também não edita.
  const lista = (await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`, { cookie: a.filipe })).dados.notas;
  assert.equal((await chamar(a.env, 'PATCH', `/api/prontuario/${lista[0].id}`, { cookie: a.recepcao, corpo: { texto: 'y' } })).status, 403);
});

test('exige o cabeçalho anti-CSRF nas gravações e valida o texto', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const sem = await worker.fetch(new Request(ORIGEM + '/api/prontuario', { method: 'POST', headers: { Cookie: a.filipe, 'Content-Type': 'application/json' }, body: JSON.stringify({ pet_id: pet.id, texto: 'x' }) }), a.env);
  assert.equal(sem.status, 403);
  for (const texto of ['', '   ', undefined, 5, 'a'.repeat(10001)]) {
    assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto } })).status, 400, String(texto).slice(0, 10));
  }
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: 'a'.repeat(10000) } })).status, 201);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { texto: 'sem pet' } })).status, 400);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: 9999, texto: 'x' } })).status, 404);
  assert.equal((await chamar(a.env, 'GET', '/api/pets/9999/prontuario', { cookie: a.filipe })).status, 404);
});

test('lista: mais nova primeiro, com autor e vínculo com o atendimento', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const outro = await novoPet(a, 'Rex');
  const at = await atendimentoEmAndamento(a, pet);
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: 'Primeira' } });
  a.relogio.agora = minutosDepois(a.relogio.agora, 30);
  const n2 = await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.suporte, corpo: { pet_id: pet.id, atendimento_id: at, texto: 'Segunda\ncom linha' } });
  assert.equal(n2.status, 201);
  assert.equal(n2.dados.atendimento.id, at);
  await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: outro.id, texto: 'Do outro pet' } });
  const r = await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`, { cookie: a.filipe });
  assert.deepEqual(r.dados.notas.map((x) => x.texto), ['Segunda\ncom linha', 'Primeira']);
  assert.equal(r.dados.notas[0].autor.nome, 'Sup');
  assert.equal(r.dados.notas[1].autor.nome, 'Dr. Filipe');
  assert.equal(r.dados.notas[0].internacao, null);
  assert.equal(r.dados.internacao_atual, null);
  // Atendimento ou internação de OUTRO pet: recusado.
  const atOutro = await atendimentoEmAndamento(a, outro);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, atendimento_id: atOutro, texto: 'x' } })).status, 400);
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, internacao_id: 999, texto: 'x' } })).status, 400);
});

test('edição: só o autor, só em 24 h; depois fica só para leitura', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const criada = await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: 'Texto original' } });
  const id = criada.dados.id;
  assert.equal(criada.dados.pode_editar, true);

  // Outro profissional (até o administrador) não edita a anotação alheia.
  assert.equal((await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.suporte, corpo: { texto: 'invasão' } })).status, 403);
  assert.equal((await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.elizabeth, corpo: { texto: 'invasão' } })).status, 403);
  const outroVe = (await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`, { cookie: a.suporte })).dados.notas[0];
  assert.equal(outroVe.pode_editar, false);

  // O autor edita dentro das 24 h (23 h 59 min ainda vale).
  a.relogio.agora = minutosDepois('2026-11-10T12:00:00.000Z', 23 * HORA + 59);
  const ok = await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.filipe, corpo: { texto: 'Texto corrigido' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.dados.texto, 'Texto corrigido');
  assert.equal(ok.dados.editado_em, a.relogio.agora.toISOString());
  assert.equal(ok.dados.editado_por_nome, 'Dr. Filipe');
  assert.equal(ok.dados.criado_em, '2026-11-10T12:00:00.000Z'); // a data original não muda
  // Texto vazio ou grande demais não vale.
  assert.equal((await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.filipe, corpo: { texto: ' ' } })).status, 400);
  assert.equal((await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.filipe, corpo: { texto: 'a'.repeat(10001) } })).status, 400);

  // Passou de 24 h: só leitura (para o autor também).
  a.relogio.agora = minutosDepois('2026-11-10T12:00:00.000Z', 24 * HORA);
  const tarde = await chamar(a.env, 'PATCH', `/api/prontuario/${id}`, { cookie: a.filipe, corpo: { texto: 'tarde demais' } });
  assert.equal(tarde.status, 409);
  assert.match(tarde.dados.erro, /24 horas/);
  const lista = (await chamar(a.env, 'GET', `/api/pets/${pet.id}/prontuario`, { cookie: a.filipe })).dados.notas;
  assert.equal(lista[0].texto, 'Texto corrigido');
  assert.equal(lista[0].pode_editar, false);
  // Dá para escrever uma anotação nova.
  assert.equal((await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: 'Complemento' } })).status, 201);
  assert.equal((await chamar(a.env, 'PATCH', '/api/prontuario/9999', { cookie: a.filipe, corpo: { texto: 'x' } })).status, 404);
});

test('registro de ações: só o tamanho do texto, nunca o conteúdo clínico', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const segredo = 'DIAGNOSTICO-SIGILOSO-XYZ';
  const c = await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: segredo } });
  await chamar(a.env, 'PATCH', `/api/prontuario/${c.dados.id}`, { cookie: a.filipe, corpo: { texto: segredo + ' revisado' } });
  const log = a.env.DB.bruto.prepare(`SELECT acao, antes, depois FROM registro_acoes WHERE entidade = 'prontuario' ORDER BY id`).all();
  assert.deepEqual(log.map((l) => l.acao), ['criar_prontuario', 'editar_prontuario']);
  assert.equal(JSON.parse(log[0].depois).tamanho, segredo.length);
  assert.deepEqual([JSON.parse(log[1].antes).tamanho, JSON.parse(log[1].depois).tamanho], [segredo.length, segredo.length + 9]);
  const tudo = JSON.stringify(a.env.DB.bruto.prepare('SELECT * FROM registro_acoes').all());
  assert.ok(!tudo.includes(segredo));
  // Salvar o mesmo texto não conta como edição.
  const igual = await chamar(a.env, 'PATCH', `/api/prontuario/${c.dados.id}`, { cookie: a.filipe, corpo: { texto: segredo + ' revisado' } });
  assert.equal(igual.status, 200);
  assert.equal(a.env.DB.bruto.prepare(`SELECT COUNT(*) AS n FROM registro_acoes WHERE acao = 'editar_prontuario'`).get().n, 1);
});

test('texto do usuário volta como texto puro (sem HTML interpretado pela API)', async () => {
  const a = await ambiente();
  const pet = await novoPet(a, 'Thor');
  const r = await chamar(a.env, 'POST', '/api/prontuario', { cookie: a.filipe, corpo: { pet_id: pet.id, texto: '<img src=x onerror=alert(1)> & "aspas"' } });
  assert.equal(r.dados.texto, '<img src=x onerror=alert(1)> & "aspas"');
});
