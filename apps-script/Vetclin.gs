/**
 * Vetclin — planilha financeira e cópia de segurança (Google Apps Script).
 *
 * Como funciona (em palavras simples):
 *  - O sistema Vetclin é a "fonte da verdade". Este script só PUXA (lê) os dados do sistema,
 *    usando uma chave de acesso que só serve para leitura. Alterar a planilha NÃO muda nada no sistema.
 *  - A cada 15 minutos ele atualiza a aba "Pagamentos" (uma linha por pagamento) e a aba "Resumo".
 *  - Uma vez por dia (por volta das 2h) ele guarda uma cópia de segurança no Google Drive:
 *    pasta "Vetclin/Backups" (arquivos .json, guarda os 30 mais novos) e "Vetclin/Backups/Fotos".
 *  - Os comprovantes (fotos) vão para o Drive em "Vetclin/Comprovantes/AAAA-MM", só visíveis para o dono.
 *
 * Instalação: veja docs/PLANILHA-E-BACKUP.md.
 * Fuso da clínica: America/Bahia (UTC-03:00, sem horário de verão). Belém também é UTC-03:00.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
var ABA_PAGAMENTOS = 'Pagamentos';
var ABA_RESUMO = 'Resumo';
var CABECALHO = ['Data', 'Hora', 'Pet', 'Código do pet', 'Tutor', 'Procedimentos', 'Total da conta', 'Forma', 'Valor', 'Recebido por', 'Situação', 'Comprovante', 'ID do pagamento', 'ID da foto'];
var COL_COMPROVANTE = 12; // coluna L
var COL_ID = 13; // coluna M (chave da linha)
var COL_FOTO = 14; // coluna N
var DESLOCAMENTO_FUSO_MS = 3 * 60 * 60 * 1000; // UTC-03:00
var DIA_MS = 24 * 60 * 60 * 1000;
var MANTER_BACKUPS = 30;
var MAX_COMPROVANTES_POR_VEZ = 25;
var MAX_PAGINAS_POR_VEZ = 40;
var LIMITE_TEMPO_MS = 4.5 * 60 * 1000; // o Google corta scripts em 6 minutos
var MSG_CHAVE_INVALIDA = 'Chave inválida — gere outra no sistema';
var ROTULO_FORMA = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };

// Erro de comunicação com o sistema. "chaveInvalida" = o sistema respondeu 401.
class ErroApi extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.status = status;
    this.chaveInvalida = status === 401;
  }
}

// ---------------------------------------------------------------------------
// Funções puras (sem Google) — testadas em tests/apps-script.test.js
// ---------------------------------------------------------------------------

/** Dinheiro em centavos -> "R$ 1.234,56". */
function formatarReais(centavos) {
  var negativo = centavos < 0;
  var c = Math.abs(Math.round(centavos));
  var inteiro = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  var cents = String(c % 100);
  if (cents.length < 2) cents = '0' + cents;
  return (negativo ? '-' : '') + 'R$ ' + inteiro + ',' + cents;
}

/** Data ISO (UTC) -> { serial, hora, dia } no horário da clínica. serial = número de data da planilha. */
function dataHoraLocal(iso) {
  var ms = Date.parse(iso) - DESLOCAMENTO_FUSO_MS; // "relógio" da clínica lido como se fosse UTC
  var d = new Date(ms);
  var minutos = d.getUTCHours() * 60 + d.getUTCMinutes();
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return {
    serial: Math.floor(ms / DIA_MS) + 25569, // 25569 = 01/01/1970 na contagem da planilha
    hora: minutos / 1440,
    dia: d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()),
  };
}

/** Número de data da planilha -> "AAAA-MM-DD". */
function serialParaDia(serial) {
  var d = new Date((Math.round(serial) - 25569) * DIA_MS);
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}

/** "Consulta (R$ 100,00); 2x Vermífugo (R$ 30,00)" */
function textoProcedimentos(itens) {
  return (itens || []).map(function (i) {
    var qtd = i.quantidade > 1 ? i.quantidade + 'x ' : '';
    return qtd + i.descricao + ' (' + formatarReais(i.preco_unitario_centavos) + ')';
  }).join('; ');
}

