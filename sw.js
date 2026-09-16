// Scanly — Service Worker (Phase 4 → extended in Phase 10)
//
// SCOPE IS DELIBERATELY NARROW, on purpose, still. This worker exists for TWO reasons now:
//
//   1) (Phase 4, unchanged) Receive the Android/WhatsApp "Share → Scanly" POST request
//      defined by `share_target` in manifest.json — a browser only lets an installed PWA
//      appear in the OS share sheet, and only receives the shared file, through a Service
//      Worker; there is no way to do this with a plain server route.
//
//   2) (Phase 10 — E: Offline App Shell, NEW) Let the app SHELL (the page itself, the
//      vendored Panzoom script, the manifest, and whatever static assets the browser
//      requests for it) still open when the driver has no signal — NOT full offline-first
//      functionality. Receipt scanning still needs a live connection to Gemini either way.
//
// What is still explicitly NEVER cached, even after Phase 10:
//   - Anything under /api/ (Gemini calls) — checked by path, GET or POST, always network.
//   - The Share Target POST route itself — untouched, handled by its own branch below,
//     completely separate from the caching logic.
//   - Cross-origin requests (Google Fonts, etc.) — only same-origin GET requests are
//     touched by the cache logic at all.
//
// Cache versioning: CACHE_NAME below must be bumped any time the cached asset set changes
// in a future edit — the activate handler purges every OTHER cache name automatically, so
// a stale shell from an old deploy never lingers indefinitely.
//
// Lifecycle: skipWaiting() + clients.claim() are still used, same as Phase 4, so the worker
// controls the page immediately without requiring the driver to close and reopen the app.
// This remains safe with caching added because Scanly is one single index.html with no
// lazy-loaded/dynamically-imported JS chunks after first load — the classic risk this
// pattern usually warns about (an old already-running page suddenly fetching a new,
// incompatible lazy chunk through a newly-activated worker) doesn't apply here. The actual
// update-lifecycle behavior (deploying a new sw.js while the app is already open) still
// has NOT been exercised on a real device — flagged explicitly in the Phase 10 report,
// same honest caveat Phase 4/5 already carried forward for this exact open item.

const CACHE_NAME = 'scanly-shell-v1';
const APP_SHELL_URLS = ['/', '/manifest.json', '/vendor/panzoom.min.js'];

const SHARE_TARGET_PATH = '/share-target';
const DB_NAME = 'scanly-share-target';
const DB_VERSION = 1;
const STORE_NAME = 'pending-image';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB ceiling — generous for a phone photo, guards against abuse

function openShareDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)){
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Only ever one pending shared image at a time — storing a new one always
// replaces (clears) any previous leftover, so nothing accumulates and nothing
// shared is ever kept as permanent storage.
async function storeSharedImage(blob){
  const db = await openShareDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    store.put({ id: 'pending', blob, mimeType: blob.type, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function handleShareTarget(event){
  try{
    const formData = await event.request.formData();
    const file = formData.get('image');
    // Validate MIME type and size BEFORE ever touching storage. Anything that
    // fails this check is dropped entirely (never written to IndexedDB) and the
    // driver is sent into the app normally — camera/gallery capture still work.
    if (!(file instanceof File) || !file.type.startsWith('image/') || file.size === 0 || file.size > MAX_IMAGE_BYTES){
      return Response.redirect('/', 303);
    }
    await storeSharedImage(file);
    return Response.redirect('/?shared=1', 303);
  }catch(err){
    return Response.redirect('/', 303);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      // Phase 10 — E: if precaching fails for any reason (one asset 404s, briefly
      // offline during install, etc.) the worker still installs normally — a failed
      // precache just means the shell isn't available offline yet until the next
      // successful online visit. It must never block Share Target from working.
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Phase 10 — E: purge any cache from a previous CACHE_NAME so a stale shell
      // from an old deploy never lingers once a new version activates.
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH){
    event.respondWith(handleShareTarget(event));
    return;
  }

  // Phase 10 — E: Offline App Shell, strictly scoped —
  //   - GET only (every mutating/POST request, including Share Target above and every
  //     Gemini call, is completely untouched by anything below this line).
  //   - same-origin only (Google Fonts and any other cross-origin request falls straight
  //     through to normal browser networking, exactly as before Phase 10).
  //   - never for /api/ (both Gemini endpoints are POST anyway, but this is an explicit,
  //     defensive exclusion by path regardless of method).
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate'){
    // Network-first for the HTML shell itself: a driver with a live connection always
    // gets the current app; the cached shell is only ever served when genuinely offline.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Cache-first for static assets (manifest, vendored Panzoom, icons) — anything not
  // precached at install gets cached opportunistically on its first successful fetch.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok){
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});
