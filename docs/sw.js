// Service worker: uygulama kabuğunu önbelleğe alır ve push bildirimlerini gösterir.
// Arayüz dosyalarını değiştirdiğinde SURUM'ü bir artır.
const SURUM = "gorev-v1";
const KABUK = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/badge-72.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SURUM).then((c) => c.addAll(KABUK)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SURUM).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Önce ağ, olmazsa önbellek: güncellemeler hemen görünür, çevrimdışıyken de açılır.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SURUM).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Görev Asistanı", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Görev Asistanı";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "genel",
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/badge-72.png",
      data: { url: data.url || "./" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