/** "Pago" ou "Estornado — motivo". */
function textoSituacao(p) {
  if (!p.estornado) return 'Pago';
  return 'Estornado' + (p.estorno_motivo ? ' — ' + p.estorno_motivo : '');
}

/** Fórmula do link para o comprovante no Drive. */
function formulaLink(url) {
  return url ? '=HYPERLINK("' + String(url).replace(/"/g, '') + '","ver")' : '';
}

/** Transforma um pagamento (como o sistema envia) em uma linha da aba Pagamentos (14 colunas). */
function montarLinha(p, linkComprovante) {
  var dh = dataHoraLocal(p.recebido_em);
  return [
    dh.serial,
    dh.hora,
    p.pet.nome,
    p.pet.codigo,
    p.tutor.nome,
    textoProcedimentos(p.pedido.itens),
    p.pedido.total_centavos / 100,
    ROTULO_FORMA[p.forma] || p.forma,
    p.valor_centavos / 100,
    p.recebido_por || '',
    textoSituacao(p),
    linkComprovante || '',
    p.id,
    p.comprovante_foto_id || '',
  ];
}

/**
 * Decide o que fazer com cada pagamento recebido: atualizar a linha que já existe (ex.: estorno)
 * ou inserir no fim. "existentes" = { 'id': númeroDaLinha }. Se o mesmo id vier duas vezes, vale o último.
 */
function planejarUpsert(existentes, itens, ultimaLinha) {
  var porId = {};
  var ordem = [];
  itens.forEach(function (it) {
    var k = String(it.id);
    if (!(k in porId)) ordem.push(k);
    porId[k] = it;
  });
  var atualizar = [];
  var inserir = [];
  var proxima = ultimaLinha + 1;
  ordem.forEach(function (k) {
    if (existentes[k]) atualizar.push({ linha: existentes[k], valores: porId[k].valores });
    else inserir.push({ linha: proxima++, valores: porId[k].valores });
  });
  return { atualizar: atualizar, inserir: inserir };
}

