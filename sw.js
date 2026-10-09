// Bei Änderungen an der App diese Nummer erhöhen, damit iPhones die neue Version laden.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const IMAGES = 'tmdb-images';
const FILES = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './icons/apple-touch-icon.png', './icons/icon-192.png',
  'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Cover-Bilder: einmal laden, dann offline aus dem Cache
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(caches.open(IMAGES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App-Dateien: Netz zuerst (damit Updates ankommen), sonst Cache
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
    );
  }
});
