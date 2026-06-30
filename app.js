const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 4;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzCXbn278amilnb9NUMM_tpMMzspMLQ2s37dXJGWCXf5tx_8VLU2RN3pYjqQ2kA21t1/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;
const CLOCK_DRIFT_SESSION_LIMIT_MS = 10 * 1000;
const CLOCK_DRIFT_NETWORK_LIMIT_MS = 2 * 60 * 1000;

const DEFAULT_ATTENDANCE_POLICY = "ONLINE_OR_OFFLINE";
const APP_SESSION_START_WALL_MS = Date.now();
const APP_SESSION_START_PERF_MS = performance.now();

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;
let syncTimer = null;
let adminMessageShownOnEntry = false;
let captureStartedAtMs = 0;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  try { db = await openDb(); } catch(e) { console.error("DB init", e); }
  bindEvents();
  await loadProfile();
  await ensurePolicyLoadedAtStartup();
  await refreshUi();
  await fetchMessages();
  setupAutoSync();
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const openedDb = e.target.result;
      if (!openedDb.objectStoreNames.contains(STORE_RECORDS)) {
        const store = openedDb.createObjectStore(STORE_RECORDS, { keyPath: "id", autoIncrement: true });
        store.createIndex("status", "status");
        store.createIndex("clientRecordId", "clientRecordId");
      }
      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) openedDb.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      if (!openedDb.objectStoreNames.contains(STORE_CONFIG)) openedDb.createObjectStore(STORE_CONFIG, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function createRecord(type) {
  const profile = await getProfile();
  const { policyInfo, gate } = await getCurrentAttendanceGate();
  if (!gate.ok) { setStatus(gate.message); return; }

  const loc = hasValidLocation(pendingLocation) ? pendingLocation : emptyLocation("not_received", "GPS دریافت نشد");
  const now = new Date();
  const nowMs = now.getTime();
  const clickMs = captureStartedAtMs || nowMs;
  
  // محاسبه درایفت زمان به صورت ایمن
  const sessionClockDriftMs = getSessionClockDriftMs();
  let networkClockDriftMs = 0;
  if (navigator.onLine) {
    getNetworkTimeDriftMs(nowMs).then(drift => {
       if (drift !== null) networkClockDriftMs = drift;
    }).catch(() => {});
  }

  // محاسبه ریسک بدون خطای سینتکس
  const risk = calculateClockRisk({ 
      sessionClockDriftMs, 
      networkClockDriftMs, 
      gpsMs: loc.timestamp, 
      clickMs, 
      offlineCreated: !navigator.onLine,
      locationStatus: loc.status
  });

  const record = {
    clientRecordId: createClientRecordId(profile.personnelCode, clickMs),
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type: type,
    recordDate: getPersianDate(now),
    recordTime: getTime(now),
    latitude: loc.latitude || "",
    longitude: loc.longitude || "",
    accuracy: loc.accuracy || "",
    locationStatus: loc.status || "",
    clockRisk: risk.clockRisk,
    clockRiskReason: risk.clockRiskReason,
    sessionClockDriftMs,
    networkClockDriftMs,
    photo: currentPhoto || "",
    status: "pending",
    createdAt: now.toISOString()
  };

  await dbPut(STORE_RECORDS, record);
  showGpsToast("✅ تردد ذخیره شد", 3000, "success");
  await refreshUi();
  if (navigator.onLine) scheduleSyncPendingRecords(500);
}

function calculateClockRisk(data) {
  const reasons = [];
  let score = 0;
  if (Math.abs(Number(data.sessionClockDriftMs) || 0) > CLOCK_DRIFT_SESSION_LIMIT_MS) {
    score += 6; reasons.push("تغییر ساعت سیستم");
  }
  if (data.offlineCreated) { score += 1; reasons.push("ثبت آفلاین"); }
  if (data.locationStatus !== "ok") { score += 4; reasons.push("GPS نامعتبر"); }
  return { clockRisk: score >= 6 ? "high" : "low", clockRiskReason: reasons.join(" | ") || "نرمال" };
}

async function getNetworkTimeDriftMs(localNowMs) {
  try {
    const response = await fetch("https://worldtimeapi.org/api/timezone/Etc/UTC", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const data = await response.json();
    return new Date(data.utc_datetime).getTime() - localNowMs;
  } catch (e) { return null; }
}
async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;
  syncRunning = true;
  try {
    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter(r => r.status === "pending" || r.status === "failed");
    
    for (const r of list) {
      try {
        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          mode: "cors",
          body: JSON.stringify(r)
        });
        const result = await res.json().catch(() => ({ ok: false }));
        if (result.ok) {
          r.status = "sent";
          r.syncedAt = new Date().toISOString();
          await dbPut(STORE_RECORDS, r);
        }
      } catch (err) { r.status = "failed"; await dbPut(STORE_RECORDS, r); }
    }
  } finally {
    syncRunning = false;
    await refreshUi();
  }
}

function scheduleSyncPendingRecords(delay = 0) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncPendingRecords(), delay);
}

function setupAutoSync() {
  window.addEventListener("online", () => {
    updateOnlineBadge();
    scheduleSyncPendingRecords(1000);
  });
  window.addEventListener("offline", updateOnlineBadge);
}

// توابع کمکی که در کد اصلی داشتید (مانند bindEvents, compressImage, ... را اینجا ادامه دهید)
function updateOnlineBadge() {
  const b = $("onlineBadge");
  if (b) {
    b.textContent = navigator.onLine ? "آنلاین" : "آفلاین";
    b.className = navigator.onLine ? "status online" : "status offline";
  }
}
