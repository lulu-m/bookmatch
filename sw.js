// BOOKMATCH — service worker : l'app s'ouvre vite, et même hors connexion
// Changer VERSION à chaque mise en ligne force la mise à jour chez les lecteurs.
const VERSION = "bm-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png",
  ...Array.from({ length: 10 }, (_, n) => `sprites/s${n}.jpg`)];

// Installation : on garde la coquille de l'app et les planches de couvertures
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
// Activation : on supprime les anciennes versions
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== "bm-img").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Données (Supabase) : toujours en direct
  if (url.hostname.endsWith("supabase.co")) return;
  // Page de l'app : réseau d'abord (pour avoir la dernière version), sinon la copie gardée
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(VERSION).then((x) => x.put("index.html", c)); return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  // Couvertures et polices : copie gardée d'abord (affichage instantané), réseau sinon
  const isImg = req.destination === "image" || /\/(covers|sprites|icons)\//.test(url.pathname);
  const isFont = url.hostname.includes("fonts.g");
  if (isImg || isFont || url.origin === location.origin) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r && (r.ok || r.type === "opaque")) { const c = r.clone(); caches.open(isImg ? "bm-img" : VERSION).then((x) => x.put(req, c)); }
      return r;
    }).catch(() => hit)));
  }
});
