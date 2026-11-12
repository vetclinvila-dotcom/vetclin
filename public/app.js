// Telas do Vetclin. Tudo é montado aqui, sem bibliotecas externas.
// Segurança: textos vindos do servidor/usuário só entram na tela via
// textContent (função "el"), nunca como HTML cru.

const raiz = document.getElementById('app');
let usuario = null; // usuário logado

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

function mostrar(...elementos) {
  raiz.classList.remove('larga'); // só a tela Hoje usa a largura grande
  raiz.replaceChildren(...elementos.filter((x) => x != null && x !== false)); // ignora vazios (senão apareceria o texto "null")
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

function telaConfiguracaoInicial() {
  mostrar(
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
        el('button', { type: 'submit' }, 'Criar acesso'),
      )));
}

function telaEntrar() {
  mostrar(
    el('h1', {}, 'Vetclin'),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        usuario = await api('POST', '/api/entrar', { login: d.login, senha: d.senha });
        irPara('#/hoje');
      },
        campo('Login', 'login', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        campo('Senha', 'senha', { type: 'password', autocomplete: 'current-password', required: true }),
        el('button', { type: 'submit' }, 'Entrar'),
      )));
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

function botaoVoltar(hash, rotulo = '← Voltar') {
  return el('button', { class: 'secundario voltar', type: 'button', onclick: () => irPara(hash) }, rotulo);
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
function confirmar(titulo, texto, rotuloOk) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'confirmacao' },
      el('h2', {}, titulo),
      ...[].concat(texto).map((t) => el('p', {}, t)),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', id: 'confirmar-sim' }, rotuloOk),
        el('button', { type: 'button', class: 'secundario', id: 'confirmar-nao' }, 'Cancelar')));
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
function campoFoto(inicial = null, nomePet = 'pet') {
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
    el('label', {}, 'Foto (opcional)'),
    el('div', { class: 'acoes' },
      el('button', { type: 'button', class: 'secundario', id: 'foto-tirar', onclick: () => camera.click() }, 'Tirar foto'),
      el('button', { type: 'button', class: 'secundario', id: 'foto-galeria-botao', onclick: () => galeria.click() }, 'Escolher da galeria')),
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

// Cartão de um paciente na tela Hoje.
function cartaoAtendimento(a, { aoAtualizar, aoErro }) {
  const p = a.pet;
  const abrirFicha = () => irPara(`#/pet/${p.id}`);
  const idade = idadeCurta(p);
  // Se chegou em outro dia (atendimento esquecido aberto), mostra a data também.
  const quando = a.de_outro_dia ? `em ${formatarDia(a.chegada_em)} às ${formatarHora(a.chegada_em)}` : formatarHora(a.chegada_em);
  const detalheHora = {
    chegou: () => `Chegou ${quando} · espera ${formatarEspera(esperaDe(a))}`,
    em_atendimento: () => `Chegou ${quando} · esperou ${formatarEspera(esperaDe(a))} · iniciou ${formatarHora(a.iniciado_em)}${a.veterinario ? ' com ' + a.veterinario.nome : ''}`,
    finalizado: () => `Chegou ${formatarHora(a.chegada_em)} · finalizado ${formatarHora(a.finalizado_em)}${a.veterinario ? ' · ' + a.veterinario.nome : ''}`,
  }[a.status];

  const pesoNo = a.sem_peso
    ? el('div', { class: 'peso-faltando' },
      el('span', { class: 'selo-sem-peso' }, 'Sem peso'),
      a.status === 'finalizado' ? null : el('button', { type: 'button', class: 'adicionar-peso', onclick: (ev) => { ev.stopPropagation(); adicionarPeso(a, aoAtualizar); } }, 'Adicionar peso'))
    : el('div', { class: 'peso-grande' }, formatarPeso(a.peso_kg));

  const corpo = el('div', { class: 'atend-corpo', role: 'link', tabindex: '0', 'aria-label': `Abrir ficha de ${p.nome}`, onclick: abrirFicha },
    miniatura(p.foto_id || a.foto_id, p.nome),
    el('div', { class: 'atend-info' },
      el('div', { class: 'atend-nome' }, p.nome, a.urgente ? el('span', { class: 'selo-urgente' }, 'URGENTE') : null),
      el('div', { class: 'suave' }, [ROTULO_ESPECIE[p.especie] || p.especie, idade].filter(Boolean).join(' · ')),
      pesoNo,
      a.motivo ? el('div', { class: 'atend-motivo' }, a.motivo) : null,
      el('div', { class: 'suave' }, `Tutor: ${a.tutor.nome}${a.tutor.final_telefone ? ' · final ' + a.tutor.final_telefone : ''}`),
      el('div', { class: 'suave atend-hora' }, detalheHora())));
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
  if (a.status === 'chegou' || a.status === 'em_atendimento') {
    botoes.push(el('button', { type: 'button', class: 'secundario', onclick: () => irPara(`#/atendimento/${a.id}/editar`) }, 'Editar'));
  }
  if (a.status === 'chegou') {
    botoes.push(el('button', { type: 'button', class: 'secundario perigo', onclick: async () => {
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
  return el('article', { class: 'cartao atend ' + a.status + (a.urgente ? ' urgente' : '') }, corpo, botoes.length ? el('div', { class: 'acoes atend-acoes' }, botoes) : null);
}

function telaHoje() {
  const minha = versaoTela;
  let dados = null;
  let finalizadosAberto = false;
  const avisos = el('div');
  const listas = el('div', { class: 'hoje-grade' }, el('p', { class: 'carregando' }, 'Carregando…'));
  mostrar(
    cabecalho(),
    el('h1', {}, 'Hoje'),
    el('div', { class: 'acoes-grandes' },
      el('button', { type: 'button', class: 'grande', id: 'registrar-chegada', onclick: () => irPara('#/busca?modo=chegada') }, 'Registrar chegada'),
      el('button', { type: 'button', class: 'grande secundario', id: 'cadastro-rapido', onclick: () => irPara('#/cadastro') }, 'Cadastro rápido'),
    ),
    avisos, listas,
    el('p', { class: 'suave' }, el('span', { class: 'etiqueta' }, NOME_PAPEL[usuario.papel] || usuario.papel), usuario.admin ? el('span', { class: 'etiqueta' }, 'Administrador') : null, usuario.nome),
    usuario.admin ? el('div', { class: 'acoes' }, el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/usuarios') }, 'Usuários')) : null,
  );

  raiz.classList.add('larga');

  function secao(classe, titulo, itens, vazio) {
    return el('section', { class: 'secao-hoje ' + classe },
      el('h2', { class: 'secao-titulo' }, titulo, el('span', { class: 'contador' }, String(itens.length))),
      itens.length ? itens.map((a) => cartaoAtendimento(a, { aoAtualizar: atualizar, aoErro: (e) => avisos.replaceChildren(caixaMensagem('erro', e.message)) })) : el('p', { class: 'suave vazio-secao' }, vazio));
  }

  function desenhar() {
    if (!dados) return;
    const total = dados.aguardando.length + dados.em_atendimento.length + dados.finalizados.length + dados.cancelados_hoje;
    const finais = el('details', { class: 'secao-hoje finalizados', open: finalizadosAberto },
      el('summary', { class: 'secao-titulo' }, 'Finalizados hoje', el('span', { class: 'contador' }, String(dados.finalizados.length))),
      dados.finalizados.length
        ? dados.finalizados.map((a) => cartaoAtendimento(a, { aoAtualizar: atualizar, aoErro: () => {} }))
        : el('p', { class: 'suave vazio-secao' }, 'Nenhum atendimento finalizado hoje ainda.'));
    finais.addEventListener('toggle', () => { finalizadosAberto = finais.open; });
    listas.replaceChildren(...[
      total === 0 ? el('div', { class: 'cartao vazio' }, el('p', {}, 'Nenhuma chegada registrada hoje ainda.'), el('p', { class: 'suave' }, 'Quando um paciente chegar, toque em "Registrar chegada".')) : null,
      secao('aguardando', 'Aguardando', dados.aguardando, 'Ninguém aguardando no momento.'),
      secao('em-atendimento', 'Em atendimento', dados.em_atendimento, 'Nenhum atendimento em andamento.'),
      finais,
      dados.cancelados_hoje ? el('p', { class: 'suave' }, `Chegadas canceladas hoje: ${dados.cancelados_hoje}`) : null,
    ].filter(Boolean)); // (replaceChildren transformaria null em o texto "null")
  }

  async function atualizar() {
    if (minha !== versaoTela) return;
    try {
      const novo = await api('GET', '/api/hoje');
      if (minha !== versaoTela) return;
      dados = novo;
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
function telaBusca(qInicial = '', modo = '') {
  const chegada = modo === 'chegada'; // toque no resultado abre o formulário de chegada
  const campoBusca = el('input', { id: 'q', type: 'search', class: 'busca-grande', placeholder: 'Nome do pet, do tutor ou telefone', autocomplete: 'off', value: qInicial, 'aria-label': 'Nome do pet, do tutor ou telefone' });
  const area = el('div', { id: 'resultados' });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, chegada ? 'Registrar chegada' : 'Buscar paciente'),
    chegada ? el('p', { class: 'suave' }, 'Busque o paciente que chegou e toque nele.') : null, campoBusca, area);

  let tempo = null;
  let numero = 0; // ignora respostas antigas
  async function buscarAgora() {
    const q = campoBusca.value.trim();
    // Guarda o texto no endereço (sem criar passo novo no "voltar").
    const sufixo = chegada ? '&modo=chegada' : '';
    history.replaceState(null, '', q ? `#/busca?q=${encodeURIComponent(q)}${sufixo}` : (chegada ? '#/busca?modo=chegada' : '#/busca'));
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
            el('button', { type: 'button', onclick: () => irPara('#/cadastro') }, 'Cadastrar novo (cadastro rápido)')));
        return;
      }
      area.replaceChildren(...resultados.map((r) => cartaoResultado(r, chegada)));
    } catch (e) {
      if (meu === numero) area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  campoBusca.addEventListener('input', () => { clearTimeout(tempo); tempo = setTimeout(buscarAgora, 300); });
  buscarAgora();
  campoBusca.focus();
}

function cartaoResultado(r, chegada = false) {
  const tutor = `Tutor: ${r.tutor.nome}${r.tutor.final_telefone ? ' · final ' + r.tutor.final_telefone : ''}`;
  if (r.tipo === 'pet') {
    return el('button', { type: 'button', class: 'resultado', onclick: () => irPara(chegada ? `#/chegada/${r.pet.id}` : `#/pet/${r.pet.id}`) },
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

// ---------- Cadastro rápido ----------
function telaCadastro() {
  const especie = escolhaEspecie('');
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Cadastrar');
  const chegadaCampos = camposChegada({ nomePet: 'pet' });
  // Chave "Chegada agora": ligada = registra também o atendimento (peso, motivo, urgência, foto).
  const chave = el('input', { type: 'checkbox', id: 'chegada_agora', name: 'chegada_agora', checked: true });
  const blocoPeso = el('div', { class: 'bloco-chegada' }, ...chegadaCampos.peso);
  const blocoResto = el('div', { class: 'bloco-chegada' }, ...chegadaCampos.resto);
  chave.addEventListener('change', () => { blocoPeso.hidden = blocoResto.hidden = !chave.checked; });
  const f = el('form', { novalidate: true },
    ...campo('Nome do pet', 'pet_nome', { required: true, autocomplete: 'off' }),
    el('label', {}, 'Espécie'), especie.caixa,
    el('label', { class: 'linha chave-chegada' }, chave, 'Chegada agora (registrar peso e motivo)'),
    blocoPeso,
    ...campo('Nome do tutor', 'tutor_nome', { required: true, autocomplete: 'off' }),
    ...campo('WhatsApp do tutor', 'whatsapp', { type: 'tel', inputmode: 'tel', placeholder: '(71) 99999-8888', autocomplete: 'off', required: true }),
    blocoResto,
    area, botao);

  async function enviar(extra = {}) {
    area.replaceChildren();
    botao.disabled = true;
    try {
      const v = (id) => f.querySelector('#' + id).value;
      const corpo = {
        tutor: { nome: v('tutor_nome'), whatsapp: v('whatsapp') },
        pet: { nome: v('pet_nome'), especie: especie.valor() || undefined },
        ...extra,
      };
      if (chave.checked) corpo.chegada = await chegadaCampos.coletar(); // confere peso/motivo e envia a foto
      const r = await api('POST', '/api/cadastro-rapido', corpo);
      irPara(chave.checked ? '#/hoje' : `#/pet/${r.pet.id}`);
    } catch (e) {
      botao.disabled = false;
      botao.hidden = false;
      if (e.status === 409 && e.dados && e.dados.duplicados) {
        // Enquanto o aviso de repetido está na tela, só as opções do aviso valem.
        botao.hidden = true;
        area.replaceChildren(cartaoDuplicado(e.dados, extra, enviar, () => { area.replaceChildren(); botao.hidden = false; }));
      } else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  }
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!especie.valor()) { area.replaceChildren(caixaMensagem('erro', 'Escolha a espécie: Cão, Gato ou Outro.')); return; }
    enviar();
  });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Cadastro rápido'), el('div', { class: 'cartao' }, f));
}

// Cartão mostrado quando a API avisa de cadastro repetido (WhatsApp ou pet).
// "aoVoltar" (opcional) desfaz o aviso para a pessoa corrigir os dados.
function cartaoDuplicado(dados, extra, reenviar, aoVoltar = null) {
  const voltar = aoVoltar ? el('button', { type: 'button', class: 'secundario', onclick: aoVoltar }, 'Voltar e corrigir os dados') : null;
  if (dados.tipo === 'pet') {
    const d = dados.duplicados[0];
    return el('div', { class: 'cartao aviso' },
      el('h2', {}, `Este tutor já tem um pet chamado ${d.nome}`),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', onclick: () => irPara(`#/pet/${d.id}`) }, 'Abrir a ficha existente'),
        el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ ...extra, confirmar_duplicado: true }) }, 'Cadastrar mesmo assim'),
        voltar));
  }
  return el('div', { class: 'cartao aviso' },
    el('h2', {}, 'Já existe cadastro com este WhatsApp'),
    ...dados.duplicados.map((t) => el('div', { class: 'cartao' },
      el('strong', {}, t.nome), el('span', { class: 'suave' }, ` · final ${t.final_telefone} · ${t.codigo}`),
      el('p', { class: 'suave' }, t.pets.length ? 'Pets: ' + t.pets.map((p) => `${p.nome} (${ROTULO_ESPECIE[p.especie] || p.especie})`).join(', ') : 'Nenhum pet cadastrado.'),
      el('button', { type: 'button', onclick: () => reenviar({ tutor_existente_id: t.id }) }, 'Sim, é esta pessoa — adicionar o pet aqui'))),
    el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ confirmar_duplicado: true }) }, 'Não, é outra pessoa da família — criar novo cadastro'),
    voltar);
}

