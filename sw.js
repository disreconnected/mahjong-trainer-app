// Mahjong Trainer's service worker (built by tools/build-mobile.js; do not edit).
const VERSION = '3cc40f06f7a0';
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'mahjong-' + SCOPE.pathname + '-';
const CACHE = CACHE_PREFIX + VERSION;
const PRECACHE = [
  './index.html',
  './style.css',
  './js/announce.js',
  './js/bots.js',
  './js/claimhelp.js',
  './js/controller.js',
  './js/endscreen.js',
  './js/exportlogs.js',
  './js/game.js',
  './js/handorder.js',
  './js/learnui.js',
  './js/learnview.js',
  './js/lessons.js',
  './js/logger.js',
  './js/progress.js',
  './js/pwa.js',
  './js/quiz.js',
  './js/review.js',
  './js/reviewui.js',
  './js/reviewview.js',
  './js/rules.js',
  './js/safety.js',
  './js/settings.js',
  './js/sound.js',
  './js/store.js',
  './js/tileart.js',
  './js/tiles.js',
  './js/ui.js',
  './js/zip.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './manifest.webmanifest',
  './sw.js'
];

// The path of a URL relative to the app's scope, e.g. '' for the folder itself, or null when the
// URL is outside the scope. scopePath always ends with '/'.
function relativeToScope(pathname, scopePath) {
  const scope = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  return pathname.startsWith(scope) ? pathname.slice(scope.length) : null;
}

// The app's own page, as seen from the scope. The query string (?seed=...) does not count.
function isAppIndexPath(rel) {
  return rel === '' || rel === 'index.html';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600), so a new
      // version never precaches files the browser cached a moment before.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  );
  // No self.skipWaiting() here: a new version waits for the page's go-ahead.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // The app's own page: the cached index, whatever the query string (?seed=..., ?help=0).
    if (isAppIndexPath(relativeToScope(url.pathname, SCOPE.pathname))) {
      event.respondWith(caches.match('./index.html', { ignoreSearch: true }).then((hit) => hit || fetch(request)));
      return;
    }
    // Any other page: only what was cached under that exact URL, else the network.
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return res;
      });
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
