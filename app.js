const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

// --- شروع ثابت‌های امنیتی ---
const MAX_HUMAN_SPEED_MPS = 45;
const TELEPORT_DISTANCE_METERS = 100;
const MIN_TIME_FOR_LONG_DISTANCE_MS = 60000;
const ACCURACY_SUSPICIOUS_METERS = 100;
// --- پایان ثابت‌های امنیتی ---

const CLOCK_RISK_GPS_CLICK_DIFF_MS = 5 * 60 * 1000;
const HIGH_GPS_WAIT_MS = 2 * 60 * 1000;
const CLOCK_DRIFT_SESSION_LIMIT_MS = 10 * 1000;
const CLOCK_DRIFT_NETWORK_LIMIT_MS = 2 * 60 * 1000;

const DEFAULT_ATTENDANCE_POLICY = "ONLINE_OR_OFFLINE";
const POLICY_NOT_ALLOWED = "NOT_ALLOWED";
const POLICY_ONLINE_ONLY = "ONLINE_ONLY";
const POLICY_OFFLINE_ONLY = "OFFLINE_ONLY";
const POLICY_ONLINE_PREFERRED = "ONLINE_PREFERRED";
const POLICY_ONLINE_OR_OFFLINE = "ONLINE_OR_OFFLINE";
const POLICY_OFFLINE_ALLOWED_IMMEDIATE = "OFFLINE_ALLOWED_IMMEDIATE";

const APP_SESSION_START_WALL_MS = Date.now();
const APP_SESSION_START_PERF_MS = performance.now();

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;
let syncTimer = null;
let adminMessageShownOnEntry = false;
let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  showGpsToast("★ حتما جی پی اس و اینترنت خود را روشن کنید تمامی مناطق تحت پوشش اینترنت هستند", 5000, "error");

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
});

function showGpsToast(message, duration = 3000, type = "success") {
  const oldToast = document.getElementById("gps-toast");
  if (oldToast) oldToast.remove();

  const toast = document.createElement("div");
  toast.id = "gps-toast";
  toast.textContent = message;

  const isSuccess = type === "success";

  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%) scale(0.8)",
    backgroundColor: isSuccess ? "rgba(22, 163, 74, 0.96)" : "rgba(220, 38, 38, 0.95)",
    color: "#ffffff",
    padding: "25px 40px",
    borderRadius: "20px",
    fontSize: "22px",
    fontWeight: "bold",
    fontFamily: "Tahoma, sans-serif",
    boxShadow: isSuccess
      ? "0 15px 50px rgba(22, 163, 74, 0.45)"
      : "0 15px 50px rgba(0, 0, 0, 0.5)",
    zIndex: "10000",
    opacity: "0",
    transition: "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
    direction: "rtl",
    textAlign: "center",
    width: "80%",
    maxWidth: "400px",
    border: "3px solid #ffffff"
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, -50%) scale(1)";
  }, 100);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translate(-50%, -50%) scale(0.8)";
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

function bindEvents() {
  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);
}

function setupAutoSync() {
  updateOnlineBadge();

  window.addEventListener("online", async () => {
    updateOnlineBadge();
    await refreshPolicyIfPossible();
    await markFirstConnectionForOfflineRecords();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
  });

  window.addEventListener("offline", updateOnlineBadge);

  window.addEventListener("focus", async () => {
    if (navigator.onLine) {
      await refreshPolicyIfPossible();
      scheduleSyncPendingRecords(500);
      await fetchMessages();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && navigator.onLine) {
      await refreshPolicyIfPossible();
      scheduleSyncPendingRecords(500);
      await fetchMessages();
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", async (event) => {
      if (!event.data) return;

      if (event.data.type === "SYNC_COMPLETE") {
        await refreshUi();
        setSyncStatus("ارسال خودکار انجام شد");
      }

      if (event.data.type === "SYNC_FAILED") {
        await refreshUi();
        setSyncStatus("ارسال خودکار کامل نشد");
      }
    });
  }

  setInterval(() => {
    if (navigator.onLine) scheduleSyncPendingRecords(0);
  }, 60000);

  if (navigator.onLine) {
    refreshPolicyIfPossible().finally(() => {
      scheduleSyncPendingRecords(1000);
    });
  }
}

