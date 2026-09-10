// service-worker.js
// ==================
// Кеширует только "оболочку" приложения (HTML/CSS/JS/иконки), чтобы оно
// открывалось мгновенно и не показывало белый экран при плохой связи.
// Запросы к самому ИИ (text.pollinations.ai) НИКОГДА не кешируются — они
// всегда должны идти в сеть за свежим ответом.

const CACHE_NAME = "sparky-shell-v1";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {
      // Не критично, если часть файлов не закешировалась при первой установке.
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Всё, что уходит не на наш собственный домен (шрифты, сам ИИ),
  // — только сеть, никогда не кешируем и не подменяем ответом из кеша.
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
