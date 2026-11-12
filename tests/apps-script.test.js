// Testes do Google Apps Script (apps-script/Vetclin.gs).
// O arquivo é carregado com o módulo "vm" do Node, com versões de mentirinha (fakes) dos serviços do Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const codigo = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps-script', 'Vetclin.gs'), 'utf8');
const copia = (x) => JSON.parse(JSON.stringify(x)); // traz valores do "vm" para este mundo (comparações)

// ---------- fakes ----------
class Faixa {
  constructor(aba, l, c, nl, nc) { Object.assign(this, { aba, l, c, nl, nc }); }
  getValues() { return this.cel((x) => (x.f ? '' : x.v)); }
  getFormulas() { return this.cel((x) => x.f || ''); }
  cel(fn) {
    const saida = [];
    for (let i = 0; i < this.nl; i++) {
      const linha = [];
      for (let j = 0; j < this.nc; j++) linha.push(fn(this.aba.cels.get(`${this.l + i},${this.c + j}`) || { v: '', f: '' }));
      saida.push(linha);
    }
    return saida;
  }
  setValues(m) {
    assert.equal(m.length, this.nl, 'setValues: linhas');
    m.forEach((linha, i) => { assert.equal(linha.length, this.nc, 'setValues: colunas'); linha.forEach((v, j) => this.p(i, j, v)); });
    return this;
  }
  p(i, j, v) {
    const chave = `${this.l + i},${this.c + j}`;
    if (typeof v === 'string' && v.startsWith('=')) this.aba.cels.set(chave, { v: '', f: v });
    else this.aba.cels.set(chave, { v, f: '' });
  }
  setValue(v) { this.p(0, 0, v); return this; }
  setFormula(f) { this.aba.cels.set(`${this.l},${this.c}`, { v: '', f }); return this; }
  setNumberFormat(f) { for (let i = 0; i < this.nl; i++) for (let j = 0; j < this.nc; j++) this.aba.formatos.set(`${this.l + i},${this.c + j}`, f); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  clearContent() { for (let i = 0; i < this.nl; i++) for (let j = 0; j < this.nc; j++) this.aba.cels.delete(`${this.l + i},${this.c + j}`); return this; }
}
class Aba {
  constructor(nome) { this.nome = nome; this.cels = new Map(); this.formatos = new Map(); this.congeladas = 0; this.ocultas = []; }
  getLastRow() { let m = 0; for (const [k, x] of this.cels) { if (x.v !== '' || x.f) m = Math.max(m, Number(k.split(',')[0])); } return m; }
  getRange(l, c, nl = 1, nc = 1) { return new Faixa(this, l, c, nl, nc); }
  setFrozenRows(n) { this.congeladas = n; }
  setColumnWidth() {}
  hideColumns(c, n) { this.ocultas.push([c, n]); }
  linha(l, nc = 14) { return this.getRange(l, 1, 1, nc).getValues()[0]; }
  formula(l, c) { return (this.cels.get(`${l},${c}`) || {}).f || ''; }
}
class Arquivo {
  constructor(nome, conteudo, tipo) { this.nome = nome; this.conteudo = conteudo; this.tipo = tipo; this.lixeira = false; this.acesso = null; this.id = 'arq' + (++Arquivo.n); }
  getName() { return this.nome; }
  getUrl() { return 'https://drive.exemplo/' + this.id; }
  setSharing(a, p) { this.acesso = [a, p]; return this; }
  setTrashed(v) { this.lixeira = v; return this; }
  setContent(c) { this.conteudo = c; return this; }
}
Arquivo.n = 0;
const iterador = (lista) => { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; };
class Pasta {
  constructor(nome) { this.nome = nome; this.pastas = []; this.arquivos = []; }
  getFoldersByName(n) { return iterador(this.pastas.filter((p) => p.nome === n)); }
  createFolder(n) { const p = new Pasta(n); this.pastas.push(p); return p; }
  getFilesByName(n) { return iterador(this.arquivos.filter((a) => a.nome === n && !a.lixeira)); }
  getFiles() { return iterador(this.arquivos.filter((a) => !a.lixeira)); }
  createFile(a, conteudo, tipo) {
    const f = typeof a === 'string' ? new Arquivo(a, conteudo, tipo) : new Arquivo(a.nome, a.bytes, a.tipo);
    this.arquivos.push(f);
    return f;
  }
}

// Cria um "Google" novo e carrega o script nele. "servidor(url, cabecalhos)" responde às chamadas ao sistema.
function carregar(servidor) {
  const g = { chamadas: [], logs: [], gatilhos: [], travaLivre: true, alertas: [], respostasPrompt: [] };
  const abas = new Map();
  const planilha = {
    getSheetByName: (n) => abas.get(n) || null,
    insertSheet: (n) => { const a = new Aba(n); abas.set(n, a); return a; },
  };
  const raiz = new Pasta('raiz');
  const props = new Map();
  const bloco = (bytes, tipo) => ({ bytes, tipo, nome: '', getContentType() { return this.tipo; }, setName(n) { this.nome = n; return this; } });
  const ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' },
    prompt: () => { const t = g.respostasPrompt.shift(); return { getSelectedButton: () => 'OK', getResponseText: () => t }; },
    alert: (t, m) => g.alertas.push(`${t}: ${m}`),
    createMenu: (nome) => { const m = { nome, itens: [], addItem(r, f) { this.itens.push([r, f]); return this; }, addSeparator() { return this; }, addToUi() { g.menu = this; } }; return m; },
  };
  const sandbox = {
    Logger: { log: (m) => g.logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => planilha, getUi: () => ui },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => g.travaLivre, releaseLock: () => {} }) },
    Utilities: {
      formatDate: (d) => d.toISOString(),
      base64Decode: (b64) => [...Buffer.from(b64, 'base64')],
      newBlob: (bytes, tipo, nome) => bloco(bytes, tipo).setName(nome),
    },
    UrlFetchApp: {
      fetch: (url, opcoes) => {
        g.chamadas.push({ url, headers: opcoes.headers });
        const r = servidor(url, opcoes.headers) || { code: 404, body: '' };
        return {
          getResponseCode: () => r.code,
          getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
          getBlob: () => bloco([...Buffer.from(r.bytes || [])], r.tipo || 'image/jpeg'),
        };
      },
    },
    DriveApp: { getRootFolder: () => raiz, Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' } },
    ScriptApp: {
      getProjectTriggers: () => [...g.gatilhos],
      deleteTrigger: (t) => { g.gatilhos = g.gatilhos.filter((x) => x !== t); },
      newTrigger: (fn) => {
        const t = { fn, tipo: [] };
        const b = { timeBased() { return b; }, everyMinutes(n) { t.tipo.push(['min', n]); return b; }, everyDays(n) { t.tipo.push(['dias', n]); return b; }, atHour(h) { t.tipo.push(['hora', h]); return b; }, inTimezone(z) { t.tipo.push(['fuso', z]); return b; }, create() { g.gatilhos.push(t); return t; } };
        return b;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox);
  Object.assign(g, { ctx: sandbox, abas, raiz, props });
  g.configurar = () => { props.set('ENDERECO', 'https://vetclin.exemplo.test'); props.set('CHAVE', 'chave-secreta-de-teste-123'); };
  g.pasta = (...caminho) => caminho.reduce((p, n) => p.pastas.find((x) => x.nome === n), raiz);
  return g;
}

// ---------- servidor de mentirinha (imita as regras do Worker) ----------
function pagamento(id, extra = {}) {
  return {
    id, recebido_em: '2026-11-12T15:30:00.000Z', forma: 'pix', valor_centavos: 10000, estornado: false, estornado_em: null, estorno_motivo: null,
    recebido_por: 'Recepção', comprovante_foto_id: null,
    pedido: { id: id * 10, total_centavos: 10000, status: 'pago', itens: [{ descricao: 'Consulta', quantidade: 1, preco_unitario_centavos: 10000 }] },
    pet: { codigo: 'P-00000' + id, nome: 'Thor', especie: 'cao' }, tutor: { codigo: 'T-00000' + id, nome: 'Maria' },
    atendimento: { chegada_em: '2026-11-12T15:00:00.000Z', peso_kg: 5, veterinario: 'Dra. Teste' },
    ...extra,
  };
}
function criarServidor(estado) {
  return (url, headers) => {
    const u = new URL(url);
    if (headers.Authorization !== 'Bearer ' + estado.chave) return { code: 401, body: { erro: 'Chave de acesso inválida.' } };
    if (estado.forcar) return { code: estado.forcar, body: {} };
    const rota = u.pathname.replace('/api/integracao/', '');
    if (rota === 'pagamentos') {
      const [iso, id] = (u.searchParams.get('desde') || '').split(',');
      const ativ = (p) => p.estornado_em || p.recebido_em;
      const lista = estado.pagamentos.filter((p) => (id === undefined ? ativ(p) >= (iso || '') : ativ(p) > iso || (ativ(p) === iso && p.id > Number(id)))).sort((a, b) => (ativ(a) + String(a.id).padStart(9, '0')).localeCompare(ativ(b) + String(b.id).padStart(9, '0')));
      const pagina = lista.slice(0, estado.tamanhoPagina || 500);
      const ult = pagina[pagina.length - 1];
      return { code: 200, body: { pagamentos: pagina, mais: lista.length > pagina.length, proximo: ult ? `${ativ(ult)},${ult.id}` : null } };
    }
    if (rota.startsWith('foto/')) {
      estado.fotosBaixadas.push(rota);
      if (estado.fotoFalha) return { code: 500, body: {} };
      return { code: 200, bytes: [0xff, 0xd8, 0xff, 1], tipo: 'image/jpeg', body: '' };
    }
    if (rota === 'backup') return { code: 200, body: { versao: 1, gerado_em: '2026-11-12T00:00:00.000Z', migracoes: [], tabelas: { pets: [{ id: 1 }] } } };
    if (rota === 'fotos-backup') {
      const desde = Number(u.searchParams.get('desde_id'));
      const fotos = (estado.fotosBackup || []).filter((f) => f.id > desde);
      return { code: 200, body: { fotos, mais: false, proximo: fotos.length ? fotos[fotos.length - 1].id : desde } };
    }
    return { code: 404, body: {} };
  };
}
const novoEstado = (extra = {}) => ({ chave: 'chave-secreta-de-teste-123', pagamentos: [], fotosBaixadas: [], ...extra });

// ---------- funções puras ----------
test('puras: dinheiro, data/hora no fuso da clínica, procedimentos, situação', () => {
  const g = carregar(() => null);
  const c = g.ctx;
  assert.equal(c.formatarReais(0), 'R$ 0,00');
  assert.equal(c.formatarReais(10000), 'R$ 100,00');
  assert.equal(c.formatarReais(123456), 'R$ 1.234,56');
  assert.equal(c.formatarReais(5), 'R$ 0,05');
  const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  // 17:59 em Bahia = 20:59Z; 02:00Z ainda é o dia anterior em Bahia.
  assert.deepEqual(copia(c.dataHoraLocal('2026-11-12T20:59:00.000Z')), { serial: serial(2026, 11, 12), hora: (17 * 60 + 59) / 1440, dia: '2026-11-12' });
  assert.deepEqual(copia(c.dataHoraLocal('2026-11-12T02:00:00.000Z')), { serial: serial(2026, 11, 11), hora: (23 * 60) / 1440, dia: '2026-11-11' });
  assert.equal(c.serialParaDia(serial(2026, 11, 11)), '2026-11-11');
  assert.equal(c.textoProcedimentos([{ descricao: 'Consulta', quantidade: 1, preco_unitario_centavos: 10000 }, { descricao: 'Vermífugo', quantidade: 2, preco_unitario_centavos: 3050 }]), 'Consulta (R$ 100,00); 2x Vermífugo (R$ 30,50)');
  assert.equal(c.textoSituacao({ estornado: false }), 'Pago');
  assert.equal(c.textoSituacao({ estornado: true, estorno_motivo: 'Duplicado' }), 'Estornado — Duplicado');
  assert.equal(c.formulaLink('https://x/y'), '=HYPERLINK("https://x/y","ver")');
  assert.equal(c.formulaLink(''), '');
});

test('puras: montar linha, upsert, nomes de arquivo, backups antigos, endereço, resumo', () => {
  const g = carregar(() => null);
  const c = g.ctx;
  const linha = copia(c.montarLinha(pagamento(7, { forma: 'cartao', valor_centavos: 5050, comprovante_foto_id: 33 }), '=HYPERLINK("u","ver")'));
  assert.equal(linha.length, 14);
  assert.deepEqual(linha.slice(2), ['Thor', 'P-000007', 'Maria', 'Consulta (R$ 100,00)', 100, 'Cartão', 50.5, 'Recepção', 'Pago', '=HYPERLINK("u","ver")', 7, 33]);
  // Upsert: linha existente é atualizada; nova vai para o fim; id repetido vale o último.
  const plano = copia(c.planejarUpsert({ 5: 2, 6: 3 }, [{ id: 6, valores: ['a'] }, { id: 8, valores: ['b'] }, { id: 8, valores: ['c'] }, { id: 9, valores: ['d'] }], 3));
  assert.deepEqual(plano, { atualizar: [{ linha: 3, valores: ['a'] }], inserir: [{ linha: 4, valores: ['c'] }, { linha: 5, valores: ['d'] }] });
  assert.equal(c.nomeArquivoComprovante('2026-11-12', 'Thor', 7, 'image/jpeg'), '2026-11-12_Thor_7.jpg');
  assert.equal(c.nomeArquivoComprovante('2026-11-12', 'Rex / Jr: "o" bravo', 7, 'image/webp'), '2026-11-12_Rex-Jr-o-bravo_7.webp');
  assert.equal(c.pastaDoMes('2026-11-12'), '2026-11');
  assert.equal(c.nomeBackup('2026-11-12'), 'vetclin-backup-2026-11-12.json');
  const nomes = [];
  for (let i = 1; i <= 33; i++) nomes.push(`vetclin-backup-2026-10-${String(i).padStart(2, '0')}.json`);
  nomes.push('outro-arquivo.json');
  assert.deepEqual(copia(c.backupsParaApagar(nomes, 30)), nomes.slice(0, 3)); // os 3 mais antigos; o arquivo alheio fica
  assert.deepEqual(copia(c.backupsParaApagar(nomes.slice(0, 5), 30)), []);
  assert.equal(c.normalizarEndereco(' vetclin.abc.workers.dev/ '), 'https://vetclin.abc.workers.dev');
  assert.equal(c.normalizarEndereco('https://vetclin.abc.workers.dev/api/saude?x=1'), 'https://vetclin.abc.workers.dev');
  assert.equal(c.normalizarEndereco(''), '');
  assert.equal(c.montarUrl('https://h', 'pagamentos', { desde: '2026-11-01T00:00:00.000Z,5', vazio: '' }), 'https://h/api/integracao/pagamentos?desde=2026-11-01T00%3A00%3A00.000Z%2C5');
  assert.deepEqual(copia(c.diasDistintos([5, 7, 5, '', 0, 6])), [7, 6, 5]);
  const resumo = copia(c.montarLinhasResumo([20, 19], 4));
  assert.equal(resumo[0][0], 20);
  assert.equal(resumo[0][1], '=SUMIFS(Pagamentos!$I:$I,Pagamentos!$A:$A,$A4,Pagamentos!$H:$H,"Pix",Pagamentos!$K:$K,"Pago")');
  assert.match(resumo[1][2], /\$A5.*"Cartão".*"Pago"/);
  assert.match(resumo[1][3], /"Dinheiro"/);
  assert.equal(resumo[1][4], '=SUM(B5:D5)');
  assert.match(c.formulaTotalMes(), /^=SUMIFS\(.*"Pago"\)$/);
});

// ---------- sincronização ----------
test('primeira atualização: cria cabeçalho, formato, linhas e resumo; manda a chave no cabeçalho', async () => {
  const estado = novoEstado({ pagamentos: [pagamento(1), pagamento(2, { recebido_em: '2026-11-12T16:00:00.000Z', forma: 'dinheiro', valor_centavos: 3000 }), pagamento(3, { recebido_em: '2026-11-13T12:00:00.000Z', forma: 'cartao', valor_centavos: 7000 })] });
  const g = carregar(criarServidor(estado));
  g.configurar();
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.ok, true, r.mensagem);
  assert.equal(r.inseridos, 3);
  const aba = g.abas.get('Pagamentos');
  assert.deepEqual(aba.linha(1), copia(g.ctx.CABECALHO));
  assert.equal(aba.congeladas, 1);
  assert.deepEqual(aba.ocultas, [[13, 2]]);
  assert.equal(aba.getLastRow(), 4);
  assert.deepEqual(aba.linha(2).slice(2, 13), ['Thor', 'P-000001', 'Maria', 'Consulta (R$ 100,00)', 100, 'Pix', 100, 'Recepção', 'Pago', '', 1]);
  assert.equal(aba.linha(3)[7], 'Dinheiro');
  assert.equal(aba.formatos.get('2,9'), 'R$ #,##0.00');
  assert.equal(aba.formatos.get('2,1'), 'dd/MM/yyyy');
  // Resumo: um dia por linha (mais novo primeiro), fórmulas escritas.
  const resumo = g.abas.get('Resumo');
  assert.equal(resumo.formula(1, 2).startsWith('=SUMIFS('), true);
  assert.equal(resumo.linha(4, 1)[0] > resumo.linha(5, 1)[0], true);
  assert.match(resumo.formula(4, 2), /\$A4/);
  assert.equal(resumo.formula(5, 5), '=SUM(B5:D5)');
  assert.equal(resumo.getLastRow(), 5);
  // Chave só no cabeçalho Authorization, nunca na URL.
  assert.ok(g.chamadas.length >= 1);
  for (const ch of g.chamadas) { assert.equal(ch.headers.Authorization, 'Bearer chave-secreta-de-teste-123'); assert.ok(!ch.url.includes('chave-secreta')); }
  assert.ok(g.props.get('CURSOR_PAGAMENTOS'));
  assert.match(g.props.get('STATUS'), /3 novos/);
  // Rodar de novo sem novidades não duplica nada.
  const r2 = copia(g.ctx.atualizarPlanilha());
  assert.equal(r2.ok, true);
  assert.equal(aba.getLastRow(), 4);
  assert.equal(r2.inseridos, 0);
});