// ---------- Registrar chegada (pet que já tem cadastro) ----------
async function telaChegada(petId) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/pets/${petId}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca?modo=chegada'); return; }
  if (minha !== versaoTela) return;
  const { pet, tutor, atendimento_aberto: aberto } = d;
  const cabecaPet = el('div', { class: 'cartao cabeca-chegada' },
    miniatura(pet.foto_id, pet.nome),
    el('div', {}, el('div', { class: 'atend-nome' }, pet.nome),
      el('div', { class: 'suave' }, [ROTULO_ESPECIE[pet.especie] || pet.especie, idadeCurta(pet)].filter(Boolean).join(' · ')),
      el('div', { class: 'suave' }, `Tutor: ${tutor.nome}${tutor.final_telefone ? ' · final ' + tutor.final_telefone : ''}`)));
  const jaNaClinica = () => el('div', { class: 'cartao aviso' },
    el('h2', {}, 'Este pet já está na clínica.'),
    el('p', {}, 'Já existe um atendimento aberto para ele. Veja na tela Hoje.'),
    el('button', { type: 'button', id: 'ir-hoje', onclick: () => irPara('#/hoje') }, 'Ir para Hoje'));
  if (aberto) {
    mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Registrar chegada'), cabecaPet, jaNaClinica());
    return;
  }
  const campos = camposChegada({ nomePet: pet.nome });
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Registrar chegada');
  const f = el('form', { novalidate: true }, ...campos.peso, ...campos.resto, area, botao);
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    area.replaceChildren();
    botao.disabled = true;
    try {
      await api('POST', '/api/atendimentos', { pet_id: pet.id, ...(await campos.coletar()) });
      irPara('#/hoje');
    } catch (e) {
      botao.disabled = false;
      if (e.status === 409 && e.dados && e.dados.atendimento_id) { botao.hidden = true; area.replaceChildren(jaNaClinica()); }
      else area.replaceChildren(caixaMensagem('erro', e.message));
    }
  });
  mostrar(cabecalho(), botaoVoltar('#/hoje'), el('h1', {}, 'Registrar chegada'), cabecaPet, el('div', { class: 'cartao' }, f));
  campos.pesoCampo.focus();
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
  const { pet, tutor, atendimentos, atendimento_aberto: aberto } = d;
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
            caixaMensagem('ok', `Apagado: ${a.tutores} tutores, ${a.pets} pets, ${a.atendimentos} atendimentos, ${a.pedidos} pedidos, ${a.fotos} fotos.`));
        } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); botao.disabled = false; }
      });
      caixa.replaceChildren(
        el('h2', {}, 'Dados de teste'),
        el('p', {}, 'Apaga todos os tutores e pets cujo nome começa com TESTE, e os atendimentos deles.'),
        el('p', {}, el('strong', {}, `Seriam apagados agora: ${c.tutores} tutores, ${c.pets} pets, ${c.atendimentos} atendimentos, ${c.pedidos} pedidos, ${c.fotos} fotos.`)),
        el('label', { for: 'confirmacao' }, 'Para confirmar, digite APAGAR'), entrada, area, el('div', { class: 'acoes' }, botao));
    } catch (e) { caixa.replaceChildren(el('h2', {}, 'Dados de teste'), caixaMensagem('erro', e.message)); }
  };
  montar();
  return caixa;
}