/** Nome do arquivo do comprovante: AAAA-MM-DD_<pet>_<id>.jpg (sem caracteres proibidos). */
function nomeArquivoComprovante(dia, petNome, pagamentoId, tipo) {
  var pet = String(petNome || 'pet').replace(/[\\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pet';
  var ext = tipo === 'image/webp' ? 'webp' : 'jpg';
  return dia + '_' + pet + '_' + pagamentoId + '.' + ext;
}

/** Nome da pasta do mês: "AAAA-MM". */
function pastaDoMes(dia) {
  return String(dia).slice(0, 7);
}

/** Nome do arquivo da cópia de segurança do dia. */
function nomeBackup(dia) {
  return 'vetclin-backup-' + dia + '.json';
}

/** Dos nomes de cópias de segurança, devolve os que devem ir para a lixeira (mantém os "manter" mais novos). */
function backupsParaApagar(nomes, manter) {
  var validos = nomes.filter(function (n) { return /^vetclin-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n); });
  validos.sort(); // a data está no nome: ordem alfabética = ordem de data
  return validos.slice(0, Math.max(0, validos.length - manter));
}

/** Nome do arquivo de uma foto da cópia: foto-000123.jpg */
function nomeFotoBackup(id, tipo) {
  var n = String(id);
  while (n.length < 6) n = '0' + n;
  return 'foto-' + n + (tipo === 'image/webp' ? '.webp' : '.jpg');
}

/** "vetclin.xyz.workers.dev/" -> "https://vetclin.xyz.workers.dev" */
function normalizarEndereco(texto) {
  var t = String(texto || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  var m = /^(https?:\/\/[^\/?#\s]+)/i.exec(t);
  return m ? m[1] : '';
}

/** Monta o endereço completo de uma chamada: https://.../api/integracao/<caminho>?a=1&b=2 */
function montarUrl(endereco, caminho, params) {
  var partes = [];
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k];
    if (v !== undefined && v !== null && v !== '') partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return endereco + '/api/integracao/' + caminho + (partes.length ? '?' + partes.join('&') : '');
}

/** Dias (números de data) da lista, sem repetir, do mais novo para o mais antigo. */
function diasDistintos(seriais) {
  var vistos = {};
  var lista = [];
  seriais.forEach(function (s) {
    if (typeof s === 'number' && s > 0 && !vistos[s]) { vistos[s] = true; lista.push(s); }
  });
  return lista.sort(function (a, b) { return b - a; });
}

/** Fórmula de soma por forma de pagamento (só "Pago") em um dia. Colunas: A data, H forma, I valor, K situação. */
function formulaSomaForma(linha, forma) {
  return '=SUMIFS(Pagamentos!$I:$I,Pagamentos!$A:$A,$A' + linha + ',Pagamentos!$H:$H,"' + forma + '",Pagamentos!$K:$K,"Pago")';
}

/** Linhas da aba Resumo: [dia, Pix, Cartão, Dinheiro, Total], a partir da linha "primeiraLinha". */
function montarLinhasResumo(dias, primeiraLinha) {
  return dias.map(function (dia, i) {
    var l = primeiraLinha + i;
    return [dia, formulaSomaForma(l, 'Pix'), formulaSomaForma(l, 'Cartão'), formulaSomaForma(l, 'Dinheiro'), '=SUM(B' + l + ':D' + l + ')'];
  });
}

/** Fórmula do total do mês atual (sem estornados). */
function formulaTotalMes() {
  return '=SUMIFS(Pagamentos!$I:$I,Pagamentos!$A:$A,">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1),Pagamentos!$A:$A,"<"&EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),1),Pagamentos!$K:$K,"Pago")';
}

/** Os dois horários de agora na clínica: "AAAA-MM-DD". */
function diaDeHoje(agora) {
  return dataHoraLocal((agora || new Date()).toISOString()).dia;
}

// ---------------------------------------------------------------------------
// Configuração (guardada no próprio script, visível só para o dono)
// ---------------------------------------------------------------------------
function props_() {
  return PropertiesService.getScriptProperties();
}

function configuracao_() {
  var p = props_();
  var endereco = p.getProperty('ENDERECO');
  var chave = p.getProperty('CHAVE');
  if (!endereco || !chave) throw new ErroApi('Falta configurar. Use o menu Vetclin > Configurar (endereço e chave).', 0);
  return { endereco: endereco, chave: chave };
}

function registrarStatus_(texto) {
  var agora = new Date();
  var carimbo = Utilities.formatDate(agora, 'America/Bahia', 'dd/MM/yyyy HH:mm');
  var linha = carimbo + ' — ' + texto;
  props_().setProperty('STATUS', linha);
  try {
    garantirAbaResumo_().getRange(1, 5).setValue(linha); // o aviso fica visível no alto da aba Resumo
  } catch (e) { /* sem planilha aberta: só guarda no script */ }
}

// ---------------------------------------------------------------------------
// Comunicação com o sistema
// ---------------------------------------------------------------------------
/** Chama o sistema (GET com a chave no cabeçalho). Devolve a resposta crua. Erros viram ErroApi. */
function buscar_(endereco, chave, caminho, params) {
  var resposta = UrlFetchApp.fetch(montarUrl(endereco, caminho, params), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + chave },
    muteHttpExceptions: true,
  });
  var codigo = resposta.getResponseCode();
  if (codigo === 401) throw new ErroApi(MSG_CHAVE_INVALIDA, 401);
  if (codigo === 429) throw new ErroApi('O sistema pediu para aguardar (muitas tentativas). Tente daqui a 15 minutos.', 429);
  if (codigo !== 200) throw new ErroApi('O sistema respondeu com erro ' + codigo + '.', codigo);
  return resposta;
}

function buscarJson_(caminho, params) {
  var c = configuracao_();
  var resposta = buscar_(c.endereco, c.chave, caminho, params);
  try {
    return JSON.parse(resposta.getContentText());
  } catch (e) {
    throw new ErroApi('Resposta do sistema não entendida.', 0);
  }
}

// ---------------------------------------------------------------------------
// Drive: pastas
// ---------------------------------------------------------------------------
/** Acha (ou cria) a pasta Vetclin/Comprovantes/2026-11 etc. */
function pasta_(caminho) {
  var atual = DriveApp.getRootFolder();
  caminho.forEach(function (nome) {
    var it = atual.getFoldersByName(nome);
    atual = it.hasNext() ? it.next() : atual.createFolder(nome);
  });
  return atual;
}

// ---------------------------------------------------------------------------
// Planilha: abas
// ---------------------------------------------------------------------------
function garantirAbaPagamentos_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var aba = ss.getSheetByName(ABA_PAGAMENTOS);
  if (!aba) aba = ss.insertSheet(ABA_PAGAMENTOS);
  if (aba.getLastRow() === 0) {
    aba.getRange(1, 1, 1, CABECALHO.length).setValues([CABECALHO]);
    aba.getRange(1, 1, 1, CABECALHO.length).setFontWeight('bold');
    aba.getRange(1, 1, 1, CABECALHO.length).setBackground('#e6f0ea');
    aba.setFrozenRows(1);
    [[1, 90], [2, 60], [3, 140], [4, 100], [5, 160], [6, 380], [7, 110], [8, 90], [9, 100], [10, 130], [11, 220], [12, 90]].forEach(function (c) { aba.setColumnWidth(c[0], c[1]); });
    aba.hideColumns(COL_ID, 2); // colunas técnicas (ID do pagamento e ID da foto)
  }
  return aba;
}