test('paginação: várias páginas na mesma atualização', () => {
  const estado = novoEstado({ tamanhoPagina: 2, pagamentos: [1, 2, 3, 4, 5].map((i) => pagamento(i, { recebido_em: `2026-11-12T1${i}:00:00.000Z` })) });
  const g = carregar(criarServidor(estado));
  g.configurar();
  assert.equal(copia(g.ctx.atualizarPlanilha()).inseridos, 5);
  assert.equal(g.abas.get('Pagamentos').getLastRow(), 6);
});

test('segunda atualização com estorno: atualiza a MESMA linha (não duplica) e o comprovante já salvo permanece', () => {
  const estado = novoEstado({ pagamentos: [pagamento(1, { comprovante_foto_id: 50 }), pagamento(2)] });
  const g = carregar(criarServidor(estado));
  g.configurar();
  g.ctx.atualizarPlanilha();
  const aba = g.abas.get('Pagamentos');
  assert.equal(aba.getLastRow(), 3);
  const linkAntes = aba.formula(2, 12);
  assert.match(linkAntes, /^=HYPERLINK\("https:\/\/drive\.exemplo\/arq\d+","ver"\)$/);
  // Estorno chega (o pagamento 1 foi recebido antes, mas o estorno é mais novo).
  estado.pagamentos[0] = pagamento(1, { comprovante_foto_id: 50, estornado: true, estornado_em: '2026-11-14T10:00:00.000Z', estorno_motivo: 'Cobrança em duplicidade' });
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.ok, true);
  assert.equal(r.atualizados, 1);
  assert.equal(r.inseridos, 0);
  assert.equal(aba.getLastRow(), 3);
  assert.equal(aba.linha(2)[10], 'Estornado — Cobrança em duplicidade');
  assert.equal(aba.linha(2)[12], 1); // mesma linha (2) e mesmo ID
  assert.equal(aba.linha(3)[10], 'Pago');
  assert.equal(aba.formula(2, 12), linkAntes);
  assert.equal(estado.fotosBaixadas.length, 1); // a foto não foi baixada de novo
});

