/* global self, caches, fetch, URL, Response, Blob */

const scope = new URL(self.registration.scope);
const options = new URL(self.location.href).searchParams;
const storageOrigin = options.get("storage");
const cachePrefix = `fanscan-images:${scope.pathname}:`;
const cacheName = `${cachePrefix}r10`;
const hour = 60 * 60 * 1000;
const staticLifetime = options.has("dev") ? 5 * 60 * 1000 : 24 * hour;
const maxImageBytes = 20 * 1024 * 1024;
const maxCacheBytes = 128 * 1024 * 1024;
const maxImages = 300;
const storedAtHeader = "x-fanscan-stored-at";
const sizeHeader = "x-fanscan-image-bytes";
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const localImage = /^(?:(?:art|avatars|brand|optimized|share)\/.+\.(?:avif|gif|jpe?g|png|webp)|favicon\.svg)$/i;
const publicObject = new RegExp(
  "^/storage/v1/object/public/(?:rosscan-public/(?:" +
    `comics/[a-z0-9-]+/(?:(?:covers|backgrounds)/${uuid}\\.webp|chapters/[0-9]+/${uuid}/[0-9]{3}\\.webp)` +
    `|home/${uuid}/(?:desktop|mobile)\\.webp)|fanscan-avatars/${uuid}/${uuid}\\.webp)$`,
  "i",
);

let storage;
let cacheIndex;
let activeIndex;
let pendingWrite = Promise.resolve();

function imagePolicy(request) {
  if (
    request.method !== "GET" || request.cache === "no-store" ||
    !["", "image"].includes(request.destination) ||
    ["authorization", "apikey", "range"].some((header) => request.headers.has(header))
  ) return null;

  const url = new URL(request.url);
  if (url.search || url.hash || url.username || url.password) return null;

  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)) {
    if (localImage.test(url.pathname.slice(scope.pathname.length))) {
      return { lifetime: staticLifetime, crossOrigin: false };
    }
  }
  if (url.origin === storageOrigin && publicObject.test(url.pathname)) {
    return { lifetime: hour, crossOrigin: url.origin !== scope.origin };
  }
  return null;
}

async function indexCache(cache) {
  const entries = new Map();
  let bytes = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const size = Number(response?.headers.get(sizeHeader));
    const storedAt = Number(response?.headers.get(storedAtHeader));
    if (!(size > 0 && storedAt > 0)) {
      await cache.delete(request);
      continue;
    }
    entries.set(request.url, size);
    bytes += size;
  }
  activeIndex = { entries, bytes };
  return activeIndex;
}

async function readImage(response, type) {
  // Enforce the byte limit even if the upstream size header is unavailable.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return size ? new Blob(chunks, { type }) : null;
      size += value.byteLength;
      if (size > maxImageBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function saveImage(cache, request, response, type) {
  const [image, state] = await Promise.all([
    readImage(response, type),
    (cacheIndex ??= indexCache(cache)),
  ]);
  if (!image || request.signal.aborted) return;
  const { entries } = state;
  const url = request.url;
  const write = pendingWrite.then(async () => {
    const previousSize = entries.get(url) ?? 0;
    for (const [oldUrl, oldSize] of entries) {
      const count = entries.size + Number(!entries.has(url));
      if (count <= maxImages && state.bytes - previousSize + image.size <= maxCacheBytes) break;
      if (oldUrl === url) continue;
      await cache.delete(oldUrl);
      entries.delete(oldUrl);
      state.bytes -= oldSize;
    }
    await cache.put(url, new Response(image, {
      headers: {
        "content-type": type,
        [storedAtHeader]: String(Date.now()),
        [sizeHeader]: String(image.size),
      },
    }));
    entries.delete(url);
    entries.set(url, image.size);
    state.bytes += image.size - previousSize;
  });
  pendingWrite = write.catch(() => undefined);
  await write;
}

async function serveImage(request, policy) {
  let cache;
  try {
    cache = await (storage ??= caches.open(cacheName));
    if (request.cache !== "reload") {
      const cached = await cache.match(request.url);
      const storedAt = Number(cached?.headers.get(storedAtHeader));
      if (storedAt && Date.now() - storedAt < policy.lifetime) {
        const entries = activeIndex?.entries;
        const size = entries?.get(request.url);
        if (size) {
          entries.delete(request.url);
          entries.set(request.url, size);
        }
        return { response: cached };
      }
    }
  } catch {
    // Browser storage may be unavailable. Image requests must still work.
  }

  let response;
  if (policy.crossOrigin && request.mode === "no-cors") {
    try {
      // A readable CORS response lets us verify and bound the bytes in Cache Storage.
      response = await fetch(request.url, {
        mode: "cors", credentials: "omit", signal: request.signal, cache: request.cache,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return { response: await fetch(request) };
    }
  } else {
    response = await fetch(request);
  }

  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (
    !cache || response.status !== 200 || response.redirected || !response.body ||
    !type?.startsWith("image/") || /\b(?:no-store|private)\b/i.test(cacheControl) ||
    Number(response.headers.get("content-length")) > maxImageBytes
  ) return { response };

  return { response, saved: saveImage(cache, request, response.clone(), type) };
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      for (const name of await caches.keys()) {
        if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
      }
    } finally {
      await self.clients.claim();
    }
  })());
});
self.addEventListener("fetch", (event) => {
  const policy = imagePolicy(event.request);
  if (!policy) return;

  const result = serveImage(event.request, policy);
  event.respondWith(result.then(({ response }) => response));
  event.waitUntil(result.then(({ saved }) => saved).catch(() => undefined));
});
