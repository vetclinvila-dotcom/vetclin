// Service worker do Vetclin.
// Roda "por trás" do app no celular. Ele é que recebe as notificações,
// mesmo com o app fechado, e mostra o aviso na tela.
// NÃO guardamos nada das chamadas /api em cache (dados clínicos e de login).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

// Não interceptamos nenhuma requisição: tudo vai direto para a rede.

// Chegou uma notificação do servidor: mostra na tela.
self.addEventListener('push', (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch {
    dados = { corpo: evento.data ? evento.data.text() : '' };
  }
  const titulo = dados.titulo || 'Vetclin';
  const opcoes = {
    body: dados.corpo || '',
    icon: '/icones/icone-192.png',
    badge: '/icones/icone-192.png',
    data: { url: dados.url || '#/hoje' },
    // Mesmo "tag" = o aviso novo substitui o antigo (não acumula repetidos).
    tag: dados.tag || undefined,
    renotify: !!dados.tag,
    // Urgência fica na tela até alguém tocar.
    requireInteraction: !!dados.urgente,
  };
  evento.waitUntil(self.registration.showNotification(titulo, opcoes));
});

// Tocou na notificação: abre o app na tela certa.
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = (evento.notification.data && evento.notification.data.url) || '#/hoje';
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of janelas) {
      if (new URL(janela.url).origin === self.location.origin) {
        await janela.focus();
        janela.postMessage({ tipo: 'abrir', url: destino });
        return;
      }
    }
    await self.clients.openWindow('/' + destino);
  })());
});

// O navegador trocou o "endereço de entrega" deste aparelho: inscreve de novo.
self.addEventListener('pushsubscriptionchange', (evento) => {
  evento.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/chave', { credentials: 'same-origin' });
      if (!r.ok) return;
      const { publica } = await r.json();
      const chave = Uint8Array.from(atob(publica.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((publica.length + 3) % 4)), (c) => c.charCodeAt(0));
      const nova = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
      await fetch('/api/push/inscrever', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vetclin' },
        body: JSON.stringify(nova.toJSON()),
      });
    } catch {
      // Sem conexão ou sem login: na próxima vez que abrir o app, a pessoa ativa de novo.
    }
  })());
});