test('comprovante: salvo uma única vez, na pasta do mês, com o nome certo e privado', () => {
  const estado = novoEstado({ pagamentos: [pagamento(4, { comprovante_foto_id: 77, pet: { codigo: 'P-1', nome: 'Rex Jr', especie: 'cao' } })] });
  const g = carregar(criarServidor(estado));
  g.configurar();
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.comprovantes, 1);
  const pasta = g.pasta('Vetclin', 'Comprovantes', '2026-11');
  assert.equal(pasta.arquivos.length, 1);
  assert.equal(pasta.arquivos[0].nome, '2026-11-12_Rex-Jr_4.jpg');
  assert.deepEqual(pasta.arquivos[0].acesso, ['PRIVATE', 'NONE']);
  assert.match(g.abas.get('Pagamentos').formula(2, 12), new RegExp(pasta.arquivos[0].id));
  // Várias atualizações depois: continua 1 arquivo, 1 download.
  g.ctx.atualizarPlanilha(); g.ctx.atualizarPlanilha();
  assert.equal(pasta.arquivos.length, 1);
  assert.deepEqual(estado.fotosBaixadas, ['foto/77']);
  // Pagamento do dia 13 em outra pasta de mês? (mesmo mês aqui). Dia 01/12 vai para 2026-12.
  estado.pagamentos.push(pagamento(5, { recebido_em: '2026-12-01T12:00:00.000Z', comprovante_foto_id: 78 }));
  g.ctx.atualizarPlanilha();
  assert.equal(g.pasta('Vetclin', 'Comprovantes', '2026-12').arquivos.length, 1);
});

