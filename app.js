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
let captureStartedAtMs = 0;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  try {
    showGpsToast("★ حتما جی پی اس و اینترنت خود را روشن کنید", 5000, "error");
    db = await openDb();
    bindEvents();
    await loadProfile();
    await ensurePolicyLoadedAtStartup();
    await refreshUi();
    await fetchMessages();
    setupAutoSync();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  } catch(e) { console.error("Init error", e); }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_RECORDS)) {
        const s = d.createObjectStore(STORE_RECORDS, { keyPath: "id", autoIncrement: true });
        s.createIndex("status", "status");
      }
      if (!d.objectStoreNames.contains(STORE_PROFILE)) d.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(STORE_CONFIG)) d.createObjectStore(STORE_CONFIG, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function bindEvents() {
  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);
}

function setupAutoSync() {
  updateOnlineBadge();
  window.addEventListener("online", () => {
    updateOnlineBadge();
    scheduleSyncPendingRecords(1000);
  });
  window.addEventListener("offline", updateOnlineBadge);
}

function showGpsToast(message, duration = 3000, type = "success") {
  const old = $("gps-toast"); if (old) old.remove();
  const t = document.createElement("div");
  t.id = "gps-toast"; t.textContent = message;
  Object.assign(t.style, {
    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
    backgroundColor: type === "success" ? "#16a34a" : "#dc2626", color: "#fff",
    padding: "20px", borderRadius: "15px", zIndex: "10000", direction: "rtl"
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}
async function startAttendanceCapture() {
  captureStartedAtMs = Date.now();
  const profile = await getProfile();
  if (!profile.personnelCode) { alert("لطفاً ابتدا پروفایل را تکمیل کنید"); return; }
  
  showGpsToast("در حال دریافت موقعیت و آماده‌سازی دوربین...", 3000);
  
  // شروع دریافت GPS
  navigator.geolocation.getCurrentPosition(
    (pos) => { pendingLocation = { 
        latitude: pos.coords.latitude, 
        longitude: pos.coords.longitude, 
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
        status: "ok" 
      }; 
    },
    (err) => { pendingLocation = { status: "error", message: err.message }; },
    { enableHighAccuracy: true, timeout: 15000 }
  );

  $("photoInput").click(); // باز کردن دوربین
}

async function handlePhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  currentPhoto = await compressImage(file);
  // بعد از انتخاب عکس، رکورد ثبت می‌شود
  await createRecord("IN/OUT");
}

async function createRecord(type) {
  const profile = await getProfile();
  const loc = pendingLocation || { status: "pending", latitude: "", longitude: "" };
  
  const record = {
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type: type,
    recordDate: new Date().toLocaleDateString('fa-IR'),
    recordTime: new Date().toLocaleTimeString('fa-IR'),
    latitude: loc.latitude,
    longitude: loc.longitude,
    photo: currentPhoto,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  await dbPut(STORE_RECORDS, record);
  showGpsToast("✅ تردد ذخیره شد", 3000, "success");
  await refreshUi();
  if (navigator.onLine) scheduleSyncPendingRecords(500);
}

function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const MAX_W = 400;
        const scale = MAX_W / img.width;
        canvas.width = MAX_W;
        canvas.height = img.height * scale;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
    };
  });
}
async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;
  syncRunning = true;
  try {
    const records = await dbGetAll(STORE_RECORDS);
    const pending = records.filter(r => r.status === "pending" || r.status === "failed");
    
    for (const r of pending) {
      try {
        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          mode: "cors",
          body: JSON.stringify(r)
        });
        const result = await res.json();
        if (result.ok) {
          r.status = "sent";
          await dbPut(STORE_RECORDS, r);
        }
      } catch (err) { r.status = "failed"; await dbPut(STORE_RECORDS, r); }
    }
  } finally {
    syncRunning = false;
    await refreshUi();
  }
}

async function saveProfile() {
  const p = {
    id: "main",
    personnelCode: $("pCode").value,
    firstName: $("fName").value,
    lastName: $("lName").value
  };
  await dbPut(STORE_PROFILE, p);
  showGpsToast("پروفایل ذخیره شد");
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (p) {
    if ($("pCode")) $("pCode").value = p.personnelCode || "";
    if ($("fName")) $("fName").value = p.firstName || "";
    if ($("lName")) $("lName").value = p.lastName || "";
  }
}

async function getProfile() {
  return await dbGet(STORE_PROFILE, "main") || {};
}

async function refreshUi() {
  const records = await dbGetAll(STORE_RECORDS);
  const pendingCount = records.filter(r => r.status === "pending").length;
  if ($("pendingCount")) $("pendingCount").textContent = pendingCount;
}

function scheduleSyncPendingRecords(delay = 0) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncPendingRecords(), delay);
}

function updateOnlineBadge() {
  const b = $("onlineBadge");
  if (b) b.textContent = navigator.onLine ? "Online" : "Offline";
}

// توابع دیتابیس (تکرار برای اطمینان از دسترسی)
function dbPut(store, val) {
  return new Promise((res) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val).onsuccess = () => res();
  });
}
function dbGet(store, key) {
  return new Promise((res) => {
    const tx = db.transaction(store, "readonly");
    tx.objectStore(store).get(key).onsuccess = (e) => res(e.target.result);
  });
}
function dbGetAll(store) {
  return new Promise((res) => {
    const tx = db.transaction(store, "readonly");
    tx.objectStore(store).getAll().onsuccess = (e) => res(e.target.result);
  });
}
async function ensurePolicyLoadedAtStartup() {}
async function fetchMessages() {}