function scheduleSyncPendingRecords(delay = 0) {
  if (syncTimer) clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncPendingRecords();
  }, delay);
}

async function registerBackgroundSync() {
  return;
}

function evaluateAttendancePolicy(policy, isOnline) {
  const normalized = normalizeAttendancePolicy(policy);

  if (normalized === POLICY_NOT_ALLOWED) {
    return {
      ok: false,
      message: "ثبت تردد برای شما مجاز نیست."
    };
  }

  if (normalized === POLICY_ONLINE_ONLY && !isOnline) {
    return {
      ok: false,
      message: "برای این کاربر فقط ثبت آنلاین مجاز است."
    };
  }

  if (normalized === POLICY_OFFLINE_ONLY && isOnline) {
    return {
      ok: false,
      message: "برای این کاربر فقط ثبت آفلاین مجاز است."
    };
  }

  return {
    ok: true,
    message: ""
  };
}

async function getCurrentAttendanceGate() {
  if (navigator.onLine) {
    await refreshPolicyIfPossible();
  }

  const policyInfo = await getAttendancePolicyInfo();
  const policy = policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;

  return {
    policyInfo,
    gate: evaluateAttendancePolicy(policy, navigator.onLine)
  };
}

async function startAttendanceCapture() {
  const personnelCode = $("personnelCode")?.value.trim() || "";
  const firstName = $("firstName")?.value.trim() || "";
  const lastName = $("lastName")?.value.trim() || "";

  if (!personnelCode || !firstName || !lastName) {
    setStatus("مشخصات پرسنلی کامل نیست.");
    return;
  }

  await saveProfileSilent();

  const { gate } = await getCurrentAttendanceGate();
  if (!gate.ok) {
    setStatus(gate.message);
    return;
  }

  captureStartedAtMs = Date.now();
  photoSelectedAtMs = 0;
  photoCompressedAtMs = 0;
  currentPhoto = "";
  pendingLocation = null;

  if ($("photoPreview")) {
    $("photoPreview").removeAttribute("src");
    $("photoPreview").style.display = "none";
  }

  const photoInput = $("photoInput");

  if (!photoInput) {
    setStatus("ورودی عکس پیدا نشد. لطفاً فایل HTML را بررسی کنید.");
    return;
  }

  photoInput.value = "";
  setStatus("دوربین باز می‌شود. لطفاً عکس بگیرید.");
  photoInput.click();
}

async function handlePhotoSelected() {
  const file = $("photoInput")?.files?.[0];

  if (!file) {
    setStatus("عکسی انتخاب نشد.");
    return;
  }

  try {
    photoSelectedAtMs = Date.now();

    await saveProfileSilent();

    const { gate } = await getCurrentAttendanceGate();
    if (!gate.ok) {
      setStatus(gate.message);
      $("photoInput").value = "";
      currentPhoto = "";
      return;
    }

    setStatus("در حال آماده‌سازی عکس، صبور باشید ...");
    currentPhoto = await compressImage(file);
    photoCompressedAtMs = Date.now();

    if ($("photoPreview")) {
      $("photoPreview").src = currentPhoto;
      $("photoPreview").style.display = "block";
    }

    if (!isGeolocationUsable()) {
      setStatus("GPS در دسترس نیست.\nلطفاً مطمئن شوید سایت با HTTPS باز شده و Location گوشی روشن است.");
      return;
    }

    setStatus("در حال دریافت GPS... اگر پیام دسترسی آمد، گزینه Allow یا مجاز را بزنید.");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      if (pendingLocation?.status === "denied") {
        setStatus("دسترسی GPS رد شد.\nتردد ذخیره نمی‌شود. لطفاً Location را برای این سایت مجاز کنید و دوباره تلاش کنید.");
        return;
      }

      if (pendingLocation?.status === "unavailable") {
        setStatus("موقعیت مکانی در دسترس نیست.\nلطفاً GPS گوشی را روشن کنید.");
        return;
      }

      if (pendingLocation?.status === "timeout") {
        setStatus("زمان دریافت GPS تمام شد.\nلطفاً در فضای بازتر قرار بگیرید و دوباره تلاش کنید.");
        return;
      }

      setStatus("GPS دریافت نشد.\nلطفاً Location را روشن و دسترسی را مجاز کنید.");
      return;
    }

    await createRecord("تردد");
  } catch (err) {
    console.error(err);
    setStatus("خطا در پردازش عکس یا ثبت تردد");
  }
}