test('comprovante: se o download falha, a linha entra sem link e a próxima atualização tenta de novo', () => {
  const estado = novoEstado({ pagamentos: [pagamento(1, { comprovante_foto_id: 9 })], fotoFalha: true });
  const g = carregar(criarServidor(estado));
  g.configurar();
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.ok, true); // não quebra
  assert.equal(r.comprovantes, 0);
  const aba = g.abas.get('Pagamentos');
  assert.equal(aba.formula(2, 12), '');
  assert.ok(g.logs.some((l) => l.includes('não foi salvo')));
  estado.fotoFalha = false;
  assert.equal(copia(g.ctx.atualizarPlanilha()).comprovantes, 1);
  assert.match(aba.formula(2, 12), /HYPERLINK/);
});

test('comprovante: se o arquivo já existe no Drive (script parou no meio), reaproveita sem duplicar', () => {
  const estado = novoEstado({ pagamentos: [pagamento(4, { comprovante_foto_id: 77 })] });
  const g = carregar(criarServidor(estado));
  g.configurar();
  const pasta = g.raiz.createFolder('Vetclin').createFolder('Comprovantes').createFolder('2026-11');
  const antigo = pasta.createFile({ nome: '2026-11-12_Thor_4.jpg', bytes: [1], tipo: 'image/jpeg' });
  g.ctx.atualizarPlanilha();
  assert.equal(pasta.arquivos.length, 1);
  assert.match(g.abas.get('Pagamentos').formula(2, 12), new RegExp(antigo.id));
});

