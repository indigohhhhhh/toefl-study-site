const CACHE = "toefl-study-shell-v6";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

// The worker has no timers, push notifications, background sync, or periodic
// work. It responds only while the installed site is actively making requests.

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET"
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/@vite/")
    || url.pathname.startsWith("/@id/")
    || url.pathname.startsWith("/@fs/")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request)),
  );
});
