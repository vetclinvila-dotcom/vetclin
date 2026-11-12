// Telas do Vetclin. Tudo é montado aqui, sem bibliotecas externas.
// Segurança: textos vindos do servidor/usuário só entram na tela via
// textContent (função "el"), nunca como HTML cru.

import { cartaoNotificacoes } from './notificacoes-app.js';
import { itensDoTexto } from './produtos-receita.js';
import { CAMPOS, VIAS, VIA_PADRAO, gruposDasLinhas, linhaDaReceita, linhaVazia, separarRemedioDose, textoDasLinhas } from './receita-linhas.js';
import { MAX_VALOR_CENTAVOS, formatarReais, lerReais, reaisParaCampo } from './dinheiro.js';
import { ROTULO_CATEGORIA, ROTULO_FORMA, atualizarDaReceita, estadoDaConta, receitaDesatualizada, totalDosItens, trocoDe } from './conta-regras.js';

const raiz = document.getElementById('app');
let usuario = null; // usuário logado
let destinoLogin = null; // tela que a pessoa tentou abrir antes de entrar (ex.: link de receita)

// ---------- ajudantes ----------

// Cria um elemento HTML. Filhos que são texto viram textContent (seguro).
function el(tag, atributos = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat()) {
    if (f == null || f === false) continue;
    e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return e;
}

// A barra de cima (cabecalho) fica sozinha no alto, de ponta a ponta; o resto vai dentro de <main class="conteudo">.
function mostrar(...elementos) {
  raiz.classList.remove('larga', 'impressao', 'colunas'); // só a tela Hoje usa a largura grande; 'impressao' é a folha da receita
  const todos = elementos.filter((x) => x != null && x !== false); // ignora vazios (senão apareceria o texto "null")
  const topo = todos.filter((x) => x.classList && x.classList.contains('topo-app'));
  const resto = todos.filter((x) => !topo.includes(x));
  raiz.replaceChildren(...topo, el('main', { class: 'conteudo' }, resto));
}

// Ícones simples (desenhos fixos do próprio sistema, nunca texto de usuário).
const ICONES = {
  mais: [['path', { d: 'M12 5v14M5 12h14' }]],
  buscar: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4 4' }]],
  impressora: [['path', { d: 'M7 9V3h10v6' }], ['rect', { x: 3, y: 9, width: 18, height: 8, rx: 2 }], ['path', { d: 'M7 14h10v7H7z' }]],
  alerta: [['path', { d: 'M12 8v5M12 17h.01' }], ['circle', { cx: 12, cy: 12, r: 9 }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  camera: [['path', { d: 'M4 8h3l2-3h6l2 3h3v11H4z' }], ['circle', { cx: 12, cy: 13, r: 3.5 }]],
  voltar: [['path', { d: 'M15 6l-6 6 6 6' }]],
  baixo: [['path', { d: 'M6 9l6 6 6-6' }]],
  fechar: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  conversa: [['path', { d: 'M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z' }]],
};
function icone(nome, tamanho = 20, espessura = 2.2) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: tamanho, height: tamanho, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': espessura, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icone' })) svg.setAttribute(k, v);
  for (const [forma, atributos] of ICONES[nome]) {
    const f = document.createElementNS(ns, forma);
    for (const [k, v] of Object.entries(atributos)) f.setAttribute(k, v);
    svg.append(f);
  }
  return svg;
}

// Chama a API. Sempre envia o cabeçalho de segurança e os cookies.
async function api(metodo, caminho, corpo) {
  let resposta;
  try {
    resposta = await fetch(caminho, {
      method: metodo,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'vetclin',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique a internet e tente de novo.');
  }
  return tratarResposta(resposta);
}

async function tratarResposta(resposta) {
  let dados = null;
  try { dados = await resposta.json(); } catch { /* resposta sem JSON */ }
  if (!resposta.ok) {
    const e = new Error((dados && dados.erro) || 'Algo deu errado. Tente novamente.');
    e.status = resposta.status;
    e.dados = dados; // guarda a resposta inteira (ex.: lista de cadastros repetidos)
    throw e;
  }
  return dados;
}

// Envia uma foto (bytes crus, JPEG). Devolve { id }.
async function enviarFotoArquivo(blob) {
  let resposta;
  try {
    resposta = await fetch('/api/fotos', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-Requested-With': 'vetclin', 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique a internet e tente de novo.');
  }
  return tratarResposta(resposta);
}

function caixaMensagem(tipo, texto) {
  return el('div', { class: 'mensagem ' + tipo, role: tipo === 'erro' ? 'alert' : 'status' }, texto);
}

// Campo com rótulo + input.
function campo(rotulo, id, atributos = {}) {
  return [el('label', { for: id }, rotulo), el('input', { id, name: id, ...atributos })];
}

// Faz um formulário chamar "acao"; mostra erros dentro dele.
function formulario(aoEnviar, ...filhos) {
  const area = el('div');
  const f = el('form', { novalidate: true }, ...filhos, area);
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const botao = f.querySelector('button[type="submit"]');
    botao.disabled = true;
    area.replaceChildren();
    try {
      await aoEnviar(Object.fromEntries(new FormData(f)), f);
    } catch (e) {
      area.replaceChildren(caixaMensagem('erro', e.message));
      botao.disabled = false;
    }
  });
  return f;
}

// ---------- telas ----------

// Logo no alto das telas de entrada (login e primeiro acesso).
const logoEntrada = () => el('img', { class: 'logo-entrada', src: '/logo-vetclin.png', alt: 'Vetclin Clínica Veterinária' });

function telaConfiguracaoInicial() {
  mostrar(el('div', { class: 'entrada' },
    logoEntrada(),
    el('h1', {}, 'Bem-vindo ao Vetclin'),
    el('div', { class: 'cartao' },
      el('p', {}, 'Vamos criar o primeiro acesso (administrador). Você vai precisar da chave de configuração que foi guardada na instalação.'),
      formulario(async (d) => {
        usuario = await api('POST', '/api/configuracao-inicial', {
          chave: d.chave, nome: d.nome, login: d.login, senha: d.senha, crmv: d.crmv,
        });
        irPara('#/hoje');
      },
        campo('Chave de configuração', 'chave', { type: 'password', autocomplete: 'off', required: true }),
        campo('Seu nome', 'nome', { autocomplete: 'name', required: true }),
        campo('Login (letras e números, sem espaços)', 'login', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        campo('Senha (mínimo 8 caracteres)', 'senha', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }),
        campo('CRMV (opcional)', 'crmv'),
        el('button', { type: 'submit', class: 'grande' }, 'Criar acesso'),
      ))));
}

// Guarda a tela pedida (só endereços internos "#/...") para voltar a ela depois do login.
function lembrarDestino() {
  const h = location.hash;
  destinoLogin = /^#\/[a-z]/.test(h) && !h.startsWith('#/hoje') ? h : null;
}

function telaEntrar() {
  if (!destinoLogin) lembrarDestino();
  mostrar(el('div', { class: 'entrada' },
    logoEntrada(),
    el('h1', {}, 'Entrar'),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        usuario = await api('POST', '/api/entrar', { login: d.login, senha: d.senha });
        const destino = destinoLogin;
        destinoLogin = null;
        irPara(destino || '#/hoje');
      },
        campo('Login', 'login', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        campo('Senha', 'senha', { type: 'password', autocomplete: 'current-password', required: true }),
        el('button', { type: 'submit', class: 'grande' }, 'Entrar'),
      ))));
}

// ---------- navegação (pelo endereço #/...) ----------
// O botão "voltar" do celular funciona porque cada tela tem seu endereço.
let versaoTela = 0; // evita que uma resposta atrasada sobrescreva a tela atual

function irPara(hash) {
  if (location.hash === hash) rotear();
  else location.hash = hash;
}

// ---------- formatação ----------
const ROTULO_ESPECIE = { cao: 'Cão', gato: 'Gato', outro: 'Outro' };
const ROTULO_SEXO = { macho: 'Macho', femea: 'Fêmea' };
const ROTULO_STATUS = { chegou: 'Chegou', em_atendimento: 'Em atendimento', finalizado: 'Finalizado', cancelado: 'Cancelado' };
const NOME_PAPEL = { recepcao: 'Recepção', veterinario: 'Veterinário(a)', suporte: 'Suporte' };

// "+5571999998888" -> "(71) 99999-8888"
function formatarTelefone(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

function formatarIdade(p) {
  const partes = [];
  if (p.idade_anos != null) partes.push(`${p.idade_anos} ${p.idade_anos === 1 ? 'ano' : 'anos'}`);
  if (p.idade_meses != null) partes.push(`${p.idade_meses} ${p.idade_meses === 1 ? 'mês' : 'meses'}`);
  return partes.length ? partes.join(' e ') : 'Não informada';
}

// Data/hora no fuso da clínica (a API guarda em UTC).
function formatarDataHora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Bahia', dateStyle: 'short', timeStyle: 'short' });
}

const FORMATO_HORA = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' });
const FORMATO_DIA = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', year: 'numeric' });

// Hora (HH:MM) no fuso da clínica.
function formatarHora(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO_HORA.format(d);
}

function formatarDia(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO_DIA.format(d);
}

// 12.4 -> "12,4 kg"
function formatarPeso(kg) {
  return `${Number(kg).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg`;
}

// Peso digitado ("12,4" ou "12.4"). Devolve número, ou null se estiver vazio. Erro de verdade se for inválido.
function lerPesoDigitado(texto) {
  const t = String(texto ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  if (!(n >= 0.01 && n <= 150)) throw new Error('O peso deve estar entre 0,01 e 150 kg. Exemplo: 12,4');
  return Math.round(n * 100) / 100;
}

// Texto da espera: "15 min" ou "1 h 05 min".
function formatarEspera(min) {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

// Minutos de espera calculados aqui na tela (assim o número anda sozinho a cada minuto).
function esperaDe(a) {
  const fim = a.iniciado_em ? Date.parse(a.iniciado_em) : Date.now();
  return Math.max(0, Math.floor((fim - Date.parse(a.chegada_em)) / 60000));
}

function idadeCurta(p) {
  const partes = [];
  if (p.idade_anos != null) partes.push(`${p.idade_anos} ${p.idade_anos === 1 ? 'ano' : 'anos'}`);
  if (p.idade_meses != null) partes.push(`${p.idade_meses} ${p.idade_meses === 1 ? 'mês' : 'meses'}`);
  return partes.join(' e ');
}

// ---------- peças de tela ----------

// Foto do pet (ou a inicial do nome, se não houver foto).
function miniatura(fotoId, nome, classe = 'miniatura') {
  if (fotoId) return el('img', { class: classe, src: `/api/fotos/${fotoId}`, alt: `Foto de ${nome}`, loading: 'lazy' });
  return el('div', { class: classe + ' sem-foto', 'aria-hidden': 'true' }, (nome || '?').trim().charAt(0).toUpperCase());
}

function carregando() {
  mostrar(el('p', { class: 'carregando' }, 'Carregando…'));
}

function telaErro(e, voltarPara = '#/hoje') {
  mostrar(cabecalho(), caixaMensagem('erro', e.message),
    el('button', { type: 'button', onclick: () => irPara(voltarPara) }, 'Voltar'));
}

// "destino" é um endereço (#/...) ou uma função a chamar.
function botaoVoltar(destino, rotulo = 'Voltar') {
  return el('button', { class: 'secundario voltar', type: 'button', onclick: typeof destino === 'function' ? destino : () => irPara(destino) }, icone('voltar', 18, 2.4), rotulo.replace(/^←\s*/, ''));
}

function campoTexto(rotulo, id, valor = '', extra = {}) {
  return [el('label', { for: id }, rotulo), el('textarea', { id, name: id, rows: 3, ...extra }, valor)];
}

// Três botões grandes (Cão / Gato / Outro). Devolve { caixa, valor() }.
function escolhaEspecie(inicial = '') {
  let atual = inicial;
  const botoes = Object.entries(ROTULO_ESPECIE).map(([chave, rotulo]) => {
    const b = el('button', { type: 'button', class: 'opcao', role: 'radio', 'aria-checked': String(chave === atual), 'data-valor': chave }, rotulo);
    b.addEventListener('click', () => {
      atual = chave;
      for (const x of botoes) x.setAttribute('aria-checked', String(x === b));
    });
    return b;
  });
  const caixa = el('div', { class: 'grupo-opcoes', role: 'radiogroup', 'aria-label': 'Espécie' }, botoes);
  return { caixa, valor: () => atual };
}

function selectSexo(atual) {
  const s = el('select', { id: 'sexo', name: 'sexo' },
    el('option', { value: '' }, 'Não informado'),
    el('option', { value: 'macho' }, 'Macho'),
    el('option', { value: 'femea' }, 'Fêmea'));
  s.value = atual || '';
  return s;
}

// Janela de confirmação. Devolve true se a pessoa confirmou.
function confirmar(titulo, texto, rotuloOk, rotuloNao = 'Cancelar') {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'confirmacao' },
      el('h2', {}, titulo),
      ...[].concat(texto).map((t) => (t instanceof Node ? t : el('p', {}, t))),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', id: 'confirmar-sim' }, rotuloOk),
        el('button', { type: 'button', class: 'secundario', id: 'confirmar-nao' }, rotuloNao)));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('#confirmar-sim').addEventListener('click', () => fechar(true));
    d.querySelector('#confirmar-nao').addEventListener('click', () => fechar(false));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(false); });
    document.body.append(d);
    d.showModal();
  });
}

// Janela com um campo para preencher (ex.: motivo do cancelamento, peso).
// "aoConfirmar(valor)" pode lançar erro: a mensagem aparece na janela e ela continua aberta.
function dialogoCampo({ titulo, texto = null, rotulo, rotuloOk, tipo = 'texto', inicial = '', aoConfirmar }) {
  return new Promise((resolve) => {
    const entrada = tipo === 'peso'
      ? el('input', { id: 'dialogo-campo', class: 'peso-entrada', type: 'text', inputmode: 'decimal', placeholder: 'ex.: 12,4', autocomplete: 'off', value: inicial })
      : el('input', { id: 'dialogo-campo', type: 'text', maxlength: 200, autocomplete: 'off', value: inicial });
    const area = el('div');
    const ok = el('button', { type: 'button', id: 'dialogo-ok' }, rotuloOk);
    const d = el('dialog', { class: 'confirmacao' },
      el('h2', {}, titulo),
      texto ? el('p', {}, texto) : null,
      el('label', { for: 'dialogo-campo' }, rotulo), entrada, area,
      el('div', { class: 'acoes' }, ok, el('button', { type: 'button', class: 'secundario', id: 'dialogo-voltar' }, 'Voltar')));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    ok.addEventListener('click', async () => {
      area.replaceChildren();
      ok.disabled = true;
      try { await aoConfirmar(entrada.value); fechar(true); } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); ok.disabled = false; }
    });
    entrada.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
    d.querySelector('#dialogo-voltar').addEventListener('click', () => fechar(false));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(false); });
    document.body.append(d);
    d.showModal();
    entrada.focus();
  });
}

// Reduz a foto no aparelho: no máximo 1024 px no lado maior, JPEG com qualidade 0,75.
async function reduzirFoto(arquivo) {
  let imagem;
  try {
    imagem = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); // já gira certo
  } catch {
    imagem = await new Promise((ok, falha) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => falha(new Error('Não foi possível ler esta foto. Tente outra.'));
      i.src = URL.createObjectURL(arquivo);
    });
  }
  const largura = imagem.width || imagem.naturalWidth;
  const altura = imagem.height || imagem.naturalHeight;
  const escala = Math.min(1, 1024 / Math.max(largura, altura));
  const tela = document.createElement('canvas');
  tela.width = Math.max(1, Math.round(largura * escala));
  tela.height = Math.max(1, Math.round(altura * escala));
  tela.getContext('2d').drawImage(imagem, 0, 0, tela.width, tela.height);
  if (imagem.close) imagem.close();
  const blob = await new Promise((ok) => tela.toBlob(ok, 'image/jpeg', 0.75));
  if (!blob) throw new Error('Não foi possível preparar a foto. Tente outra.');
  return blob;
}

// Campo de foto: tirar foto (câmera) ou escolher da galeria, com miniatura e "Remover foto".
// "inicial" = id de uma foto que já existe. Devolve { caixa, mudou(), resolver() }.
function campoFoto(inicial = null, nomePet = 'pet', rotulo = 'Foto (opcional)') {
  let fotoId = inicial;        // foto já guardada no servidor
  let blob = null;             // foto nova, ainda não enviada
  let urlPrevia = null;
  let mudou = false;
  const previa = el('div', { class: 'foto-previa' });
  const erro = el('div');
  const camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'escondido', id: 'foto-camera', 'aria-label': 'Tirar foto' });
  const galeria = el('input', { type: 'file', accept: 'image/*', class: 'escondido', id: 'foto-galeria', 'aria-label': 'Escolher foto da galeria' });
  const desenhar = () => {
    previa.replaceChildren();
    if (urlPrevia || fotoId) {
      previa.append(
        el('img', { class: 'foto-grande', src: urlPrevia || `/api/fotos/${fotoId}`, alt: `Foto de ${nomePet}` }),
        el('button', { type: 'button', class: 'secundario', id: 'foto-remover', onclick: () => {
          if (urlPrevia) URL.revokeObjectURL(urlPrevia);
          urlPrevia = null; blob = null; fotoId = null; mudou = true; desenhar();
        } }, 'Remover foto'));
    }
  };
  async function escolher(ev) {
    const arquivo = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!arquivo) return;
    erro.replaceChildren();
    try {
      blob = await reduzirFoto(arquivo);
      if (urlPrevia) URL.revokeObjectURL(urlPrevia);
      urlPrevia = URL.createObjectURL(blob);
      fotoId = null; mudou = true;
      desenhar();
    } catch (e) { erro.replaceChildren(caixaMensagem('erro', e.message)); }
  }
  camera.addEventListener('change', escolher);
  galeria.addEventListener('change', escolher);
  desenhar();
  const caixa = el('div', { class: 'campo-foto' },
    el('label', {}, rotulo),
    el('div', { class: 'botoes-foto' },
      el('button', { type: 'button', class: 'foto-botao', id: 'foto-tirar', onclick: () => camera.click() }, icone('camera', 20), 'Tirar foto'),
      el('button', { type: 'button', class: 'foto-botao', id: 'foto-galeria-botao', onclick: () => galeria.click() }, 'Escolher da galeria')),
    camera, galeria, previa, erro);
  return {
    caixa,
    mudou: () => mudou,
    // Envia a foto nova (se houver) e devolve o id (ou null, se não tem foto).
    async resolver() {
      if (blob) {
        const r = await enviarFotoArquivo(blob);
        fotoId = r.id; blob = null; // se algo falhar depois, não envia de novo
      }
      return fotoId;
    },
  };
}

// Escolha "Normal" / "URGENTE" (dois botões grandes).
function escolhaUrgencia(inicial = false) {
  let urgente = !!inicial;
  const normal = el('button', { type: 'button', class: 'opcao', role: 'radio', id: 'urgencia-normal' }, 'Normal');
  const forte = el('button', { type: 'button', class: 'opcao urgente', role: 'radio', id: 'urgencia-urgente' }, 'URGENTE');
  const marcar = () => { normal.setAttribute('aria-checked', String(!urgente)); forte.setAttribute('aria-checked', String(urgente)); };
  normal.addEventListener('click', () => { urgente = false; marcar(); });
  forte.addEventListener('click', () => { urgente = true; marcar(); });
  marcar();
  return { caixa: el('div', { class: 'grupo-opcoes dois', role: 'radiogroup', 'aria-label': 'Urgência' }, normal, forte), valor: () => urgente };
}

// Campos de uma chegada. O PESO vem primeiro e é o maior campo da tela.
// Devolve partes separadas, porque o cadastro rápido põe o peso no meio do formulário:
//   peso (nós da tela), resto (motivo, urgência, foto) e coletar() -> dados prontos para a API.
function camposChegada({ nomePet = 'pet', pesoInicial = null, motivo = '', urgente = false, fotoInicial = null, permitirPesarDepois = true } = {}) {
  let pesarDepois = false;
  const peso = el('input', {
    id: 'peso_kg', name: 'peso_kg', class: 'peso-entrada', type: 'text', inputmode: 'decimal', placeholder: 'ex.: 12,4',
    autocomplete: 'off', 'aria-label': 'Peso em quilos', value: pesoInicial != null ? String(pesoInicial).replace('.', ',') : '',
  });
  const depois = el('button', { type: 'button', class: 'secundario', id: 'pesar-depois', 'aria-pressed': 'false' }, 'Pesar depois');
  const aviso = el('p', { class: 'aviso-peso', hidden: true }, 'Sem peso por enquanto. O cartão ficará marcado como "Sem peso" até alguém informar.');
  depois.addEventListener('click', () => {
    pesarDepois = !pesarDepois;
    depois.setAttribute('aria-pressed', String(pesarDepois));
    depois.textContent = pesarDepois ? 'Pesar depois (marcado)' : 'Pesar depois';
    peso.disabled = pesarDepois;
    if (pesarDepois) peso.value = '';
    aviso.hidden = !pesarDepois;
    if (!pesarDepois) peso.focus();
  });
  const motivoCampo = el('textarea', { id: 'motivo', name: 'motivo', rows: 2, maxlength: 200, placeholder: 'ex.: vômito desde ontem' }, motivo);
  const urgencia = escolhaUrgencia(urgente);
  const foto = campoFoto(fotoInicial, nomePet);
  return {
    peso: [
      el('label', { for: 'peso_kg', class: 'rotulo-peso' }, 'Peso (kg)'),
      peso,
      permitirPesarDepois ? el('div', { class: 'linha-pesar-depois' }, depois) : null,
      aviso,
    ],
    resto: [
      el('label', { for: 'motivo' }, 'Motivo da vinda'), motivoCampo,
      el('label', {}, 'Urgência'), urgencia.caixa,
      foto.caixa,
    ],
    foto,
    pesoCampo: peso,
    // Confere tudo e envia a foto (se houver). Lança erro com mensagem em português.
    async coletar() {
      const kg = pesarDepois ? null : lerPesoDigitado(peso.value);
      if (kg === null && !pesarDepois) throw new Error('Informe o peso ou escolha "Pesar depois".');
      const m = motivoCampo.value.trim();
      if (!m) throw new Error('Preencha o motivo da vinda.');
      return { peso_kg: kg, pesar_depois: pesarDepois, motivo: m, urgente: urgencia.valor(), foto_id: await foto.resolver() };
    },
  };
}

// ---------- Hoje ----------
const PODE_ATENDER = ['veterinario', 'suporte']; // quem inicia e finaliza atendimentos

// Janela rápida para informar o peso de quem ficou "Sem peso".
async function adicionarPeso(a, aoAtualizar) {
  const ok = await dialogoCampo({
    titulo: `Peso de ${a.pet.nome}`, rotulo: 'Peso (kg)', rotuloOk: 'Salvar peso', tipo: 'peso',
    aoConfirmar: async (valor) => {
      const kg = lerPesoDigitado(valor);
      if (kg === null) throw new Error('Informe o peso em kg. Exemplo: 12,4');
      await api('PATCH', `/api/atendimentos/${a.id}`, { peso_kg: kg });
    },
  });
  if (ok) aoAtualizar();
}

