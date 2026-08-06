// Dahora Expresso - Service Worker Otimizado com Suporte a Web Push
const CACHE_NAME = 'dahora-expresso-cache-v12';
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
  let payload = {
    title: 'Nova Tele recebida',
    body: 'Nova entrega atribuída. Toque para abrir.',
    data: {
      tele_id: null,
      tele_code: null,
      action: 'open_tele'
    }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed) {
        if (parsed.title) payload.title = parsed.title;
        if (parsed.body) payload.body = parsed.body;
        if (parsed.data) payload.data = Object.assign({}, payload.data, parsed.data);
      }
    } catch (e) {
      payload.body = event.data.text() || payload.body;
    }
  }

  const teleId = payload.data?.tele_id || 'new';
  const options = {
    title: payload.title,
    body: payload.body,
    icon: '/logo.png',
    badge: '/logo.png',
    tag: `tele-${teleId}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [600, 250, 600, 250, 900],
    data: {
      tele_id: teleId,
      tele_code: payload.data?.tele_code || null,
      action: payload.data?.action || 'open_tele',
      url: `/motoboy.html?tele_id=${teleId}`
    }
  };

  event.waitUntil(
    self.registration.showNotification(options.title, options)
  );
});

// Clique na notificação Push
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const teleId = event.notification.data?.tele_id;
  const targetUrl = teleId ? `/motoboy.html?tele_id=${teleId}` : '/motoboy.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let client of windowClients) {
        if (client.url && client.url.includes('motoboy.html') && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    self.skipWaiting();
  }
});