function cabecalho() {
  return el('div', { class: 'topo' },
    el('a', { class: 'marca', href: '#/hoje' }, 'Vetclin'),
    el('button', { class: 'secundario', type: 'button', onclick: sair }, 'Sair'),
  );
}

async function sair() {
  try { await api('POST', '/api/sair'); } catch { /* mesmo com erro, voltamos ao login */ }
  usuario = null;
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
    el('button', { class: 'secundario', type: 'button', onclick: () => irPara('#/hoje') }, '← Voltar'),
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
          ),
          el('button', { class: 'secundario', type: 'button', onclick: () => telaEditarUsuario(u) }, 'Editar'),
        ))),
    ),
    el('div', { class: 'acoes' }, el('button', { type: 'button', onclick: telaNovoUsuario }, 'Novo usuário')),
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
    el('button', { class: 'secundario', type: 'button', onclick: telaUsuarios }, '← Voltar'),
    el('h1', {}, 'Novo usuário'),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        await api('POST', '/api/usuarios', {
          nome: d.nome, login: d.login, senha: d.senha, papel: d.papel, crmv: d.crmv, admin: d.admin === 'on',
        });
        telaUsuarios();
      },
        campo('Nome', 'nome', { required: true }),
        campo('Login', 'login', { autocapitalize: 'none', required: true }),
        campo('Senha (mínimo 8 caracteres)', 'senha', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }),
        el('label', { for: 'papel' }, 'Papel'), selectPapel(),
        campo('CRMV (só para veterinários)', 'crmv'),
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'admin' }), 'Administrador'),
        el('button', { type: 'submit' }, 'Criar usuário'),
      )));
}

