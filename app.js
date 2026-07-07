// Frontend.js
// PLACE: replace the whole file content with this full code

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 1;
const STORE_PROFILE = "profile";
const STORE_RECORDS = "records";
const STORE_META = "meta";

const DEFAULT_ATTENDANCE_POLICY = "standard";
const HEARTBEAT_INTERVAL_MS = 60000;
let heartbeatTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
  await initDb();
  bindEvents();
  await loadProfile();
  await ensurePolicyLoadedAtStartup();
  refreshUi();
  fetchMessages();
  setupAutoSync();
  startHeartbeat();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});

window.addEventListener("online", () => {
  refreshNetworkStatus();
  syncPendingRecords();
  sendHeartbeat();
});

window.addEventListener("offline", () => {
  refreshNetworkStatus();
  sendHeartbeat();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshNetworkStatus();
    if (navigator.onLine) {
      syncPendingRecords();
      sendHeartbeat();
    }
  }
});

function bindEvents() {
  const saveProfileBtn = document.getElementById("saveProfileBtn");
  const attendanceBtn = document.getElementById("attendanceBtn");
  const syncBtn = document.getElementById("syncBtn");

  if (saveProfileBtn) saveProfileBtn.addEventListener("click", saveProfile);
  if (attendanceBtn) attendanceBtn.addEventListener("click", registerAttendance);
  if (syncBtn) syncBtn.addEventListener("click", syncPendingRecords);
}

function refreshUi() {
  refreshNetworkStatus();
}

function refreshNetworkStatus() {
  const el = document.getElementById("networkStatus");
  if (!el) return;

  if (navigator.onLine) {
    el.textContent = "آنلاین";
    el.className = "status online";
  } else {
    el.textContent = "آفلاین";
    el.className = "status offline";
  }
}

function setupAutoSync() {
  setInterval(() => {
    if (navigator.onLine) {
      syncPendingRecords();
    }
  }, 30000);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

async function sendHeartbeat() {
  const profile = await getProfile();
  if (!profile || !String(profile.personnelCode || "").trim()) return;
  if (!navigator.onLine) return;

  const payload = {
    type: "ConnectionStatus",
    personnelCode: String(profile.personnelCode || "").trim(),
    firstName: String(profile.firstName || "").trim(),
    lastName: String(profile.lastName || "").trim(),
    status: "آنلاین",
    connectionStatusFa: "آنلاین",
    online: true,
    clientTime: new Date().toISOString(),
    source: "heartbeat"
  };

  try {
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

async function saveProfile() {
  const personnelCode = String(document.getElementById("personnelCode")?.value || "").trim();
  const firstName = String(document.getElementById("firstName")?.value || "").trim();
  const lastName = String(document.getElementById("lastName")?.value || "").trim();

  const profile = {
    id: "profile",
    personnelCode,
    firstName,
    lastName,
    savedAt: new Date().toISOString()
  };

  await dbPut(STORE_PROFILE, profile);
  refreshUi();
}

async function loadProfile() {
  const profile = await getProfile();
  if (!profile) return;

  const personnelCode = document.getElementById("personnelCode");
  const firstName = document.getElementById("firstName");
  const lastName = document.getElementById("lastName");

  if (personnelCode) personnelCode.value = profile.personnelCode || "";
  if (firstName) firstName.value = profile.firstName || "";
  if (lastName) lastName.value = profile.lastName || "";
}

async function getProfile() {
  return await dbGet(STORE_PROFILE, "profile");
}

async function registerAttendance() {
  const profile = await getProfile();
  if (!profile || !String(profile.personnelCode || "").trim()) return;

  const now = new Date();
  const record = {
    id: crypto.randomUUID(),
    clientRecordId: crypto.randomUUID(),
    type: "Attendance",
    recordType: "Attendance",
    personnelCode: String(profile.personnelCode || "").trim(),
    firstName: String(profile.firstName || "").trim(),
    lastName: String(profile.lastName || "").trim(),
    recordDate: formatDate(now),
    recordHour: formatTime(now),
    recordTime: now.toISOString(),
    deviceTime: now.toISOString(),
    deviceTimeAtClick: now.toISOString(),
    deviceTimeAtPhoto: "",
    deviceTimeAtPhotoCompressed: "",
    deviceTimeAtGps: "",
    gpsTimestamp: "",
    latitude: "",
    longitude: "",
    accuracy: "",
    locationStatus: "",
    locationError: "",
    gpsWaitMs: "",
    photoDelayMs: "",
    submitDelayMs: 0,
    offlineCreated: !navigator.onLine,
    createdOnline: !!navigator.onLine,
    connectionStatus: navigator.onLine ? "online" : "offline",
    connectionStatusFa: navigator.onLine ? "آنلاین" : "آفلاین",
    firstConnectionAfterOfflineRecord: "",
    lastConnectionBeforeUpload: "",
    uploadedAt: "",
    delayAfterFirstConnectionMs: "",
    clockRisk: "",
    clockRiskReason: "",
    sessionClockDriftMs: "",
    networkClockDriftMs: "",
    attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
    policyVersion: 0,
    policyFetchedAt: "",
    policySource: "",
    photo: "",
    createdAt: now.toISOString(),
    lastSyncTryAt: "",
    syncTryCount: 0,
    status: "pending",
    syncedAt: "",
    serverResponse: ""
  };

  await dbPut(STORE_RECORDS, record);

  if (navigator.onLine) {
    await syncPendingRecords();
  }
}

async function syncPendingRecords() {
  if (!navigator.onLine) return;

  const records = await dbGetAll(STORE_RECORDS);
  const pending = records.filter(r => r.status !== "sent");

  for (const r of pending) {
    try {
      r.status = "syncing";
      r.lastSyncTryAt = new Date().toISOString();
      r.syncTryCount = Number(r.syncTryCount || 0) + 1;
      await dbPut(STORE_RECORDS, r);

      const payload = buildServerPayload(r);

      await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });

      r.status = "sent";
      r.syncedAt = new Date().toISOString();
      r.uploadedAt = r.syncedAt;
      r.serverResponse = "sent";
      await dbPut(STORE_RECORDS, r);
    } catch (err) {
      r.status = "failed";
      r.serverResponse = JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err)
      });
      await dbPut(STORE_RECORDS, r);
    }
  }
}

