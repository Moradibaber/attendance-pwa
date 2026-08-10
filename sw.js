const CACHE_NAME = "attendance-pwa-v218";
const FILES = [
  "./",
  "index.html", 
  "styles.css",
  "app.js?v=63",
  "manifest.json?v=2",
  "cover-rights-reserved.png"
];

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // fetch با {cache:'reload'} به‌جای cache.addAll معمولی - این تضمین
      // می‌کند که کش مرورگر/GitHub Pages دور زده شود و همیشه آخرین نسخه
      // واقعی فایل‌ها از شبکه گرفته شود، حتی اگر هدرهای HTTP کش قدیمی
      // را مجاز بدانند.
      await Promise.all(
        FILES.map(async (url) => {
          const response = await fetch(url, { cache: "reload" });
          await cache.put(url, response);
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
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Never intercept Google Apps Script / Google / Firebase – let the browser talk to the network directly
  if (
    url.includes('script.google.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('google.com') ||
    url.includes('firebase') ||
    url.includes('worldtimeapi.org')
  ) {
    return; // critical: do NOT call event.respondWith
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

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {};
  }

  const notif = payload.notification || {};
  const data = payload.data || {};
  const personnelCode = data.personnelCode || "";
  const title = notif.title || "بروزرسانی سیستم";
  const body = notif.body || "";

  event.waitUntil(
    (async () => {
      // Log the online event to the sheet FIRST — this is the whole point:
      // the fact this code is running at all proves the device is online right now.
      if (personnelCode) {
        try {
          await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
              type: "PushReceived",
              personnelCode: personnelCode,
              deviceTime: new Date().toISOString()
            })
          });
        } catch (err) {
          console.error("PushReceived log failed:", err);
        }
      }

      // Browsers require a visible notification when a push is shown.
      await self.registration.showNotification(title, {
        body: body,
        icon: "icon-192.png",
        silent: true,
        tag: "attendance-update"
      });
    })()
  );
});
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-pending-attendance") {
    event.waitUntil(syncPendingRecordsInBackground());
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

        // Prepare the same payload as the main app
    if (record.offlineCreated === true && !record.firstConnectionAfterOfflineRecord) {
      record.firstConnectionAfterOfflineRecord = new Date().toISOString();
    }
    record.lastConnectionBeforeUpload = new Date().toISOString();
    record.lastSyncTryAt = record.lastConnectionBeforeUpload;
    record.syncTryCount = Number(record.syncTryCount || 0) + 1;

    const payload = {
      clientRecordId: record.clientRecordId || "",
      personnelCode: record.personnelCode || "",
      firstName: record.firstName || "",
      lastName: record.lastName || "",
      password: record.password || "",
      type: record.type || record.recordType || "",
      recordType: record.recordType || record.type || "",
      recordDate: record.recordDate || "",
      recordHour: record.recordHour || record.recordTime || "",
      recordTime: record.recordTime || record.recordHour || "",
      latitude: record.latitude || "",
      longitude: record.longitude || "",
      accuracy: record.accuracy || "",
      locationStatus: record.locationStatus || "",
      locationError: record.locationError || "",
      deviceTime: record.deviceTime || "",
      deviceTimeAtClick: record.deviceTimeAtClick || "",
      deviceTimeAtPhoto: record.deviceTimeAtPhoto || "",
      deviceTimeAtPhotoCompressed: record.deviceTimeAtPhotoCompressed || "",
      deviceTimeAtGps: record.deviceTimeAtGps || "",
      gpsTimestamp: record.gpsTimestamp || "",
      gpsWaitMs: record.gpsWaitMs ?? "",
      photoDelayMs: record.photoDelayMs ?? "",
      submitDelayMs: record.submitDelayMs ?? "",
      offlineCreated: !!record.offlineCreated,
      createdOnline: record.createdOnline === true,
      connectionStatus: record.connectionStatus || (record.offlineCreated ? "offline" : "online"),
      connectionStatusFa: record.connectionStatusFa || (record.offlineCreated ? "آفلاین" : "آنلاین"),
      firstConnectionAfterOfflineRecord: record.firstConnectionAfterOfflineRecord || "",
      lastConnectionBeforeUpload: record.lastConnectionBeforeUpload || "",
      uploadedAt: record.uploadedAt || "",
      delayAfterFirstConnectionMs: record.delayAfterFirstConnectionMs ?? "",
      clockRisk: record.clockRisk || "",
      clockRiskReason: record.clockRiskReason || "",
      sessionClockDriftMs: record.sessionClockDriftMs ?? "",
      networkClockDriftMs: record.networkClockDriftMs ?? "",
      attendancePolicy: record.attendancePolicy || "ONLINE_OR_OFFLINE",
      policyVersion: Number(record.policyVersion || 0),
      policyFetchedAt: record.policyFetchedAt || "",
      policySource: record.policySource || "",
      photo: record.photo || "",
      createdAt: record.createdAt || "",
      lastSyncTryAt: record.lastSyncTryAt || "",
      syncTryCount: Number(record.syncTryCount || 0),
      workLocation: record.workLocation || ""
    };

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
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