// ---------- cópia de segurança ----------
test('backup: salva o JSON do dia, mantém só os 30 mais novos e não mexe em outros arquivos', () => {
  const g = carregar(criarServidor(novoEstado()));
  g.configurar();
  const pasta = g.raiz.createFolder('Vetclin').createFolder('Backups');
  for (let i = 0; i < 34; i++) pasta.createFile(`vetclin-backup-2020-01-${String(i + 1).padStart(2, '0')}.json`, '{}', 'application/json');
  const alheio = pasta.createFile('minhas-anotacoes.txt', 'oi', 'text/plain');
  const r = copia(g.ctx.fazerBackup());
  assert.equal(r.ok, true, r.mensagem);
  const vivos = pasta.arquivos.filter((a) => !a.lixeira && /^vetclin-backup-/.test(a.nome));
  assert.equal(vivos.length, 30);
  assert.ok(vivos.some((a) => a.nome === r.arquivo)); // o de hoje está lá
  assert.equal(pasta.arquivos.filter((a) => a.lixeira).length, 5); // 35 - 30
  assert.ok(pasta.arquivos.filter((a) => a.lixeira).every((a) => a.nome.startsWith('vetclin-backup-2020-01-0')));
  assert.equal(alheio.lixeira, false);
  assert.equal(JSON.parse(vivos.find((a) => a.nome === r.arquivo).conteudo).versao, 1);
  // Duas vezes no mesmo dia: sobrescreve, não duplica.
  g.ctx.fazerBackup();
  assert.equal(pasta.arquivos.filter((a) => a.nome === r.arquivo).length, 1);
});

