/* Party Quiz companion — offline shell.
 *
 * The companion is a static bundle: one page, a dozen stylesheets and scripts, and
 * a handful of images. Precaching them makes a second launch instant and keeps the
 * UI usable while a phone switches between Wi-Fi and mobile data. Gameplay itself
 * always needs the WebSocket, so nothing here pretends to work offline.
 *
 * Strategy:
 *   - navigation (HTML): network first, cache as fallback (a stale UI is worse than
 *     no UI when upstream ships a protocol change);
 *   - static assets: stale-while-revalidate, cache keyed without the ?v= buster;
 *   - cross-origin (Three.js CDN, Steam link): untouched, straight to the network.
 */
const VERSION = 'pqrevamped-v3';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.ico',
  './core/templates/game.html',
  './core/templates/css/reset.css',
  './core/templates/css/pwa.css',
  './core/templates/css/input.css',
  './core/templates/css/normalize.css',
  './core/templates/css/index.css',
  './core/templates/css/styles.css',
  './core/templates/css/popup.css',
  './core/templates/css/mobile-ux.css',
  './core/templates/css/pq-tokens.css',
  './core/templates/css/pq-components.css',
  './core/templates/css/pq-bonus.css',
  './core/templates/css/pq-screens.css',
  './core/templates/css/pq-revamped.css',
  './core/templates/js/i18n.js',
  './core/templates/js/avatars_list.js',
  './core/templates/js/avatars.js',
  './core/templates/js/commands.js',
  './core/templates/js/main.js',
  './core/templates/js/bonus-lootbox.js',
  './core/templates/js/bonus.js',
  './core/templates/js/selection.js',
  './core/templates/js/utils.js',
  './core/templates/js/emoji.js',
  './core/templates/js/custom_avatar_3d.js',
  './core/templates/js/revamped.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/party_quiz_logo_wordmark.png',
  './assets/video-camera.png',
  './localized/english/lang.json',
];

function cacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.delete('v');
  return url.toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(cacheKey(new Request(new URL(path, self.location).toString())), response);
      } catch (error) {
        // A missing optional file must not abort the whole install.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(cacheKey(request), response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(cacheKey(request))) || (await caches.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const key = cacheKey(request);
  const cached = (await cache.match(key)) || (await caches.match(request, { ignoreSearch: true }));
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(key, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;        // CDN / external links
  if (url.pathname.includes('/pqlog')) return;            // telemetry is fire-and-forget
  if (url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (/\.(?:css|js|json|png|jpe?g|svg|woff2?|ttf|ico|obj|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