// "Conta: R$ 145,00 · aberta" / "aguardando pagamento" (laranja) / "Pago ✓" (turquesa).
function resumoDaConta(pedido) {
  const e = estadoDaConta(pedido);
  const resta = pedido.pago_centavos > 0 && e.tipo === 'aguardando';
  return el('span', { class: 'atend-conta' }, 'Conta: ', el('strong', {}, formatarReais(pedido.total_centavos)), ' · ',
    e.tipo === 'aberta' ? 'aberta' : el('span', { class: 'pilula-conta ' + e.tipo }, e.texto),
    resta ? el('span', { class: 'conta-parcial' }, ` · pago ${formatarReais(pedido.pago_centavos)}`) : null);
}

// "agora mesmo", "há 5 min", "há 1 h 05 min".
function tempoDesde(iso) {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? 'agora mesmo' : `há ${formatarEspera(min)}`;
}

// Quem enviou a conta: "Dr(a). Elizabeth" para veterinário; o nome puro para os demais.
function nomeComTitulo(pessoa) {
  if (!pessoa) return '';
  return pessoa.papel === 'veterinario' ? comTratamento(pessoa.nome) : pessoa.nome;
}

// Cartão de um paciente na tela Hoje.
function cartaoAtendimento(a, { aoAtualizar, aoErro }) {
  const p = a.pet;
  const abrirFicha = () => irPara(`#/pet/${p.id}`);
  const idade = idadeCurta(p);
  // Se chegou em outro dia (atendimento esquecido aberto), mostra a data também.
  const quando = a.de_outro_dia ? `em ${formatarDia(a.chegada_em)} às ${formatarHora(a.chegada_em)}` : formatarHora(a.chegada_em);
  const vet = a.veterinario ? comTratamento(a.veterinario.nome) : null;
  // A "pílula" do cartão: espera (laranja claro), com quem está (turquesa) ou finalizado (cinza).
  const pilula = {
    chegou: () => el('span', { class: 'pilula espera' }, `Chegou ${quando} · espera ${formatarEspera(esperaDe(a))}`),
    em_atendimento: () => el('span', { class: 'pilula com-vet' }, `${vet ? 'Com ' + vet : 'Em atendimento'} desde ${formatarHora(a.iniciado_em)}`),
    finalizado: () => el('span', { class: 'pilula pronto' }, `Chegou ${formatarHora(a.chegada_em)} · finalizado ${formatarHora(a.finalizado_em)}${vet ? ' · ' + vet : ''}`),
  }[a.status];

  const pesoNo = a.sem_peso
    ? el('div', { class: 'peso-faltando' },
      el('span', { class: 'selo-sem-peso' }, 'Sem peso'),
      a.status === 'finalizado' ? null : el('button', { type: 'button', class: 'secundario adicionar-peso', onclick: (ev) => { ev.stopPropagation(); adicionarPeso(a, aoAtualizar); } }, 'Adicionar peso'))
    : el('span', { class: 'peso-grande' }, formatarPeso(a.peso_kg));

  const corpo = el('div', { class: 'atend-corpo', role: 'link', tabindex: '0', 'aria-label': `Abrir ficha de ${p.nome}`, onclick: abrirFicha },
    miniatura(p.foto_id || a.foto_id, p.nome),
    el('div', { class: 'atend-info' },
      el('div', { class: 'atend-linha-nome' }, el('strong', { class: 'atend-nome' }, p.nome), a.sem_peso ? null : pesoNo),
      a.sem_peso ? pesoNo : null,
      el('span', { class: 'atend-sub' }, `${[ROTULO_ESPECIE[p.especie] || p.especie, idade].filter(Boolean).join(', ')} · Tutor: ${a.tutor.nome}${a.tutor.final_telefone ? ' · final ' + a.tutor.final_telefone : ''}`),
      a.motivo ? el('span', { class: 'atend-motivo' }, a.motivo) : null,
      pilula()));
  corpo.addEventListener('keydown', (ev) => { if (ev.target === corpo && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); abrirFicha(); } });

  // Roda uma ação (chamada à API) e atualiza a lista.
  const rodar = (botao, funcao) => async () => {
    botao.disabled = true;
    try { await funcao(); await aoAtualizar(); } catch (e) { botao.disabled = false; await aoAtualizar(); aoErro(e); }
  };
  const botoes = [];
  if (a.status === 'chegou' && PODE_ATENDER.includes(usuario.papel)) {
    const b = el('button', { type: 'button', class: 'iniciar' }, 'Iniciar atendimento');
    b.addEventListener('click', rodar(b, () => api('POST', `/api/atendimentos/${a.id}/iniciar`)));
    botoes.push(b);
  }
  if (a.status === 'em_atendimento' && PODE_ATENDER.includes(usuario.papel)) {
    const b = el('button', { type: 'button', class: 'finalizar' }, 'Finalizar');
    b.addEventListener('click', async () => {
      if (await confirmar(`Finalizar o atendimento de ${p.nome}?`, 'Depois de finalizado, ele sai da lista de atendimentos em andamento.', 'Sim, finalizar')) {
        rodar(b, () => api('POST', `/api/atendimentos/${a.id}/finalizar`))();
      }
    });
    botoes.push(b);
  }
  if ((a.status === 'em_atendimento' || a.status === 'finalizado') && PODE_ATENDER.includes(usuario.papel)) {
    const b = el('button', { type: 'button', class: 'secundario receita-botao' }, 'Receita');
    b.addEventListener('click', async () => { b.disabled = true; try { await abrirNovaReceita({ atendimento_id: a.id }); } catch (e) { b.disabled = false; aoErro(e); } });
    botoes.push(b);
  }
  botoes.push(el('button', { type: 'button', class: 'secundario colar-botao', onclick: () => irPara(`#/receitas/transcrever?pet=${p.id}&atendimento=${a.id}`) }, 'Receita do WhatsApp'));
  if (a.status === 'chegou' || a.status === 'em_atendimento') {
    botoes.push(el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/atendimento/${a.id}/editar`) }, 'Editar'));
  }
  if (a.status === 'chegou') {
    botoes.push(el('button', { type: 'button', class: 'perigo', onclick: async () => {
      const feito = await dialogoCampo({
        titulo: `Cancelar a chegada de ${p.nome}?`, texto: 'Ele sai da fila de espera. Conte o motivo:', rotulo: 'Motivo do cancelamento', rotuloOk: 'Sim, cancelar chegada',
        aoConfirmar: async (motivo) => {
          if (!motivo.trim()) throw new Error('Preencha o motivo do cancelamento.');
          await api('POST', `/api/atendimentos/${a.id}/cancelar`, { motivo: motivo.trim() });
        },
      });
      if (feito) aoAtualizar();
    } }, 'Cancelar chegada'));
  }
  // Botão "Conta": abre a conta do atendimento (itens e pagamento). Fica em destaque quando falta receber.
  if (a.pedido || a.status === 'em_atendimento' || a.status === 'finalizado') {
    const falta = a.pedido && a.pedido.status === 'aguardando_pagamento';
    botoes.unshift(el('button', { type: 'button', class: (falta ? '' : 'secundario ') + 'conta-botao', onclick: () => irPara(`#/conta/${a.id}`) }, 'Conta'));
  }
  // Com conta aberta, o total dela substitui o "Produtos: R$" (que já está dentro da conta).
  const temProdutos = !a.pedido && (a.produtos_centavos > 0 || a.produtos_sem_valor > 0);
  const conta = a.pedido ? resumoDaConta(a.pedido) : null;
  return el('article', { class: 'cartao-pet ' + a.status + (a.urgente ? ' urgente' : '') },
    a.urgente ? el('div', { class: 'faixa-urgente' }, icone('alerta', 14, 2.6), 'URGENTE') : null,
    corpo,
    conta || temProdutos || botoes.length
      ? el('div', { class: 'atend-rodape' },
        conta,
        temProdutos
          ? el('span', { class: 'atend-produtos' }, 'Produtos: ', el('strong', {}, formatarReais(a.produtos_centavos)),
            a.produtos_sem_valor > 0 ? el('span', { class: 'selo-produto-sem-valor' }, `${a.produtos_sem_valor} sem valor`) : null)
          : null,
        botoes.length ? el('div', { class: 'atend-botoes' }, botoes) : null)
      : null);
}

// "Quinta-feira, 12 de novembro" (no fuso da clínica).
function dataDeHoje() {
  const t = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Bahia', weekday: 'long', day: 'numeric', month: 'long' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function telaHoje() {
  const minha = versaoTela;
  let dados = null;
  let finalizadosAberto = false;
  let receitas = { imprimir: [], pedidas: [] };
  const avisos = el('div');
  // Cartão "Ativar notificações": só aparece enquanto este aparelho não recebe avisos.
  const cartaoAviso = el('div');
  cartaoNotificacoes({ compacto: true }).then((c) => { if (c && minha === versaoTela) cartaoAviso.replaceChildren(c); }).catch(() => {});
  const colunas = el('div', { class: 'hoje-colunas' }, el('p', { class: 'carregando' }, 'Carregando…'));
  const contagemTitulo = el('span', { class: 'so-desktop' });
  mostrar(
    cabecalho(),
    el('div', { class: 'hoje-topo' },
      el('div', {},
        el('h1', {}, 'Hoje'),
        el('p', { class: 'hoje-data' }, dataDeHoje(), contagemTitulo)),
      el('div', { class: 'hoje-acoes' },
        el('button', { type: 'button', class: 'grande', id: 'registrar-chegada', onclick: () => irPara('#/chegada/nova') }, icone('mais', 22, 2.6), 'Registrar chegada'),
        el('button', { type: 'button', class: 'secundario buscar', id: 'buscar-paciente', onclick: () => irPara('#/busca') }, icone('buscar', 18), 'Buscar paciente'))),
    cartaoAviso,
    avisos, colunas,
    el('div', { class: 'acoes atalhos-rodape so-celular' },
      el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/precos') }, 'Preços'),
      el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/notificacoes') }, 'Notificações'),
      usuario.admin ? el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/caixa') }, 'Caixa de hoje') : null,
      usuario.admin ? el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/usuarios') }, 'Usuários') : null),
  );

  raiz.classList.add('larga');

  const aoErro = (e) => avisos.replaceChildren(caixaMensagem('erro', e.message));
  function colunaPets(classe, titulo, itens, vazio) {
    return el('section', { class: classe, 'aria-label': titulo },
      el('div', { class: 'secao-titulo' }, el('h2', { class: 'titulo-secao' }, titulo), el('span', { class: 'contagem' }, `${itens.length} ${itens.length === 1 ? 'pet' : 'pets'}`)),
      itens.length ? itens.map((a) => cartaoAtendimento(a, { aoAtualizar: atualizar, aoErro })) : el('p', { class: 'suave vazio-secao' }, vazio));
  }

  // Receitas: "Pedidos de receita para você" (veterinários) e "Para imprimir" (todos).
  function secoesReceitas() {
    const partes = [];
    if (receitas.pedidas.length) {
      partes.push(el('section', { class: 'secao-lateral pedidas', 'aria-label': 'Pedidos de receita para você' },
        el('div', { class: 'secao-titulo' }, el('h2', { class: 'titulo-secao' }, 'Pedidos para você'), el('span', { class: 'selo-contagem' }, String(receitas.pedidas.length))),
        receitas.pedidas.map((x) => el('div', { class: 'item-imprimir' },
          el('div', { class: 'item-info' },
            el('strong', {}, x.pet.nome),
            el('span', { class: 'detalhe' }, `${x.solicitada_por_nome || 'Um colega'} pediu${x.nota_pedido ? ' · ' + x.nota_pedido : ''}`)),
          el('button', { type: 'button', class: 'abrir-pedido', onclick: () => irPara(`#/receita/${x.id}`) }, 'Abrir receita')))));
    }
    if (receitas.imprimir.length) {
      partes.push(el('section', { class: 'secao-lateral para-imprimir', 'aria-label': 'Para imprimir' },
        el('div', { class: 'secao-titulo' },
          el('h2', { class: 'titulo-secao com-icone' }, icone('impressora', 18), 'Para imprimir'),
          el('span', { class: 'selo-contagem' }, String(receitas.imprimir.length))),
        receitas.imprimir.map(cartaoParaImprimir),
        el('button', { type: 'button', class: 'secundario ver-todas', onclick: () => irPara('#/receitas/imprimir') }, 'Ver lista')));
    }
    return partes;
  }

  // Contas enviadas para a recepção (de qualquer dia): finalizado e não pago precisa ficar à vista.
  function secaoPagamento() {
    const lista = dados.aguardando_pagamento || [];
    if (!lista.length) return null;
    return el('section', { class: 'secao-lateral secao-pagamento', 'aria-label': 'Aguardando pagamento' },
      el('div', { class: 'secao-titulo' }, el('h2', { class: 'titulo-secao' }, 'Aguardando pagamento'), el('span', { class: 'selo-contagem' }, String(lista.length))),
      lista.map((x) => el('div', { class: 'item-imprimir item-pagamento' },
        el('div', { class: 'item-info' },
          el('strong', {}, x.pet.nome, x.atendimento_status === 'finalizado' ? el('span', { class: 'etiqueta' }, 'Finalizado') : null),
          el('span', { class: 'detalhe' }, `Tutor: ${x.tutor.nome}`),
          el('span', { class: 'detalhe valor-pagamento' }, x.pago_centavos > 0 ? `Falta ${formatarReais(x.restante_centavos)} de ${formatarReais(x.total_centavos)}` : formatarReais(x.total_centavos)),
          el('span', { class: 'detalhe' }, `${x.enviado_por ? 'enviado por ' + nomeComTitulo(x.enviado_por) + ' ' : ''}${tempoDesde(x.enviado_em)}`)),
        el('button', { type: 'button', class: 'receber-botao', onclick: () => irPara(`#/conta/${x.atendimento_id}?receber=1`) }, 'Receber'))));
  }

  function desenhar() {
    if (!dados) return;
    const total = dados.aguardando.length + dados.em_atendimento.length + dados.finalizados.length + dados.cancelados_hoje;
    contagemTitulo.textContent = total ? ` · ${total} ${total === 1 ? 'atendimento' : 'atendimentos'}` : '';
    const finais = el('details', { class: 'finalizados', open: finalizadosAberto },
      el('summary', {}, 'Finalizados hoje', el('span', { class: 'direita' }, el('span', { class: 'contador-cinza' }, String(dados.finalizados.length)), el('span', { class: 'seta' }, icone('baixo', 16, 2.4)))),
      dados.finalizados.length
        ? dados.finalizados.map((a) => cartaoAtendimento(a, { aoAtualizar: atualizar, aoErro: () => {} }))
        : el('p', { class: 'suave vazio-secao' }, 'Nenhum atendimento finalizado hoje ainda.'));
    finais.addEventListener('toggle', () => { finalizadosAberto = finais.open; });
    colunas.replaceChildren(...[
      total === 0 ? el('div', { class: 'cartao vazio vazio-geral' }, el('p', {}, 'Nenhuma chegada registrada hoje ainda.'), el('p', { class: 'suave' }, 'Quando um paciente chegar, toque em "Registrar chegada".')) : null,
      colunaPets('col-aguardando', 'Aguardando', dados.aguardando, 'Ninguém aguardando no momento.'),
      colunaPets('col-atendimento', 'Em atendimento', dados.em_atendimento, 'Nenhum atendimento em andamento.'),
      el('aside', { class: 'col-lateral', 'aria-label': 'Pagamentos, receitas e finalizados' }, secaoPagamento(), ...secoesReceitas(), finais),
      dados.cancelados_hoje ? el('p', { class: 'suave' }, `Chegadas canceladas hoje: ${dados.cancelados_hoje}`) : null,
    ].filter(Boolean)); // (replaceChildren transformaria null em o texto "null")
  }

  async function atualizar() {
    if (minha !== versaoTela) return;
    try {
      const [novo, imprimir, pedidas] = await Promise.all([
        api('GET', '/api/hoje'),
        api('GET', '/api/receitas?status=para_imprimir').catch(() => null),
        PODE_ATENDER.includes(usuario.papel) ? api('GET', '/api/receitas?pedidas_a_mim=1').catch(() => null) : null,
      ]);
      if (minha !== versaoTela) return;
      dados = novo;
      receitas = { imprimir: imprimir ? imprimir.receitas : receitas.imprimir, pedidas: pedidas ? pedidas.receitas : (PODE_ATENDER.includes(usuario.papel) ? receitas.pedidas : []) };
      avisos.replaceChildren();
      desenhar();
    } catch (e) {
      if (minha !== versaoTela) return;
      if (e.status === 401) { usuario = null; telaEntrar(); return; }
      avisos.replaceChildren(caixaMensagem('erro', e.message));
    }
  }

  // Atualiza a cada 20 s (se a tela estiver visível) e redesenha a cada minuto (só a espera muda).
  const parar = () => minha !== versaoTela;
  const t20 = setInterval(() => { if (parar()) { clearInterval(t20); return; } if (document.visibilityState === 'visible') atualizar(); }, 20000);
  const t60 = setInterval(() => { if (parar()) { clearInterval(t60); return; } desenhar(); }, 60000);
  const aoVoltar = () => { if (parar()) { document.removeEventListener('visibilitychange', aoVoltar); return; } if (document.visibilityState === 'visible') atualizar(); };
  document.addEventListener('visibilitychange', aoVoltar);
  atualizar();
}

// ---------- Busca ----------
function telaBusca(qInicial = '') {
  const campoBusca = el('input', { id: 'q', type: 'search', class: 'busca-grande', placeholder: 'Nome do pet, do tutor ou telefone', autocomplete: 'off', value: qInicial, 'aria-label': 'Nome do pet, do tutor ou telefone' });
  const area = el('div', { id: 'resultados' });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Buscar paciente'), campoBusca, area);

  let tempo = null;
  let numero = 0; // ignora respostas antigas
  async function buscarAgora() {
    const q = campoBusca.value.trim();
    // Guarda o texto no endereço (sem criar passo novo no "voltar").
    history.replaceState(null, '', q ? `#/busca?q=${encodeURIComponent(q)}` : '#/busca');
    const meu = ++numero;
    if (q.length < 2) {
      area.replaceChildren(el('p', { class: 'suave' }, 'Digite pelo menos 2 letras ou 4 números do telefone.'));
      return;
    }
    area.replaceChildren(el('p', { class: 'carregando' }, 'Buscando…'));
    try {
      const { resultados } = await api('GET', '/api/busca?q=' + encodeURIComponent(q));
      if (meu !== numero) return;
      if (!resultados.length) {
        area.replaceChildren(
          el('div', { class: 'cartao vazio' },
            el('p', {}, 'Nenhum paciente encontrado.'),
            el('button', { type: 'button', onclick: () => irPara('#/chegada/nova') }, 'Registrar chegada de um pet novo')));
        return;
      }
      area.replaceChildren(...resultados.map((r) => cartaoResultado(r)));
    } catch (e) {
      if (meu === numero) area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  campoBusca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(buscarAgora, 300); });
  buscarAgora();
  campoBusca.focus();
}

function cartaoResultado(r) {
  const tutor = `Tutor: ${r.tutor.nome}${r.tutor.final_telefone ? ' · final ' + r.tutor.final_telefone : ''}`;
  if (r.tipo === 'pet') {
    return el('button', { type: 'button', class: 'resultado', onclick: () => irPara(`#/pet/${r.pet.id}`) },
      el('strong', { class: 'resultado-nome' }, r.pet.nome),
      el('span', {}, ROTULO_ESPECIE[r.pet.especie] || r.pet.especie),
      el('span', { class: 'suave' }, tutor),
      el('small', { class: 'suave' }, `${r.pet.codigo} · ${r.tutor.codigo}`));
  }
  return el('button', { type: 'button', class: 'resultado', onclick: () => irPara(`#/tutor/${r.tutor.id}`) },
    el('strong', { class: 'resultado-nome' }, r.tutor.nome),
    el('span', {}, 'Tutor (sem pets cadastrados)'),
    el('span', { class: 'suave' }, r.tutor.final_telefone ? `final ${r.tutor.final_telefone}` : ''),
    el('small', { class: 'suave' }, r.tutor.codigo));
}

// ---------- Registrar chegada (um só formulário) ----------
// A recepção não sabe se o pet já tem cadastro. O formulário sempre parece "pet novo"; enquanto
// a pessoa digita, o painel procura no cadastro e oferece "É este". Se ela ignorar, cadastra como novo
// (com os avisos de repetido de sempre).
const FORMATO_DIA_CURTO = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', day: '2-digit', month: '2-digit' });
function formatarDiaCurto(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO_DIA_CURTO.format(d);
}

// Monta um "candidato" (mesmo formato de /api/chegada/sugestoes) a partir da ficha do pet.
async function candidatoDoPet(petId) {
  const d = await api('GET', `/api/pets/${petId}`);
  const comPeso = d.atendimentos.find((a) => a.peso_kg != null);
  const ultima = d.atendimentos.find((a) => a.status !== 'cancelado');
  return {
    pet: { id: d.pet.id, codigo: d.pet.codigo, nome: d.pet.nome, especie: d.pet.especie, idade: idadeCurta(d.pet) || null, foto_id: d.pet.foto_id },
    tutor: { id: d.tutor.id, nome: d.tutor.nome, final_telefone: d.tutor.final_telefone },
    ultimo_peso_kg: comPeso ? comPeso.peso_kg : null,
    ultima_visita_em: ultima ? ultima.chegada_em : null,
    em_atendimento: !!d.atendimento_aberto,
  };
}

function cartaoCandidato(c, aoEscolher) {
  const detalhes = [ROTULO_ESPECIE[c.pet.especie] || c.pet.especie, c.pet.idade].filter(Boolean).join(', ');
  const final = c.tutor.final_telefone ? `Final ${c.tutor.final_telefone}` : '';
  const peso = c.ultimo_peso_kg != null
    ? `último peso ${formatarPeso(c.ultimo_peso_kg)}${c.ultima_visita_em ? ' em ' + formatarDiaCurto(c.ultima_visita_em) : ''}`
    : (c.ultima_visita_em ? `última visita em ${formatarDiaCurto(c.ultima_visita_em)}` : 'sem visitas anteriores');
  return el('div', { class: 'candidato', 'data-pet-id': String(c.pet.id) },
    el('div', { class: 'candidato-cartao' },
      miniatura(c.pet.foto_id, c.pet.nome, 'miniatura laranja'),
      el('div', { class: 'candidato-info' },
        el('strong', { class: 'resultado-nome' }, c.pet.nome),
        el('span', { class: 'detalhe' }, `${detalhes ? detalhes + ' · ' : ''}Tutor: ${c.tutor.nome}`),
        el('span', { class: 'detalhe pequeno' }, [final, peso].filter(Boolean).join(' · ')))),
    c.em_atendimento
      ? el('div', { class: 'candidato-acao' }, el('strong', { class: 'ja-na-clinica' }, 'Já está na clínica'), el('a', { href: '#/hoje', class: 'ver-hoje' }, 'Ver em Hoje'))
      : el('button', { type: 'button', class: 'grande este', onclick: () => aoEscolher(c) }, 'É este — continuar'));
}

// "petPre" = id de um pet já escolhido (vem da ficha do pet: #/chegada/123).
async function telaChegadaNova(petPre = null) {
  const minha = versaoTela;
  let escolhido = null; // candidato escolhido ("É este"); null = cadastro novo
  if (petPre) {
    carregando();
    try { escolhido = await candidatoDoPet(petPre); } catch (e) { if (minha === versaoTela) telaErro(e, '#/hoje'); return; }
    if (minha !== versaoTela) return;
  }

  const especie = escolhaEspecie('');
  const campos = camposChegada({ nomePet: 'pet' });
  const area = el('div');
  const sugestoes = el('div', { id: 'sugestoes' });
  const botao = el('button', { type: 'submit', id: 'enviar-chegada', class: 'grande' }, 'Registrar chegada');
  const entradaPet = el('input', { id: 'pet_nome', name: 'pet_nome', autocomplete: 'off', required: true });
  const entradaTutor = el('input', { id: 'tutor_nome', name: 'tutor_nome', autocomplete: 'off', required: true });
  const entradaFone = el('input', { id: 'whatsapp', name: 'whatsapp', type: 'tel', inputmode: 'tel', placeholder: '(71) 99999-8888', autocomplete: 'off', required: true });
  const blocoNomes = el('div', {}, el('label', { for: 'pet_nome' }, 'Nome do pet'), entradaPet, el('label', { for: 'tutor_nome' }, 'Nome do tutor'), entradaTutor, sugestoes);
  const blocoNovo = el('div', {}, el('label', {}, 'Espécie'), especie.caixa, el('label', { for: 'whatsapp' }, 'WhatsApp do tutor'), entradaFone);
  const cabecaEscolhido = el('div', { class: 'cartao cabeca-chegada', id: 'pet-escolhido' });
  const blocoPeso = el('div', { class: 'bloco-chegada' }, ...campos.peso);

  function desenharEscolhido() {
    const c = escolhido;
    blocoNomes.hidden = blocoNovo.hidden = !!c;
    cabecaEscolhido.hidden = !c;
    if (c) {
      cabecaEscolhido.replaceChildren(
        miniatura(c.pet.foto_id, c.pet.nome, 'miniatura laranja'),
        el('div', { class: 'candidato-info' },
          el('div', {}, 'Pet: ', el('strong', {}, c.pet.nome), ` (${(ROTULO_ESPECIE[c.pet.especie] || c.pet.especie).toLowerCase()}) — tutor ${c.tutor.nome}`),
          c.ultimo_peso_kg != null ? el('div', { class: 'suave' }, `último peso ${formatarPeso(c.ultimo_peso_kg)}`) : null,
          c.em_atendimento ? el('div', { class: 'ja-na-clinica' }, 'Já está na clínica. ', el('a', { href: '#/hoje' }, 'Ver em Hoje')) : null),
        el('button', { type: 'button', class: 'secundario', id: 'trocar-pet', onclick: () => { escolhido = null; desenharEscolhido(); procurar(); } }, 'trocar'));
      sugestoes.replaceChildren();
    }
    botao.hidden = !!(c && c.em_atendimento);
  }

  function escolher(c) {
    escolhido = c;
    area.replaceChildren();
    desenharEscolhido();
    campos.pesoCampo.focus();
  }

  // Procura no cadastro enquanto digita (espera 300 ms depois da última tecla).
  let tempo = null;
  let numero = 0; // ignora respostas antigas
  async function procurar() {
    if (escolhido) return;
    const meu = ++numero;
    const pet = entradaPet.value.trim();
    if (pet.length < 2) { sugestoes.replaceChildren(); return; }
    const qs = new URLSearchParams({ pet, tutor: entradaTutor.value.trim(), whatsapp: entradaFone.value.trim() });
    try {
      const { sugestoes: lista } = await api('GET', '/api/chegada/sugestoes?' + qs);
      if (meu !== numero || escolhido || minha !== versaoTela) return;
      sugestoes.replaceChildren(...(lista.length
        ? [el('section', { class: 'cartao sugestoes', 'aria-label': 'Encontramos no cadastro' },
          el('p', { class: 'sug-titulo' }, icone('check', 16, 2.4), 'Encontramos no cadastro'),
          ...lista.map((c) => cartaoCandidato(c, escolher)),
          el('p', { class: 'sug-nota' }, 'Não é? Continue preenchendo e criamos um cadastro novo.'))]
        : []));
    } catch (e) {
      if (meu === numero) sugestoes.replaceChildren(); // sugestão é só um auxílio: se falhar, segue como cadastro novo
    }
  }
  for (const x of [entradaPet, entradaTutor, entradaFone]) x.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(procurar, 300); });

  const f = el('form', { novalidate: true }, cabecaEscolhido, blocoNomes, blocoNovo, el('div', { class: 'divisor' }), blocoPeso, el('div', { class: 'bloco-chegada' }, ...campos.resto), area, botao);
  desenharEscolhido();

  async function enviar(extra = {}) {
    area.replaceChildren();
    botao.disabled = true;
    try {
      const chegada = await campos.coletar(); // confere peso/motivo e envia a foto
      if (escolhido) {
        await api('POST', '/api/atendimentos', { pet_id: escolhido.pet.id, ...chegada });
      } else {
        await api('POST', '/api/cadastro-rapido', {
          tutor: { nome: entradaTutor.value, whatsapp: entradaFone.value },
          pet: { nome: entradaPet.value, especie: especie.valor() || undefined },
          chegada, ...extra,
        });
      }
      irPara('#/hoje');
    } catch (e) {
      botao.disabled = false;
      botao.hidden = false;
      if (e.status === 409 && e.dados && e.dados.atendimento_id) {
        botao.hidden = true;
        area.replaceChildren(el('div', { class: 'cartao aviso' }, el('h2', {}, 'Este pet já está na clínica.'),
          el('p', {}, 'Já existe um atendimento aberto para ele. Veja na tela Hoje.'),
          el('button', { type: 'button', id: 'ir-hoje', onclick: () => irPara('#/hoje') }, 'Ir para Hoje')));
      } else if (e.status === 409 && e.dados && e.dados.duplicados) {
        // Enquanto o aviso de repetido está na tela, só as opções do aviso valem.
        botao.hidden = true;
        const usar = async (id) => { try { escolher(await candidatoDoPet(id)); botao.hidden = !!escolhido.em_atendimento; } catch (er) { area.replaceChildren(caixaMensagem('erro', er.message)); } };
        area.replaceChildren(cartaoDuplicado(e.dados, extra, enviar, () => { area.replaceChildren(); botao.hidden = false; }, usar));
      } else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!escolhido && !especie.valor()) { area.replaceChildren(caixaMensagem('erro', 'Escolha a espécie: Cão, Gato ou Outro.')); return; }
    enviar();
  });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Registrar chegada'), el('div', { class: 'form-plano' }, f));
  if (escolhido) campos.pesoCampo.focus(); else entradaPet.focus();
}

