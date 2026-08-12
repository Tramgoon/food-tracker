const CACHE_NAME = 'food-tracker-offline-v1';
const INSTALL_CACHE_URLS = [
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(INSTALL_CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/api/');
}

function noStoreRequest(request) {
  return new Request(request, { cache: 'no-store' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || isApiRequest(url)) {
    event.respondWith(fetch(noStoreRequest(request)));
    return;
  }

  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(noStoreRequest(request)));
    return;
  }

  event.respondWith(
    fetch(noStoreRequest(request))
      .then((response) => {
        if (response.ok) {
          const cacheKey = request.mode === 'navigate' ? '/index.html' : request;
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(async () => {
        if (request.mode === 'navigate') {
          return (await caches.match('/index.html')) || Response.error();
        }
        return (await caches.match(request)) || Response.error();
      })
  );
});
