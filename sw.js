// Scanly — Service Worker (Phase 4)
//
// SCOPE IS DELIBERATELY NARROW. This is the first Service Worker ever added to
// this project. It exists for exactly ONE reason: to receive the Android/
// WhatsApp "Share → Scanly" POST request defined by `share_target` in
// manifest.json (a browser only lets an installed PWA appear in the OS share
// sheet, and only receives the shared file, through a Service Worker — there
// is no way to do this with a plain server route).
//
// It does NOT implement offline support, does NOT cache the app shell, and does
// NOT use the Cache Storage API at all. Its `fetch` handler only ever calls
// respondWith() for the exact share-target POST route below — every other
// request (index.html, /api/extract-phone, /api/extract-receipt, images,
// fonts, everything) is left completely alone and falls through to normal
// browser networking, untouched by this file.
//
// Lifecycle: skipWaiting() + clients.claim() are used so the worker starts
// controlling the page immediately after install, without requiring the driver
// to close and reopen the app first. This is safe specifically BECAUSE this
// worker never caches anything — there is no "stale cached version" risk that
// the usual advice against immediate skipWaiting()/clients.claim() is about.

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

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH){
    event.respondWith(handleShareTarget(event));
    return;
  }
  // Every other request: no respondWith() call — falls through to default
  // browser networking exactly as if this Service Worker did not exist.
});