function buildServerPayload(record) {
  return {
    clientRecordId: record.clientRecordId || "",
    personnelCode: record.personnelCode || "",
    firstName: record.firstName || "",
    lastName: record.lastName || "",
    type: record.type || record.recordType || "",
    recordType: record.recordType || record.type || "",
    recordDate: record.recordDate || "",
    recordHour: record.recordHour || "",
    recordTime: record.recordTime || "",
    deviceTime: record.deviceTime || "",
    deviceTimeAtClick: record.deviceTimeAtClick || "",
    deviceTimeAtPhoto: record.deviceTimeAtPhoto || "",
    deviceTimeAtPhotoCompressed: record.deviceTimeAtPhotoCompressed || "",
    deviceTimeAtGps: record.deviceTimeAtGps || "",
    gpsTimestamp: record.gpsTimestamp || "",
    latitude: record.latitude || "",
    longitude: record.longitude || "",
    accuracy: record.accuracy || "",
    locationStatus: record.locationStatus || "",
    locationError: record.locationError || "",
    gpsWaitMs: record.gpsWaitMs || "",
    photoDelayMs: record.photoDelayMs || "",
    submitDelayMs: Number(record.submitDelayMs || 0),
    offlineCreated: !!record.offlineCreated,
    createdOnline: !!record.createdOnline,
    connectionStatus: record.connectionStatus || "",
    connectionStatusFa: record.connectionStatusFa || "",
    firstConnectionAfterOfflineRecord: record.firstConnectionAfterOfflineRecord || "",
    lastConnectionBeforeUpload: record.lastConnectionBeforeUpload || "",
    uploadedAt: record.uploadedAt || "",
    delayAfterFirstConnectionMs: record.delayAfterFirstConnectionMs || "",
    clockRisk: record.clockRisk || "",
    clockRiskReason: record.clockRiskReason || "",
    sessionClockDriftMs: record.sessionClockDriftMs || "",
    networkClockDriftMs: record.networkClockDriftMs || "",
    attendancePolicy: record.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
    policyVersion: Number(record.policyVersion || 0),
    policyFetchedAt: record.policyFetchedAt || "",
    policySource: record.policySource || "",
    photo: record.photo || "",
    createdAt: record.createdAt || "",
    lastSyncTryAt: record.lastSyncTryAt || "",
    syncTryCount: Number(record.syncTryCount || 0)
  };
}

async function fetchMessages() {
  const profile = await getProfile();
  const pCode = String(profile?.personnelCode || "").trim();
  if (!pCode) return;

  try {
    const url = `${APPS_SCRIPT_URL}?action=getMessages&personnelCode=${encodeURIComponent(pCode)}&_=${Date.now()}`;
    await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
  } catch (_) {}
}

async function ensurePolicyLoadedAtStartup() {
  return;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function formatTime(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function initDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function (event) {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
    };

    req.onsuccess = function () {
      resolve();
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}

function getDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onsuccess = function () {
      resolve(req.result);
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}

async function dbPut(storeName, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(value);

    req.onsuccess = function () {
      resolve(value);
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}

async function dbGet(storeName, key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);

    req.onsuccess = function () {
      resolve(req.result || null);
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}

async function dbGetAll(storeName) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();

    req.onsuccess = function () {
      resolve(req.result || []);
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}
