// Dahora Expresso - Service Worker Otimizado com Suporte a Web Push
const CACHE_NAME = 'dahora-expresso-cache-v9';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/motoboy.html',
  '/motoboy.js',
  '/manifest.json'
];

// Instalação do Service Worker e Cache Inicial
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('📦 [Service Worker] Fazendo cache dos arquivos estáticos v6');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Ativação e Limpeza de Caches Antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('🗑️ [Service Worker] Removendo cache antigo:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
      // Purga explícita de arquivos de configuração dinâmicos do cache atual
      return caches.open(CACHE_NAME).then((cache) => {
        return Promise.all([
          cache.delete('/runtime-config.js'),
          cache.delete('/config.local.js')
        ]);
      });
    })
  );
  self.clients.claim();
});

// Interceptação de Requisições de Rede (Fetch)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-Only para endpoints da API e configurações estáticas injetadas/locais
  if (url.pathname.startsWith('/api/') || url.pathname.includes('config.local.js') || url.pathname.includes('runtime-config.js')) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.pathname.includes('config.js') || url.pathname.includes('motoboy.html') || url.pathname.includes('motoboy.js')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(

    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => console.log('[Service Worker] Modo offline para requisição GET'));

        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});

// Escuta eventos PUSH em segundo plano
self.addEventListener('push', (event) => {
  let data = { type: 'NEW_TELE', tele_id: null, title: 'Nova Tele atribuída', body: 'Nova entrega disponível. Toque para visualizar.' };

  if (event.data) {
    try {
      data = Object.assign({}, data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  let options = {};

  if (data.type === 'SUPPORT_MESSAGE') {
    const convId = data.conversation_id || 'central';
    options = {
      title: data.title || 'Nova mensagem da Central',
      body: data.body || 'Você recebeu uma nova mensagem operacional.',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: `support-${convId}`,
      renotify: true,
      vibrate: [250, 120, 250],
      data: {
        type: 'SUPPORT_MESSAGE',
        url: '/motoboy.html?view=support'
      }
    };
  } else {
    // NEW_TELE por padrão
    const teleId = data.tele_id || 'new';
    options = {
      title: data.title || 'Nova Tele atribuída',
      body: data.body || 'Nova entrega disponível. Toque para visualizar.',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: `tele-${teleId}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [600, 250, 600, 250, 900],
      actions: [
        { action: 'open_tele', title: 'Abrir Tele' }
      ],
      data: {
        type: 'NEW_TELE',
        tele_id: teleId,
        url: `/motoboy.html?view=tele&tele_id=${teleId}`
      }
    };
  }

  event.waitUntil(
    self.registration.showNotification(options.title, options)
  );
});

// Clique na notificação Push
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/motoboy.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let client of windowClients) {
        if (client.url.includes('motoboy.html') && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(urlToOpen);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    self.skipWaiting();
  }
});