function openDb() {
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
        store.createIndex("clientRecordId", "clientRecordId", { unique: false });
      } else {
        const tx = e.target.transaction;
        const store = tx.objectStore(STORE_RECORDS);

        if (!store.indexNames.contains("status")) {
          store.createIndex("status", "status");
        }

        if (!store.indexNames.contains("clientRecordId")) {
          store.createIndex("clientRecordId", "clientRecordId", { unique: false });
        }
      }

      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) {
        openedDb.createObjectStore(STORE_PROFILE, {
          keyPath: "id"
        });
      }

      if (!openedDb.objectStoreNames.contains(STORE_CONFIG)) {
        openedDb.createObjectStore(STORE_CONFIG, {
          keyPath: "id"
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.put(value);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function saveProfile() {
  const btn = document.getElementById("saveProfileBtn");
  if (!btn) return;

  const originalText = "ذخیره مشخصات";
  const originalBg = "#ff9800"; // رنگ نارنجی اصلی شما

  // ۱. حالت در حال ذخیره (رنگ خاکستری + انیمیشن سه نقطه)
  btn.disabled = true;
  btn.style.backgroundColor = "#6c757d"; 
  btn.innerHTML = 'در حال ذخیره <span class="dots"></span>';

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      // افکت لرزش در صورت خطا در پر کردن فرم
      btn.classList.add("shake");
      setTimeout(() => btn.classList.remove("shake"), 500);
      
      if (typeof setStatus === "function") setStatus("اطلاعات پرسنلی کامل نیست.");
      
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    // عملیات ذخیره در دیتابیس
    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    if (typeof refreshPolicyIfPossible === "function") await refreshPolicyIfPossible();

    // ۲. حالت موفقیت (ررضایتمندی کاربر با رنگ سبز)
    btn.style.backgroundColor = "#28a745";
    btn.textContent = "✅ ذخیره شد";
    if (typeof showGpsToast === "function") showGpsToast("✅ مشخصات با موفقیت ثبت شد", 3000, "success");

    // ۳. بازگشت به حالت عادی بعد از ۲.۵ ثانیه
    setTimeout(() => {
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
    }, 2500);

  } catch (e) {
    // حالت خطا
    btn.disabled = false;
    btn.style.backgroundColor = originalBg;
    btn.textContent = originalText;
    if (typeof setStatus === "function") setStatus("خطا در ذخیره مشخصات");
  }
}

async function saveProfileSilent() {
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE, {
    id: "main",
    ...profile
  });
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (!p) return;

  if ($("personnelCode")) $("personnelCode").value = p.personnelCode || "";
  if ($("firstName")) $("firstName").value = p.firstName || "";
  if ($("lastName")) $("lastName").value = p.lastName || "";
}

function getProfileFromInputs() {
  return {
    personnelCode: $("personnelCode")?.value.trim() || "",
    firstName: $("firstName")?.value.trim() || "",
    lastName: $("lastName")?.value.trim() || ""
  };
}

async function getProfile() {
  const saved = await dbGet(STORE_PROFILE, "main");
  const inputProfile = getProfileFromInputs();

  const profile = {
    personnelCode: inputProfile.personnelCode || saved?.personnelCode || "",
    firstName: inputProfile.firstName || saved?.firstName || "",
    lastName: inputProfile.lastName || saved?.lastName || ""
  };
if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE, {
    id: "main",
    ...profile
  });

  return profile;
}