// Cartão mostrado quando a API avisa de cadastro repetido (WhatsApp ou pet).
// "aoVoltar" (opcional) desfaz o aviso para a pessoa corrigir os dados.
// "usarPet(id)" (opcional) deixa escolher o pet que já existe; sem ele, abre a ficha.
function cartaoDuplicado(dados, extra, reenviar, aoVoltar = null, usarPet = null) {
  const voltar = aoVoltar ? el('button', { type: 'button', class: 'secundario', onclick: aoVoltar }, 'Voltar e corrigir os dados') : null;
  if (dados.tipo === 'pet') {
    const d = dados.duplicados[0];
    return el('div', { class: 'cartao aviso' },
      el('h2', {}, `Este tutor já tem um pet chamado ${d.nome}`),
      el('div', { class: 'acoes' },
        usarPet
          ? el('button', { type: 'button', id: 'usar-este', onclick: () => usarPet(d.id) }, 'Usar este')
          : el('button', { type: 'button', onclick: () => irPara(`#/pet/${d.id}`) }, 'Abrir a ficha existente'),
        el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ ...extra, confirmar_duplicado: true }) }, 'Cadastrar mesmo assim'),
        voltar));
  }
  return el('div', { class: 'cartao aviso' },
    el('h2', {}, 'É a mesma pessoa?'),
    el('p', {}, 'Já existe cadastro com este WhatsApp.'),
    ...dados.duplicados.map((t) => el('div', { class: 'cartao' },
      el('strong', {}, t.nome), el('span', { class: 'suave' }, ` · final ${t.final_telefone} · ${t.codigo}`),
      el('p', { class: 'suave' }, t.pets.length ? 'Pets: ' + t.pets.map((p) => `${p.nome} (${ROTULO_ESPECIE[p.especie] || p.especie})`).join(', ') : 'Nenhum pet cadastrado.'),
      el('button', { type: 'button', onclick: () => reenviar({ tutor_existente_id: t.id }) }, 'Sim, é esta pessoa — adicionar o pet aqui'))),
    el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ confirmar_duplicado: true }) }, 'Não, é outra pessoa da família — criar novo cadastro'),
    voltar);
}

// ---------- Editar atendimento em aberto (peso, motivo, urgência, foto) ----------
async function telaEditarAtendimento(id) {
  const minha = versaoTela;
  carregando();
  let a;
  try { a = await api('GET', `/api/atendimentos/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e); return; }
  if (minha !== versaoTela) return;
  if (a.status !== 'chegou' && a.status !== 'em_atendimento') {
    mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, a.pet.nome), caixaMensagem('erro', 'Este atendimento já foi encerrado e não pode mais ser alterado.'));
    return;
  }
  const campos = camposChegada({ nomePet: a.pet.nome, pesoInicial: a.peso_kg, motivo: a.motivo, urgente: a.urgente, fotoInicial: a.foto_id, permitirPesarDepois: false });
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Salvar');
  const f = el('form', { novalidate: true },
    a.sem_peso ? el('p', { class: 'aviso-peso' }, 'Este paciente está sem peso. Informe abaixo, ou salve sem peso por enquanto.') : null,
    ...campos.peso, ...campos.resto, area, botao);
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    area.replaceChildren();
    botao.disabled = true;
    try {
      const kg = lerPesoDigitado(campos.pesoCampo.value);
      const motivo = f.querySelector('#motivo').value.trim();
      if (!motivo) throw new Error('Preencha o motivo da vinda.');
      const corpo = { motivo, urgente: f.querySelector('#urgencia-urgente').getAttribute('aria-checked') === 'true' };
      if (kg !== null) corpo.peso_kg = kg;
      else if (!a.sem_peso) throw new Error('Informe o peso em kg.');
      if (campos.foto.mudou()) corpo.foto_id = await campos.foto.resolver();
      await api('PATCH', `/api/atendimentos/${id}`, corpo);
      irPara('#/hoje');
    } catch (e) {
      botao.disabled = false;
      area.replaceChildren(caixaMensagem('erro', e.message));
    }
  });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, `Editar chegada de ${a.pet.nome}`),
    el('p', { class: 'suave' }, `Tutor: ${a.tutor.nome}`), el('div', { class: 'cartao' }, f));
}

// ---------- Ficha do pet ----------
async function telaPet(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/pets/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const { pet, tutor, atendimentos, atendimento_aberto: aberto, receitas = [] } = d;
  const linha = (rotulo, ...valor) => el('p', {}, el('span', { class: 'suave' }, rotulo + ': '), ...valor);
  mostrar(
    cabecalho(), botaoVoltar('#/busca', '← Buscar'),
    el('div', { class: 'cabeca-ficha' },
      miniatura(pet.foto_id, pet.nome, 'foto-ficha'),
      el('h1', { class: 'nome-pet' }, pet.nome, pet.ativo ? null : el('span', { class: 'etiqueta inativo' }, 'Arquivado'))),
    pet.ativo
      ? (aberto
        ? el('div', { class: 'cartao aviso' },
          el('p', {}, el('strong', {}, 'Este pet já está na clínica.')),
          el('button', { type: 'button', class: 'grande', id: 'registrar-chegada', disabled: true }, 'Registrar chegada'),
          el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/hoje') }, 'Ver em Hoje'))
        : el('button', { type: 'button', class: 'grande bloco', id: 'registrar-chegada', onclick: () => irPara(`#/chegada/${pet.id}`) }, 'Registrar chegada'))
      : null,
    pet.ativo && PODE_ATENDER.includes(usuario.papel)
      ? el('button', { type: 'button', class: 'grande bloco', id: 'nova-receita', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await abrirNovaReceita({ pet_id: pet.id, atendimento_id: aberto ? aberto.id : undefined }); } catch (e) { ev.target.disabled = false; alert(e.message); }
      } }, 'Nova receita') : null,
    pet.ativo ? el('button', { type: 'button', class: 'secundario bloco', id: 'colar-receita-pet', onclick: () => irPara(`#/receitas/transcrever?pet=${pet.id}${aberto ? '&atendimento=' + aberto.id : ''}`) }, 'Colar receita do WhatsApp') : null,
    el('div', { class: 'cartao' },
      linha('Espécie', ROTULO_ESPECIE[pet.especie] || pet.especie),
      linha('Raça', pet.raca || 'Não informada', pet.raca && !pet.raca_confirmada ? el('span', { class: 'etiqueta alerta' }, 'a confirmar') : null),
      linha('Idade', formatarIdade(pet)),
      linha('Sexo', ROTULO_SEXO[pet.sexo] || 'Não informado'),
      pet.observacoes ? linha('Observações', pet.observacoes) : null,
      el('p', {}, el('small', { class: 'suave' }, pet.codigo)),
      el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/pet/${pet.id}/editar`) }, 'Editar')),
    el('h2', {}, 'Tutor'),
    el('div', { class: 'cartao' },
      el('p', {}, el('strong', {}, tutor.nome)),
      linha('WhatsApp', formatarTelefone(tutor.whatsapp)),
      el('p', {}, el('small', { class: 'suave' }, tutor.codigo)),
      el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/tutor/${tutor.id}`) }, 'Abrir ficha do tutor')),
    el('h2', {}, 'Receitas'),
    el('div', { class: 'cartao' }, listaReceitasPet(receitas)),
    el('h2', {}, 'Histórico de atendimentos e peso'),
    el('div', { class: 'cartao' },
      atendimentos.length
        ? el('ul', { class: 'lista-simples historico' }, atendimentos.map((a) => el('li', {},
          el('div', { class: 'hist-linha' },
            el('strong', {}, formatarDia(a.chegada_em)),
            a.sem_peso ? el('span', { class: 'selo-sem-peso pequeno' }, 'Sem peso') : el('span', { class: 'hist-peso' }, formatarPeso(a.peso_kg)),
            a.urgente ? el('span', { class: 'selo-urgente' }, 'URGENTE') : null,
            el('span', { class: 'etiqueta' }, ROTULO_STATUS[a.status] || a.status)),
          a.motivo ? el('div', {}, a.motivo) : null,
          a.veterinario ? el('div', { class: 'suave' }, `Veterinário(a): ${a.veterinario}`) : null)))
        : el('p', { class: 'suave' }, 'Nenhum atendimento ainda')),
  );
}

async function telaEditarPet(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/pets/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const p = d.pet;
  const especie = escolhaEspecie(p.especie);
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Salvar');
  const f = el('form', { novalidate: true },
    ...campo('Nome do pet', 'nome', { required: true, value: p.nome }),
    el('label', {}, 'Espécie'), especie.caixa,
    ...campo('Raça', 'raca', { value: p.raca || '' }),
    el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'raca_confirmada', checked: p.raca_confirmada }), 'Raça confirmada'),
    el('label', { for: 'sexo' }, 'Sexo'), selectSexo(p.sexo),
    ...campo('Idade (anos)', 'idade_anos', { type: 'number', inputmode: 'numeric', min: 0, max: 40, value: p.idade_anos ?? '' }),
    ...campo('Idade (meses, de 0 a 11)', 'idade_meses', { type: 'number', inputmode: 'numeric', min: 0, max: 11, value: p.idade_meses ?? '' }),
    ...campoTexto('Observações', 'observacoes', p.observacoes || ''),
    el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'arquivado', checked: !p.ativo }), 'Arquivar (some da busca)'),
    area, botao);

  async function salvar(extra = {}) {
    area.replaceChildren();
    botao.disabled = true;
    const v = (n) => f.elements[n].value;
    try {
      await api('PATCH', `/api/pets/${id}`, {
        nome: v('nome'), especie: especie.valor(), raca: v('raca'), raca_confirmada: f.elements.raca_confirmada.checked,
        sexo: v('sexo'), idade_anos: v('idade_anos'), idade_meses: v('idade_meses'), observacoes: v('observacoes'),
        ativo: !f.elements.arquivado.checked, ...extra,
      });
      irPara(`#/pet/${id}`);
    } catch (e) {
      botao.disabled = false;
      if (e.status === 409 && e.dados && e.dados.duplicados) area.replaceChildren(cartaoDuplicado(e.dados, extra, salvar));
      else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  f.addEventListener('submit', (ev) => { ev.preventDefault(); salvar(); });
  mostrar(cabecalho(), botaoVoltar(`#/pet/${id}`), el('h1', {}, `Editar ${p.nome}`), el('div', { class: 'cartao' }, f));
}

// ---------- Ficha do tutor ----------
async function telaTutor(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/tutores/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const { tutor, pets } = d;
  if (tutor.mesclado_em_id) {
    mostrar(cabecalho(), el('h1', {}, tutor.nome),
      caixaMensagem('erro', 'Este cadastro foi unido a outro.'),
      el('button', { type: 'button', onclick: () => irPara(`#/tutor/${tutor.mesclado_em_id}`) }, 'Abrir o cadastro atual'));
    return;
  }
  const ativos = pets.filter((p) => p.ativo);
  mostrar(
    cabecalho(), botaoVoltar('#/busca', '← Buscar'),
    el('h1', {}, tutor.nome),
    el('div', { class: 'cartao' },
      el('p', {}, el('span', { class: 'suave' }, 'WhatsApp: '), formatarTelefone(tutor.whatsapp)),
      tutor.observacoes ? el('p', {}, el('span', { class: 'suave' }, 'Observações: '), tutor.observacoes) : null,
      el('p', {}, el('small', { class: 'suave' }, tutor.codigo)),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/tutor/${id}/editar`) }, 'Editar'),
        el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/tutor/${id}/juntar`) }, 'Juntar com outro cadastro'))),
    el('h2', {}, 'Pets'),
    ativos.length
      ? ativos.map((p) => el('button', { type: 'button', class: 'resultado', onclick: () => irPara(`#/pet/${p.id}`) },
        el('strong', { class: 'resultado-nome' }, p.nome), el('span', {}, ROTULO_ESPECIE[p.especie] || p.especie), el('small', { class: 'suave' }, p.codigo)))
      : el('p', { class: 'suave' }, 'Nenhum pet cadastrado.'),
    el('button', { type: 'button', onclick: () => irPara(`#/tutor/${id}/novo-pet`) }, 'Adicionar outro pet'),
  );
}

async function telaEditarTutor(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/tutores/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const t = d.tutor;
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Salvar');
  const f = el('form', { novalidate: true },
    ...campo('Nome do tutor', 'nome', { required: true, value: t.nome }),
    ...campo('WhatsApp', 'whatsapp', { type: 'tel', inputmode: 'tel', value: formatarTelefone(t.whatsapp), placeholder: '(71) 99999-8888' }),
    ...campoTexto('Observações', 'observacoes', t.observacoes || ''),
    area, botao);
  async function salvar(extra = {}) {
    area.replaceChildren();
    botao.disabled = true;
    try {
      await api('PATCH', `/api/tutores/${id}`, { nome: f.elements.nome.value, whatsapp: f.elements.whatsapp.value, observacoes: f.elements.observacoes.value, ...extra });
      irPara(`#/tutor/${id}`);
    } catch (e) {
      botao.disabled = false;
      if (e.status === 409 && e.dados && e.dados.duplicados) {
        area.replaceChildren(el('div', { class: 'cartao aviso' },
          el('h2', {}, 'Já existe cadastro com este WhatsApp'),
          ...e.dados.duplicados.map((x) => el('p', {}, `${x.nome} · final ${x.final_telefone} · ${x.codigo}`)),
          el('button', { type: 'button', class: 'secundario', onclick: () => salvar({ confirmar_duplicado: true }) }, 'Salvar mesmo assim')));
      } else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  f.addEventListener('submit', (ev) => { ev.preventDefault(); salvar(); });
  mostrar(cabecalho(), botaoVoltar(`#/tutor/${id}`), el('h1', {}, `Editar ${t.nome}`), el('div', { class: 'cartao' }, f));
}

async function telaNovoPet(tutorId) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/tutores/${tutorId}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const especie = escolhaEspecie('');
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Cadastrar pet');
  const f = el('form', { novalidate: true },
    ...campo('Nome do pet', 'nome', { required: true, autocomplete: 'off' }),
    el('label', {}, 'Espécie'), especie.caixa,
    ...campo('Raça (opcional)', 'raca'),
    el('label', { for: 'sexo' }, 'Sexo'), selectSexo(''),
    ...campo('Idade (anos)', 'idade_anos', { type: 'number', inputmode: 'numeric', min: 0, max: 40 }),
    ...campo('Idade (meses, de 0 a 11)', 'idade_meses', { type: 'number', inputmode: 'numeric', min: 0, max: 11 }),
    area, botao);
  async function enviar(extra = {}) {
    area.replaceChildren();
    if (!especie.valor()) { area.replaceChildren(caixaMensagem('erro', 'Escolha a espécie: Cão, Gato ou Outro.')); return; }
    botao.disabled = true;
    const v = (n) => f.elements[n].value;
    try {
      const p = await api('POST', '/api/pets', {
        tutor_id: tutorId, nome: v('nome'), especie: especie.valor(), raca: v('raca'), sexo: v('sexo'),
        idade_anos: v('idade_anos'), idade_meses: v('idade_meses'), ...extra,
      });
      irPara(`#/pet/${p.id}`);
    } catch (e) {
      botao.disabled = false;
      if (e.status === 409 && e.dados && e.dados.duplicados) area.replaceChildren(cartaoDuplicado(e.dados, extra, enviar));
      else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  f.addEventListener('submit', (ev) => { ev.preventDefault(); enviar(); });
  mostrar(cabecalho(), botaoVoltar(`#/tutor/${tutorId}`), el('h1', {}, 'Adicionar outro pet'),
    el('p', { class: 'suave' }, `Tutor: ${d.tutor.nome}`), el('div', { class: 'cartao' }, f));
}

// ---------- Juntar cadastros ----------
async function telaJuntar(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/tutores/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const principal = d.tutor;
  const campoBusca = el('input', { id: 'q', type: 'search', class: 'busca-grande', placeholder: 'Nome ou telefone do outro cadastro', autocomplete: 'off', 'aria-label': 'Buscar o outro cadastro' });
  const area = el('div');
  mostrar(cabecalho(), botaoVoltar(`#/tutor/${id}`), el('h1', {}, 'Juntar com outro cadastro'),
    el('div', { class: 'cartao' }, el('p', {}, 'Este cadastro será mantido:'), el('strong', {}, principal.nome), el('span', { class: 'suave' }, ` · ${formatarTelefone(principal.whatsapp)}`)),
    el('p', {}, 'Busque o outro cadastro (o repetido), que será unido a este:'), campoBusca, area);

  let tempo = null; let numero = 0;
  async function buscarAgora() {
    const q = campoBusca.value.trim();
    const meu = ++numero;
    if (q.length < 2) { area.replaceChildren(); return; }
    try {
      const { resultados } = await api('GET', '/api/busca?q=' + encodeURIComponent(q));
      if (meu !== numero) return;
      const vistos = new Map();
      for (const r of resultados) if (r.tutor.id !== id) vistos.set(r.tutor.id, r.tutor);
      if (!vistos.size) { area.replaceChildren(el('p', { class: 'suave' }, 'Nenhum outro cadastro encontrado.')); return; }
      area.replaceChildren(...[...vistos.values()].map((t) => el('button', { type: 'button', class: 'resultado', onclick: () => escolher(t.id) },
        el('strong', { class: 'resultado-nome' }, t.nome), el('span', { class: 'suave' }, t.final_telefone ? `final ${t.final_telefone}` : ''), el('small', { class: 'suave' }, t.codigo))));
    } catch (e) { if (meu === numero) area.replaceChildren(caixaMensagem('erro', e.message)); }
  }
  campoBusca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(buscarAgora, 300); });

  async function escolher(outroId) {
    area.replaceChildren(el('p', { class: 'carregando' }, 'Carregando…'));
    try {
      const o = await api('GET', `/api/tutores/${outroId}`);
      const lista = (x) => x.pets.filter((p) => p.ativo).map((p) => p.nome).join(', ') || 'nenhum pet';
      area.replaceChildren(el('div', { class: 'cartao aviso' },
        el('h2', {}, 'Confira os dois cadastros'),
        el('p', {}, el('strong', {}, 'Fica: '), `${principal.nome} · ${formatarTelefone(principal.whatsapp)} · pets: ${lista(d)}`),
        el('p', {}, el('strong', {}, 'Será unido: '), `${o.tutor.nome} · ${formatarTelefone(o.tutor.whatsapp)} · pets: ${lista(o)}`),
        el('button', { type: 'button', onclick: () => juntar(o) }, 'Juntar cadastros')));
    } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); }
  }

  async function juntar(o) {
    const ok = await confirmar('Juntar cadastros?', [
      `Os pets de ${o.tutor.nome} vão passar para ${principal.nome}.`,
      `O cadastro de ${o.tutor.nome} vai deixar de aparecer nas buscas.`,
    ], 'Sim, juntar');
    if (!ok) return;
    try {
      await api('POST', `/api/tutores/${id}/mesclar`, { duplicado_id: o.tutor.id });
      irPara(`#/tutor/${id}`);
    } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); }
  }
}

