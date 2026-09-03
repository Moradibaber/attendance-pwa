const CACHE_NAME = "attendance-pwa-v350"; 
const FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js?v=63",
  "manifest.json?v=2",
  "cover-rights-reserved.png"
];
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./sw.js",
  "./pwa-qr.png",   // ← add this
  // ... other files
];
const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        FILES.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            await cache.put(url, response);
          } catch (e) {
            console.warn("Cache put failed for", url, e);
          }
        })
      );
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
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Never intercept Google / Firebase / time APIs
  if (
    url.includes("script.google.com") ||
    url.includes("googleapis.com") ||
    url.includes("gstatic.com") ||
    url.includes("google.com") ||
    url.includes("firebase") ||
    url.includes("worldtimeapi.org")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return (
        cachedResponse ||
        fetch(event.request).catch(() => {
          console.warn("Fetch failed and not in cache:", event.request.url);
          return new Response("Offline Content Not Available", { status: 503 });
        })
      );
    })
  );
});
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let personnelCode = "";
    let title = "یادآوری تردد";
    let body = " ";

    // ---- Parse payload safely ----
    try {
      if (event.data) {
        const payload = event.data.json();
        console.log("SW Push payload:", payload);

        const data = payload.data || payload || {};
        personnelCode =
          data.personnelCode ||
          data.personnelcode ||
          data.PersonnelCode ||
          payload.personnelCode ||
          "";

        if (payload.notification) {
          title = payload.notification.title || title;
          body = payload.notification.body || body;
        }
      }
    } catch (e) {
      console.error("SW parse error:", e);
    }

    // ---- Fallback: read from IndexedDB ----
    if (!personnelCode) {
      try {
        const db = await openDbInServiceWorker();
        const profile = await dbGetInServiceWorker(db, "profile", "main");
        if (profile && profile.personnelCode) {
          personnelCode = profile.personnelCode;
          console.log("SW used profile fallback:", personnelCode);
        }
      } catch (e) {
        console.warn("SW profile fallback failed:", e);
      }
    }

    console.log("SW final personnelCode:", personnelCode);

    // ---- Always report to server ----
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          type: "PushReceived",
          personnelCode: String(personnelCode || "UNKNOWN"),
          deviceId: "",
          deviceTime: new Date().toISOISOString(),
          source: "sw-push"
        })
      });
      console.log("SW PushReceived status:", res.status);
    } catch (err) {
      console.error("SW PushReceived failed:", err);
    }

    // ---- Show notification (keeps SW alive) ----
    try {
      await self.registration.showNotification(title, {
        body: body,
        icon: "icon-192.png",
        badge: "icon-192.png",
        silent: true,
        tag: "attendance-ping",
        data: { personnelCode }
      });
    } catch (e) {
      console.error("showNotification error:", e);
    }
  })());
});

async function syncPendingRecordsInBackground() {
  try {
    const db = await openDbInServiceWorker();
    const records = await dbGetAllInServiceWorker(db, STORE_RECORDS);
    const list = records.filter(
      (r) => r.status === "pending" || r.status === "failed"
    );

    if (!list.length) {
      await notifyClients("SYNC_COMPLETE");
      return;
    }

    for (const record of list) {
      try {
        const response = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
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
    }

    await notifyClients("SYNC_COMPLETE");
  } catch (err) {
    console.error("syncPendingRecordsInBackground Error:", err);
    await notifyClients("SYNC_FAILED");
  }
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
        openedDb.createObjectStore("profile", { keyPath: "id" });
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

function dbGetInServiceWorker(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
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
    client.postMessage({ type });
  }
}