async function ensurePolicyLoadedAtStartup() {
  const profile = await dbGet(STORE_PROFILE, "main");
  if (!profile?.personnelCode) return;

  const cached = await getAttendancePolicyInfo();
  if (cached?.personnelCode === profile.personnelCode) {
    if (navigator.onLine) {
      await refreshPolicyIfPossible();
    }
    return;
  }

  if (navigator.onLine) {
    await refreshPolicyIfPossible();
  } else {
    await saveAttendancePolicyInfo({
      personnelCode: profile.personnelCode,
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      policyFetchedAt: "",
      policySource: "default_offline"
    });
  }
}

async function getAttendancePolicyInfo() {
  const policy = await dbGet(STORE_CONFIG, "attendancePolicy");
  if (!policy) {
    return {
      id: "attendancePolicy",
      personnelCode: "",
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      policyFetchedAt: "",
      policySource: "default"
    };
  }
  return policy;
}

async function saveAttendancePolicyInfo(data) {
  await dbPut(STORE_CONFIG, {
    id: "attendancePolicy",
    personnelCode: data.personnelCode || "",
    attendancePolicy: normalizeAttendancePolicy(data.attendancePolicy),
    policyVersion: Number(data.policyVersion || 0),
    policyFetchedAt: data.policyFetchedAt || "",
    policySource: data.policySource || ""
  });
}

function normalizeAttendancePolicy(policy) {
  const p = String(policy || "").trim().toUpperCase();

  if (
    p === POLICY_NOT_ALLOWED ||
    p === POLICY_ONLINE_ONLY ||
    p === POLICY_OFFLINE_ONLY ||
    p === POLICY_ONLINE_PREFERRED ||
    p === POLICY_ONLINE_OR_OFFLINE ||
    p === POLICY_OFFLINE_ALLOWED_IMMEDIATE
  ) {
    return p;
  }

  return DEFAULT_ATTENDANCE_POLICY;
}