// ---------- Dados de teste (só administrador) ----------
function secaoDadosTeste() {
  const caixa = el('div', { class: 'cartao' }, el('h2', {}, 'Dados de teste'), el('p', { class: 'carregando' }, 'Carregando…'));
  const montar = async () => {
    try {
      const c = await api('GET', '/api/admin/dados-teste');
      const area = el('div');
      const entrada = el('input', { id: 'confirmacao', placeholder: 'Digite APAGAR', autocomplete: 'off', autocapitalize: 'characters' });
      const botao = el('button', { type: 'button' }, 'Apagar dados de teste');
      botao.addEventListener('click', async () => {
        area.replaceChildren();
        botao.disabled = true;
        try {
          const r = await api('POST', '/api/admin/apagar-dados-teste', { confirmacao: entrada.value });
          const a = r.apagados;
          caixa.replaceChildren(el('h2', {}, 'Dados de teste'),
            caixaMensagem('ok', `Apagado: ${a.tutores} tutores, ${a.pets} pets, ${a.atendimentos} atendimentos, ${a.pedidos} pedidos, ${a.receitas} receitas, ${a.fotos} fotos.`));
        } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); botao.disabled = false; }
      });
      caixa.replaceChildren(
        el('h2', {}, 'Dados de teste'),
        el('p', {}, 'Apaga todos os tutores e pets cujo nome começa com TESTE, e os atendimentos e receitas deles.'),
        el('p', {}, el('strong', {}, `Seriam apagados agora: ${c.tutores} tutores, ${c.pets} pets, ${c.atendimentos} atendimentos, ${c.pedidos} pedidos, ${c.receitas} receitas, ${c.fotos} fotos.`)),
        el('label', { for: 'confirmacao' }, 'Para confirmar, digite APAGAR'), entrada, area, el('div', { class: 'acoes' }, botao));
    } catch (e) { caixa.replaceChildren(el('h2', {}, 'Dados de teste'), caixaMensagem('erro', e.message)); }
  };
  montar();
  return caixa;
}

// Barra de cima: logo, atalhos (só no computador) e a pessoa logada com o botão "Sair".
function cabecalho() {
  const h = location.hash || '#/hoje';
  const atalho = (rotulo, destino, ativo) => el('a', { href: destino, 'aria-current': ativo ? 'page' : null }, rotulo);
  return el('header', { class: 'topo-app' }, el('div', { class: 'topo-dentro' },
    el('a', { class: 'marca', href: '#/hoje', 'aria-label': 'Vetclin — tela Hoje' }, el('img', { class: 'logo', src: '/logo-vetclin.png', alt: 'Vetclin Clínica Veterinária', width: 122, height: 38 })),
    usuario ? el('nav', { class: 'nav-principal', 'aria-label': 'Principal' },
      atalho('Hoje', '#/hoje', /^#\/(hoje|chegada|atendimento|conta)/.test(h) || h === '#/'),
      atalho('Pacientes', '#/busca', /^#\/(busca|pet|tutor)/.test(h)),
      atalho('Receitas', '#/receitas/imprimir', /^#\/receita/.test(h)),
      atalho('Preços', '#/precos', h.startsWith('#/precos')),
      atalho('Notificações', '#/notificacoes', h.startsWith('#/notificacoes')),
      usuario.admin ? atalho('Caixa', '#/caixa', h.startsWith('#/caixa')) : null,
      usuario.admin ? atalho('Usuários', '#/usuarios', h.startsWith('#/usuarios')) : null) : null,
    usuario ? el('div', { class: 'topo-direita' },
      el('span', { class: 'chip-usuario', title: usuario.nome },
        el('span', { class: 'chip-inicial', 'aria-hidden': 'true' }, (usuario.nome || '?').trim().charAt(0).toUpperCase()),
        el('span', { class: 'chip-nome' }, NOME_PAPEL[usuario.papel] || usuario.nome)),
      el('button', { class: 'secundario', type: 'button', onclick: sair }, 'Sair')) : null));
}

async function sair() {
  try { await api('POST', '/api/sair'); } catch { /* mesmo com erro, voltamos ao login */ }
  usuario = null;
  destinoLogin = null;
  telaEntrar();
}

async function telaUsuarios() {
  mostrar(el('p', { class: 'carregando' }, 'Carregando…'));
  let lista;
  try {
    lista = (await api('GET', '/api/usuarios')).usuarios;
  } catch (e) {
    mostrar(cabecalho(), caixaMensagem('erro', e.message), el('button', { type: 'button', onclick: () => irPara('#/hoje') }, 'Voltar'));
    return;
  }
  mostrar(
    cabecalho(),
    botaoVoltar('#/hoje'),
    el('h1', {}, 'Usuários'),
    el('div', { class: 'cartao' },
      el('ul', { class: 'lista-usuarios' }, lista.map((u) =>
        el('li', {},
          el('div', {},
            el('strong', {}, u.nome), ' ',
            el('span', { class: 'suave' }, `(${u.login})`), el('br'),
            el('span', { class: 'etiqueta' }, NOME_PAPEL[u.papel] || u.papel),
            u.admin ? el('span', { class: 'etiqueta' }, 'Administrador') : null,
            u.ativo ? null : el('span', { class: 'etiqueta inativo' }, 'Inativo'),
            u.whatsapp ? el('span', { class: 'suave' }, ' ' + formatarTelefone(u.whatsapp)) : null,
          ),
          el('button', { class: 'secundario', type: 'button', onclick: () => telaEditarUsuario(u) }, 'Editar'),
        ))),
    ),
    el('div', { class: 'acoes' }, el('button', { type: 'button', onclick: telaNovoUsuario }, 'Novo usuário')),
    secaoDadosClinica(),
    secaoDadosTeste(),
  );
}

function selectPapel(atual) {
  const s = el('select', { id: 'papel', name: 'papel' },
    el('option', { value: 'recepcao' }, 'Recepção'),
    el('option', { value: 'veterinario' }, 'Veterinário(a)'),
    el('option', { value: 'suporte' }, 'Suporte'));
  s.value = atual || 'recepcao';
  return s;
}

function telaNovoUsuario() {
  mostrar(
    cabecalho(),
    botaoVoltar(telaUsuarios),
    el('h1', {}, 'Novo usuário'),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        await api('POST', '/api/usuarios', {
          nome: d.nome, login: d.login, senha: d.senha, papel: d.papel, crmv: d.crmv, whatsapp: d.whatsapp, admin: d.admin === 'on',
        });
        telaUsuarios();
      },
        campo('Nome', 'nome', { required: true }),
        campo('Login', 'login', { autocapitalize: 'none', required: true }),
        campo('Senha (mínimo 8 caracteres)', 'senha', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }),
        el('label', { for: 'papel' }, 'Papel'), selectPapel(),
        campo('CRMV (só para veterinários)', 'crmv'),
        campo('WhatsApp (para receber pedidos de receita)', 'whatsapp', { type: 'tel', inputmode: 'tel', placeholder: '(71) 99999-8888', autocomplete: 'off' }),
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'admin' }), 'Administrador'),
        el('button', { type: 'submit', class: 'grande' }, 'Criar usuário'),
      )));
}

function telaEditarUsuario(u) {
  mostrar(
    cabecalho(),
    botaoVoltar(telaUsuarios),
    el('h1', {}, `Editar ${u.nome}`),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        const corpo = { nome: d.nome, papel: d.papel, crmv: d.crmv, whatsapp: d.whatsapp, admin: d.admin === 'on', ativo: d.ativo === 'on' };
        if (d.senha) corpo.senha = d.senha;
        await api('PATCH', `/api/usuarios/${u.id}`, corpo);
        // Se o administrador editou a si mesmo, atualiza os dados da tela.
        if (u.id === usuario.id) usuario = await api('GET', '/api/eu');
        telaUsuarios();
      },
        el('p', { class: 'suave' }, `Login: ${u.login}`),
        campo('Nome', 'nome', { required: true, value: u.nome }),
        el('label', { for: 'papel' }, 'Papel'), selectPapel(u.papel),
        campo('CRMV', 'crmv', { value: u.crmv || '' }),
        campo('WhatsApp (para receber pedidos de receita)', 'whatsapp', { type: 'tel', inputmode: 'tel', placeholder: '(71) 99999-8888', autocomplete: 'off', value: u.whatsapp ? formatarTelefone(u.whatsapp) : '' }),
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'admin', checked: u.admin }), 'Administrador'),
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'ativo', checked: u.ativo }), 'Ativo (pode entrar no sistema)'),
        campo('Nova senha (deixe em branco para não mudar)', 'senha', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
        el('button', { type: 'submit' }, 'Salvar'),
      )));
}


// ---------- Receitas ----------
const ROTULO_RECEITA = { rascunho: 'Rascunho', liberada: 'Liberada', impressa: 'Impressa', entregue: 'Entregue', cancelada: 'Cancelada' };
const MODELO_LINHA = 'Medicamento ___ mg — dar ___ a cada ___ horas por ___ dias';

// "Dra. Elizabeth" fica como está; "Felipe" vira "Dr(a). Felipe".
function comTratamento(nome) {
  const n = String(nome ?? '').trim();
  return /^dra?\.?\s/i.test(n) ? n : `Dr(a). ${n}`;
}

// "1234" -> "CRMV 1234"; "CRMV-BA 1234" fica como está.
function rotuloCrmv(c) {
  const t = String(c ?? '').trim();
  return !t ? '' : /^crmv/i.test(t) ? t : `CRMV ${t}`;
}

function chipReceita(status) {
  return el('span', { class: 'etiqueta st-' + status }, ROTULO_RECEITA[status] || status);
}

// Transforma o texto colado do WhatsApp em elementos da tela: mantém as quebras de linha,
// *negrito* e _itálico_. Nunca usa innerHTML (tudo entra como texto).
function marcasZap(linha) {
  const nos = [];
  let buf = '';
  const descarrega = () => { if (buf) { nos.push(buf); buf = ''; } };
  let i = 0;
  while (i < linha.length) {
    const ch = linha[i];
    if (ch === '*' || ch === '_') {
      const fim = linha.indexOf(ch, i + 1);
      const colado = fim > i + 1 && !/\s/.test(linha[i + 1]) && !/\s/.test(linha[fim - 1]);
      // O sublinhado dentro de uma palavra (ex.: nome_do_arquivo) não vira itálico.
      const dentroDePalavra = ch === '_' && fim > 0 && ((i > 0 && /\w/.test(linha[i - 1])) || /\w/.test(linha[fim + 1] || ''));
      if (colado && !dentroDePalavra) {
        descarrega();
        nos.push(el(ch === '*' ? 'strong' : 'em', {}, ...marcasZap(linha.slice(i + 1, fim))));
        i = fim + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  descarrega();
  return nos;
}

function renderizarReceita(textoReceita) {
  const saida = [];
  String(textoReceita ?? '').split('\n').forEach((linha, n) => {
    if (n > 0) saida.push('\n');
    saida.push(...marcasZap(linha));
  });
  return saida;
}

function limparInvisiveis(t) {
  return String(t).replace(/[​-‍⁠﻿]/g, '').replace(/\r\n?/g, '\n');
}

async function copiarTexto(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* tenta o jeito antigo */ }
  const area = el('textarea', { class: 'copia-escondida', readonly: true }, t);
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, t.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function dataPorExtenso(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Bahia', day: 'numeric', month: 'long', year: 'numeric' });
}

// "Cão, SRD, 5 anos, 12,4 kg"
function linhaPaciente(p) {
  const partes = [ROTULO_ESPECIE[p.especie] || p.especie, p.raca, idadeCurta(p), p.peso_kg != null ? formatarPeso(p.peso_kg) : null].filter(Boolean);
  return partes.join(', ');
}

// "Canina" / "Felina" (como aparece no papel).
const ROTULO_ESPECIE_PAPEL = { cao: 'Canina', gato: 'Felina', outro: 'Outra' };

// A folha do receituário (A4), como o modelo aprovado. Usada na impressão, na prévia do editor e na transcrição.
// d = { clinica, pet:{nome,especie,raca,sexo,idade_anos,idade_meses,peso_kg}, tutor, vet:{nome,crmv}|null, linhas, texto, orientacoes, data, segundaVia }
// Receita em colunas (linhas): grupos por via, itens numerados e a quantidade a comprar na ponta. Senão: o texto como está.
function montarFolha(d) {
  const c = d.clinica || {};
  const cidadeData = (c.clinica_cidade ? c.clinica_cidade + ', ' : '') + dataPorExtenso(d.data);
  const grupos = d.linhas ? gruposDasLinhas(d.linhas) : [];
  const campo = (rotulo, valor, classe = '') => el('div', { class: classe }, el('strong', {}, rotulo + ': '), valor || '—');
  const endereco = [c.clinica_endereco, c.clinica_cidade].filter(Boolean).join(' · ');
  const corpo = grupos.length
    ? el('section', { class: 'folha-corpo-grupos', 'aria-label': 'Medicamentos' }, grupos.map((g) => el('div', { class: 'folha-grupo' },
      el('h2', {}, g.via),
      g.itens.map((i) => el('div', { class: 'folha-item' },
        i.titulo || i.comprar ? el('div', { class: 'folha-item-linha' },
          el('span', { class: 'titulo' }, `${i.n} – ${i.titulo}`), el('span', { class: 'pontilhado', 'aria-hidden': 'true' }), el('span', { class: 'comprar' }, i.comprar)) : null,
        i.instrucao ? el('p', {}, i.instrucao) : null)))))
    : el('div', { class: 'folha-corpo folha-texto' }, ...renderizarReceita(d.texto));
  return el('article', { class: 'folha' },
    d.segundaVia ? el('div', { class: 'folha-via' }, '2ª via') : null,
    el('header', { class: 'folha-cabeca' },
      el('img', { class: 'folha-logo', src: '/logo-vetclin.png', alt: c.clinica_nome || 'Vetclin' }),
      el('div', { class: 'folha-titulo-linha' }, el('div', { class: 'linha-t' }), el('h2', { class: 'folha-titulo' }, 'RECEITUÁRIO'), el('div', { class: 'linha-l' }))),
    el('section', { class: 'folha-dados', 'aria-label': 'Paciente' },
      campo('Paciente', d.pet.nome, 'dobro'),
      campo('Peso', d.pet.peso_kg != null ? formatarPeso(d.pet.peso_kg) : ''),
      campo('Espécie', ROTULO_ESPECIE_PAPEL[d.pet.especie] || d.pet.especie),
      campo('Raça', d.pet.raca),
      campo('Idade', idadeCurta(d.pet)),
      campo('Sexo', ROTULO_SEXO[d.pet.sexo] || ''),
      campo('Responsável', d.tutor, 'dobro')),
    corpo,
    d.orientacoes ? el('section', { class: 'folha-orientacoes-caixa' }, el('h2', {}, 'ORIENTAÇÕES'), el('div', { class: 'folha-corpo' }, ...renderizarReceita(d.orientacoes))) : null,
    el('footer', { class: 'folha-assinatura' },
      el('p', {}, cidadeData),
      el('div', { class: 'folha-vet' },
        el('div', { class: 'folha-linha' }),
        el('strong', {}, d.vet ? d.vet.nome : 'Veterinário(a)'),
        d.vet && d.vet.crmv ? el('span', {}, rotuloCrmv(d.vet.crmv)) : null)),
    endereco || c.clinica_telefone
      ? el('div', { class: 'folha-rodape' }, el('span', {}, endereco), el('span', {}, c.clinica_telefone || ''))
      : null);
}

// Dados da folha a partir da resposta de GET /api/receitas/:id.
function dadosDaFolha(d, vetPrevia = null) {
  const r = d.receita;
  const peso = d.pet.ultimo_peso;
  return {
    clinica: d.clinica,
    pet: { nome: d.pet.nome, especie: d.pet.especie, raca: d.pet.raca, sexo: d.pet.sexo, idade_anos: d.pet.idade_anos, idade_meses: d.pet.idade_meses, peso_kg: peso ? peso.kg : null },
    tutor: d.tutor.nome,
    vet: d.veterinario || vetPrevia,
    linhas: r.linhas, texto: r.texto, orientacoes: r.orientacoes, data: r.liberada_em || null,
    segundaVia: r.vezes_impressa >= 1,
  };
}

// Cartão do paciente no alto da receita: inicial, nome, espécie/raça/idade, peso e tutor.
function cabecaReceita(d) {
  const p = d.pet;
  const peso = p.ultimo_peso;
  const pesoHoje = peso && formatarDia(peso.data) === formatarDia(new Date().toISOString());
  const resumo = [ROTULO_ESPECIE[p.especie] || p.especie, p.raca, idadeCurta(p)].filter(Boolean).join(', ');
  return el('div', { class: 'cartao cartao-paciente cabeca-receita' },
    miniatura(null, p.nome, 'miniatura laranja'),
    el('div', { class: 'info' },
      el('strong', {}, `${p.nome}${resumo ? ' · ' + resumo : ''}`),
      el('span', { class: 'peso-receita' },
        peso ? [pesoHoje ? 'Peso hoje: ' : 'Último peso: ', el('strong', {}, formatarPeso(peso.kg)), pesoHoje ? '' : ` (${formatarDia(peso.data)})`] : 'Sem peso registrado',
        ` · Tutor: ${d.tutor.nome}`),
      el('div', {}, chipReceita(d.receita.status), d.receita.versao > 1 ? el('span', { class: 'etiqueta' }, `Versão ${d.receita.versao}`) : null),
      d.receita.origem === 'transcrita' ? el('span', {}, `Transcrita por ${d.receita.criado_por_nome || 'a recepção'} · o veterinário confere e assina no papel`) : null));
}

// Janela para escolher o veterinário (e uma observação) e enviar o pedido.
// "aoEscolher(vet, nota, acao)" pode lançar erro: a mensagem aparece na janela.
function dialogoPedirReceita(vets, aoEscolher) {
  return new Promise((resolve) => {
    const seletor = el('select', { id: 'pedir-vet' }, el('option', { value: '' }, 'Escolha o veterinário…'), vets.map((v) => el('option', { value: String(v.id) }, v.nome)));
    const nota = el('input', { id: 'pedir-nota', type: 'text', maxlength: 200, autocomplete: 'off', placeholder: 'ex.: cão com otite, 12 kg' });
    const area = el('div');
    const enviar = el('button', { type: 'button', id: 'pedir-whatsapp' }, 'Enviar pelo WhatsApp');
    const copiar = el('button', { type: 'button', class: 'secundario', id: 'pedir-copiar' }, 'Copiar link');
    const d = el('dialog', { class: 'confirmacao' },
      el('h2', {}, 'Enviar para outro veterinário'),
      el('p', { class: 'suave' }, 'O colega recebe o link no WhatsApp, abre e escreve a receita.'),
      el('label', { for: 'pedir-vet' }, 'Para quem?'), seletor,
      el('label', { for: 'pedir-nota' }, 'Observação (opcional)'), nota, area,
      el('div', { class: 'acoes' }, enviar, copiar, el('button', { type: 'button', class: 'secundario', id: 'pedir-voltar' }, 'Voltar')));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    const rodar = (botao, acao) => async () => {
      area.replaceChildren();
      const vet = vets.find((v) => String(v.id) === seletor.value);
      if (!vet) { area.replaceChildren(caixaMensagem('erro', 'Escolha o veterinário.')); return; }
      botao.disabled = true;
      try { await aoEscolher(vet, nota.value.trim(), acao); fechar(true); } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); botao.disabled = false; }
    };
    enviar.addEventListener('click', rodar(enviar, 'whatsapp'));
    copiar.addEventListener('click', rodar(copiar, 'copiar'));
    d.querySelector('#pedir-voltar').addEventListener('click', () => fechar(false));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(false); });
    document.body.append(d);
    d.showModal();
  });
}

// Texto do pedido enviado ao colega pelo WhatsApp.
function mensagemPedido(d, vet, nota) {
  const p = d.pet;
  const info = [ROTULO_ESPECIE[p.especie] || p.especie, idadeCurta(p), p.ultimo_peso ? formatarPeso(p.ultimo_peso.kg) : null].filter(Boolean).join(', ');
  return `Oi, ${vet.nome}! Pode escrever a receita do *${p.nome}* (${info}) — tutor ${d.tutor.nome}? É só abrir: ${location.origin}/#/receita/${d.receita.id}` + (nota ? `\n\nObs.: ${nota}` : '');
}

function linkWhatsapp(vet, mensagem) {
  const digitos = String(vet.whatsapp || '').replace(/\D/g, '');
  return `https://wa.me/${digitos}?text=${encodeURIComponent(mensagem)}`;
}

// ---------- Editor da receita ----------
// ---------- Produtos e valores da receita (só para a equipe) ----------
// Cada linha do texto da receita vira uma linha de produto. A equipe marca "Temos?" (Sim/Não);
// se Sim, digita quantidade e valor. Os valores NUNCA vão para o papel impresso.

// Quantidade digitada -> número de 1 a 999 (vazio vale 1); null se inválida.
const lerQuantidade = (t) => { const x = String(t).trim(); if (!x) return 1; return /^\d{1,3}$/.test(x) && Number(x) >= 1 ? Number(x) : null; };

