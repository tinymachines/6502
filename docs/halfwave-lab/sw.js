/* The Lab's offline shell.
 *
 * The app is one file that already degrades to a packed trace when no API
 * answers, so a cached shell with no network is still a working lab. The
 * strategy is therefore simple and honest:
 *
 *  - navigations and same-origin assets: network first, cache fallback, so
 *    a deploy shows on the next online load and offline gets the last one;
 *  - /api is NEVER touched: every response there reflects the machine just
 *    POSTed, and a cache would hand one client another client's chip.
 */
const CACHE = "halfwave-shell-v1";
const SHELL = ["./", "manifest.webmanifest",
               "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/api")) return; // stateless: never cached
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" });
      if (hit) return hit;
      throw new Error("offline and not cached");
    }
  })());
});