function garantirAbaResumo_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var aba = ss.getSheetByName(ABA_RESUMO);
  if (!aba) {
    aba = ss.insertSheet(ABA_RESUMO);
    aba.getRange(1, 1).setValue('Total do mês atual');
    aba.getRange(1, 1).setFontWeight('bold');
    aba.getRange(1, 2).setFormula(formulaTotalMes());
    aba.getRange(1, 2).setNumberFormat('R$ #,##0.00');
    aba.getRange(3, 1, 1, 5).setValues([['Dia', 'Pix', 'Cartão', 'Dinheiro', 'Total']]);
    aba.getRange(3, 1, 1, 5).setFontWeight('bold');
    aba.getRange(3, 1, 1, 5).setBackground('#e6f0ea');
    aba.setFrozenRows(3);
    aba.setColumnWidth(1, 150);
    aba.setColumnWidth(5, 330);
  }
  return aba;
}

/** Lê a coluna "ID do pagamento" e devolve { 'id': número da linha }. */
function lerExistentes_(aba) {
  var ultima = aba.getLastRow();
  var mapa = {};
  if (ultima < 2) return mapa;
  var ids = aba.getRange(2, COL_ID, ultima - 1, 1).getValues();
  ids.forEach(function (l, i) { if (l[0] !== '' && l[0] !== null) mapa[String(l[0])] = i + 2; });
  return mapa;
}

/** Aplica os pagamentos recebidos: atualiza linhas existentes e acrescenta as novas. */
function aplicarPagamentos_(aba, pagamentos) {
  if (!pagamentos.length) return { inseridos: 0, atualizados: 0 };
  var existentes = lerExistentes_(aba);
  var ultima = Math.max(aba.getLastRow(), 1);
  var links = aba.getLastRow() >= 2 ? aba.getRange(2, COL_COMPROVANTE, aba.getLastRow() - 1, 1).getFormulas() : [];
  var itens = pagamentos.map(function (p) {
    var linha = existentes[String(p.id)];
    var linkAtual = linha && links[linha - 2] ? links[linha - 2][0] : '';
    return { id: p.id, valores: montarLinha(p, linkAtual) };
  });
  var plano = planejarUpsert(existentes, itens, ultima);
  plano.atualizar.forEach(function (u) {
    aba.getRange(u.linha, 1, 1, CABECALHO.length).setValues([u.valores]);
  });
  if (plano.inserir.length) {
    var primeira = plano.inserir[0].linha;
    var n = plano.inserir.length;
    aba.getRange(primeira, 1, n, CABECALHO.length).setValues(plano.inserir.map(function (i) { return i.valores; }));
    aba.getRange(primeira, 1, n, 1).setNumberFormat('dd/MM/yyyy');
    aba.getRange(primeira, 2, n, 1).setNumberFormat('HH:mm');
    aba.getRange(primeira, 7, n, 1).setNumberFormat('R$ #,##0.00');
    aba.getRange(primeira, 9, n, 1).setNumberFormat('R$ #,##0.00');
  }
  return { inseridos: plano.inserir.length, atualizados: plano.atualizar.length };
}