// Cria a seção. "d" é a resposta de GET /api/receitas/:id; "pegarTexto()" devolve o texto atual da receita.
// Devolve { caixa, aoMudarTexto(), salvarAgora(), semValor(), focarPrimeiroSemValor() }.
function secaoProdutos(d, pegarTexto, minha) {
  const id = d.receita.id;
  const anteriores = d.receita.itens.map((i) => ({
    descricao: i.descricao, temos: i.temos, qtd: String(i.quantidade), valor: i.temos ? reaisParaCampo(i.valor_unitario_centavos) : '',
  }));
  let itens = itensDoTexto(d.receita.texto, anteriores);
  const lista = el('div', { class: 'produtos-lista' });
  const total = el('div', { class: 'produtos-total', id: 'produtos-total' });
  const aviso = el('div', { class: 'aviso-peso produtos-aviso', id: 'produtos-aviso' });
  const estado = el('div', { class: 'estado-salvo', id: 'produtos-estado', role: 'status' });
  const caixa = el('section', { class: 'cartao produtos-secao', id: 'produtos-secao' },
    el('h2', {}, 'Produtos e valores (só para a equipe)'),
    el('p', { class: 'suave' }, 'Não sai no papel da receita. Marque se a clínica tem o produto e digite o valor.'),
    lista, total, aviso, estado);

  const quantidadeDe = (it) => lerQuantidade(it.qtd) ?? 1;
  const valorDe = (it) => { const v = lerReais(it.valor); return v !== null && v <= MAX_VALOR_CENTAVOS ? v : null; };
  const subtotalDe = (it) => (it.temos && valorDe(it) !== null ? quantidadeDe(it) * valorDe(it) : 0);
  const semValor = () => itens.filter((it) => it.temos && valorDe(it) === null);

  // Texto do rodapé (total e aviso). Não mexe nas linhas, para não atrapalhar quem está digitando.
  function atualizarRodape() {
    escreverTotal(total, itens.reduce((t, it) => t + subtotalDe(it), 0));
    const n = semValor().length;
    aviso.textContent = n === 1 ? "1 produto marcado como 'temos' está sem valor" : `${n} produtos marcados como 'temos' estão sem valor`;
    aviso.hidden = n === 0;
    total.hidden = itens.length === 0;
  }

  function desenharLinha(it) {
    const subtotal = el('div', { class: 'produto-subtotal' });
    const detalhes = el('div', { class: 'produto-detalhes' });
    const linha = el('div', { class: 'produto-linha' + (it.temos ? ' sim' : '') });
    const nao = el('button', { type: 'button', class: 'opcao', role: 'radio', 'data-escolha': 'nao' }, 'Não');
    const sim = el('button', { type: 'button', class: 'opcao', role: 'radio', 'data-escolha': 'sim' }, 'Sim');
    const qtd = el('input', { type: 'text', inputmode: 'numeric', class: 'produto-qtd', 'aria-label': `Quantidade de ${it.descricao}`, value: it.qtd, maxlength: 3, autocomplete: 'off' });
    const valor = el('input', { type: 'text', inputmode: 'decimal', class: 'produto-valor', 'aria-label': `Valor de ${it.descricao} (R$)`, value: it.valor, placeholder: '0,00', maxlength: 14, autocomplete: 'off' });
    const atualizar = () => {
      nao.setAttribute('aria-checked', String(!it.temos));
      sim.setAttribute('aria-checked', String(it.temos));
      linha.classList.toggle('sim', it.temos);
      detalhes.hidden = !it.temos;
      const q = lerQuantidade(it.qtd); const v = lerReais(it.valor);
      qtd.classList.toggle('invalido', q === null);
      valor.classList.toggle('invalido', it.valor.trim() !== '' && (v === null || v > MAX_VALOR_CENTAVOS));
      subtotal.textContent = valorDe(it) !== null ? `Subtotal: ${formatarReais(subtotalDe(it))}` : '';
      atualizarRodape();
    };
    nao.addEventListener('click', () => { it.temos = false; atualizar(); agendar(); });
    sim.addEventListener('click', () => { it.temos = true; atualizar(); agendar(); if (valorDe(it) === null) valor.focus(); });
    qtd.addEventListener('input', () => { it.qtd = qtd.value; atualizar(); agendar(); });
    valor.addEventListener('input', () => { it.valor = valor.value; atualizar(); agendar(); });
    detalhes.append(
      el('label', { class: 'produto-campo' }, 'Qtd (cobrança)', qtd),
      el('label', { class: 'produto-campo' }, 'Valor (R$)', valor),
      subtotal);
    linha.append(
      el('div', { class: 'produto-nome' }, it.descricao),
      el('div', { class: 'produto-temos' },
        el('span', { class: 'produto-pergunta' }, 'Temos?'),
        el('div', { class: 'grupo-opcoes dois', role: 'radiogroup', 'aria-label': `Temos o produto ${it.descricao}?` }, nao, sim)),
      detalhes);
    it.campoValor = valor;
    atualizar();
    return linha;
  }

  function desenhar() {
    lista.replaceChildren(...(itens.length ? itens.map(desenharLinha) : [el('p', { class: 'suave' }, 'Quando houver texto na receita, cada linha aparece aqui.')]));
    atualizarRodape();
  }

  // ----- salvar (1 s depois da última mudança) -----
  let ultimoEnvio = JSON.stringify(corpo());
  let tempo = null; let salvando = null; let bloqueado = false;
  function corpo() {
    return { itens: itens.map((it) => ({
      descricao: it.descricao, temos: it.temos, quantidade: it.temos ? quantidadeDe(it) : 1, valor_unitario_centavos: it.temos ? valorDe(it) : null,
    })) };
  }
  async function salvarAgora() {
    clearTimeout(tempo);
    if (salvando) await salvando;
    const envio = corpo(); const txt = JSON.stringify(envio);
    if (txt === ultimoEnvio || bloqueado) return;
    estado.textContent = 'Salvando…'; estado.className = 'estado-salvo';
    salvando = (async () => {
      try {
        await api('PUT', `/api/receitas/${id}/itens`, envio);
        ultimoEnvio = txt;
        estado.textContent = 'Salvo';
      } catch (e) {
        if (e.status === 409 || e.status === 403) { bloqueado = true; estado.textContent = 'Não salvo'; estado.className = 'estado-salvo erro'; return; }
        estado.textContent = 'Não salvo — tentando de novo…'; estado.className = 'estado-salvo erro';
        tempo = setTimeout(salvarAgora, 4000);
      } finally { salvando = null; }
    })();
    await salvando;
  }
  function agendar() {
    estado.textContent = 'Salvando…'; estado.className = 'estado-salvo';
    clearTimeout(tempo);
    tempo = setTimeout(salvarAgora, 1000);
  }
  // Ao sair da tela ou do app, grava na hora.
  const aoSair = () => { if (document.visibilityState === 'hidden' || document.visibilityState === undefined) salvarAgora(); };
  document.addEventListener('visibilitychange', aoSair);
  window.addEventListener('hashchange', () => { document.removeEventListener('visibilitychange', aoSair); salvarAgora(); }, { once: true });

  // O texto da receita mudou: refaz a lista (guardando as escolhas) só se as linhas mudaram.
  let tempoTexto = null;
  function sincronizar() {
    clearTimeout(tempoTexto);
    if (minha !== versaoTela) return;
    const novos = itensDoTexto(pegarTexto(), itens);
    const igual = novos.length === itens.length && novos.every((n, i) => n.descricao === itens[i].descricao);
    if (igual) return;
    itens = novos;
    desenhar();
    agendar();
  }

  desenhar();
  estado.textContent = d.receita.itens.length ? 'Salvo' : '';
  return {
    caixa,
    aoMudarTexto() { clearTimeout(tempoTexto); tempoTexto = setTimeout(sincronizar, 300); },
    salvarAgora: async () => { sincronizar(); await salvarAgora(); },
    semValor: () => semValor().map((it) => it.descricao),
    focarPrimeiroSemValor() {
      const it = semValor()[0];
      if (it && it.campoValor) { it.campoValor.scrollIntoView({ block: 'center' }); it.campoValor.focus(); }
    },
  };
}

// ---------- Receita em colunas (editor padrão) ----------
// Cada remédio é uma linha com campos separados (remédio, dose, como dar, a cada, por quanto tempo),
// e na mesma linha a equipe marca "Temos?", quantidade e valor (só para a equipe, nunca no papel).
// O texto da receita é gerado a partir das linhas (receita-linhas.js); os produtos são as próprias linhas.
const ROTULOS_COLUNAS = { remedio: 'Remédio', dose: 'Dose', como: 'Como dar', intervalo: 'A cada', duracao: 'Duração' };
const EXEMPLOS_COLUNAS = { remedio: 'ex.: Amoxicilina', dose: '250 mg', como: '1 comprimido', intervalo: '12 h', duracao: '7 dias' };
const CAMPOS_ENVIO = [...CAMPOS, 'via', 'comprar']; // o que vai para o servidor em cada remédio
const eViaPropria = (via) => !!String(via ?? '').trim() && !VIAS.includes(String(via).trim()); // "Outro" com nome escrito à mão

// Escreve "Total dos produtos ........ R$ 45,00" (nome à esquerda, valor grande à direita).
function escreverTotal(caixa, centavos) {
  caixa.replaceChildren(el('span', {}, 'Total dos produtos'), el('span', { class: 'valor' }, formatarReais(centavos)));
}

// "d" é a resposta de GET /api/receitas/:id. "aoMudar()" avisa a tela para gravar o texto/linhas.
// Devolve { caixa, linhas(), texto(), salvarAgora(), semValor(), focarPrimeiroSemValor() }.
function editorColunas(d, minha, aoMudar) {
  const id = d.receita.id;
  const itensSalvos = d.receita.itens;
  // Linhas guardadas + a escolha "Temos?" de cada uma (os produtos foram salvos na ordem das linhas preenchidas).
  let n = 0;
  let linhas = (d.receita.linhas ?? []).map((l) => {
    const it = linhaDaReceita(l) ? itensSalvos[n++] : null;
    const base = { ...linhaVazia(), ...l, temos: !!(it && it.temos), qtd: it ? String(it.quantidade) : '1', valor: it && it.temos ? reaisParaCampo(it.valor_unitario_centavos) : '' };
    base.via = String(base.via ?? '').trim() || VIA_PADRAO; // receita antiga: sem via = Uso oral
    base.viaOutro = eViaPropria(base.via);
    return base;
  });
  const novaLinha = () => ({ ...linhaVazia(), temos: false, qtd: '1', valor: '', viaOutro: false });
  if (!linhas.length) linhas = [novaLinha()];

  const lista = el('div', { class: 'remedios-lista', id: 'remedios-lista' });
  const total = el('div', { class: 'produtos-total', id: 'produtos-total' });
  const aviso = el('div', { class: 'aviso-peso produtos-aviso', id: 'produtos-aviso' });
  const estado = el('div', { class: 'estado-salvo', id: 'produtos-estado', role: 'status' });
  const adicionar = el('button', { type: 'button', class: 'adicionar', id: 'adicionar-remedio' }, icone('mais', 20, 2.4), 'Adicionar remédio');
  const caixa = el('section', { class: 'cartao remedios-secao', id: 'remedios-secao' },
    el('h2', {}, 'Remédios'),
    el('p', { class: 'suave' }, 'Um remédio por cartão. "Temos?", Qtd (cobrança) e valor são só para a equipe e não saem no papel.'),
    lista, el('div', { class: 'acoes' }, adicionar), total, aviso, estado);

  const quantidadeDe = (it) => lerQuantidade(it.qtd) ?? 1;
  const valorDe = (it) => { const v = lerReais(it.valor); return v !== null && v <= MAX_VALOR_CENTAVOS ? v : null; };
  const subtotalDe = (it) => (it.temos && valorDe(it) !== null ? quantidadeDe(it) * valorDe(it) : 0);
  const preenchidas = () => linhas.filter((it) => linhaDaReceita(it));
  const semValor = () => preenchidas().filter((it) => it.temos && valorDe(it) === null);
  const descricao = (it) => linhaDaReceita(it, { marcas: false }).slice(0, 300);

  function atualizarRodape() {
    escreverTotal(total, linhas.reduce((t, it) => t + subtotalDe(it), 0));
    const faltam = semValor().length;
    aviso.textContent = faltam === 1 ? "1 produto marcado como 'temos' está sem valor" : `${faltam} produtos marcados como 'temos' estão sem valor`;
    aviso.hidden = faltam === 0;
  }

  // Sugestões do campo Remédio (nomes já usados em receitas liberadas).
  function campoRemedio(it, aoEscolher) {
    const entrada = el('input', { type: 'text', class: 'rem-remedio', 'data-campo': 'remedio', maxlength: 200, autocomplete: 'off', autocapitalize: 'sentences', placeholder: EXEMPLOS_COLUNAS.remedio, 'aria-label': ROTULOS_COLUNAS.remedio, value: it.remedio });
    const chips = el('div', { class: 'chips-sugestao' });
    let tempo = null; let numero = 0;
    entrada.addEventListener('input', () => {
      it.remedio = entrada.value;
      clearTimeout(tempo);
      const q = entrada.value.replace(/\*/g, '').trim();
      if (q.length < 2) { numero += 1; chips.replaceChildren(); return; }
      tempo = setTimeout(async () => {
        const meu = ++numero;
        try {
          const { sugestoes } = await api('GET', '/api/sugestoes-receita?tipo=remedio&q=' + encodeURIComponent(q));
          if (meu !== numero || minha !== versaoTela) return;
          chips.replaceChildren(...sugestoes.slice(0, 5).map((s) => {
            const b = el('button', { type: 'button', class: 'chip-sugestao' }, s.texto);
            b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // não fecha o teclado
            b.addEventListener('click', () => { chips.replaceChildren(); aoEscolher(separarRemedioDose(s.texto)); });
            return b;
          }));
        } catch { chips.replaceChildren(); }
      }, 250);
    });
    entrada.addEventListener('blur', () => setTimeout(() => chips.replaceChildren(), 200));
    return { entrada, chips };
  }

  // "1 · Uso oral": o número conta só os remédios da mesma via (igual ao papel).
  function atualizarPilulas() {
    const contagem = new Map();
    for (const it of linhas) {
      const nome = String(it.via ?? '').trim() || VIA_PADRAO;
      const chave = nome.toLocaleUpperCase('pt-BR');
      const n = (contagem.get(chave) ?? 0) + 1;
      if (linhaDaReceita(it) || String(it.comprar ?? '').trim()) contagem.set(chave, n);
      if (it.pilula) it.pilula.textContent = `${n} · ${nome}`;
    }
  }

  function desenharLinha(it, pos) {
    const subtotal = el('div', { class: 'produto-subtotal' });
    const detalhes = el('div', { class: 'produto-detalhes' });
    const linha = el('div', { class: 'remedio-linha' + (it.temos ? ' sim' : ''), 'data-pos': String(pos) });
    const entradas = {};
    for (const c of ['dose', 'como', 'intervalo', 'duracao']) {
      entradas[c] = el('input', { type: 'text', 'data-campo': c, maxlength: 200, autocomplete: 'off', placeholder: EXEMPLOS_COLUNAS[c], 'aria-label': ROTULOS_COLUNAS[c], value: it[c] });
      entradas[c].addEventListener('input', () => { it[c] = entradas[c].value; mudou(); });
    }
    const rem = campoRemedio(it, ({ remedio, dose }) => {
      it.remedio = remedio; rem.entrada.value = remedio;
      if (dose) { it.dose = dose; entradas.dose.value = dose; }
      mudou();
      (dose ? entradas.como : entradas.dose).focus();
    });
    rem.entrada.addEventListener('input', mudou);

    // Via: lista (Uso oral, Uso injetável…) ou "Outro" com o nome escrito à mão.
    const seletorVia = el('select', { 'data-campo': 'via', 'aria-label': 'Via' },
      VIAS.map((v) => el('option', { value: v }, v)), el('option', { value: 'outro' }, 'Outro…'));
    seletorVia.value = it.viaOutro ? 'outro' : (VIAS.includes(it.via) ? it.via : VIA_PADRAO);
    const viaOutro = el('input', { type: 'text', class: 'via-outro', 'data-campo': 'via-outro', maxlength: 40, autocomplete: 'off', placeholder: 'Qual via? ex.: Banho', 'aria-label': 'Nome da via', value: it.viaOutro ? it.via : '' });
    viaOutro.hidden = !it.viaOutro;
    seletorVia.addEventListener('change', () => {
      it.viaOutro = seletorVia.value === 'outro';
      it.via = it.viaOutro ? viaOutro.value : seletorVia.value;
      viaOutro.hidden = !it.viaOutro;
      if (it.viaOutro) viaOutro.focus();
      mudou();
    });
    viaOutro.addEventListener('input', () => { it.via = viaOutro.value; mudou(); });

    const comprar = el('input', { type: 'text', 'data-campo': 'comprar', maxlength: 30, autocomplete: 'off', placeholder: 'ex.: 1 CX', 'aria-label': 'Comprar (vai no papel)', value: it.comprar ?? '' });
    comprar.addEventListener('input', () => { it.comprar = comprar.value; mudou(); });
    // Enter no último campo da última linha abre uma linha nova (sem precisar tocar no botão).
    comprar.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && pos === linhas.length - 1) { ev.preventDefault(); adicionarLinha(); } });

    const nao = el('button', { type: 'button', class: 'opcao', role: 'radio', 'data-escolha': 'nao' }, 'Não');
    const sim = el('button', { type: 'button', class: 'opcao', role: 'radio', 'data-escolha': 'sim' }, 'Sim');
    const qtd = el('input', { type: 'text', inputmode: 'numeric', class: 'produto-qtd', 'aria-label': 'Qtd (cobrança)', value: it.qtd, maxlength: 3, autocomplete: 'off' });
    const valor = el('input', { type: 'text', inputmode: 'decimal', class: 'produto-valor', 'aria-label': 'Valor (R$)', value: it.valor, placeholder: '0,00', maxlength: 14, autocomplete: 'off' });
    const atualizar = () => {
      nao.setAttribute('aria-checked', String(!it.temos));
      sim.setAttribute('aria-checked', String(it.temos));
      linha.classList.toggle('sim', it.temos);
      detalhes.hidden = !it.temos;
      const q = lerQuantidade(it.qtd); const v = lerReais(it.valor);
      qtd.classList.toggle('invalido', q === null);
      valor.classList.toggle('invalido', it.valor.trim() !== '' && (v === null || v > MAX_VALOR_CENTAVOS));
      subtotal.textContent = valorDe(it) !== null ? `Subtotal: ${formatarReais(subtotalDe(it))}` : '';
      atualizarRodape();
    };
    const mudouProduto = () => { atualizar(); agendar(); };
    nao.addEventListener('click', () => { it.temos = false; mudouProduto(); });
    sim.addEventListener('click', () => { it.temos = true; mudouProduto(); if (valorDe(it) === null) valor.focus(); });
    qtd.addEventListener('input', () => { it.qtd = qtd.value; mudouProduto(); });
    valor.addEventListener('input', () => { it.valor = valor.value; mudouProduto(); });
    detalhes.append(
      el('div', { class: 'titulo-valor' }, 'Valor (só equipe)'),
      el('label', { class: 'produto-campo' }, 'Qtd (cobrança)', qtd),
      el('label', { class: 'produto-campo' }, 'Valor (R$)', valor),
      subtotal);
    it.campoValor = valor;
    it.campoRemedio = rem.entrada;
    it.pilula = el('span', { class: 'pilula-via' });

    const remover = el('button', { type: 'button', class: 'remover-remedio', 'aria-label': `Remover remédio ${pos + 1}`, onclick: () => {
      linhas.splice(pos, 1);
      if (!linhas.length) linhas.push(novaLinha());
      desenhar(); mudou();
    } }, icone('fechar', 18));
    const campoRot = (c, entrada, classe = '') => el('label', { class: 'rem-campo ' + classe }, ROTULOS_COLUNAS[c], entrada);
    linha.append(
      el('div', { class: 'rem-topo' }, it.pilula, remover),
      el('div', { class: 'rem-grade' },
        el('div', { class: 'rem-campo rem-remedio' }, el('label', {}, ROTULOS_COLUNAS.remedio, rem.entrada), rem.chips),
        campoRot('dose', entradas.dose), campoRot('como', entradas.como, 'rem-como'), campoRot('intervalo', entradas.intervalo), campoRot('duracao', entradas.duracao),
        el('label', { class: 'rem-campo rem-via' }, 'Via', seletorVia, viaOutro)),
      el('div', { class: 'rem-pe' },
        el('label', { class: 'rem-campo rem-comprar' }, 'Comprar (vai no papel)', comprar),
        el('div', { class: 'rem-temos' },
          el('span', { class: 'rotulo-mini' }, 'Temos?'),
          el('div', { class: 'grupo-opcoes dois', role: 'radiogroup', 'aria-label': `Temos o remédio ${pos + 1}?` }, nao, sim)),
        detalhes));
    atualizar();
    return linha;
  }

  function desenhar() {
    lista.replaceChildren(...linhas.map(desenharLinha));
    atualizarPilulas();
    atualizarRodape();
    total.hidden = false;
  }
  function adicionarLinha() {
    linhas.push(novaLinha());
    desenhar();
    linhas[linhas.length - 1].campoRemedio.focus();
    linhas[linhas.length - 1].campoRemedio.scrollIntoView({ block: 'center' });
  }
  adicionar.addEventListener('click', adicionarLinha);

  // ----- salvar os produtos (1 s depois da última mudança); o texto e as linhas a tela grava -----
  const corpoItens = () => ({ itens: preenchidas().map((it) => ({
    descricao: descricao(it), temos: it.temos, quantidade: it.temos ? quantidadeDe(it) : 1, valor_unitario_centavos: it.temos ? valorDe(it) : null,
  })) });
  let ultimoEnvio = JSON.stringify(corpoItens());
  let tempo = null; let salvando = null; let bloqueado = false;
  async function salvarAgora() {
    clearTimeout(tempo);
    if (salvando) await salvando;
    const envio = corpoItens(); const txt = JSON.stringify(envio);
    if (txt === ultimoEnvio || bloqueado) return;
    estado.textContent = 'Salvando…'; estado.className = 'estado-salvo';
    salvando = (async () => {
      try {
        await api('PUT', `/api/receitas/${id}/itens`, envio);
        ultimoEnvio = txt;
        estado.textContent = 'Salvo';
      } catch (e) {
        if (e.status === 409 || e.status === 403) { bloqueado = true; estado.textContent = 'Não salvo'; estado.className = 'estado-salvo erro'; return; }
        estado.textContent = 'Não salvo — tentando de novo…'; estado.className = 'estado-salvo erro';
        tempo = setTimeout(salvarAgora, 4000);
      } finally { salvando = null; }
    })();
    await salvando;
  }
  function agendar() {
    estado.textContent = 'Salvando…'; estado.className = 'estado-salvo';
    clearTimeout(tempo);
    tempo = setTimeout(salvarAgora, 1000);
  }
  function mudou() { atualizarPilulas(); atualizarRodape(); agendar(); aoMudar(); }
  const aoSair = () => { if (document.visibilityState === 'hidden') salvarAgora(); };
  document.addEventListener('visibilitychange', aoSair);
  window.addEventListener('hashchange', () => { document.removeEventListener('visibilitychange', aoSair); salvarAgora(); }, { once: true });

  desenhar();
  estado.textContent = itensSalvos.length ? 'Salvo' : '';
  return {
    caixa,
    linhas: () => linhas.map((it) => Object.fromEntries(CAMPOS_ENVIO.map((c) => [c, String(it[c] ?? '')]))),
    texto: () => textoDasLinhas(linhas),
    aoMudarTexto() {},
    salvarAgora,
    parar() { bloqueado = true; clearTimeout(tempo); },
    semValor: () => semValor().map(descricao),
    focarPrimeiroSemValor() {
      const it = semValor()[0];
      if (it && it.campoValor) { it.campoValor.scrollIntoView({ block: 'center' }); it.campoValor.focus(); }
    },
  };
}