function telaEditarUsuario(u) {
  mostrar(
    cabecalho(),
    el('button', { class: 'secundario', type: 'button', onclick: telaUsuarios }, '← Voltar'),
    el('h1', {}, `Editar ${u.nome}`),
    el('div', { class: 'cartao' },
      formulario(async (d) => {
        const corpo = { nome: d.nome, papel: d.papel, crmv: d.crmv, admin: d.admin === 'on', ativo: d.ativo === 'on' };
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
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'admin', checked: u.admin }), 'Administrador'),
        el('label', { class: 'linha' }, el('input', { type: 'checkbox', name: 'ativo', checked: u.ativo }), 'Ativo (pode entrar no sistema)'),
        campo('Nova senha (deixe em branco para não mudar)', 'senha', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
        el('button', { type: 'submit' }, 'Salvar'),
      )));
}


// ---------- roteador ----------
function rotear() {
  versaoTela++;
  if (!usuario) return; // sem login, quem manda é a tela de entrada
  const [caminho, consulta = ''] = (location.hash || '#/hoje').split('?');
  const partes = caminho.replace(/^#\//, '').split('/');
  const n = Number(partes[1]);
  const [rota, , acao] = partes;
  if (rota === 'hoje' || rota === '') return telaHoje();
  if (rota === 'busca') { const qs = new URLSearchParams(consulta); return telaBusca(qs.get('q') || '', qs.get('modo') || ''); }
  if (rota === 'chegada' && n) return telaChegada(n);
  if (rota === 'atendimento' && n && acao === 'editar') return telaEditarAtendimento(n);
  if (rota === 'cadastro') return telaCadastro();
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
      if (e.status === 401) telaEntrar();
      else throw e;
    }
  } catch (e) {
    mostrar(caixaMensagem('erro', e.message), el('button', { type: 'button', onclick: () => location.reload() }, 'Tentar de novo'));
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* sem service worker, o app segue normal */ });
}
iniciar();
