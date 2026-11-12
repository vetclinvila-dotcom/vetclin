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
        telaHoje();
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
        telaHoje();
      },
        campo('Login', 'login', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        campo('Senha', 'senha', { type: 'password', autocomplete: 'current-password', required: true }),
        el('button', { type: 'submit' }, 'Entrar'),
      )));
}

const NOME_PAPEL = { recepcao: 'Recepção', veterinario: 'Veterinário(a)' };

function cabecalho(titulo) {
  return el('div', { class: 'topo' },
    el('span', { class: 'marca' }, 'Vetclin'),
    el('button', { class: 'secundario', type: 'button', onclick: sair }, 'Sair'),
  );
}

async function sair() {
  try { await api('POST', '/api/sair'); } catch { /* mesmo com erro, voltamos ao login */ }
  usuario = null;
  telaEntrar();
}

function telaHoje() {
  mostrar(
    cabecalho(),
    el('h1', {}, `Olá, ${usuario.nome}`),
    el('div', { class: 'cartao' },
      el('p', {}, el('span', { class: 'etiqueta' }, NOME_PAPEL[usuario.papel] || usuario.papel), usuario.admin ? el('span', { class: 'etiqueta' }, 'Administrador') : null),
      el('h2', {}, 'Hoje'),
      el('p', { class: 'suave' }, 'Aqui aparecerão os atendimentos do dia. Esta tela será construída nos próximos passos.'),
    ),
    usuario.admin ? el('div', { class: 'acoes' }, el('button', { type: 'button', onclick: telaUsuarios }, 'Usuários')) : null,
  );
}

async function telaUsuarios() {
  mostrar(el('p', { class: 'carregando' }, 'Carregando…'));
  let lista;
  try {
    lista = (await api('GET', '/api/usuarios')).usuarios;
  } catch (e) {
    mostrar(cabecalho(), caixaMensagem('erro', e.message), el('button', { type: 'button', onclick: telaHoje }, 'Voltar'));
    return;
  }
  mostrar(
    cabecalho(),
    el('button', { class: 'secundario', type: 'button', onclick: telaHoje }, '← Voltar'),
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
  );
}

function selectPapel(atual) {
  const s = el('select', { id: 'papel', name: 'papel' },
    el('option', { value: 'recepcao' }, 'Recepção'),
    el('option', { value: 'veterinario' }, 'Veterinário(a)'));
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

// ---------- início ----------
async function iniciar() {
  try {
    const { precisa } = await api('GET', '/api/configuracao-inicial');
    if (precisa) return telaConfiguracaoInicial();
    try {
      usuario = await api('GET', '/api/eu');
      telaHoje();
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