// Pergunta, uma vez por tentativa de liberar, o que fazer com produtos sem valor.
// Devolve 'valor' (voltar e digitar) ou 'liberar' (seguir mesmo assim). Esc = voltar.
function dialogoSemValor(descricoes) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'confirmacao', id: 'dialogo-sem-valor' },
      el('h2', {}, 'Produto sem valor'),
      el('p', {}, 'Estes produtos estão sem valor:'),
      el('ul', { class: 'lista-sem-valor' }, descricoes.map((t) => el('li', {}, t))),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', id: 'sem-valor-colocar' }, 'Colocar valor agora'),
        el('button', { type: 'button', class: 'secundario', id: 'sem-valor-liberar' }, 'Liberar mesmo assim')));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('#sem-valor-colocar').addEventListener('click', () => fechar('valor'));
    d.querySelector('#sem-valor-liberar').addEventListener('click', () => fechar('liberar'));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar('valor'); });
    document.body.append(d);
    d.showModal();
  });
}

async function telaReceita(id, consulta = '') {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/receitas/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e); return; }
  if (minha !== versaoTela) return;
  if (d.receita.status !== 'rascunho') { telaReceitaLeitura(d, minha); return; }
  const r = d.receita;
  const ehVet = usuario.papel === 'veterinario';
  // Padrão: remédios em colunas. Receita antiga (só texto) ou "Colar texto do WhatsApp": texto livre.
  const modoColunas = new URLSearchParams(consulta).get('modo') !== 'texto' && (r.linhas !== null || !r.texto.trim());
  const colunas = modoColunas ? editorColunas(d, minha, () => agendar()) : null;
  // Quando um colega pediu esta receita, o botão principal envia para ele em um toque.
  const pediu = r.solicitada_por_usuario && r.solicitada_por_usuario.id !== usuario.id ? r.solicitada_por_usuario : null;

  const texto = el('textarea', { id: 'receita-texto', class: 'receita-texto', rows: 10, placeholder: 'Escreva ou cole aqui o texto do WhatsApp', 'aria-label': 'Receita', maxlength: 10000, autocomplete: 'off', autocapitalize: 'sentences' }, r.texto);
  const orient = el('textarea', { id: 'receita-orientacoes', class: 'receita-orient', rows: 4, maxlength: 5000, 'aria-label': 'Orientações', placeholder: 'Cuidados para o tutor (alimentação, repouso, retorno…)' }, r.orientacoes || '');
  const estado = el('div', { class: 'estado-salvo', role: 'status' }, 'Salvo');
  const sugestoes = el('div', { class: 'chips-sugestao', 'aria-label': 'Sugestões' });
  const avisos = el('div');
  const blocoOrient = el('details', { class: 'orientacoes-bloco', open: !!r.orientacoes }, el('summary', {}, 'Orientações (opcional)'), orient);

  // ----- crescer sozinho -----
  const crescer = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };

  // ----- salvar sozinho (1,5 s depois de parar de digitar) -----
  // O que vai para o servidor: em colunas, o texto é gerado das linhas e as linhas vão junto.
  const envioAtual = () => (modoColunas
    ? { texto: colunas.texto(), linhas_json: colunas.linhas(), orientacoes: orient.value }
    : { texto: texto.value, orientacoes: orient.value });
  let salvo = JSON.stringify(envioAtual());
  let tempoSalvar = null;
  let salvando = null; // promessa do salvamento em andamento
  let bloqueada = false; // true depois que a receita sai do rascunho
  const mudou = () => JSON.stringify(envioAtual()) !== salvo;
  async function salvarAgora() {
    clearTimeout(tempoSalvar);
    if (salvando) { await salvando; }
    if (!mudou() || bloqueada) return;
    const envio = envioAtual();
    const txtEnvio = JSON.stringify(envio);
    estado.textContent = 'Salvando…';
    estado.className = 'estado-salvo';
    salvando = (async () => {
      try {
        await api('PATCH', `/api/receitas/${id}`, envio);
        salvo = txtEnvio;
        estado.textContent = mudou() ? 'Salvando…' : 'Salvo';
      } catch (e) {
        if (e.status === 409) { bloqueada = true; estado.textContent = 'Não salvo'; avisos.replaceChildren(caixaMensagem('erro', e.message)); return; }
        estado.textContent = 'Não salvo — tentando de novo…';
        estado.className = 'estado-salvo erro';
        tempoSalvar = setTimeout(salvarAgora, 4000);
        return;
      } finally { salvando = null; }
      if (mudou()) tempoSalvar = setTimeout(salvarAgora, 1500);
    })();
    await salvando;
  }
  const agendar = () => {
    estado.textContent = 'Salvando…';
    estado.className = 'estado-salvo';
    clearTimeout(tempoSalvar);
    tempoSalvar = setTimeout(salvarAgora, 1500);
  };
  // Ao sair do app (ex.: abrir o WhatsApp) grava na hora.
  const aoEsconder = () => { if (minha !== versaoTela) { document.removeEventListener('visibilitychange', aoEsconder); return; } if (document.visibilityState === 'hidden') salvarAgora(); };
  document.addEventListener('visibilitychange', aoEsconder);

  // ----- sugestões da linha atual -----
  let tempoSug = null; let numeroSug = 0;
  function linhaAtual() {
    const pos = texto.selectionStart;
    const ate = texto.value.slice(0, pos);
    const ini = ate.lastIndexOf('\n') + 1;
    let fim = texto.value.indexOf('\n', pos);
    if (fim === -1) fim = texto.value.length;
    return { ini, fim, linha: ate.slice(ini).trim() };
  }
  function atualizarSugestoes() {
    clearTimeout(tempoSug);
    const { linha } = linhaAtual();
    if (linha.replace(/\*/g, '').length < 2) { numeroSug += 1; sugestoes.replaceChildren(); return; }
    tempoSug = setTimeout(async () => {
      const meu = ++numeroSug;
      try {
        const { sugestoes: lista } = await api('GET', '/api/sugestoes-receita?q=' + encodeURIComponent(linha));
        if (meu !== numeroSug || minha !== versaoTela) return;
        sugestoes.replaceChildren(...lista.slice(0, 5).map((s) => {
          const b = el('button', { type: 'button', class: 'chip-sugestao' }, s.texto);
          b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // não fecha o teclado
          b.addEventListener('click', () => {
            const { ini, fim } = linhaAtual();
            texto.setRangeText(s.texto + '\n', ini, fim < texto.value.length ? fim + 1 : fim, 'end');
            if (!texto.value.slice(0, texto.selectionStart).endsWith('\n')) texto.setRangeText('\n', texto.selectionStart, texto.selectionStart, 'end');
            sugestoes.replaceChildren();
            texto.focus();
            crescer(texto); agendar(); produtos.aoMudarTexto();
          });
          return b;
        }));
      } catch { sugestoes.replaceChildren(); }
    }, 250);
  }

  const produtos = colunas || secaoProdutos(d, () => texto.value, minha);
  texto.addEventListener('input', () => {
    if (/[​-‍⁠﻿\r]/.test(texto.value)) { // texto colado do WhatsApp pode trazer caracteres invisíveis
      const pos = limparInvisiveis(texto.value.slice(0, texto.selectionStart)).length;
      texto.value = limparInvisiveis(texto.value);
      texto.setSelectionRange(pos, pos);
    }
    crescer(texto); agendar(); atualizarSugestoes(); produtos.aoMudarTexto();
  });
  texto.addEventListener('click', atualizarSugestoes);
  texto.addEventListener('keyup', (ev) => { if (ev.key.startsWith('Arrow')) atualizarSugestoes(); });
  orient.addEventListener('input', () => { crescer(orient); agendar(); });
  blocoOrient.addEventListener('toggle', () => crescer(orient));

  const modelo = el('button', { type: 'button', class: 'secundario', id: 'modelo-linha', onclick: () => {
    const v = texto.value;
    texto.setRangeText((v && !v.endsWith('\n') ? '\n' : '') + MODELO_LINHA, v.length, v.length, 'end');
    texto.focus(); crescer(texto); agendar(); produtos.aoMudarTexto();
  } }, '+ Modelo de linha');

  // ----- botões -----
  const comAviso = (botao, funcao) => async () => {
    avisos.replaceChildren();
    botao.disabled = true;
    try { await funcao(); } catch (e) { avisos.replaceChildren(caixaMensagem('erro', e.message)); }
    botao.disabled = false;
  };

  // Antes de liberar: grava tudo, confere o texto e avisa (uma vez) sobre produtos sem valor.
  // Devolve false se a pessoa voltou para corrigir.
  async function prepararLiberacao() {
    await salvarAgora();
    await produtos.salvarAgora();
    if (!(colunas ? colunas.texto() : texto.value).trim()) throw new Error('Escreva a receita antes de liberar.');
    const faltam = produtos.semValor();
    if (faltam.length && (await dialogoSemValor(faltam)) === 'valor') { produtos.focarPrimeiroSemValor(); return false; }
    return true;
  }
  // "Assinada por Dra. Elizabeth — CRMV …" (o CRMV vem da lista de veterinários; a sessão não o carrega).
  async function textoAssinatura() {
    const eu = (await api('GET', '/api/usuarios/veterinarios')).veterinarios.find((v) => v.id === usuario.id);
    const crmv = eu && eu.crmv ? rotuloCrmv(eu.crmv) : 'sem CRMV cadastrado (peça ao administrador)';
    return `Assinada por ${comTratamento(usuario.nome)} — ${crmv}.`;
  }

  const liberarSo = async () => {
    if (!(await prepararLiberacao())) return;
    const assinatura = await textoAssinatura();
    if (!(await confirmar(`Liberar a receita de ${d.pet.nome}?`, [assinatura, 'Depois de liberada não pode ser editada.'], 'Sim, liberar'))) return;
    const nova = await api('POST', `/api/receitas/${id}/liberar`, {});
    bloqueada = true;
    if (colunas) colunas.parar();
    telaReceitaLeitura(nova, minha, 'Receita liberada. A recepção foi avisada para imprimir.');
  };

  // Um toque: grava, libera para a impressão e abre o WhatsApp de quem pediu.
  const enviarColega = async () => {
    if (!(await prepararLiberacao())) return;
    const assinatura = await textoAssinatura();
    const nomeColega = comTratamento(pediu.nome);
    if (!(await confirmar(`Enviar a receita de ${d.pet.nome}?`, [assinatura, `Vai para a impressão e abre o WhatsApp de ${nomeColega}. Depois de enviada não pode ser editada.`], 'Enviar', 'Voltar'))) return;
    const nova = await api('POST', `/api/receitas/${id}/liberar`, {});
    bloqueada = true;
    if (colunas) colunas.parar();
    telaReceitaLeitura(nova, minha, `Receita liberada e enviada para a impressão. Abrindo o WhatsApp de ${nomeColega}…`);
    const msg = `Pronto, ${pediu.nome}! A receita do *${d.pet.nome}* já foi para a impressão na recepção: ${location.origin}/#/receita/${id}`;
    location.href = linkWhatsapp(pediu, msg); // jeito que funciona no iPhone, inclusive no app instalado
  };

  const liberar = el('button', { type: 'button', class: 'principal', id: pediu ? 'enviar-colega' : 'liberar' },
    el('span', { class: 'titulo' }, pediu ? `Enviar para ${comTratamento(pediu.nome)}` : 'Liberar para impressão'),
    el('span', { class: 'subtitulo' }, pediu ? 'Vai para a impressão e abre o WhatsApp dele' : 'A recepção é avisada para imprimir'));
  liberar.addEventListener('click', comAviso(liberar, pediu ? enviarColega : liberarSo));
  const soLiberar = pediu ? el('button', { type: 'button', class: 'secundario largo', id: 'so-liberar' }, 'Só liberar para impressão') : null;
  if (soLiberar) soLiberar.addEventListener('click', comAviso(soLiberar, liberarSo));

  const pedir = el('button', { type: 'button', class: 'secundario largo', id: 'pedir' }, 'Pedir para um colega escrever (WhatsApp)');
  pedir.addEventListener('click', comAviso(pedir, async () => {
    await salvarAgora();
    await produtos.salvarAgora();
    const { veterinarios } = await api('GET', '/api/usuarios/veterinarios');
    const outros = veterinarios.filter((v) => v.id !== usuario.id);
    if (!outros.length) throw new Error('Não há outro veterinário ativo cadastrado.');
    await dialogoPedirReceita(outros, async (vet, nota, acao) => {
      const novo = await api('POST', `/api/receitas/${id}/pedir`, { para_usuario_id: vet.id, nota });
      if (acao === 'copiar') {
        const ok = await copiarTexto(`${location.origin}/#/receita/${id}`);
        avisos.replaceChildren(caixaMensagem(ok ? 'ok' : 'erro', ok ? `Link copiado. Pedido registrado para ${vet.nome}.` : 'Não foi possível copiar. Pedido registrado; envie o link manualmente.'));
        return;
      }
      avisos.replaceChildren(caixaMensagem('ok', `Pedido registrado para ${vet.nome}. Abrindo o WhatsApp…`));
      location.href = linkWhatsapp(vet, mensagemPedido(novo, vet, nota)); // jeito que funciona no iPhone, inclusive no app instalado
    });
  }));

  // Alternar entre colunas e texto livre ("Colar texto do WhatsApp").
  const alternarModo = el('button', { type: 'button', class: 'secundario', id: colunas ? 'modo-texto' : 'modo-colunas' }, colunas ? 'Colar do WhatsApp' : 'Usar colunas');
  alternarModo.addEventListener('click', comAviso(alternarModo, async () => {
    if (colunas) {
      // O texto já está gerado: grava tudo e solta as colunas (a receita passa a ser só texto).
      await salvarAgora();
      await colunas.salvarAgora();
      await api('PATCH', `/api/receitas/${id}`, { texto: colunas.texto(), linhas_json: null });
      irPara(`#/receita/${id}?modo=texto`);
    } else {
      if (texto.value.trim()) throw new Error('As colunas só podem ser usadas em uma receita vazia. Apague o texto antes.');
      await salvarAgora();
      irPara(`#/receita/${id}`);
    }
  }));

  const previa = el('button', { type: 'button', class: 'secundario', id: 'ver-previa' }, 'Ver como sai');
  previa.addEventListener('click', comAviso(previa, async () => { await salvarAgora(); await produtos.salvarAgora(); irPara(`#/receita/${id}/imprimir`); }));

  const cancelar = el('button', { type: 'button', class: 'perigo largo', id: 'cancelar-receita' }, 'Cancelar receita');
  cancelar.addEventListener('click', comAviso(cancelar, async () => {
    if (!(await confirmar('Cancelar esta receita?', 'O rascunho será descartado.', 'Sim, cancelar receita'))) return;
    bloqueada = true;
    clearTimeout(tempoSalvar);
    await produtos.salvarAgora();
    await api('POST', `/api/receitas/${id}/cancelar`, {});
    irPara(`#/pet/${d.pet.id}`);
  }));

  mostrar(
    cabecalho(),
    botaoVoltar(async () => { await salvarAgora(); await produtos.salvarAgora(); irPara(`#/pet/${d.pet.id}`); }, 'Ficha do pet'),
    el('h1', { class: 'titulo-receita' }, `Receita de ${d.pet.nome}`),
    estado,
    cabecaReceita(d),
    r.solicitada_por_nome && r.solicitada_a === usuario.id
      ? el('div', { class: 'pedido-banner' }, icone('conversa', 20),
        el('span', {}, el('strong', {}, `${comTratamento(r.solicitada_por_nome)} pediu esta receita${r.nota_pedido ? ':' : ' para você.'}`), r.nota_pedido ? ' ' + r.nota_pedido : '')) : null,
    r.solicitada_a_nome && r.solicitada_a !== usuario.id ? el('div', { class: 'pedido-banner simples' }, `Pedida a ${r.solicitada_a_nome}${r.nota_pedido ? ' — ' + r.nota_pedido : ''}.`) : null,
    r.versao > 1 ? el('div', { class: 'suave' }, 'Esta é uma nova versão: ao liberar, a versão anterior é cancelada.') : null,
    colunas ? null : el('label', { for: 'receita-texto', class: 'rotulo-receita' }, 'Receita'),
    colunas ? null : texto, colunas ? null : sugestoes,
    colunas ? null : el('div', { class: 'acoes' }, modelo),
    colunas ? colunas.caixa : null,
    blocoOrient,
    colunas ? null : produtos.caixa,
    avisos,
    el('div', { class: 'botoes-receita' },
      ehVet ? [liberar, soLiberar] : el('p', { class: 'suave' }, 'Só o veterinário libera a receita. Envie para o veterinário liberar.'),
      previa, alternarModo,
      pediu && ehVet ? null : pedir, cancelar));
  if (colunas) raiz.classList.add('colunas');
  crescer(orient);
  if (!colunas) {
    crescer(texto);
    texto.focus();
    texto.setSelectionRange(texto.value.length, texto.value.length);
  }
}

// Receita já liberada (ou impressa/entregue/cancelada): só leitura.
function telaReceitaLeitura(d, minha, mensagem = null) {
  if (minha !== versaoTela) return;
  const r = d.receita;
  const podeCorrigir = PODE_ATENDER.includes(usuario.papel) && ['liberada', 'impressa', 'entregue'].includes(r.status);
  const area = el('div');
  const botoes = [];
  const produtos = r.status === 'cancelada' ? null : secaoProdutos(d, () => r.texto, minha);
  if (['liberada', 'impressa', 'entregue'].includes(r.status)) {
    botoes.push(el('button', { type: 'button', class: 'grande bloco', id: 'ir-imprimir', onclick: () => irPara(`#/receita/${r.id}/imprimir`) }, 'Imprimir'));
  }
  if (podeCorrigir) {
    const b = el('button', { type: 'button', class: 'secundario bloco', id: 'nova-versao' }, 'Nova versão (corrigir)');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { const n = await api('POST', `/api/receitas/${r.id}/nova-versao`, {}); irPara(`#/receita/${n.receita.id}`); } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); b.disabled = false; }
    });
    botoes.push(b);
  }
  if (PODE_ATENDER.includes(usuario.papel) && r.status === 'liberada') {
    const b = el('button', { type: 'button', class: 'perigo bloco', id: 'cancelar-liberada' }, 'Cancelar receita');
    b.addEventListener('click', async () => {
      if (!(await confirmar('Cancelar esta receita?', 'Ela sai da lista para imprimir.', 'Sim, cancelar receita'))) return;
      try { await api('POST', `/api/receitas/${r.id}/cancelar`, {}); irPara(`#/pet/${d.pet.id}`); } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); }
    });
    botoes.push(b);
  }
  mostrar(
    cabecalho(), botaoVoltar(`#/pet/${d.pet.id}`, '← Ficha do pet'),
    mensagem ? caixaMensagem('ok', mensagem) : null,
    cabecaReceita(d),
    d.veterinario ? el('p', { class: 'suave' }, `Assinada por ${comTratamento(d.veterinario.nome)}${d.veterinario.crmv ? ' — ' + rotuloCrmv(d.veterinario.crmv) : ''} · liberada ${formatarDataHora(r.liberada_em)}`) : null,
    r.versao > 1 && d.receita_anterior ? el('p', { class: 'suave' }, `Corrige a versão ${d.receita_anterior.versao}.`) : null,
    r.versao_seguinte && r.status !== 'cancelada' ? el('div', { class: 'mensagem ok' }, 'Existe uma nova versão desta receita.', ' ', el('a', { href: `#/receita/${r.versao_seguinte.id}` }, 'Abrir')) : null,
    el('div', { class: 'cartao' }, el('div', { class: 'folha-corpo' }, ...renderizarReceita(r.texto)),
      r.orientacoes ? el('div', { class: 'folha-orientacoes' }, el('strong', {}, 'Orientações'), el('div', { class: 'folha-corpo' }, ...renderizarReceita(r.orientacoes))) : null),
    produtos ? produtos.caixa : null,
    area, el('div', { class: 'botoes-receita' }, botoes));
}

// ---------- Página de impressão ----------
async function telaImprimirReceita(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/receitas/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e); return; }
  if (minha !== versaoTela) return;
  const r = d.receita;
  const rascunho = r.status === 'rascunho';
  const imprimivel = ['liberada', 'impressa', 'entregue'].includes(r.status);
  let vetPrevia = null;
  if (rascunho && usuario.papel === 'veterinario') {
    try { vetPrevia = (await api('GET', '/api/usuarios/veterinarios')).veterinarios.find((v) => v.id === usuario.id) || { nome: usuario.nome }; } catch { vetPrevia = { nome: usuario.nome }; }
  }
  const area = el('div', { class: 'so-tela' });
  const faltaClinica = !d.clinica.clinica_endereco && !d.clinica.clinica_telefone && !d.clinica.clinica_cidade;
  let estadoAtual = r.status;

  const botoes = el('div', { class: 'acoes so-tela botoes-impressao' });
  function desenharBotoes() {
    botoes.replaceChildren();
    if (imprimivel) {
      botoes.append(el('button', { type: 'button', id: 'imprimir', onclick: perguntarDepois }, 'Imprimir'));
      if (estadoAtual === 'liberada' || estadoAtual === 'impressa') {
        botoes.append(el('button', { type: 'button', class: 'secundario', id: 'marcar-entregue', onclick: entregue }, 'Marcar como entregue'));
      }
    }
    botoes.append(el('button', { type: 'button', class: 'secundario', onclick: () => history.length > 1 ? history.back() : irPara(rascunho ? `#/receita/${id}` : '#/hoje') }, 'Voltar'));
  }
  async function marcar(caminho, ok) {
    area.replaceChildren();
    try {
      const novo = await api('POST', `/api/receitas/${id}/${caminho}`, {});
      estadoAtual = novo.receita.status;
      area.replaceChildren(caixaMensagem('ok', ok));
      desenharBotoes();
    } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); }
  }
  function entregue() { return marcar('entregue', 'Marcada como entregue.'); }
  function perguntarDepois() {
    window.print();
    // No iPhone o diálogo de impressão não "espera"; por isso perguntamos em seguida.
    area.replaceChildren(el('div', { class: 'cartao aviso' },
      el('p', {}, el('strong', {}, 'Saiu certo?')),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', id: 'marcar-impressa', onclick: () => marcar('impressa', 'Marcada como impressa.') }, 'Marcar como impressa'),
        el('button', { type: 'button', class: 'secundario', onclick: () => area.replaceChildren() }, 'Ainda não'))));
  }
  desenharBotoes();

  mostrar(
    cabecalho(),
    rascunho ? el('div', { class: 'mensagem erro so-tela' }, 'Prévia: esta receita ainda não foi liberada, não dá para imprimir.') : null,
    el('div', { class: 'so-tela suave' }, `Receita de ${d.pet.nome}`, ' ', chipReceita(r.status)),
    !rascunho && r.status !== 'cancelada' ? el('p', { class: 'so-tela' }, el('a', { href: `#/receita/${id}`, id: 'ir-produtos' }, 'Produtos e valores (só para a equipe)')) : null,
    faltaClinica && usuario.admin ? el('p', { class: 'so-tela aviso-peso' }, 'Faltam endereço, telefone e cidade da clínica no papel. ', el('a', { href: '#/usuarios' }, 'Preencher Dados da clínica')) : null,
    botoes, area,
    montarFolha(dadosDaFolha(d, vetPrevia)));
  raiz.classList.add('impressao');
}