test('backup: espelha as fotos aos poucos (cursor) sem repetir', () => {
  const estado = novoEstado({ fotosBackup: [{ id: 1, tipo: 'image/jpeg', base64: Buffer.from([1, 2]).toString('base64') }, { id: 2, tipo: 'image/webp', base64: Buffer.from([3]).toString('base64') }] });
  const g = carregar(criarServidor(estado));
  g.configurar();
  const r = copia(g.ctx.fazerBackup());
  assert.equal(r.fotos, 2);
  const fotos = g.pasta('Vetclin', 'Backups', 'Fotos');
  assert.deepEqual(fotos.arquivos.map((a) => a.nome), ['foto-000001.jpg', 'foto-000002.webp']);
  assert.equal(g.props.get('CURSOR_FOTOS'), '2');
  estado.fotosBackup.push({ id: 3, tipo: 'image/jpeg', base64: Buffer.from([4]).toString('base64') });
  assert.equal(copia(g.ctx.fazerBackup()).fotos, 1);
  assert.equal(fotos.arquivos.length, 3);
  assert.ok(g.chamadas.filter((c) => c.url.includes('fotos-backup')).every((c) => c.headers.Authorization.startsWith('Bearer ')));
});

// ---------- erros ----------
test('401: não quebra, avisa "Chave inválida — gere outra no sistema" e guarda o aviso', () => {
  const g = carregar(criarServidor(novoEstado({ chave: 'outra-chave-completamente-diferente' })));
  g.configurar();
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.ok, false);
  assert.equal(r.chaveInvalida, true);
  assert.equal(r.mensagem, 'Chave inválida — gere outra no sistema');
  assert.match(g.props.get('STATUS'), /Chave inválida — gere outra no sistema/);
  assert.equal(g.props.get('CURSOR_PAGAMENTOS') ?? null, null);
  const b = copia(g.ctx.fazerBackup());
  assert.equal(b.ok, false);
  assert.equal(b.chaveInvalida, true);
  assert.equal(b.mensagem, 'Chave inválida — gere outra no sistema');
  // O gatilho automático também não lança erro.
  assert.doesNotThrow(() => g.ctx.atualizacaoAutomatica());
  assert.doesNotThrow(() => g.ctx.copiaAutomatica());
  // O aviso aparece na aba Resumo, para quem abrir a planilha.
  assert.match(String(g.abas.get('Resumo')?.linha(1, 5)[4] ?? ''), /Chave inválida/);
});

