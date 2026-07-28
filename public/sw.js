// Dahora Expresso - Service Worker Otimizado
const CACHE_NAME = 'dahora-expresso-cache-v3';
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
      console.log('📦 [Service Worker] Fazendo cache dos arquivos estáticos v3');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // Força o SW novo a ativar imediatamente
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
    })
  );
  self.clients.claim(); // Assume o controle das abas abertas imediatamente
});

// Interceptação de Requisições de Rede (Fetch)
self.addEventListener('fetch', (event) => {
  // 🔥 CORREÇÃO DO BUG CRÍTICO: 
  // APIs de cache só suportam o método GET. Se for POST (como as requisições do Supabase),
  // nós ignoramos o Service Worker e deixamos a requisição passar direto para a internet.
  if (event.request.method !== 'GET') {
    return; 
  }

  // Bypass service worker for cross-origin requests (like Supabase API)
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Lógica de Cache para requisições GET (HTML, CSS, JS, Imagens)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Se estiver no cache, devolve imediatamente, mas busca uma versão nova em background (Stale-While-Revalidate)
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => console.log('[Service Worker] Rodando em modo offline para esta requisição GET'));
        
        return cachedResponse;
      }

      // Se não estiver no cache, busca normal na internet
      return fetch(event.request).then((networkResponse) => {
        // Não cacheia respostas inválidas ou de extensões do navegador
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        // Guarda uma cópia no cache e devolve a resposta para a tela
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});

// Escuta mensagens do painel administrativo para pular linha de espera
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    self.skipWaiting();
  }
});