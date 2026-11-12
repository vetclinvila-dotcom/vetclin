// Service worker mínimo do Vetclin.
// Por enquanto só existe para permitir instalar o app no celular.
// NÃO guardamos nada das chamadas /api em cache (dados clínicos e de login).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

// Não interceptamos nenhuma requisição: tudo vai direto para a rede.
// (Sem evento "fetch", o navegador usa o comportamento normal.)

// Passo 4 (futuro): aqui entrará o tratamento de notificações push:
// self.addEventListener('push', (evento) => { ... });