// ---------- Lista "Para imprimir" ----------
function cartaoParaImprimir(x) {
  return el('div', { class: 'item-imprimir' },
    el('div', { class: 'item-info' },
      el('strong', {}, x.pet.nome, x.status === 'impressa' ? el('span', { class: 'etiqueta st-impressa' }, 'Impressa') : null, x.versao > 1 ? el('span', { class: 'etiqueta' }, `Versão ${x.versao}`) : null),
      el('span', { class: 'detalhe' }, `Receita${x.veterinario ? ' · ' + comTratamento(x.veterinario.nome) : ''} · ${formatarHora(x.liberada_em)}`),
      el('span', { class: 'detalhe' }, `Tutor: ${x.tutor.nome}`),
      x.previa ? el('span', { class: 'receita-previa' }, x.previa) : null),
    el('button', { type: 'button', class: 'abrir-imprimir', onclick: () => irPara(`#/receita/${x.id}/imprimir`) }, 'Imprimir'));
}

async function telaReceitasImprimir() {
  const minha = versaoTela;
  const lista = el('div', { class: 'carregando' }, 'Carregando…');
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Para imprimir'),
    el('button', { type: 'button', class: 'secundario bloco', id: 'colar-receita', onclick: () => irPara('#/receitas/transcrever') }, 'Colar receita do WhatsApp'),
    el('div', { class: 'secao-lateral' }, lista));
  async function atualizar() {
    if (minha !== versaoTela) return;
    try {
      const { receitas } = await api('GET', '/api/receitas?status=para_imprimir');
      if (minha !== versaoTela) return;
      lista.className = 'lista-imprimir';
      lista.replaceChildren(...(receitas.length ? receitas.map(cartaoParaImprimir) : [el('p', { class: 'suave' }, 'Nenhuma receita para imprimir agora.')]));
    } catch (e) { if (minha === versaoTela) { lista.className = ''; lista.replaceChildren(caixaMensagem('erro', e.message)); } }
  }
  const t = setInterval(() => { if (minha !== versaoTela) { clearInterval(t); return; } if (document.visibilityState === 'visible') atualizar(); }, 20000);
  atualizar();
}

// ---------- Colar receita do WhatsApp (transcrição) ----------
async function telaTranscrever(consulta) {
  const minha = versaoTela;
  const qs = new URLSearchParams(consulta);
  const petId = Number(qs.get('pet')) || null;
  const atendId = Number(qs.get('atendimento')) || null;
  const voltarPara = petId ? `#/pet/${petId}` : '#/receitas/imprimir';
  if (!petId) { telaEscolherPetReceita(); return; }
  carregando();
  let ficha; let vets; let clinica;
  try {
    [ficha, vets, clinica] = await Promise.all([api('GET', `/api/pets/${petId}`), api('GET', '/api/usuarios/veterinarios'), api('GET', '/api/configuracoes/clinica')]);
  } catch (e) { if (minha === versaoTela) telaErro(e, voltarPara); return; }
  if (minha !== versaoTela) return;
  const { pet, tutor } = ficha;
  const ultimo = ficha.atendimentos.find((a) => !a.sem_peso);
  const vetsOk = vets.veterinarios;

  const seletor = el('select', { id: 'transc-vet' }, el('option', { value: '' }, 'Escolha o veterinário…'), vetsOk.map((v) => el('option', { value: String(v.id) }, v.nome)));
  const texto = el('textarea', { id: 'transc-texto', class: 'receita-texto', rows: 10, placeholder: 'Cole aqui o texto da receita', 'aria-label': 'Cole aqui o texto da receita', maxlength: 10000 });
  const orient = el('textarea', { id: 'transc-orientacoes', class: 'receita-orient', rows: 3, maxlength: 5000, 'aria-label': 'Orientações' });
  const previa = el('div', { class: 'previa-folha' });
  const area = el('div');
  const botao = el('button', { type: 'button', class: 'grande bloco', id: 'gerar-documento' }, 'Gerar documento');
  const crescer = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };

  function desenharPrevia() {
    const vet = vetsOk.find((v) => String(v.id) === seletor.value);
    previa.replaceChildren(montarFolha({
      clinica, pet: { nome: pet.nome, especie: pet.especie, raca: pet.raca, sexo: pet.sexo, idade_anos: pet.idade_anos, idade_meses: pet.idade_meses, peso_kg: ultimo ? ultimo.peso_kg : null },
      tutor: tutor.nome, vet: vet ? { nome: vet.nome, crmv: vet.crmv } : null, linhas: null, texto: texto.value, orientacoes: orient.value.trim(), data: null, segundaVia: false,
    }));
  }
  const aoDigitar = (t) => () => {
    if (/[​-‍⁠﻿\r]/.test(t.value)) t.value = limparInvisiveis(t.value);
    crescer(t); desenharPrevia();
  };
  texto.addEventListener('input', aoDigitar(texto));
  orient.addEventListener('input', aoDigitar(orient));
  seletor.addEventListener('change', desenharPrevia);

  botao.addEventListener('click', async () => {
    area.replaceChildren();
    if (!seletor.value) { area.replaceChildren(caixaMensagem('erro', 'Escolha o veterinário que receitou.')); return; }
    if (!texto.value.trim()) { area.replaceChildren(caixaMensagem('erro', 'Cole o texto da receita.')); return; }
    botao.disabled = true;
    try {
      const novo = await api('POST', '/api/receitas/transcrever', {
        pet_id: pet.id, atendimento_id: atendId || undefined, veterinario_id: Number(seletor.value), texto: texto.value, orientacoes: orient.value,
      });
      irPara(`#/receita/${novo.receita.id}/imprimir`);
    } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); botao.disabled = false; }
  });

  mostrar(
    cabecalho(), botaoVoltar(voltarPara),
    el('h1', {}, 'Colar receita do WhatsApp'),
    el('div', { class: 'cartao cabeca-receita' }, el('div', { class: 'atend-nome' }, pet.nome),
      el('div', { class: 'suave' }, [ROTULO_ESPECIE[pet.especie] || pet.especie, idadeCurta(pet)].filter(Boolean).join(' · ')),
      el('div', { class: 'suave' }, `Tutor: ${tutor.nome}`),
      atendId ? el('div', { class: 'suave' }, 'Ligada ao atendimento de hoje.') : null),
    el('label', { for: 'transc-vet' }, 'Veterinário que receitou'), seletor,
    el('label', { for: 'transc-texto', class: 'rotulo-receita' }, 'Cole aqui o texto da receita'), texto,
    el('details', { class: 'orientacoes-bloco' }, el('summary', {}, 'Orientações (opcional)'), orient),
    el('h2', {}, 'Como vai sair'), previa, area, botao);
  desenharPrevia();
  texto.focus();
}

// Sem pet escolhido ainda: busca e toque.
function telaEscolherPetReceita() {
  const campoBusca = el('input', { id: 'q', type: 'search', class: 'busca-grande', placeholder: 'Nome do pet, do tutor ou telefone', autocomplete: 'off', 'aria-label': 'Buscar o paciente' });
  const area = el('div', { id: 'resultados' });
  mostrar(cabecalho(), botaoVoltar('#/receitas/imprimir'), el('h1', {}, 'Colar receita do WhatsApp'), el('p', { class: 'suave' }, 'Primeiro, escolha o paciente.'), campoBusca, area);
  let tempo = null; let numero = 0;
  async function buscarAgora() {
    const q = campoBusca.value.trim();
    const meu = ++numero;
    if (q.length < 2) { area.replaceChildren(); return; }
    try {
      const { resultados } = await api('GET', '/api/busca?q=' + encodeURIComponent(q));
      if (meu !== numero) return;
      const pets = resultados.filter((r) => r.tipo === 'pet');
      area.replaceChildren(...(pets.length
        ? pets.map((r) => el('button', { type: 'button', class: 'resultado', onclick: () => irPara(`#/receitas/transcrever?pet=${r.pet.id}`) },
          el('strong', { class: 'resultado-nome' }, r.pet.nome), el('span', {}, ROTULO_ESPECIE[r.pet.especie] || r.pet.especie), el('span', { class: 'suave' }, `Tutor: ${r.tutor.nome}`)))
        : [el('p', { class: 'suave' }, 'Nenhum paciente encontrado.')]));
    } catch (e) { if (meu === numero) area.replaceChildren(caixaMensagem('erro', e.message)); }
  }
  campoBusca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(buscarAgora, 300); });
  campoBusca.focus();
}

// Cria (ou abre o rascunho existente de) uma receita para o atendimento / pet.
async function abrirNovaReceita(corpo) {
  const r = await api('POST', '/api/receitas', corpo);
  irPara(`#/receita/${r.receita.id}`);
}

// Lista de receitas na ficha do pet.
function listaReceitasPet(receitas) {
  if (!receitas.length) return el('p', { class: 'suave' }, 'Nenhuma receita ainda.');
  return el('ul', { class: 'lista-simples' }, receitas.map((x) => el('li', {},
    el('button', { type: 'button', class: 'resultado receita-linha', onclick: () => irPara(`#/receita/${x.id}`) },
      el('div', { class: 'hist-linha' }, chipReceita(x.status), x.versao > 1 ? el('span', { class: 'etiqueta' }, `Versão ${x.versao}`) : null,
        el('span', { class: 'suave' }, formatarDia(x.liberada_em || x.criado_em))),
      x.previa ? el('div', {}, x.previa) : el('div', { class: 'suave' }, '(vazia)'),
      x.total_produtos_centavos > 0 ? el('div', { class: 'atend-produtos' }, `Produtos: ${formatarReais(x.total_produtos_centavos)}`) : null,
      el('div', { class: 'suave' }, [x.veterinario ? comTratamento(x.veterinario) : null, x.transcrita_por ? `transcrita por ${x.transcrita_por}` : null].filter(Boolean).join(' · '))))));
}

// Formulários de Usuários: dados da clínica.
function secaoDadosClinica() {
  const caixa = el('div', { class: 'cartao' }, el('h2', {}, 'Dados da clínica'), el('p', { class: 'carregando' }, 'Carregando…'));
  (async () => {
    try {
      const c = await api('GET', '/api/configuracoes/clinica');
      const form = formulario(async (v) => {
        await api('PATCH', '/api/configuracoes/clinica', { clinica_nome: v.clinica_nome, clinica_endereco: v.clinica_endereco, clinica_telefone: v.clinica_telefone, clinica_cidade: v.clinica_cidade, consulta_hora_corte: v.consulta_hora_corte });
        form.querySelector('.ok-clinica').replaceChildren(caixaMensagem('ok', 'Dados da clínica salvos.'));
        form.querySelector('button[type="submit"]').disabled = false;
      },
        el('p', { class: 'suave' }, 'Aparecem no alto da receita impressa.'),
        campo('Nome da clínica', 'clinica_nome', { required: true, value: c.clinica_nome }),
        campo('Endereço', 'clinica_endereco', { value: c.clinica_endereco, autocomplete: 'off' }),
        campo('Telefone', 'clinica_telefone', { value: c.clinica_telefone, type: 'tel', autocomplete: 'off' }),
        campo('Cidade (aparece na data)', 'clinica_cidade', { value: c.clinica_cidade, autocomplete: 'off' }),
        campo('Consulta: horário em que passa a valer o preço da noite', 'consulta_hora_corte', { type: 'time', value: c.consulta_hora_corte || '18:00' }),
        el('div', { class: 'ok-clinica' }),
        el('button', { type: 'submit' }, 'Salvar dados da clínica'));
      caixa.replaceChildren(el('h2', {}, 'Dados da clínica'), form);
    } catch (e) { caixa.replaceChildren(el('h2', {}, 'Dados da clínica'), caixaMensagem('erro', e.message)); }
  })();
  return caixa;
}


// ---------- Conta do atendimento (itens e pagamento) ----------
const PODE_CANCELAR_CONTA = ['veterinario', 'suporte']; // (administradores também podem)

// Janela para receber um pagamento: forma (3 botões grandes), valor, dinheiro recebido/troco e foto do comprovante.
// "aoConfirmar(corpo)" chama a API; se lançar erro, a mensagem aparece na janela. Devolve true se registrou.
function dialogoPagamento({ restante, pet }) {
  return new Promise((resolve) => {
    let forma = '';
    const area = el('div');
    const valorEntrada = el('input', { id: 'pag-valor', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: reaisParaCampo(restante), class: 'campo-valor' });
    const recebidoEntrada = el('input', { id: 'pag-recebido', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'ex.: 100,00', class: 'campo-valor' });
    const troco = el('p', { class: 'troco', id: 'pag-troco', role: 'status' });
    const blocoDinheiro = el('div', { class: 'bloco-dinheiro', hidden: true }, el('label', { for: 'pag-recebido' }, 'Recebido do cliente (R$)'), recebidoEntrada, troco);
    const foto = campoFoto(null, 'comprovante', 'Foto do comprovante (opcional)');
    const botoesForma = Object.entries(ROTULO_FORMA).map(([chave, rotulo]) => {
      const b = el('button', { type: 'button', class: 'opcao forma-opcao', role: 'radio', 'aria-checked': 'false', 'data-valor': chave }, rotulo);
      b.addEventListener('click', () => {
        forma = chave;
        for (const x of botoesForma) x.setAttribute('aria-checked', String(x === b));
        blocoDinheiro.hidden = forma !== 'dinheiro';
        atualizarTroco();
      });
      return b;
    });
    function atualizarTroco() {
      const valor = lerReais(valorEntrada.value);
      const recebido = lerReais(recebidoEntrada.value);
      troco.className = 'troco';
      if (forma !== 'dinheiro' || recebido === null || valor === null) { troco.textContent = ''; return; }
      const t = trocoDe(valor, recebido);
      if (t === null) { troco.textContent = `Faltam ${formatarReais(valor - recebido)} do cliente`; troco.classList.add('falta'); } else troco.textContent = `Troco: ${formatarReais(t)}`;
    }
    valorEntrada.addEventListener('input', atualizarTroco);
    recebidoEntrada.addEventListener('input', atualizarTroco);
    const ok = el('button', { type: 'button', id: 'pag-confirmar' }, 'Confirmar recebimento');
    const d = el('dialog', { class: 'confirmacao dialogo-rolagem' },
      el('h2', {}, 'Receber pagamento'),
      el('p', { class: 'suave' }, `${pet} · falta receber `, el('strong', {}, formatarReais(restante))),
      el('label', {}, 'Forma de pagamento'),
      el('div', { class: 'grupo-opcoes', role: 'radiogroup', 'aria-label': 'Forma de pagamento' }, botoesForma),
      el('label', { for: 'pag-valor' }, 'Valor deste pagamento (R$)'), valorEntrada,
      blocoDinheiro, foto.caixa, area,
      el('div', { class: 'acoes' }, ok, el('button', { type: 'button', class: 'secundario', id: 'pag-voltar' }, 'Voltar')));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    ok.addEventListener('click', async () => {
      area.replaceChildren();
      ok.disabled = true;
      try {
        if (!forma) throw new Error('Escolha a forma de pagamento: Pix, Cartão ou Dinheiro.');
        const valor = lerReais(valorEntrada.value);
        if (valor === null || valor <= 0) throw new Error('Informe o valor recebido. Exemplo: 50,00');
        if (valor > restante) throw new Error(`O valor é maior que o que falta pagar (${formatarReais(restante)}).`);
        const corpo = { forma, valor_centavos: valor };
        if (forma === 'dinheiro' && recebidoEntrada.value.trim()) {
          const recebido = lerReais(recebidoEntrada.value);
          if (recebido === null) throw new Error('Valor recebido do cliente inválido. Exemplo: 100,00');
          if (recebido < valor) throw new Error('O dinheiro recebido é menor que o valor a pagar.');
          corpo.recebido_dinheiro_centavos = recebido;
        }
        const fotoId = await foto.resolver();
        if (fotoId) corpo.comprovante_foto_id = fotoId;
        fechar(corpo);
      } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); ok.disabled = false; }
    });
    d.querySelector('#pag-voltar').addEventListener('click', () => fechar(null));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(null); });
    document.body.append(d);
    d.showModal();
  });
}

// Janela "Adicionar item": busca no catálogo (com chips de categoria) ou item livre.
// "aoAdicionar(item)" é chamado a cada item; a janela continua aberta até tocar em "Concluir".
function dialogoAdicionarItem(aoAdicionar) {
  return new Promise((resolve) => {
    let categoria = '';
    let tempo = null;
    const aviso = el('div', { 'aria-live': 'polite' });
    const resultados = el('div', { class: 'lista-catalogo' });
    const busca = el('input', { id: 'item-busca', type: 'search', class: 'busca-grande', placeholder: 'Buscar no catálogo', autocomplete: 'off' });
    const chips = ['', ...Object.keys(ROTULO_CATEGORIA)].map((c) => {
      const b = el('button', { type: 'button', class: 'chip-filtro', 'aria-pressed': String(c === categoria), 'data-categoria': c }, c ? ROTULO_CATEGORIA[c] : 'Todos');
      b.addEventListener('click', () => { categoria = c; for (const x of chips) x.setAttribute('aria-pressed', String(x === b)); carregar(); });
      return b;
    });
    async function adicionar(item, descricao) {
      aviso.replaceChildren();
      try { await aoAdicionar(item); aviso.replaceChildren(caixaMensagem('ok', `Adicionado: ${descricao}`)); } catch (e) { aviso.replaceChildren(caixaMensagem('erro', e.message)); }
    }
    async function carregar() {
      try {
        const qs = new URLSearchParams({ q: busca.value.trim(), categoria });
        const { itens } = await api('GET', '/api/catalogo?' + qs);
        resultados.replaceChildren(...(itens.length
          ? itens.map((c) => el('button', { type: 'button', class: 'secundario item-catalogo', onclick: () => adicionar({ catalogo_id: c.id, descricao: c.nome, quantidade: 1, preco_unitario_centavos: c.preco_centavos, origem: 'manual' }, c.nome) },
            el('span', { class: 'item-catalogo-nome' }, c.nome), el('strong', {}, formatarReais(c.preco_centavos))))
          : [el('p', { class: 'suave' }, 'Nada encontrado. Use "Item livre" abaixo ou cadastre em Preços.')]));
      } catch (e) { resultados.replaceChildren(caixaMensagem('erro', e.message)); }
    }
    busca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(carregar, 250); });
    // Item livre
    const livreDescricao = el('input', { id: 'livre-descricao', type: 'text', maxlength: 200, autocomplete: 'off', placeholder: 'ex.: Taxa de urgência' });
    const livreValor = el('input', { id: 'livre-valor', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'ex.: 30,00' });
    const livreQtd = el('input', { id: 'livre-qtd', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: '1' });
    const livreOk = el('button', { type: 'button', id: 'livre-adicionar' }, 'Adicionar item livre');
    livreOk.addEventListener('click', async () => {
      const descricao = livreDescricao.value.trim();
      const valor = lerReais(livreValor.value);
      const qtd = /^\d{1,3}$/.test(livreQtd.value.trim()) ? Number(livreQtd.value.trim()) : 0;
      if (!descricao) { aviso.replaceChildren(caixaMensagem('erro', 'Escreva o nome do item.')); return; }
      if (valor === null || valor > MAX_VALOR_CENTAVOS) { aviso.replaceChildren(caixaMensagem('erro', 'Informe o valor do item. Exemplo: 30,00')); return; }
      if (qtd < 1) { aviso.replaceChildren(caixaMensagem('erro', 'A quantidade deve ser de 1 a 999.')); return; }
      await adicionar({ descricao, quantidade: qtd, preco_unitario_centavos: valor, catalogo_id: null, origem: 'manual' }, descricao);
      livreDescricao.value = ''; livreValor.value = ''; livreQtd.value = '1';
    });
    const d = el('dialog', { class: 'confirmacao dialogo-rolagem dialogo-largo' },
      el('h2', {}, 'Adicionar item'),
      busca, el('div', { class: 'chips-filtro', role: 'group', 'aria-label': 'Categoria' }, chips),
      resultados, aviso,
      el('details', { class: 'item-livre' },
        el('summary', {}, 'Item livre (fora do catálogo)'),
        el('label', { for: 'livre-descricao' }, 'Nome do item'), livreDescricao,
        el('div', { class: 'linha-dupla' },
          el('div', {}, el('label', { for: 'livre-valor' }, 'Valor (R$)'), livreValor),
          el('div', {}, el('label', { for: 'livre-qtd' }, 'Quantidade'), livreQtd)),
        livreOk),
      el('div', { class: 'acoes' }, el('button', { type: 'button', id: 'item-concluir' }, 'Concluir')));
    const fechar = () => { clearTimeout(tempo); d.close(); d.remove(); resolve(); };
    d.querySelector('#item-concluir').addEventListener('click', fechar);
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(); });
    document.body.append(d);
    d.showModal();
    carregar();
  });
}

