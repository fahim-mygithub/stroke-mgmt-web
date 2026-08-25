/* eslint-disable no-restricted-globals */
/**
 * stroke-mgmt-web service worker.
 *
 * Layered on top of the in-page IndexedDB content cache (CMS JSON lives there).
 * The SW handles the *asset* layer:
 *
 *  - Install: precache the static app shell. The list is small and enumerated
 *    inline (no build step). Bump the cache-name version suffix when shell
 *    assets change.
 *  - Activate: drop any cache whose name doesn't match the current shell-cache
 *    name or the long-lived CMS-images cache name.
 *  - Fetch:
 *      * Same-origin requests under scope (the app shell) → cache-first with
 *        network fallback. Navigations that miss cache and fail on network
 *        fall back to the precached `index.html`.
 *      * CMS image bytes (`stroke-mgmt-cms.a2hosted.com/uploads/*`) →
 *        stale-while-revalidate against a long-lived cache that survives
 *        app-shell version bumps.
 *      * Everything else (in particular the CMS API JSON at
 *        `/api/articles`, `/api/algorithms`, etc.) → pass through. The
 *        IndexedDB layer in the page is the single source of truth for that
 *        data; the SW must not double-cache it.
 */

const APP_SHELL_CACHE = 'stroke-mgmt-app-shell-v9';
const CMS_IMAGES_CACHE = 'stroke-mgmt-cms-images-v1';
const CMS_IMAGES_ORIGIN = 'https://stroke-mgmt-cms.a2hosted.com';
const CMS_IMAGES_PATH_PREFIX = '/uploads/';

const PRECACHE_URLS = [
  './',
  './index.html',
  './privacy-policy.html',
  './logo.png',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      // `cache: 'reload'` bypasses the browser HTTP cache so a version bump
      // can never pin a stale pre-deploy shell into the new cache.
      const requests = PRECACHE_URLS.map(
        (u) => new Request(new URL(u, self.registration.scope).toString(), { cache: 'reload' })
      );
      // Atomic on purpose: if any asset fails, the whole install fails and
      // the previous worker + shell cache stay in service. Swallowing the
      // error here would let activate delete the old cache and strand
      // offline clients with no shell at all.
      await cache.addAll(requests);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key === APP_SHELL_CACHE || key === CMS_IMAGES_CACHE) return undefined;
          if (key.startsWith('stroke-mgmt-app-shell-')) return caches.delete(key);
          return undefined;
        })
      );
      await self.clients.claim();
    })()
  );
});

function isCmsImageRequest(url) {
  return url.origin === CMS_IMAGES_ORIGIN && url.pathname.startsWith(CMS_IMAGES_PATH_PREFIX);
}

function isAppShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname.startsWith(scopePath);
}

/**
 * True only for navigations that are *meant* to render the app shell: the bare
 * scope URL or an explicit `index.html`. Standalone pages under scope (notably
 * `privacy-policy.html`, which the Play Store links to publicly) must never be
 * answered with the shell — serving the app in place of the policy is exactly
 * the "link does not lead to a relevant webpage" failure Google rejects for.
 */
function isShellNavigation(request) {
  if (request.mode !== 'navigate') return false;
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  const scopePath = new URL(self.registration.scope).pathname;
  return pathname === scopePath || pathname === `${scopePath}index.html`;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CMS_IMAGES_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      // `<img>` tags issue no-cors requests by default, so the response is
      // opaque (status 0, ok false). We still want to cache those — opaque
      // responses replay fine into a future <img>. Without this, the image
      // cache would never fill from natural page browsing.
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    // Don't wait for the revalidation; let it run in the background.
    networkPromise.catch(() => {});
    return cached;
  }
  const network = await networkPromise;
  if (network) return network;
  // No cache, no network — let the browser surface the failure.
  return fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(APP_SHELL_CACHE);
  // Direct match first.
  let cached = await cache.match(request);
  // Static-host convention: directory-style URLs serve `index.html` from the
  // same path. The precache lists `index.html` (relative), not the bare scope
  // URL, so navigations to e.g. `…/stroke-mgmt-web/` need this fallback to hit
  // the precached shell.
  if (!cached && isShellNavigation(request)) {
    const indexUrl = new URL('index.html', self.registration.scope).toString();
    cached = await cache.match(indexUrl);
  }
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // Network failed. Last-ditch fallback for shell navigations only.
    if (isShellNavigation(request)) {
      const indexUrl = new URL('index.html', self.registration.scope).toString();
      const fallback = await cache.match(indexUrl);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isCmsImageRequest(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (CMS API JSON, third-party, etc.) — passthrough.
});