async function refreshPolicyIfPossible() {
  if (!navigator.onLine) return null;

  const profile = await getProfile().catch(() => null);
  if (!profile?.personnelCode) return null;

  try {
    const url = `${APPS_SCRIPT_URL}?action=getUserPolicy&personnelCode=${encodeURIComponent(profile.personnelCode)}`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return null;

    const result = await res.json().catch(() => null);
    if (!result || result.ok !== true) return null;

    const normalizedPolicy = normalizeAttendancePolicy(result.attendancePolicy);

    const policyInfo = {
      personnelCode: profile.personnelCode,
      attendancePolicy: normalizedPolicy,
      policyVersion: Number(result.policyVersion || 0),
      policyFetchedAt: new Date().toISOString(),
      policySource: "server"
    };

    await saveAttendancePolicyInfo(policyInfo);
    return policyInfo;
  } catch (e) {
    return null;
  }
}
async function createRecord(type) {
  const personnelCode = $("personnelCode")?.value.trim();
  const firstName = $("firstName")?.value.trim();
  const lastName = $("lastName")?.value.trim();

  if (!personnelCode || !firstName || !lastName) {
    setStatus("لطفاً مشخصات پرسنلی را کامل وارد کنید.");
    return;
  }

  setStatus("در حال پردازش اطلاعات موقعیت مکانی...");

  const location = pendingLocation;
  pendingLocation = null;

  if (!hasValidLocation(location)) {
    setStatus("GPS معتبر دریافت نشد. تردد ثبت نشد.");
    return;
  }

  // --- شروع چک‌های امنیتی موقعیت مکانی ---
  await runLocationSecurityChecks(location);
  // --- پایان چک‌های امنیتی موقعیت مکانی ---

  setStatus("در حال بررسی محدوده جغرافیایی (Geo-fencing)...");

  // --- شروع چک Geo-fencing ---
  const geoFence = await getGeoFence();
  const refreshedGeoFence = await refreshGeoFenceIfPossible();

  if (refreshedGeoFence && refreshedGeoFence.length > 0) {
    if (geoFence.length === 0 || refreshedGeoFence.some(rf => rf.version > (geoFence[0]?.version || 0))) {
      await dbPut(STORE_CONFIG, { id: "geoFence", ...refreshedGeoFence });
    }
  }

  const currentGeoFences = geoFence || [];

  if (currentGeoFences.length > 0) {
    const isOnGeoFence = currentGeoFences.some(fence =>
      isPointInPolygon(
        location.coords.latitude,
        location.coords.longitude,
        fence.coordinates.map(c => ({ lat: c[0], lng: c[1] }))
      )
    );

    if (!isOnGeoFence) {
      const message = `شما خارج از محدوده مجاز تردد هستید.`;
      setStatus(message);
      showGpsToast(message, 5000, "error");
      return;
    }
  }
  // --- پایان چک Geo-fencing ---

  const { attendancePolicy } = await getAttendancePolicyInfo();
  const policyGate = evaluateAttendancePolicy(attendancePolicy, navigator.onLine);

  if (!policyGate.ok) {
    setStatus(policyGate.message);
    return;
  }

  const record = {
    personnelCode,
    firstName,
    lastName,
    type,
    photo: currentPhoto,
    location: {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      altitude: location.coords.altitude,
      timestamp: location.timestamp,
      clientTimestamp: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    status: "pending", // default status
    clientRecordId: crypto.randomUUID(),
    photoTimestamp: photoSelectedAtMs,
    photoCompressedTimestamp: photoCompressedAtMs,
    appSessionStartWallMs: APP_SESSION_START_WALL_MS,
    appSessionStartPerfMs: APP_SESSION_START_PERF_MS,
    captureStartedAtMs: captureStartedAtMs,
    locationReceivedAtMs: location.timestamp,
    photoSelectedAtMs: photoSelectedAtMs,
    photoCompressedAtMs: photoCompressedAtMs,
    gpsWaitMs: GPS_WAIT_MS,
    gpsRetryMs: GPS_RETRY_MS,
    goodAccuracyMeters: GOOD_ACCURACY_METERS,
    clockRiskGpsClickDiffMs: CLOCK_RISK_GPS_CLICK_DIFF_MS,
    highGpsWaitMs: HIGH_GPS_WAIT_MS,
    clockDriftSessionLimitMs: CLOCK_DRIFT_SESSION_LIMIT_MS,
    clockDriftNetworkLimitMs: CLOCK_DRIFT_NETWORK_LIMIT_MS
  };

  try {
    setStatus("در حال ذخیره تردد در حافظه محلی...");
    const recordId = await dbPut(STORE_RECORDS, record);

    if (navigator.onLine) {
      await syncPendingRecords();
    } else {
      setSyncStatus("تردد در صف انتظار برای همگام‌سازی");
    }

    setStatus(`تردد ${type} با موفقیت ثبت شد.`);
    await refreshUi();

    if ($("photoPreview")) {
      $("photoPreview").removeAttribute("src");
      $("photoPreview").style.display = "none";
    }

    currentPhoto = "";
    pendingLocation = null;
    photoSelectedAtMs = 0;
    photoCompressedAtMs = 0;
    captureStartedAtMs = 0;

  } catch (err) {
    console.error("Error creating record:", err);
    setStatus("خطا در ذخیره تردد");
  }
}

function setStatus(message) {
  const statusElement = $("status");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function setSyncStatus(message) {
  const statusElement = $("syncStatus");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

async function refreshUi() {
  await loadProfile();
  await loadRecords();
  await loadMessages();
  updateOnlineBadge();
  const { policyInfo } = await getCurrentAttendanceGate();
  updatePolicyBadge(policyInfo);
}

async function loadRecords() {
  const records = await dbGetAll(STORE_RECORDS);
  const list = $("recordsList");
  if (!list) return;

  list.innerHTML = ""; // Clear existing list

  records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  for (const record of records) {
    const item = document.createElement("div");
    item.className = "record-item";

    let statusIcon = "";
    if (record.status === "pending") {
      statusIcon = "⏳"; // Pending
    } else if (record.status === "synced") {
      statusIcon = "✅"; // Synced
    } else if (record.status === "failed") {
      statusIcon = "❌"; // Failed
    }

    const locationInfo = record.location ?
      `(${record.location.latitude.toFixed(5)}, ${record.location.longitude.toFixed(5)}, Acc: ${record.location.accuracy.toFixed(0)}m)` :
      "";

    item.innerHTML = `
      <span class="record-status">${statusIcon}</span>
      <span class="record-type">${record.type}</span>
      <span class="record-time">${new Date(record.createdAt).toLocaleString()}</span>
      <span class="record-location">${locationInfo}</span>
    `;

    list.appendChild(item);
  }
}

function updateOnlineBadge() {
  const badge = $("onlineBadge");
  if (!badge) return;

  if (navigator.onLine) {
    badge.textContent = "آنلاین";
    badge.style.backgroundColor = "#28a745"; // Green
  } else {
    badge.textContent = "آفلاین";
    badge.style.backgroundColor = "#dc3545"; // Red
  }
}

function updatePolicyBadge(policyInfo) {
  const badge = $("policyBadge");
  if (!badge) return;

  const policyText = policyInfo?.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;
  badge.textContent = `سیاست: ${policyText}`;

  switch (policyText) {
    case POLICY_ONLINE_ONLY:
      badge.style.backgroundColor = "#ffc107"; // Yellow
      break;
    case POLICY_OFFLINE_ONLY:
      badge.style.backgroundColor = "#17a2b8"; // Info
      break;
    case POLICY_NOT_ALLOWED:
      badge.style.backgroundColor = "#6c757d"; // Gray
      break;
    default:
      badge.style.backgroundColor = "#007bff"; // Blue
      break;
  }
}

async function loadMessages() {
  const messages = await fetchMessages();
  const list = $("messagesList");
  if (!list) return;

  list.innerHTML = ""; // Clear existing list

  messages.forEach((msg) => {
    const item = document.createElement("div");
    item.className = "message-item";
    item.innerHTML = `
      <span class="message-timestamp">${new Date(msg.timestamp).toLocaleString()}</span>
      <span class="message-text">${msg.message}</span>
    `;
    list.appendChild(item);
  });
}

async function fetchMessages() {
  try {
    const profile = await getProfile().catch(() => null);
    if (!profile?.personnelCode) return [];

    const url = `${APPS_SCRIPT_URL}?action=getMessages&personnelCode=${encodeURIComponent(profile.personnelCode)}`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return [];

    const result = await res.json().catch(() => null);
    if (!result || result.ok !== true || !result.messages) return [];

    return result.messages || [];
  } catch (e) {
    console.error("Error fetching messages:", e);
    return [];
  }
}

function syncPendingRecords() {
  if (syncRunning) return;
  syncRunning = true;
  setSyncStatus("در حال ارسال...");

  const recordsToSync = [];
  db.transaction(STORE_RECORDS, "readonly")
    .objectStore(STORE_RECORDS)
    .index("status")
    .getAll("pending")
    .onsuccess = async (event) => {
      const pendingRecords = event.target.result;

      if (pendingRecords.length === 0) {
        setSyncStatus("هیچ ترددی برای ارسال وجود ندارد.");
        syncRunning = false;
        return;
      }

      const profile = await getProfile().catch(() => null);
      if (!profile) {
        setStatus("خطا: مشخصات پرسنلی یافت نشد.");
        syncRunning = false;
        return;
      }

      const payload = {
        personnelCode: profile.personnelCode,
        records: pendingRecords.map(r => {
          // Remove potentially large photo data if not needed on server or if clientRecordId is enough
          const { photo, ...rest } = r;
          return {
            ...rest,
            photoBase64: photo // Send photo as base64 string
          };
        })
      };

      try {
        const url = `${APPS_SCRIPT_URL}?action=saveRecords`;
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify(payload),
          headers: {
            "Content-Type": "application/json",
          },
          cache: "no-store"
        });

        const result = await response.json().catch(() => null);

        if (result && result.ok === true && result.savedRecords) {
          const savedIds = new Set(result.savedRecords.map(sr => sr.clientRecordId));
          const tx = db.transaction(STORE_RECORDS, "readwrite");
          const store = tx.objectStore(STORE_RECORDS);

          for (const record of pendingRecords) {
            if (savedIds.has(record.clientRecordId)) {
              record.status = "synced";
              store.put(record); // Update status to synced
            } else {
              record.status = "failed"; // Mark as failed if not in server response
              store.put(record);
            }
          }

          await tx.done;
          setSyncStatus(`ارسال ${savedIds.size} از ${pendingRecords.length} تردد انجام شد.`);
          await refreshUi();
        } else {
          throw new Error("Server error or no records saved.");
        }
      } catch (error) {
        console.error("Sync error:", error);
        // Mark all pending records as failed to prevent infinite retries on persistent errors
        const tx = db.transaction(STORE_RECORDS, "readwrite");
        const store = tx.objectStore(STORE_RECORDS);
        for (const record of pendingRecords) {
          record.status = "failed";
          store.put(record);
        }
        await tx.done;
        setSyncStatus("خطا در ارسال ترددها.");
      } finally {
        syncRunning = false;
      }
    };
}

function isGeolocationUsable() {
  return typeof navigator !== "undefined" && navigator.geolocation && typeof crypto !== "undefined";
}

function hasValidLocation(location) {
  if (!location) return false;

  if (location.coords.accuracy > GOOD_ACCURACY_METERS && location.timestamp + GPS_WAIT_MS < Date.now()) {
    return false;
  }

  if (location.status === "denied" || location.status === "unavailable" || location.status === "timeout") {
    return false;
  }

  return true;
}

async function getLocationIOSFriendly() {
  return new Promise((resolve) => {
    if (!isGeolocationUsable()) {
      return resolve({
        status: "unavailable",
        message: "Geolocation API not available."
      });
    }

    const timeout = GPS_WAIT_MS;
    let retries = 3;
    let watchId = null;

    const success = (pos) => {
      clearTimeout(timer);
      if (watchId) navigator.geolocation.clearWatch(watchId);
      resolve({
        coords: pos.coords,
        timestamp: pos.timestamp,
        status: "granted"
      });
    };

    const error = (err) => {
      clearTimeout(timer);
      if (watchId) navigator.geolocation.clearWatch(watchId);
      let status = "unknown";
      switch (err.code) {
        case err.PERMISSION_DENIED:
          status = "denied";
          break;
        case err.POSITION_UNAVAILABLE:
          status = "unavailable";
          break;
        case err.TIMEOUT:
          status = "timeout";
          break;
      }
      resolve({
        status
      });
    };

    const timer = setTimeout(() => {
      if (retries-- > 0) {
        setStatus(`دریافت GPS... ${retries} تلاش باقی مانده`);
        watchId = navigator.geolocation.watchPosition(success, error, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: timeout / (retries + 1)
        });
      } else {
        error({
          code: 3,
          message: "Timeout"
        }); // Simulate timeout error
      }
    }, timeout);

    watchId = navigator.geolocation.watchPosition(success, error, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: timeout
    });
  });
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        // Calculate new dimensions to preserve aspect ratio, max width 800px
        const maxWidth = 800;
        const ratio = Math.min(maxWidth / img.width, 1); // No larger than original, max 800px width
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Compress to JPEG with quality 0.8
        canvas.toBlob((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.8);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function markFirstConnectionForOfflineRecords() {
  return new Promise(async (resolve, reject) => {
    const records = await dbGetAll(STORE_RECORDS);
    const pendingRecords = records.filter(r => r.status === "pending");

    if (pendingRecords.length === 0) {
      resolve();
      return;
    }

    const hasOfflineRecord = pendingRecords.some(r => r.location?.policySource === "offline_allowed_immediate");

    if (hasOfflineRecord) {
      // If any pending record was created offline (e.g., POLICY_OFFLINE_ALLOWED_IMMEDIATE),
      // we need to ensure its server-side record is correctly created upon reconnection.
      // The syncPendingRecords function already handles this by sending them.
      // This function might be redundant if syncPendingRecords is robust.
      // If specific logic is needed here (e.g., updating a flag), implement it.
      resolve();
      return;
    }
    resolve();
  });
}


// --- توابع Geo-fencing ---

async function getGeoFence() {
  const fenceData = await dbGet(STORE_CONFIG, "geoFence");
  return fenceData ? fenceData.value : []; // Assuming value holds the array of fences
}

async function refreshGeoFenceIfPossible() {
  if (!navigator.onLine) return null;

  try {
    const profile = await getProfile().catch(() => null);
    if (!profile?.personnelCode) return null;

    // Assuming a new action in Apps Script to fetch GeoFence data
    const url = `${APPS_SCRIPT_URL}?action=getGeoFence`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return null;

    const result = await res.json().catch(() => null);

    if (!result || result.ok !== true || !result.geoFences) return null;

    // Store the fetched geoFences with a version or timestamp if available
    // Example: result.geoFences might include a 'version' field
    // await dbPut(STORE_CONFIG, { id: "geoFence", value: result.geoFences, version: result.version });
    return result.geoFences || [];

  } catch (e) {
    console.error("Error refreshing GeoFence:", e);
    return null;
  }
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres Earth radius
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // distance in metres
}

// Function to check if a point is inside a polygon (using Ray Casting algorithm)
function isPointInPolygon(lat, lon, polygon) {
  let isInside = false;
  const numVertices = polygon.length;
  for (let i = 0, j = numVertices - 1; i < numVertices; j = i++) {
    const xi = polygon[i].lat,
      yi = polygon[i].lng;
    const xj = polygon[j].lat,
      yj = polygon[j].lng;

    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}
// --- توابع Anti-Spoofing ---

function detectLocationTeleport(currentLocation, previousLocation) {
  if (!currentLocation || !previousLocation || !previousLocation.coords || !currentLocation.coords) {
    return { teleport: false, message: "" };
  }

  const distance = distanceMeters(
    previousLocation.coords.latitude,
    previousLocation.coords.longitude,
    currentLocation.coords.latitude,
    currentLocation.coords.longitude
  );

  const timeDiff = currentLocation.timestamp - previousLocation.timestamp;

  if (timeDiff <= 0 || timeDiff > MIN_TIME_FOR_LONG_DISTANCE_MS) {
    // If time difference is zero, negative, or very large, skip teleport detection for this interval
    return { teleport: false, message: "" };
  }

  const speed = distance / (timeDiff / 1000); // Speed in meters per second

  if (distance > TELEPORT_DISTANCE_METERS && speed > MAX_HUMAN_SPEED_MPS) {
    return {
      teleport: true,
      message: `احتمال جابجایی غیرعادی: فاصله ${distance.toFixed(0)} متر در ${timeDiff / 1000} ثانیه (سرعت ${speed.toFixed(2)} m/s).`
    };
  }

  return { teleport: false, message: "" };
}

function detectFakeAccuracy(location) {
  if (!location || !location.coords) {
    return { fakeAccuracy: false, message: "" };
  }

  if (location.coords.accuracy > ACCURACY_SUSPICIOUS_METERS) {
    return {
      fakeAccuracy: true,
      message: `دقت GPS مشکوک است: ${location.coords.accuracy.toFixed(2)} متر.`
    };
  }

  return { fakeAccuracy: false, message: "" };
}

async function runLocationSecurityChecks(location) {
  const previousLocation = await dbGet(STORE_RECORDS, "lastLocation")
    .then(r => r ? JSON.parse(r.value) : null) // Assuming lastLocation stores a JSON string of the location object
    .catch(() => null);

  const { teleport, message: teleportMessage } = detectLocationTeleport(location, previousLocation);
  if (teleport) {
    const msg = `هشدار امنیتی: ${teleportMessage}`;
    setStatus(msg);
    showGpsToast(msg, 6000, "error");
    throw new Error(msg);
  }

  const { fakeAccuracy, message: accuracyMessage } = detectFakeAccuracy(location);
  if (fakeAccuracy) {
    const msg = `هشدار امنیتی: ${accuracyMessage}`;
    setStatus(msg);
    showGpsToast(msg, 6000, "error");
    throw new Error(msg);
  }

  // Save current location as the 'lastLocation' for the next check
  // Use a simple key-value store for 'lastLocation'
  await dbPut(STORE_CONFIG, { id: "lastLocation", value: JSON.stringify({
    coords: location.coords,
    timestamp: location.timestamp
  })});
}

// --- توابع کمکی متفرقه ---

function isPointInPolygon(lat, lon, polygon) {
  let isInside = false;
  const numVertices = polygon.length;
  for (let i = 0, j = numVertices - 1; i < numVertices; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;

    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres Earth radius
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // distance in metres
}
