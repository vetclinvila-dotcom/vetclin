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
  raiz.replaceChildren(...elementos);
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

// ---------- peças de tela ----------
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

// ---------- Hoje ----------
function telaHoje() {
  mostrar(
    cabecalho(),
    el('h1', {}, `Olá, ${usuario.nome}`),
    el('div', { class: 'acoes-grandes' },
      el('button', { type: 'button', class: 'grande', onclick: () => irPara('#/busca') }, 'Buscar paciente'),
      el('button', { type: 'button', class: 'grande', onclick: () => irPara('#/cadastro') }, 'Cadastro rápido'),
    ),
    el('div', { class: 'cartao' },
      el('p', {}, el('span', { class: 'etiqueta' }, NOME_PAPEL[usuario.papel] || usuario.papel), usuario.admin ? el('span', { class: 'etiqueta' }, 'Administrador') : null),
      el('h2', {}, 'Hoje'),
      el('p', { class: 'suave' }, 'Aqui aparecerão os atendimentos do dia. Esta tela será construída nos próximos passos.'),
    ),
    usuario.admin ? el('div', { class: 'acoes' }, el('button', { type: 'button', class: 'secundario', onclick: () => irPara('#/usuarios') }, 'Usuários')) : null,
  );
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
            el('button', { type: 'button', onclick: () => irPara('#/cadastro') }, 'Cadastrar novo')));
        return;
      }
      area.replaceChildren(...resultados.map(cartaoResultado));
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

// ---------- Cadastro rápido ----------
function telaCadastro() {
  const especie = escolhaEspecie('');
  const area = el('div');
  const botao = el('button', { type: 'submit' }, 'Cadastrar');
  const f = el('form', { novalidate: true },
    ...campo('Nome do pet', 'pet_nome', { required: true, autocomplete: 'off' }),
    el('label', {}, 'Espécie'), especie.caixa,
    ...campo('Nome do tutor', 'tutor_nome', { required: true, autocomplete: 'off' }),
    ...campo('WhatsApp do tutor', 'whatsapp', { type: 'tel', inputmode: 'tel', placeholder: '(71) 99999-8888', autocomplete: 'off', required: true }),
    area, botao);

  async function enviar(extra = {}) {
    area.replaceChildren();
    botao.disabled = true;
    try {
      const v = (id) => f.querySelector('#' + id).value;
      const r = await api('POST', '/api/cadastro-rapido', {
        tutor: { nome: v('tutor_nome'), whatsapp: v('whatsapp') },
        pet: { nome: v('pet_nome'), especie: especie.valor() || undefined },
        ...extra,
      });
      irPara(`#/pet/${r.pet.id}`);
    } catch (e) {
      botao.disabled = false;
      if (e.status === 409 && e.dados && e.dados.duplicados) area.replaceChildren(cartaoDuplicado(e.dados, extra, enviar));
      else area.replaceChildren(caixaMensagem('erro', e.message));
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
function cartaoDuplicado(dados, extra, reenviar) {
  if (dados.tipo === 'pet') {
    const d = dados.duplicados[0];
    return el('div', { class: 'cartao aviso' },
      el('h2', {}, `Este tutor já tem um pet chamado ${d.nome}`),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', onclick: () => irPara(`#/pet/${d.id}`) }, 'Abrir a ficha existente'),
        el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ ...extra, confirmar_duplicado: true }) }, 'Cadastrar mesmo assim')));
  }
  return el('div', { class: 'cartao aviso' },
    el('h2', {}, 'Já existe cadastro com este WhatsApp'),
    ...dados.duplicados.map((t) => el('div', { class: 'cartao' },
      el('strong', {}, t.nome), el('span', { class: 'suave' }, ` · final ${t.final_telefone} · ${t.codigo}`),
      el('p', { class: 'suave' }, t.pets.length ? 'Pets: ' + t.pets.map((p) => `${p.nome} (${ROTULO_ESPECIE[p.especie] || p.especie})`).join(', ') : 'Nenhum pet cadastrado.'),
      el('button', { type: 'button', onclick: () => reenviar({ tutor_existente_id: t.id }) }, 'Sim, é esta pessoa — adicionar o pet aqui'))),
    el('button', { type: 'button', class: 'secundario', onclick: () => reenviar({ confirmar_duplicado: true }) }, 'Não, é outra pessoa da família — criar novo cadastro'));
}

// ---------- Ficha do pet ----------
async function telaPet(id) {
  const minha = versaoTela;
  carregando();
  let d;
  try { d = await api('GET', `/api/pets/${id}`); } catch (e) { if (minha === versaoTela) telaErro(e, '#/busca'); return; }
  if (minha !== versaoTela) return;
  const { pet, tutor, atendimentos } = d;
  const linha = (rotulo, ...valor) => el('p', {}, el('span', { class: 'suave' }, rotulo + ': '), ...valor);
  mostrar(
    cabecalho(), botaoVoltar('#/busca', '← Buscar'),
    el('h1', { class: 'nome-pet' }, pet.nome, pet.ativo ? null : el('span', { class: 'etiqueta inativo' }, 'Arquivado')),
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
    el('h2', {}, 'Atendimentos'),
    el('div', { class: 'cartao' },
      atendimentos.length
        ? el('ul', { class: 'lista-simples' }, atendimentos.map((a) => el('li', {},
          el('strong', {}, formatarDataHora(a.chegada_em)), ' ',
          el('span', { class: 'etiqueta' }, ROTULO_STATUS[a.status] || a.status),
          a.motivo ? el('div', { class: 'suave' }, a.motivo) : null)))
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
            caixaMensagem('ok', `Apagado: ${a.tutores} tutores, ${a.pets} pets, ${a.atendimentos} atendimentos, ${a.pedidos} pedidos.`));
        } catch (e) { area.replaceChildren(caixaMensagem('erro', e.message)); botao.disabled = false; }
      });
      caixa.replaceChildren(
        el('h2', {}, 'Dados de teste'),
        el('p', {}, 'Apaga todos os tutores e pets cujo nome começa com TESTE, e os atendimentos deles.'),
        el('p', {}, el('strong', {}, `Seriam apagados agora: ${c.tutores} tutores, ${c.pets} pets, ${c.atendimentos} atendimentos, ${c.pedidos} pedidos.`)),
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
  if (rota === 'busca') return telaBusca(new URLSearchParams(consulta).get('q') || '');
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