async function telaConta(atendimentoId, consulta = '') {
  const minha = versaoTela;
  let abrirRecebimento = new URLSearchParams(consulta).get('receber') === '1';
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('p', { class: 'carregando' }, 'Carregando…'));
  let d;
  let itens = [];
  let trocoAviso = null; // "Troco: R$ 50,00" logo depois de receber em dinheiro
  const erro = el('div');
  const corpo = el('div', { class: 'conta-corpo' });
  const copia = (lista) => lista.map((i) => ({ ...i }));
  const aplicar = (r) => { d = r; itens = copia(r.pedido.itens); };
  const paraEnvio = (lista) => lista.map(({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }) => ({ descricao, quantidade, preco_unitario_centavos, catalogo_id, origem }));

  async function salvar(lista) {
    aplicar(await api('PUT', `/api/atendimentos/${atendimentoId}/pedido/itens`, { itens: paraEnvio(lista) }));
    desenhar();
  }
  // Roda uma ação; se falhar, mostra o erro e recarrega a conta (para a tela refletir o que de fato está gravado).
  async function agir(funcao) {
    erro.replaceChildren();
    try { await funcao(); } catch (e) {
      if (minha !== versaoTela) return;
      if (e.status === 401) { usuario = null; telaEntrar(); return; }
      erro.replaceChildren(caixaMensagem('erro', e.message));
      try { aplicar(await api('GET', `/api/atendimentos/${atendimentoId}/pedido`)); desenhar(); } catch { /* mantém o que está na tela */ }
    }
  }
  // O rascunho calculado só vira conta de verdade ao salvar.
  async function garantirSalva() { if (d.pedido.rascunho) await salvar(itens); return d.pedido.id; }

  async function receber() {
    await agir(async () => {
      const id = await garantirSalva();
      const pagamento = await dialogoPagamento({ restante: d.pedido.restante_centavos, pet: d.atendimento.pet.nome });
      if (!pagamento) return;
      const r = await api('POST', `/api/pedidos/${id}/pagamentos`, pagamento);
      trocoAviso = r.troco_centavos > 0 ? `Troco: ${formatarReais(r.troco_centavos)}` : null;
      aplicar(r);
      desenhar();
    });
  }

  function linhaItem(i, editavel) {
    const trocarQtd = (nova) => agir(() => salvar(itens.map((x) => (x === i ? { ...x, quantidade: nova } : x))));
    const editarPreco = () => dialogoCampo({
      titulo: `Valor de ${i.descricao}`, texto: 'Valor de cada unidade.', rotulo: 'Valor (R$)', rotuloOk: 'Salvar valor', inicial: reaisParaCampo(i.preco_unitario_centavos),
      aoConfirmar: async (v) => {
        const c = lerReais(v);
        if (c === null || c > MAX_VALOR_CENTAVOS) throw new Error('Informe o valor. Exemplo: 45,00');
        await salvar(itens.map((x) => (x === i ? { ...x, preco_unitario_centavos: c } : x)));
      },
    });
    return el('li', { class: 'conta-item' },
      el('div', { class: 'conta-item-topo' },
        el('strong', { class: 'conta-item-nome' }, i.descricao, i.origem === 'receita' ? el('span', { class: 'etiqueta' }, 'Receita') : null),
        el('strong', { class: 'subtotal' }, formatarReais(i.quantidade * i.preco_unitario_centavos))),
      i.origem === 'consulta' && d.automaticos.consulta ? el('p', { class: 'conta-explicacao' }, d.automaticos.consulta.explicacao) : null,
      el('div', { class: 'conta-item-linha' },
        editavel
          ? el('div', { class: 'passos' },
            el('button', { type: 'button', class: 'secundario passo', 'aria-label': 'Diminuir quantidade', disabled: i.quantidade <= 1, onclick: () => trocarQtd(i.quantidade - 1) }, '−'),
            el('span', { class: 'qtd', 'aria-label': `Quantidade ${i.quantidade}` }, String(i.quantidade)),
            el('button', { type: 'button', class: 'secundario passo', 'aria-label': 'Aumentar quantidade', disabled: i.quantidade >= 999, onclick: () => trocarQtd(i.quantidade + 1) }, '+'))
          : el('span', { class: 'qtd' }, `${i.quantidade} ×`),
        editavel
          ? el('button', { type: 'button', class: 'secundario preco-item', 'aria-label': `Alterar valor de ${i.descricao}`, onclick: editarPreco }, formatarReais(i.preco_unitario_centavos))
          : el('span', { class: 'preco-item-fixo' }, formatarReais(i.preco_unitario_centavos)),
        editavel ? el('button', { type: 'button', class: 'secundario remover-item', 'aria-label': `Remover ${i.descricao}`, onclick: () => agir(() => salvar(itens.filter((x) => x !== i))) }, icone('fechar', 18, 2.4)) : null));
  }

  function listaPagamentos(p) {
    if (!p.pagamentos.length) return null;
    return el('div', { class: 'cartao conta-pagamentos' }, el('h2', {}, 'Pagamentos'),
      el('ul', { class: 'lista-simples' }, p.pagamentos.map((g) => el('li', { class: 'pagamento-linha' + (g.estornado ? ' estornado' : '') },
        el('div', { class: 'pagamento-info' },
          el('strong', {}, `${ROTULO_FORMA[g.forma] || g.forma} · ${formatarReais(g.valor_centavos)}`, g.estornado ? el('span', { class: 'etiqueta st-cancelada' }, 'Desfeito') : null),
          el('span', { class: 'detalhe' }, `Recebido por ${g.recebido_por.nome} em ${formatarDataHora(g.recebido_em)}`),
          g.forma === 'dinheiro' && g.recebido_dinheiro_centavos != null ? el('span', { class: 'detalhe' }, `Cliente deu ${formatarReais(g.recebido_dinheiro_centavos)} · troco ${formatarReais(g.troco_centavos)}`) : null,
          g.comprovante_foto_id ? el('a', { class: 'detalhe', href: `/api/fotos/${g.comprovante_foto_id}`, target: '_blank', rel: 'noopener' }, 'Ver foto do comprovante') : null,
          g.estornado ? el('span', { class: 'detalhe estorno-motivo' }, `Desfeito por ${g.estornado_por ? g.estornado_por.nome : '—'}: ${g.estorno_motivo || ''}`) : null),
        !g.estornado && usuario.admin
          ? el('button', { type: 'button', class: 'perigo desfazer-pagamento', onclick: () => dialogoCampo({
            titulo: 'Desfazer este pagamento?', texto: `${ROTULO_FORMA[g.forma]} de ${formatarReais(g.valor_centavos)}. Só administradores podem fazer isso. Conte o motivo:`,
            rotulo: 'Motivo', rotuloOk: 'Sim, desfazer pagamento',
            aoConfirmar: async (m) => {
              if (!m.trim()) throw new Error('Preencha o motivo.');
              trocoAviso = null;
              aplicar(await api('POST', `/api/pagamentos/${g.id}/estornar`, { motivo: m.trim() }));
              desenhar();
            },
          }) }, 'Desfazer')
          : null))));
  }

  function desenhar() {
    if (minha !== versaoTela) return;
    const p = d.pedido;
    const at = d.atendimento;
    const editavel = p.pode_editar;
    const e = estadoDaConta(p);
    const vet = PODE_ATENDER.includes(usuario.papel);
    const cartaoPaciente = el('div', { class: 'cartao cartao-paciente conta-paciente' },
      miniatura(at.pet.foto_id, at.pet.nome),
      el('div', { class: 'info' }, el('strong', {}, at.pet.nome), el('span', {}, `Tutor: ${at.tutor.nome}`),
        el('span', {}, `Atendimento: ${ROTULO_STATUS[at.status] || at.status}${at.veterinario_nome ? ' · ' + comTratamento(at.veterinario_nome) : ''}`)),
      el('span', { class: 'pilula-conta ' + e.tipo }, p.rascunho ? 'conta nova' : e.texto));

    const pagoUltimo = [...p.pagamentos].reverse().find((g) => !g.estornado);
    const sucesso = p.status === 'pago'
      ? el('div', { class: 'cartao conta-sucesso', role: 'status' },
        el('div', { class: 'sucesso-titulo' }, icone('check', 28, 3), 'Pago ✓'),
        pagoUltimo ? el('p', {}, `Recebido por ${pagoUltimo.recebido_por.nome} em ${formatarDataHora(p.pago_em || pagoUltimo.recebido_em)}`) : null,
        trocoAviso ? el('p', { class: 'troco-grande' }, trocoAviso) : null)
      : (trocoAviso ? caixaMensagem('ok', trocoAviso) : null);

    const semValor = d.automaticos.sem_valor;
    const avisos = editavel && semValor.length
      ? el('div', { class: 'aviso-peso aviso-sem-valor', role: 'alert' },
        el('strong', {}, 'Produto sem valor na receita (não entrou na conta):'),
        el('ul', {}, semValor.map((x) => el('li', {}, `${x.descricao}${x.quantidade > 1 ? ' (' + x.quantidade + ')' : ''}`))),
        el('span', { class: 'suave' }, 'Coloque o valor na receita ou adicione o item abaixo.'))
      : null;

    const botoes = [];
    if (editavel) {
      const comPagamento = p.pagamentos.some((g) => !g.estornado);
      botoes.push(el('button', { type: 'button', class: 'secundario bloco-botao', id: 'adicionar-item', onclick: async () => { await dialogoAdicionarItem((item) => salvar([...itens, item])); } }, icone('mais', 20, 2.6), 'Adicionar item'));
      if (receitaDesatualizada(itens, d.automaticos)) {
        botoes.push(el('button', { type: 'button', class: 'secundario bloco-botao', id: 'atualizar-receita', onclick: () => agir(() => salvar(atualizarDaReceita(itens, d.automaticos))) }, 'Atualizar da receita'));
      }
      const vazio = p.total_centavos <= 0;
      if (p.status === 'aberto' && vet) {
        botoes.push(el('button', { type: 'button', class: 'grande', id: 'enviar-recepcao', disabled: vazio, onclick: () => agir(async () => {
          const id = await garantirSalva();
          await api('POST', `/api/pedidos/${id}/enviar-recepcao`);
          irPara('#/hoje');
        }) }, 'Enviar para a recepção'));
        botoes.push(el('button', { type: 'button', class: 'secundario bloco-botao', id: 'cobrar-aqui', disabled: vazio, onclick: receber }, 'Cobrar aqui'));
      } else {
        botoes.push(el('button', { type: 'button', class: 'grande', id: 'receber', disabled: vazio, onclick: receber },
          p.pago_centavos > 0 ? `Receber o restante (${formatarReais(p.restante_centavos)})` : (p.status === 'aberto' ? 'Receber pagamento' : `Receber ${formatarReais(p.restante_centavos)}`)));
      }
      if (!p.rascunho && !comPagamento && (vet || usuario.admin)) {
        botoes.push(el('button', { type: 'button', class: 'perigo bloco-botao', id: 'cancelar-conta', onclick: async () => {
          const feito = await dialogoCampo({
            titulo: 'Cancelar esta conta?', texto: 'A conta some da lista de pagamentos. Conte o motivo:', rotulo: 'Motivo do cancelamento', rotuloOk: 'Sim, cancelar conta',
            aoConfirmar: async (m) => {
              if (!m.trim()) throw new Error('Preencha o motivo do cancelamento.');
              await api('POST', `/api/pedidos/${p.id}/cancelar`, { motivo: m.trim() });
            },
          });
          if (feito) irPara('#/hoje');
        } }, 'Cancelar conta'));
      }
    }

    corpo.replaceChildren(...[
      cartaoPaciente, sucesso,
      el('div', { class: 'cartao' },
        el('h2', {}, 'Itens da conta'),
        itens.length ? el('ul', { class: 'conta-itens' }, itens.map((i) => linhaItem(i, editavel))) : el('p', { class: 'suave' }, 'Nenhum item ainda. Toque em "Adicionar item".'),
        avisos,
        el('div', { class: 'conta-total' },
          el('span', {}, 'Total'),
          el('strong', { class: 'total-valor', id: 'conta-total' }, formatarReais(p.total_centavos))),
        p.pago_centavos > 0 && p.status !== 'pago'
          ? el('p', { class: 'conta-parcial-linha' }, `Já pago ${formatarReais(p.pago_centavos)} · falta `, el('strong', {}, formatarReais(p.restante_centavos)))
          : null),
      el('div', { class: 'conta-botoes' }, botoes),
      listaPagamentos(p),
      p.status === 'pago' ? el('button', { type: 'button', class: 'secundario bloco', onclick: () => irPara('#/hoje') }, 'Voltar para Hoje') : null,
    ].filter(Boolean));

    if (abrirRecebimento && editavel) { abrirRecebimento = false; receber(); }
  }

  try {
    aplicar(await api('GET', `/api/atendimentos/${atendimentoId}/pedido`));
  } catch (e) { if (minha === versaoTela) telaErro(e); return; }
  if (minha !== versaoTela) return;
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Conta'), erro, corpo);
  desenhar();
}

// ---------- Preços (catálogo) ----------
const ORDEM_CATEGORIAS = ['consulta', 'exame', 'vacina', 'procedimento', 'produto', 'outro'];

// Janela para criar ou editar um item do catálogo. "item" = null para um novo.
function dialogoItemCatalogo(item, aoSalvar) {
  return new Promise((resolve) => {
    const area = el('div');
    const nome = el('input', { id: 'cat-nome', type: 'text', maxlength: 120, autocomplete: 'off', value: item ? item.nome : '', placeholder: 'ex.: Vacina V10' });
    const preco = el('input', { id: 'cat-preco', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: item ? reaisParaCampo(item.preco_centavos) : '', placeholder: 'ex.: 90,00' });
    const cat = el('select', { id: 'cat-categoria' }, ORDEM_CATEGORIAS.map((c) => el('option', { value: c }, ROTULO_CATEGORIA[c])));
    cat.value = item ? item.categoria : 'produto';
    if (item && item.categoria === 'consulta') cat.disabled = true; // as consultas são usadas pela regra do horário
    const ok = el('button', { type: 'button', id: 'cat-salvar' }, item ? 'Salvar' : 'Criar item');
    const d = el('dialog', { class: 'confirmacao dialogo-rolagem' },
      el('h2', {}, item ? 'Editar item' : 'Novo item'),
      el('label', { for: 'cat-nome' }, 'Nome'), nome,
      el('label', { for: 'cat-categoria' }, 'Categoria'), cat,
      el('label', { for: 'cat-preco' }, 'Preço (R$)'), preco, area,
      el('div', { class: 'acoes' }, ok, el('button', { type: 'button', class: 'secundario', id: 'cat-voltar' }, 'Voltar')));
    const fechar = (v) => { d.close(); d.remove(); resolve(v); };
    ok.addEventListener('click', async () => {
      area.replaceChildren();
      ok.disabled = true;
      try {
        const centavos = lerReais(preco.value);
        if (!nome.value.trim()) throw new Error('Escreva o nome do item.');
        if (centavos === null || centavos > MAX_VALOR_CENTAVOS) throw new Error('Informe o preço. Exemplo: 90,00');
        await aoSalvar({ nome: nome.value.trim(), categoria: cat.value, preco_centavos: centavos });
        fechar(true);
      } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); ok.disabled = false; }
    });
    d.querySelector('#cat-voltar').addEventListener('click', () => fechar(false));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fechar(false); });
    document.body.append(d);
    d.showModal();
    nome.focus();
  });
}

async function telaPrecos() {
  const minha = versaoTela;
  let categoria = '';
  let comInativos = false;
  let tempo = null;
  const lista = el('div', { class: 'carregando' }, 'Carregando…');
  const avisos = el('div');
  const busca = el('input', { id: 'preco-busca', type: 'search', class: 'busca-grande', placeholder: 'Buscar item (ex.: vacina)', autocomplete: 'off' });
  const chips = ['', ...ORDEM_CATEGORIAS].map((c) => {
    const b = el('button', { type: 'button', class: 'chip-filtro', 'aria-pressed': String(c === categoria), 'data-categoria': c }, c ? ROTULO_CATEGORIA[c] : 'Todos');
    b.addEventListener('click', () => { categoria = c; for (const x of chips) x.setAttribute('aria-pressed', String(x === b)); carregar(); });
    return b;
  });
  const inativos = el('input', { type: 'checkbox', id: 'preco-inativos' });
  inativos.addEventListener('change', () => { comInativos = inativos.checked; carregar(); });

  async function carregar() {
    if (minha !== versaoTela) return;
    try {
      const qs = new URLSearchParams({ q: busca.value.trim(), categoria, inativos: comInativos ? '1' : '' });
      const { itens } = await api('GET', '/api/catalogo?' + qs);
      if (minha !== versaoTela) return;
      desenhar(itens);
    } catch (e) { if (minha === versaoTela) { lista.className = ''; lista.replaceChildren(caixaMensagem('erro', e.message)); } }
  }
  function linha(c) {
    return el('div', { class: 'preco-linha' + (c.ativo ? '' : ' inativo') },
      el('div', { class: 'preco-info' },
        el('strong', {}, c.nome, c.ativo ? null : el('span', { class: 'etiqueta inativo' }, 'Desativado')),
        c.categoria === 'consulta' ? el('span', { class: 'detalhe' }, usuario.admin ? 'Usado na conta pelo horário da consulta' : 'Usado na conta pelo horário da consulta · só administradores mudam este valor') : null),
      el('strong', { class: 'preco-valor' }, formatarReais(c.preco_centavos)),
      el('div', { class: 'preco-botoes' },
        // Valor das consultas: só administradores editam (decisão da clínica).
        c.categoria === 'consulta' && !usuario.admin ? null : el('button', { type: 'button', class: 'secundario editar-preco', onclick: async () => {
          if (await dialogoItemCatalogo(c, (v) => api('PATCH', `/api/catalogo/${c.id}`, v))) carregar();
        } }, 'Editar'),
        c.categoria === 'consulta' ? null : el('button', { type: 'button', class: 'secundario', onclick: async () => {
          avisos.replaceChildren();
          try { await api('PATCH', `/api/catalogo/${c.id}`, { ativo: !c.ativo }); carregar(); } catch (e) { avisos.replaceChildren(caixaMensagem('erro', e.message)); }
        } }, c.ativo ? 'Desativar' : 'Ativar')));
  }
  function desenhar(itens) {
    lista.className = 'lista-precos';
    if (!itens.length) { lista.replaceChildren(el('p', { class: 'suave' }, 'Nenhum item encontrado.')); return; }
    lista.replaceChildren(...ORDEM_CATEGORIAS.filter((c) => itens.some((i) => i.categoria === c)).map((c) =>
      el('section', { class: 'cartao grupo-preco', 'aria-label': ROTULO_CATEGORIA[c] },
        el('h2', {}, ROTULO_CATEGORIA[c]),
        itens.filter((i) => i.categoria === c).map(linha))));
  }
  busca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(carregar, 250); });

  mostrar(cabecalho(), botaoVoltar('#/hoje'),
    el('div', { class: 'precos-topo' },
      el('h1', {}, 'Preços'),
      el('button', { type: 'button', class: 'grande', id: 'novo-item', onclick: async () => {
        if (await dialogoItemCatalogo(null, (v) => api('POST', '/api/catalogo', v))) carregar();
      } }, icone('mais', 22, 2.6), 'Novo item')),
    busca, el('div', { class: 'chips-filtro', role: 'group', 'aria-label': 'Categoria' }, chips),
    el('label', { class: 'linha', for: 'preco-inativos' }, inativos, 'Mostrar itens desativados'),
    avisos, lista);
  carregar();
}

// ---------- Caixa de hoje (só administrador) ----------
async function telaCaixa() {
  const minha = versaoTela;
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Caixa de hoje'), el('p', { class: 'carregando' }, 'Carregando…'));
  let c;
  try { c = await api('GET', '/api/caixa/hoje'); } catch (e) { if (minha === versaoTela) telaErro(e); return; }
  if (minha !== versaoTela) return;
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Caixa de hoje'),
    el('p', { class: 'hoje-data' }, dataDeHoje()),
    el('div', { class: 'caixa-total cartao' }, el('span', {}, 'Total recebido hoje'), el('strong', { id: 'caixa-total' }, formatarReais(c.total_centavos)),
      el('span', { class: 'suave' }, `${c.quantidade} ${c.quantidade === 1 ? 'pagamento' : 'pagamentos'}`)),
    el('div', { class: 'caixa-formas' }, Object.entries(ROTULO_FORMA).map(([f, rotulo]) => el('div', { class: 'cartao caixa-forma', 'data-forma': f },
      el('span', { class: 'caixa-forma-nome' }, rotulo), el('strong', {}, formatarReais(c.por_forma[f].total_centavos)),
      el('span', { class: 'suave' }, `${c.por_forma[f].quantidade} ${c.por_forma[f].quantidade === 1 ? 'pagamento' : 'pagamentos'}`)))),
    c.estornados_hoje.quantidade ? el('p', { class: 'suave' }, `Pagamentos desfeitos hoje (não contados): ${c.estornados_hoje.quantidade} · ${formatarReais(c.estornados_hoje.total_centavos)}`) : null,
    el('div', { class: 'cartao' }, el('h2', {}, 'Pagamentos de hoje'),
      c.pagamentos.length
        ? el('ul', { class: 'lista-simples' }, c.pagamentos.map((g) => el('li', { class: 'pagamento-linha' },
          el('div', { class: 'pagamento-info' }, el('strong', {}, `${g.pet} · ${formatarReais(g.valor_centavos)}`),
            el('span', { class: 'detalhe' }, `${ROTULO_FORMA[g.forma]} · ${formatarHora(g.recebido_em)} · recebido por ${g.recebido_por} · tutor ${g.tutor}`)))))
        : el('p', { class: 'suave' }, 'Nenhum pagamento recebido hoje ainda.')));
}

// ---------- roteador ----------
// Tela "Notificações": ativar, testar ou desativar neste aparelho.
async function telaNotificacoes() {
  const minha = versaoTela;
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Notificações'), el('p', { class: 'carregando' }, 'Carregando…'));
  const cartao = await cartaoNotificacoes();
  if (minha !== versaoTela) return;
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Notificações'), cartao,
    el('p', { class: 'suave' }, 'Cada aparelho é ativado separadamente (iPhone, computador da recepção etc.).'));
}

function rotear() {
  versaoTela++;
  if (!usuario) return; // sem login, quem manda é a tela de entrada
  const [caminho, consulta = ''] = (location.hash || '#/hoje').split('?');
  const partes = caminho.replace(/^#\//, '').split('/');
  const n = Number(partes[1]);
  const [rota, , acao] = partes;
  if (rota === 'hoje' || rota === '') return telaHoje();
  if (rota === 'busca') {
    const qs = new URLSearchParams(consulta);
    if (qs.get('modo') === 'chegada') return irPara('#/chegada/nova'); // endereço antigo
    return telaBusca(qs.get('q') || '');
  }
  if (rota === 'chegada') return telaChegadaNova(n || null); // #/chegada/nova ou #/chegada/<id do pet>
  if (rota === 'atendimento' && n && acao === 'editar') return telaEditarAtendimento(n);
  if (rota === 'receita' && n) return acao === 'imprimir' ? telaImprimirReceita(n) : telaReceita(n, consulta);
  if (rota === 'receitas' && partes[1] === 'imprimir') return telaReceitasImprimir();
  if (rota === 'receitas' && partes[1] === 'transcrever') return telaTranscrever(consulta);
  if (rota === 'cadastro') return irPara('#/chegada/nova'); // endereço antigo do cadastro rápido
  if (rota === 'conta' && n) return telaConta(n, consulta);
  if (rota === 'precos') return telaPrecos();
  if (rota === 'caixa') return usuario.admin ? telaCaixa() : telaHoje();
  if (rota === 'notificacoes') return telaNotificacoes();
  if (rota === 'usuarios') return usuario.admin ? telaUsuarios() : telaHoje();
  if (rota === 'pet' && n) return acao === 'editar' ? telaEditarPet(n) : telaPet(n);
  if (rota === 'tutor' && n) {
    if (acao === 'editar') return telaEditarTutor(n);
    if (acao === 'novo-pet') return telaNovoPet(n);
    if (acao === 'juntar') return telaJuntar(n);
    return telaTutor(n);
  }
  telaHoje();
}
window.addEventListener('hashchange', rotear);

// ---------- início ----------
async function iniciar() {
  try {
    const { precisa } = await api('GET', '/api/configuracao-inicial');
    if (precisa) return telaConfiguracaoInicial();
    try {
      usuario = await api('GET', '/api/eu');
      rotear();
    } catch (e) {
      if (e.status === 401) { lembrarDestino(); telaEntrar(); } else throw e;
    }
  } catch (e) {
    mostrar(caixaMensagem('erro', e.message), el('button', { type: 'button', onclick: () => location.reload() }, 'Tentar de novo'));
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* sem service worker, o app segue normal */ });
}
iniciar();
