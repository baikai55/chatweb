const LEGACY_CACHE_NAME = "chatweb-shell-v1";
const serviceWorkerURL = new URL(self.location.href);
const scopeKey = new URL(self.registration.scope).pathname
  .replace(/[^a-z0-9]+/gi, "-")
  .replace(/^-|-$/g, "") || "root";
const buildId = (serviceWorkerURL.searchParams.get("build") || "fallback")
  .replace(/[^a-z0-9._-]+/gi, "-");
const CACHE_PREFIX = `chatweb-shell-${scopeKey}-`;
const CACHE_NAME = `${CACHE_PREFIX}${buildId}`;
const scopeURL = new URL(self.registration.scope);
const scopedURL = (path) => new URL(path, scopeURL).href;
const registeredAssets = serviceWorkerURL.searchParams.getAll("asset")
  .map((path) => new URL(path, scopeURL))
  .filter((url) => url.origin === scopeURL.origin && url.pathname.startsWith(scopeURL.pathname))
  .map((url) => url.href);
const SHELL_URLS = [...new Set([
  scopeURL.href,
  scopedURL("index.html"),
  scopedURL("manifest.webmanifest"),
  scopedURL("icons/icon-192.png"),
  scopedURL("icons/icon-512.png"),
  ...registeredAssets,
])];
const REFRESH_URLS = new Set([
  scopedURL("manifest.webmanifest"),
  scopedURL("icons/icon-192.png"),
  scopedURL("icons/icon-512.png"),
  scopedURL("icons/apple-touch-icon.png"),
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key === LEGACY_CACHE_NAME || (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API calls, uploads, or requests to user-configured backends.
  if (
    request.method !== "GET"
    || url.origin !== self.location.origin
    || url.pathname.startsWith("/__api/")
    || request.headers.has("authorization")
    || request.headers.has("x-api-key")
    || request.headers.has("api-key")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(scopeURL.href))),
    );
    return;
  }

  // Manifest 和固定文件名图标没有内容 hash：在线时刷新缓存，离线时再读旧副本。
  if (REFRESH_URLS.has(url.href)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