test('outros erros (servidor fora do ar, 429, sem configurar, atualização simultânea) viram mensagem, sem quebrar', () => {
  const estado = novoEstado({ forcar: 500 });
  const g = carregar(criarServidor(estado));
  assert.match(copia(g.ctx.atualizarPlanilha()).mensagem, /Falta configurar/); // ainda sem endereço/chave
  g.configurar();
  assert.match(copia(g.ctx.atualizarPlanilha()).mensagem, /erro 500/);
  estado.forcar = 429;
  assert.match(copia(g.ctx.atualizarPlanilha()).mensagem, /aguardar/);
  estado.forcar = 0;
  g.travaLivre = false; // outra execução está rodando
  const r = copia(g.ctx.atualizarPlanilha());
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /já está em andamento/);
  assert.equal(g.chamadas.length, 2); // nada foi chamado enquanto travado
  assert.equal(copia(g.ctx.fazerBackup()).ok, false);
});

// ---------- gatilhos e menu ----------
test('instalar: remove gatilhos antigos e cria os dois (15 min e diário ~2h)', () => {
  const g = carregar(criarServidor(novoEstado()));
  g.gatilhos.push({ fn: 'antigo' }, { fn: 'outro' });
  g.ctx.instalarGatilhos_();
  assert.equal(g.gatilhos.length, 2);
  assert.deepEqual(copia(g.gatilhos.map((t) => t.fn)), ['atualizacaoAutomatica', 'copiaAutomatica']);
  assert.deepEqual(copia(g.gatilhos[0].tipo), [['min', 15]]);
  assert.deepEqual(copia(g.gatilhos[1].tipo), [['dias', 1], ['hora', 2], ['fuso', 'America/Bahia']]);
  g.ctx.instalarGatilhos_(); // de novo: continua 2
  assert.equal(g.gatilhos.length, 2);
});

