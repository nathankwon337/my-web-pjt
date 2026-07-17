// Service worker for the "Learning games" offline app.
// Strategy: network-first, fall back to cache only when offline.
//
// (v4 change: xlsx.full.min.js and pinyin-pro.min.js used to be loaded from
// CDNs (cdnjs/jsdelivr). Cross-origin script loads come back as "opaque"
// responses with status 0, and the fetch handler below only caches
// status === 200 responses — so those CDN files were never actually being
// cached, meaning Excel upload silently broke offline even after a prior
// online visit. They're now self-hosted (same-origin), so they cache
// normally and are also explicitly pre-cached below for guaranteed offline
// availability from the very first install.)
//
// (v3 change: this used to be cache-first, which meant updates to index.html/gamify.js
// could keep showing a stale cached copy for a while after a new version was deployed.
// Network-first fixes that — while online you always get the latest files; the cache
// is only used as a fallback when there's no network.)

const CACHE_NAME = 'learning-games-v4';

// Core pages/assets to pre-cache the first time the service worker installs
// (this first install still needs to happen while online).
const CORE_ASSETS = [
  './',
  './index.html',
  './sentence_card_game.html',
  './word_match_game.html',
  './speaking_practice_game.html',
  './voca_trainer.html',
  './gamify.js',
  './gamify_config.js',
  './xlsx.full.min.js',
  './pinyin-pro.min.js',
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
    fetch(event.request).then(function (response) {
      if (response && response.status === 200) {
        var copy = response.clone();
        // event.waitUntil keeps the service worker alive long enough for this
        // cache write to actually finish (a bare, un-awaited promise can get
        // cut off once the response is returned).
        event.waitUntil(
          caches.open(CACHE_NAME).then(function (cache) { return cache.put(event.request, copy); })
        );
      }
      return response;
    }).catch(function () {
      // Offline (or request failed): serve the last cached copy if we have one.
      return caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        // Nothing cached for this exact request and it's a page navigation —
        // fall back to the cached app shell so the app still opens offline.
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return undefined;
      });
    })
  );
});
