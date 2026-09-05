/**
 * The smallest service worker that does something honest.
 *
 * This is a multiplayer game: it is useless without a network, so there is no
 * pretence of offline play. The worker exists to make the app installable (a
 * fetch handler is part of the install criteria) and to make a repeat launch
 * from the home screen instant instead of a cold round-trip.
 *
 * It deliberately never touches matchmaking or gameplay traffic — those must
 * always hit the live server.
 */
const VERSION = "v1";
const SHELL = `stickstakes-shell-${VERSION}`;
const ASSETS = `stickstakes-assets-${VERSION}`;
const KEEP = new Set([SHELL, ASSETS]);

self.addEventListener("install", (event) => {
  // Warm the shell so the very first launch from the home screen is instant.
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(["/", "/manifest.webmanifest"]))
      .catch(() => {}) // a cold install offline is fine; the fetch handler copes
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Anything the live server must answer itself. */
function isLiveTraffic(url) {
  return (
    url.pathname.startsWith("/colyseus") ||
    url.pathname.startsWith("/matchmake") ||
    url.pathname.startsWith("/health") ||
    url.pathname.startsWith("/__healthcheck")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveTraffic(url)) return;

  // Navigations: network first, so a deploy is picked up immediately; the
  // cached shell is only a fallback for a flaky restaurant connection.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Vite fingerprints everything under /assets, so a hit can never be stale.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSETS).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Icons and the manifest: serve fast, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(ASSETS).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    }),
  );
});
