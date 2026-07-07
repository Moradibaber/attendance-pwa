const CACHE_NAME = "attendance-pwa-v75"; 
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.json"];

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(FILES);
    })
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  // خارج کردن کامل درخواست‌های ساعت جهانی از حیطه مدیریت سرویس‌ورکر
  if (event.request.url.includes('worldtimeapi.org')) {
    return; 
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).catch(() => {
        console.warn("Fetch failed and not in cache:", event.request.url);
        return new Response("Offline Content Not Available", { status: 503 });
      });
    })
  );
});

async function syncPendingRecordsInBackground() {
  try {
    const db = await openDbInServiceWorker();
    const records = await dbGetAllInServiceWorker(db, STORE_RECORDS);
    const list = records.filter((r) => r.status === "pending" || r.status === "failed");

    if (!list.length) {
      await notifyClients("SYNC_COMPLETE");
      return;
    } 

  for (const record of list) {

  try {

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(record)
    });

    const text = await response.text();

    console.log("Sending to:", APPS_SCRIPT_URL);
    console.log("HTTP Status:", response.status);
    console.log("Response:", text);

    const result = JSON.parse(text);

    if (result.ok) {
      record.status = "sent";
    } else {
      record.status = "failed";
    }

    await dbPutInServiceWorker(db, STORE_RECORDS, record);

  } catch (err) {

    console.error("SW Sync Error:", err);
    console.error("URL:", APPS_SCRIPT_URL);

    record.status = "failed";
    await dbPutInServiceWorker(db, STORE_RECORDS, record);

  }

}   // پایان حلقه for

await notifyClients("SYNC_COMPLETE");

} catch (err) {

  console.error("syncPendingRecordsInBackground Error:", err);

  await notifyClients("SYNC_FAILED");
}
function openDbInServiceWorker() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const openedDb = e.target.result;

      if (!openedDb.objectStoreNames.contains(STORE_RECORDS)) {
        const store = openedDb.createObjectStore(STORE_RECORDS, {
          keyPath: "id",
          autoIncrement: true
        });

        store.createIndex("status", "status");
      }

      if (!openedDb.objectStoreNames.contains("profile")) {
        openedDb.createObjectStore("profile", {
          keyPath: "id"
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAllInServiceWorker(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPutInServiceWorker(db, store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.put(value);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function notifyClients(type) {
  const clientsList = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window"
  });

  for (const client of clientsList) {
    client.postMessage({
      type
    });
  }
}
}
