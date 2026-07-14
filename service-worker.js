// Service worker for the "Learning games" offline app.
// Strategy: cache-first, refresh in the background, fall back to cache when offline.
// This covers same-origin pages AND cross-origin assets (Google Fonts, SheetJS from
// cdnjs) automatically, since every fetch the page makes passes through here.

const CACHE_NAME = 'learning-games-v2';

// Core pages/assets to pre-cache the first time the service worker installs
// (this first install still needs to happen while online).
const CORE_ASSETS = [
  './',
  './index.html',
  './sentence_card_game.html',
  './word_match_game.html',
  './speaking_practice_game.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        // addAll fails all-or-nothing; use individual puts so one failed
        // (e.g. CDN blip) asset doesn't block the whole install.
        return Promise.all(
          CORE_ASSETS.map(function (url) {
            return fetch(url).then(function (res) {
              if (res && res.ok) return cache.put(url, res);
            }).catch(function () { /* ignore, will be cached on first real visit */ });
          })
        );
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names.filter(function (n) { return n !== CACHE_NAME; })
               .map(function (n) { return caches.delete(n); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request)
        .then(function (response) {
          if (response && response.status === 200) {
            var copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, copy);
            });
          }
          return response;
        })
        .catch(function () {
          // Offline and not cached: for page navigations, fall back to the
          // cached index so the app shell still opens instead of erroring out.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return cached;
        });

      return cached || networkFetch;
    })
  );
});