/** Atualiza a aba Resumo (uma linha por dia). As fórmulas só são reescritas quando surge um dia novo. */
function atualizarResumo_(abaPag) {
  var resumo = garantirAbaResumo_();
  var ultima = abaPag.getLastRow();
  var datas = ultima >= 2 ? abaPag.getRange(2, 1, ultima - 1, 1).getValues().map(function (l) { return l[0]; }) : [];
  var dias = diasDistintos(datas);
  var ultimaResumo = resumo.getLastRow();
  var atuais = ultimaResumo >= 4 ? resumo.getRange(4, 1, ultimaResumo - 3, 1).getValues().map(function (l) { return l[0]; }) : [];
  if (JSON.stringify(atuais) === JSON.stringify(dias)) return false;
  if (ultimaResumo >= 4) resumo.getRange(4, 1, ultimaResumo - 3, 5).clearContent();
  if (dias.length) {
    var bloco = montarLinhasResumo(dias, 4);
    resumo.getRange(4, 1, bloco.length, 5).setValues(bloco);
    resumo.getRange(4, 1, bloco.length, 1).setNumberFormat('dd/MM/yyyy');
    resumo.getRange(4, 2, bloco.length, 4).setNumberFormat('R$ #,##0.00');
  }
  return true;
}

/**
 * Salva no Drive os comprovantes que ainda não têm link (no máximo MAX_COMPROVANTES_POR_VEZ por vez).
 * O próprio link na planilha é a prova de que o arquivo já foi salvo, então cada foto é salva uma única vez.
 */
function salvarComprovantesPendentes_(aba, limite) {
  var ultima = aba.getLastRow();
  if (ultima < 2) return 0;
  var n = ultima - 1;
  var dados = aba.getRange(2, 1, n, CABECALHO.length).getValues();
  var links = aba.getRange(2, COL_COMPROVANTE, n, 1).getFormulas();
  var c = configuracao_();
  var salvos = 0;
  for (var i = 0; i < n && salvos < limite; i++) {
    var fotoId = dados[i][COL_FOTO - 1];
    if (!fotoId || links[i][0]) continue;
    try {
      var dia = serialParaDia(dados[i][0]);
      var pastaMes = pasta_(['Vetclin', 'Comprovantes', pastaDoMes(dia)]);
      var resposta = buscar_(c.endereco, c.chave, 'foto/' + fotoId, {});
      var blob = resposta.getBlob();
      var nome = nomeArquivoComprovante(dia, dados[i][2], dados[i][COL_ID - 1], blob.getContentType());
      var jaExiste = pastaMes.getFilesByName(nome);
      var arquivo;
      if (jaExiste.hasNext()) {
        arquivo = jaExiste.next(); // já salvo antes (ex.: o script parou no meio)
      } else {
        arquivo = pastaMes.createFile(blob.setName(nome));
        arquivo.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); // só o dono vê
      }
      aba.getRange(i + 2, COL_COMPROVANTE).setFormula(formulaLink(arquivo.getUrl()));
      salvos++;
    } catch (e) {
      if (e.chaveInvalida) throw e;
      Logger.log('Comprovante do pagamento ' + dados[i][COL_ID - 1] + ' não foi salvo: ' + e.message);
    }
  }
  return salvos;
}