test('menu Vetclin e Configurar (valida endereço e chave antes de guardar)', () => {
  const estado = novoEstado();
  const g = carregar(criarServidor(estado));
  g.ctx.onOpen();
  assert.equal(g.menu.nome, 'Vetclin');
  assert.deepEqual(g.menu.itens.map((i) => i[0]), ['Configurar (endereço e chave)', 'Instalar atualizações automáticas', 'Atualizar planilha agora', 'Fazer cópia de segurança agora']);
  for (const [, fn] of g.menu.itens) assert.equal(typeof g.ctx[fn], 'function', fn);
  // Chave errada: não guarda.
  g.respostasPrompt = ['vetclin.exemplo.test/', 'chave-errada'];
  g.ctx.menuConfigurar();
  assert.equal(g.props.get('CHAVE') ?? null, null);
  assert.match(g.alertas.at(-1), /Chave inválida — gere outra no sistema/);
  // Chave certa: guarda o endereço normalizado.
  g.respostasPrompt = ['vetclin.exemplo.test/', ' chave-secreta-de-teste-123 '];
  g.ctx.menuConfigurar();
  assert.equal(g.props.get('ENDERECO'), 'https://vetclin.exemplo.test');
  assert.equal(g.props.get('CHAVE'), 'chave-secreta-de-teste-123');
  assert.match(g.alertas.at(-1), /Tudo certo/);
  g.ctx.menuInstalar();
  assert.equal(g.gatilhos.length, 2);
});
