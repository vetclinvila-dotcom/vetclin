// Notificações: a parte que roda na tela do app.
// Mostra o cartão "Ativar notificações", pede a permissão do aparelho e
// cadastra o aparelho no servidor.

const CABECALHOS = { 'Content-Type': 'application/json', 'X-Requested-With': 'vetclin' };

// É iPhone/iPad?
function ehIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// O app foi aberto pelo ícone da tela de início?
function instalado() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * Diz se este aparelho pode receber notificações agora.
 * @returns {'ok'|'instalar'|'incompativel'|'bloqueado'}
 */
export function situacao() {
  if (ehIos() && !instalado()) return 'instalar';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'incompativel';
  if (Notification.permission === 'denied') return 'bloqueado';
  return 'ok';
}

// Converte a chave pública (base64url) para bytes.
function bytesDaChave(b64) {
  const t = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
}

/** Este aparelho já está recebendo? */
export async function ativo() {
  if (situacao() !== 'ok' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

/**
 * Ativa as notificações neste aparelho. PRECISA ser chamado a partir de um toque
 * num botão (o iPhone só pede permissão assim).
 */
export async function ativar() {
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') throw new Error('Permissão não concedida. Para mudar: Ajustes → Notificações → Vetclin.');
  const reg = await navigator.serviceWorker.ready;
  const r = await fetch('/api/push/chave', { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Não foi possível falar com o servidor.');
  const { publica } = await r.json();
  let inscricao = await reg.pushManager.getSubscription();
  if (!inscricao) {
    inscricao = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDaChave(publica) });
  }
  const s = await fetch('/api/push/inscrever', {
    method: 'POST', credentials: 'same-origin', headers: CABECALHOS, body: JSON.stringify(inscricao.toJSON()),
  });
  if (!s.ok) {
    const d = await s.json().catch(() => ({}));
    throw new Error(d.erro || 'Não foi possível ativar.');
  }
  // Manda um aviso de teste para a pessoa ver que funcionou.
  await fetch('/api/push/teste', { method: 'POST', credentials: 'same-origin', headers: CABECALHOS, body: '{}' });
}

/** Desativa neste aparelho. */
export async function desativar() {
  const reg = await navigator.serviceWorker.ready;
  const inscricao = await reg.pushManager.getSubscription();
  if (!inscricao) return;
  await fetch('/api/push/cancelar', {
    method: 'POST', credentials: 'same-origin', headers: CABECALHOS, body: JSON.stringify({ endpoint: inscricao.endpoint }),
  });
  await inscricao.unsubscribe();
}

// Pequeno ajudante para criar elementos com texto (nunca innerHTML).
function criar(tag, atributos = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos) if (f !== null && f !== undefined) e.append(f);
  return e;
}

/**
 * Monta o cartão de notificações.
 * @param {{ compacto?: boolean }} opcoes compacto = só aparece se ainda NÃO estiver ativo (para a tela Hoje).
 * @returns {Promise<HTMLElement|null>}
 */
export async function cartaoNotificacoes({ compacto = false } = {}) {
  const sit = situacao();
  const jaAtivo = sit === 'ok' ? await ativo().catch(() => false) : false;
  if (compacto && (jaAtivo || sit === 'incompativel' || sit === 'bloqueado')) return null;

  const caixa = criar('div', { class: 'cartao cartao-notificacoes' });
  const mensagem = criar('p', { class: 'aviso-notificacoes' });
  const desenhar = (estado) => {
    caixa.replaceChildren();
    caixa.append(criar('h3', {}, 'Notificações neste aparelho'));
    if (estado === 'instalar') {
      caixa.append(
        criar('p', {}, 'Para receber avisos no iPhone, instale o app primeiro:'),
        criar('ol', {},
          criar('li', {}, 'No Safari, toque em Compartilhar (quadrado com seta).'),
          criar('li', {}, 'Toque em "Adicionar à Tela de Início".'),
          criar('li', {}, 'Abra o Vetclin pelo ícone e volte aqui.')),
      );
    } else if (estado === 'incompativel') {
      caixa.append(criar('p', {}, 'Este navegador não recebe notificações. No iPhone, use o app instalado pelo Safari (iOS 16.4 ou mais novo).'));
    } else if (estado === 'bloqueado') {
      caixa.append(criar('p', {}, 'As notificações foram bloqueadas. Para liberar: Ajustes do aparelho → Notificações → Vetclin → Permitir.'));
    } else if (estado === 'ativo') {
      caixa.append(
        criar('p', {}, 'Ativadas. Você recebe os avisos da Vetclin aqui.'),
        criar('div', { class: 'acoes' },
          criar('button', { type: 'button', class: 'secundario', onclick: async () => {
            mensagem.textContent = 'Enviando teste…';
            await fetch('/api/push/teste', { method: 'POST', credentials: 'same-origin', headers: CABECALHOS, body: '{}' });
            mensagem.textContent = 'Teste enviado. Deve chegar em alguns segundos.';
          } }, 'Enviar teste'),
          criar('button', { type: 'button', class: 'secundario', onclick: async () => {
            await desativar().catch(() => {});
            desenhar('desligado');
          } }, 'Desativar')),
      );
    } else {
      const botao = criar('button', { type: 'button', class: 'grande', onclick: async () => {
        botao.disabled = true;
        mensagem.textContent = 'Ativando…';
        try {
          await ativar();
          desenhar('ativo');
          mensagem.textContent = 'Pronto! Um aviso de teste foi enviado.';
        } catch (e) {
          botao.disabled = false;
          mensagem.textContent = e.message;
        }
      } }, 'Ativar notificações');
      caixa.append(criar('p', {}, 'Receba um aviso no celular quando um paciente chegar ou uma receita ficar pronta.'), botao);
    }
    caixa.append(mensagem);
  };
  desenhar(jaAtivo ? 'ativo' : (sit === 'ok' ? 'desligado' : sit));
  return caixa;
}

// Quando a pessoa toca numa notificação com o app já aberto, vai para a tela certa.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.tipo === 'abrir' && typeof e.data.url === 'string' && e.data.url.startsWith('#/')) {
      location.hash = e.data.url;
    }
  });
}