// ---------------------------------------------------------------------------
// Atualização da planilha (núcleo) — usada pelo menu e pelo gatilho de 15 minutos
// ---------------------------------------------------------------------------
/** Devolve { ok, mensagem }. Nunca lança erro (o gatilho não pode "quebrar"). */
function atualizarPlanilha() {
  var trava = LockService.getScriptLock();
  if (!trava.tryLock(30000)) return { ok: false, mensagem: 'Outra atualização já está em andamento.' };
  try {
    var inicio = Date.now();
    var aba = garantirAbaPagamentos_();
    var cursor = props_().getProperty('CURSOR_PAGAMENTOS') || '';
    var inseridos = 0;
    var atualizados = 0;
    for (var pagina = 0; pagina < MAX_PAGINAS_POR_VEZ; pagina++) {
      var r = buscarJson_('pagamentos', { desde: cursor });
      var res = aplicarPagamentos_(aba, r.pagamentos || []);
      inseridos += res.inseridos;
      atualizados += res.atualizados;
      if (r.proximo) { cursor = r.proximo; props_().setProperty('CURSOR_PAGAMENTOS', cursor); }
      if (!r.mais || Date.now() - inicio > LIMITE_TEMPO_MS) break;
    }
    var comprovantes = salvarComprovantesPendentes_(aba, MAX_COMPROVANTES_POR_VEZ);
    atualizarResumo_(aba);
    var msg = 'Planilha atualizada: ' + inseridos + ' novos, ' + atualizados + ' alterados, ' + comprovantes + ' comprovantes salvos.';
    registrarStatus_(msg);
    return { ok: true, mensagem: msg, inseridos: inseridos, atualizados: atualizados, comprovantes: comprovantes };
  } catch (e) {
    var texto = e && e.chaveInvalida ? MSG_CHAVE_INVALIDA : 'Não foi possível atualizar: ' + (e && e.message ? e.message : e);
    Logger.log(texto);
    try { registrarStatus_(texto); } catch (e2) { /* ignora */ }
    return { ok: false, mensagem: texto, chaveInvalida: !!(e && e.chaveInvalida) };
  } finally {
    trava.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Cópia de segurança (núcleo)
// ---------------------------------------------------------------------------
function espelharFotos_(inicio) {
  var pastaFotos = pasta_(['Vetclin', 'Backups', 'Fotos']);
  var c = configuracao_();
  var cursor = Number(props_().getProperty('CURSOR_FOTOS') || 0);
  var total = 0;
  for (var lote = 0; lote < 200; lote++) {
    var r = JSON.parse(buscar_(c.endereco, c.chave, 'fotos-backup', { desde_id: cursor }).getContentText());
    (r.fotos || []).forEach(function (f) {
      var nome = nomeFotoBackup(f.id, f.tipo);
      if (!pastaFotos.getFilesByName(nome).hasNext()) {
        pastaFotos.createFile(Utilities.newBlob(Utilities.base64Decode(f.base64), f.tipo, nome));
      }
      total++;
    });
    if (r.proximo !== undefined && r.proximo !== null) { cursor = r.proximo; props_().setProperty('CURSOR_FOTOS', String(cursor)); }
    if (!r.mais || Date.now() - inicio > LIMITE_TEMPO_MS) break;
  }
  return total;
}

/** Devolve { ok, mensagem }. Nunca lança erro. */
function fazerBackup() {
  var trava = LockService.getScriptLock();
  if (!trava.tryLock(30000)) return { ok: false, mensagem: 'Outra operação já está em andamento.' };
  try {
    var inicio = Date.now();
    var c = configuracao_();
    var conteudo = buscar_(c.endereco, c.chave, 'backup', {}).getContentText();
    JSON.parse(conteudo); // confere que veio um JSON inteiro antes de guardar
    var pastaBackups = pasta_(['Vetclin', 'Backups']);
    var nome = nomeBackup(diaDeHoje(new Date()));
    var existente = pastaBackups.getFilesByName(nome);
    if (existente.hasNext()) existente.next().setContent(conteudo);
    else pastaBackups.createFile(nome, conteudo, 'application/json');

    var nomes = [];
    var arquivos = pastaBackups.getFiles();
    var porNome = {};
    while (arquivos.hasNext()) { var a = arquivos.next(); nomes.push(a.getName()); porNome[a.getName()] = a; }
    var apagar = backupsParaApagar(nomes, MANTER_BACKUPS);
    apagar.forEach(function (n) { porNome[n].setTrashed(true); });

    var fotos = 0;
    var avisoFotos = '';
    try { fotos = espelharFotos_(inicio); } catch (e) {
      if (e.chaveInvalida) throw e;
      avisoFotos = ' (fotos: ' + e.message + ')';
      Logger.log('Fotos não copiadas: ' + e.message);
    }
    var msg = 'Cópia de segurança salva: ' + nome + '; ' + apagar.length + ' antigas na lixeira; ' + fotos + ' fotos novas' + avisoFotos + '.';
    registrarStatus_(msg);
    return { ok: true, mensagem: msg, arquivo: nome, apagados: apagar.length, fotos: fotos };
  } catch (e) {
    var texto = e && e.chaveInvalida ? MSG_CHAVE_INVALIDA : 'Não foi possível fazer a cópia de segurança: ' + (e && e.message ? e.message : e);
    Logger.log(texto);
    try { registrarStatus_(texto); } catch (e2) { /* ignora */ }
    return { ok: false, mensagem: texto, chaveInvalida: !!(e && e.chaveInvalida) };
  } finally {
    trava.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Gatilhos (rodam sozinhos, sem janelas)
// ---------------------------------------------------------------------------
function atualizacaoAutomatica() { atualizarPlanilha(); }
function copiaAutomatica() { fazerBackup(); }

/** Remove os gatilhos antigos deste projeto e cria os dois: planilha (15 min) e cópia (diária, ~2h). */
function instalarGatilhos_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('atualizacaoAutomatica').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('copiaAutomatica').timeBased().everyDays(1).atHour(2).inTimezone('America/Bahia').create();
}

// ---------------------------------------------------------------------------
// Menu "Vetclin"
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Vetclin')
    .addItem('Configurar (endereço e chave)', 'menuConfigurar')
    .addItem('Instalar atualizações automáticas', 'menuInstalar')
    .addSeparator()
    .addItem('Atualizar planilha agora', 'menuAtualizar')
    .addItem('Fazer cópia de segurança agora', 'menuBackup')
    .addToUi();
}

function avisar_(titulo, texto) {
  SpreadsheetApp.getUi().alert(titulo, texto, SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuConfigurar() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Endereço do sistema', 'Digite o endereço do sistema (ex.: https://vetclin.seunome.workers.dev):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var endereco = normalizarEndereco(r1.getResponseText());
  if (!endereco) { avisar_('Endereço inválido', 'Não entendi o endereço. Copie e cole o endereço do sistema.'); return; }
  var r2 = ui.prompt('Chave de acesso', 'Cole a chave gerada no sistema (Usuários > Integração com Google):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var chave = String(r2.getResponseText() || '').trim();
  if (!chave) { avisar_('Chave vazia', 'Você não colou a chave.'); return; }
  try {
    buscar_(endereco, chave, 'pagamentos', { limite: 1, desde: new Date().toISOString() }); // só para testar
  } catch (e) {
    avisar_('Não deu certo', e.chaveInvalida ? MSG_CHAVE_INVALIDA : 'Não consegui falar com o sistema: ' + e.message);
    return;
  }
  props_().setProperty('ENDERECO', endereco);
  props_().setProperty('CHAVE', chave);
  props_().deleteProperty('CURSOR_PAGAMENTOS'); // recomeça do início: traz todo o histórico
  avisar_('Tudo certo', 'Endereço e chave conferidos e guardados. Agora use "Instalar atualizações automáticas".');
}

function menuInstalar() {
  try { configuracao_(); } catch (e) { avisar_('Falta configurar', e.message); return; }
  instalarGatilhos_();
  avisar_('Pronto', 'A planilha vai se atualizar a cada 15 minutos e a cópia de segurança será feita todo dia por volta das 2h.');
}

function menuAtualizar() {
  var r = atualizarPlanilha();
  avisar_(r.ok ? 'Pronto' : 'Atenção', r.mensagem);
}

function menuBackup() {
  var r = fazerBackup();
  avisar_(r.ok ? 'Pronto' : 'Atenção', r.mensagem);
}
