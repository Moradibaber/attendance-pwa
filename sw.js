const CACHE_NAME = "attendance-pwa-v63";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.json"];

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
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

self.addEventListener("fetch", (event) => {
  // خارج کردن کامل درخواست‌های ساعت جهانی از حیطه مدیریت سرویس‌ورکر
  if (event.request.url.includes("worldtimeapi.org")) {
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

/* =========================
   Background Sync
   Fires when the OS/browser regains connectivity, even if the PWA is
   closed/backgrounded. Chrome/Android only - iOS Safari has no Background
   Sync support at all, so these tags simply never fire there; everything
   still falls back to the foreground triggers already in app.js.
========================= */

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-records") {
    event.waitUntil(syncPendingRecordsInBackground());
  }

  if (event.tag === "sync-heartbeat") {
    event.waitUntil(sendHeartbeatInBackground());
  }
});

// Best-effort periodic heartbeat on installed Android PWAs with enough
// engagement. The browser - not this code - decides the real interval
// (often hours), so this is a bonus signal, not something to rely on.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "heartbeat-periodic") {
    event.waitUntil(sendHeartbeatInBackground());
  }
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

        // Re-throw so Background Sync knows this attempt failed and
        // schedules an automatic retry with backoff.
        throw err;
      }
    }

    await notifyClients("SYNC_COMPLETE");
  } catch (err) {
    console.error("syncPendingRecordsInBackground Error:", err);
    await notifyClients("SYNC_FAILED");
    throw err;
  }
}

async function sendHeartbeatInBackground() {
  try {
    const db = await openDbInServiceWorker();
    const profile = await dbGetInServiceWorker(db, STORE_PROFILE, "main");

    if (!profile || !profile.personnelCode) return;

    const payload = {
      type: "Heartbeat",
      personnelCode: profile.personnelCode || "",
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      deviceTime: new Date().toISOString(),
      source: "background-sync"
    };

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    console.log("Background heartbeat HTTP status:", response.status);
  } catch (err) {
    console.error("sendHeartbeatInBackground Error:", err);
    // Re-throw so Background Sync retries automatically once connectivity
    // is confirmed to be back.
    throw err;
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

      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) {
        openedDb.createObjectStore(STORE_PROFILE, {
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

function dbGetInServiceWorker(db, store, key) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve(null);
      return;
    }

    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);

    req.onsuccess = () => resolve(req.result || null);
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
// sw.js - Service Worker for Background Reachability Probes

self.addEventListener('push', function (event) {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { probeId: event.data.text() };
    }
  }

  // استخراج ProbeID برای بازگرداندن رسید
  const probeId = data.probeId || 'unknown';
  const personnelCode = data.personnelCode || 'unknown';

  // ارسال رسید به سمت Backend بدون معطل کردن کاربر
  const receiptPromise = fetch('YOUR_APPS_SCRIPT_URL', {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordReceipt',
      probeId: probeId,
      personnelCode: personnelCode,
      clientTime: new Date().toISOString(),
      permissionState: Notification.permission,
      networkState: navigator.onLine ? 'online' : 'offline'
    })
  });

  // اگر دیتا شامل پیام متنی بود، نمایش بده (اختیاری برای مچ‌گیری نامحسوس)
  if (data.title) {
    const options = {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/badge.png',
      tag: 'probe-' + probeId
    };
    event.waitUntil(Promise.all([receiptPromise, self.registration.showNotification(data.title, options)]));
  } else {
    event.waitUntil(receiptPromise);
  }
});

// وقتی کاربر روی نوتیفیکیشن کلیک می‌کند
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
