// FILE: app.js

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;

const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";

const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

const CLOCK_DRIFT_SESSION_LIMIT_MS = 10 * 1000;

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
let lastAdminMessage = null; // تغییر از "" به null برای شروع دقیق
let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

/* =========================
   Boot
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    showGpsToast(
      "★ حتما جی پی اس و اینترنت خود را روشن کنید تمامی مناطق تحت پوشش اینترنت هستند",
      5000,
      "error"
    );
  } catch (_) {}

  try {
    db = await openDb();
  } catch (e) {
    console.error("DB init error", e);
  }

  try {
    bindEvents();
  } catch (_) {}

  try {
    await loadProfile();
  } catch (_) {}

  try {
    await ensurePolicyLoadedAtStartup();
  } catch (_) {}

  try {
    await refreshUi();
  } catch (_) {}

  try {
    await fetchMessages();
  } catch (_) {}

  try {
    setupAutoSync();
  } catch (_) {}

  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  } catch (_) {}
});

/* =========================
   UI Helpers
========================= */

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
    backgroundColor: isSuccess
      ? "rgba(22, 163, 74, 0.96)"
      : "rgba(220, 38, 38, 0.95)",
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

function setStatus(m) {
  const el = $("captureStatus");
  if (el) el.textContent = m;
}

function setSyncStatus(m) {
  const el = $("syncStatus");
  if (el) el.textContent = m;
}

function updateOnlineBadge() {
  const el = $("onlineBadge");
  if (!el) return;

  if (navigator.onLine) {
    el.textContent = "آنلاین";
    el.className = "status online";
  } else {
    el.textContent = "آفلاین";
    el.className = "status offline";
  }
}

function escapeHtml(v) {
  if (!v) return "";
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================
   Events
========================= */

function bindEvents() {
  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);

  const cameraBtn = $("cameraBtn");
  const photoInput = $("photoInput");

  if (cameraBtn && photoInput) {
    const openCamera = (e) => {
      e.preventDefault();
      e.stopPropagation();

      photoInput.value = "";
      photoInput.click();
    };

    cameraBtn.addEventListener("click", openCamera);
    cameraBtn.addEventListener("touchend", openCamera, { passive: false });
  }
}

/* =========================
   Auto Sync
========================= */

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
    if (!navigator.onLine) return;
    await refreshPolicyIfPossible();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !navigator.onLine) return;
    await refreshPolicyIfPossible();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
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
    refreshPolicyIfPossible().finally(() => scheduleSyncPendingRecords(1000));
  }
}

function scheduleSyncPendingRecords(delay = 0) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncPendingRecords(), delay);
}

/* =========================
   IndexedDB
========================= */

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

        if (!store.indexNames.contains("status")) store.createIndex("status", "status");
        if (!store.indexNames.contains("clientRecordId")) {
          store.createIndex("clientRecordId", "clientRecordId", { unique: false });
        }
      }

      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) {
        openedDb.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }

      if (!openedDb.objectStoreNames.contains(STORE_CONFIG)) {
        openedDb.createObjectStore(STORE_CONFIG, { keyPath: "id" });
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

/* =========================
   Profile
========================= */

function getProfileFromInputs() {
  return {
    personnelCode: $("personnelCode")?.value.trim() || "",
    firstName: $("firstName")?.value.trim() || "",
    lastName: $("lastName")?.value.trim() || ""
  };
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (!p) return;

  if ($("personnelCode")) $("personnelCode").value = p.personnelCode || "";
  if ($("firstName")) $("firstName").value = p.firstName || "";
  if ($("lastName")) $("lastName").value = p.lastName || "";
}

async function saveProfileSilent() {
  const profile = getProfileFromInputs();
  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }
  await dbPut(STORE_PROFILE, { id: "main", ...profile });
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

  await dbPut(STORE_PROFILE, { id: "main", ...profile });
  return profile;
}

async function saveProfile() {
  if (!db) db = await openDb();

  const btn = $("saveProfileBtn");
  if (!btn) return;

  const originalText = "ذخیره مشخصات";
  const originalBg = "#ff9800";

  btn.disabled = true;
  btn.style.backgroundColor = "#6c757d";
  btn.innerHTML = 'در حال ذخیره <span class="dots"></span>';

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      btn.classList.add("shake");
      setTimeout(() => btn.classList.remove("shake"), 500);

      setStatus("اطلاعات پرسنلی کامل نیست.");

      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    loadProfile(); 
    setTimeout(() => {
        refreshPolicyIfPossible();
        fetchMessages();
    }, 500);

    btn.style.backgroundColor = "#28a745";
    btn.textContent = "ذخیره شد";
    showGpsToast("success", "مشخصات با موفقیت ثبت شد", "3000");

    setTimeout(() => {
        btn.disabled = false;
        btn.style.backgroundColor = originalBg;
        btn.textContent = originalText;
    }, 2500);
  } catch (_) {
    btn.disabled = false;
    btn.style.backgroundColor = originalBg;
    btn.textContent = originalText;
    setStatus("خطا در ذخیره مشخصات");
  }
}

/* =========================
   Policy
========================= */

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

function evaluateAttendancePolicy(policy, isOnline) {
  const normalized = normalizeAttendancePolicy(policy);

  if (normalized === POLICY_NOT_ALLOWED) {
    return { ok: false, message: "ثبت تردد برای شما مجاز نیست." };
  }

  if (normalized === POLICY_ONLINE_ONLY && !isOnline) {
    return { ok: false, message: "برای این کاربر فقط ثبت آنلاین مجاز است." };
  }

  if (normalized === POLICY_OFFLINE_ONLY && isOnline) {
    return { ok: false, message: "برای این کاربر فقط ثبت آفلاین مجاز است." };
  }

  return { ok: true, message: "" };
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

async function ensurePolicyLoadedAtStartup() {
  const profile = await dbGet(STORE_PROFILE, "main");
  if (!profile?.personnelCode) return;

  const cached = await getAttendancePolicyInfo();
  if (cached?.personnelCode === profile.personnelCode) {
    if (navigator.onLine) await refreshPolicyIfPossible();
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

async function refreshPolicyIfPossible() {
    if (!navigator.onLine) {
        console.log("[Policy] Offline, skipping policy refresh.");
        return;
    }
    try {
        const profile = await dbGet(STORE_PROFILE, "main");
        if (!profile || !profile.personnelCode) {
            console.log("[Policy] Profile or personnel code not found yet.");
            return;
        }
        
        const personnelCode = encodeURIComponent(profile.personnelCode.toString().trim());
        const timestamp = Date.now();
        const url = `${APPS_SCRIPT_URL}?action=getUserPolicy&personnelCode=${personnelCode}&_nocache=${timestamp}`;
        
        console.log("[Policy] Fetching policy from server...");
        
        const response = await fetch(url, {
            method: "GET",
            mode: "cors",
            redirect: "follow"
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const text = await response.text();
        const data = JSON.parse(text);
        
        if (data && typeof data === 'object') {
            await saveAttendancePolicyInfo(data);
            console.log("[Policy] Successfully updated and saved:", data);
            
            // اعمال تغییرات جدید در UI پس از دریافت پالسی
            if (typeof updateOnlineBadge === "function") {
                updateOnlineBadge();
            }
        }
    } catch (error) {
        console.error("[Policy] Failed to refresh policy on iOS/Safari:", error);
    }
}

async function getCurrentAttendanceGate() {
  if (navigator.onLine) await refreshPolicyIfPossible();
  const policyInfo = await getAttendancePolicyInfo();
  const policy = policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;

  return {
    policyInfo,
    gate: evaluateAttendancePolicy(policy, navigator.onLine)
  };
}

/* =========================
   Attendance Capture
========================= */

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

  const preview = $("photoPreview");
  if (preview) {
    preview.removeAttribute("src");
    preview.style.display = "none";
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

    const preview = $("photoPreview");
    if (preview) {
      preview.src = currentPhoto;
      preview.style.display = "block";
    }

    if (!isGeolocationUsable()) {
      setStatus(
        "GPS در دسترس نیست.\nلطفاً مطمئن شوید سایت با HTTPS باز شده و Location گوشی روشن است."
      );
      return;
    }

    setStatus("در حال دریافت GPS... اگر پیام دسترسی آمد، گزینه Allow یا مجاز را بزنید.");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      if (pendingLocation?.status === "denied") {
        setStatus(
          "دسترسی GPS رد شد.\nتردد ذخیره نمی‌شود. لطفاً Location را برای این سایت مجاز کنید و دوباره تلاش کنید."
        );
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

/* =========================
   Record Creation
========================= */

async function createRecord(type) {
  const profile = await getProfile();

  const { policyInfo, gate } = await getCurrentAttendanceGate();
  if (!gate.ok) {
    setStatus(gate.message);
    return;
  }

  const attendancePolicy = policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;

  if (GPS_REQUIRED && !hasValidLocation(pendingLocation)) {
    setStatus("GPS معتبر نیست. تردد ذخیره نشد.");
    return;
  }

  const loc = hasValidLocation(pendingLocation)
    ? pendingLocation
    : emptyLocation("not_received", "GPS دریافت نشد");

  const now = new Date();
  const nowMs = now.getTime();

  const clickMs = captureStartedAtMs || nowMs;
  const photoMs = photoSelectedAtMs || "";
  const photoCompressedMs = photoCompressedAtMs || "";
  const gpsMs = loc.timestamp && !isNaN(loc.timestamp) ? Number(loc.timestamp) : null;

  const deviceTime = now.toISOString();
  const deviceTimeAtClick = new Date(clickMs).toISOString();
  const deviceTimeAtPhoto = photoMs ? new Date(photoMs).toISOString() : "";
  const deviceTimeAtPhotoCompressed = photoCompressedMs ? new Date(photoCompressedMs).toISOString() : "";
  const deviceTimeAtGps = gpsMs ? new Date(gpsMs).toISOString() : "";
  const gpsTimestamp = deviceTimeAtGps;

  const gpsWaitMs = gpsMs ? Math.max(0, gpsMs - clickMs) : "";
  const photoDelayMs = photoMs ? Math.max(0, photoMs - clickMs) : "";
  const submitDelayMs = Math.max(0, nowMs - clickMs);

  const offlineCreated = !navigator.onLine;
  const createdOnline = navigator.onLine;

  const sessionClockDriftMs = getSessionClockDriftMs();
  const networkClockDriftMs = navigator.onLine ? await getNetworkTimeDriftMs(nowMs) : null;

  const risk = calculateClockRisk({
    clickMs,
    gpsMs,
    offlineCreated,
    locationStatus: loc.status,
    sessionClockDriftMs
  });

  const clientRecordId = createClientRecordId(profile.personnelCode, clickMs);

  const record = {
    clientRecordId,
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type,
    recordType: type,
    recordDate: getIsoDate(now),
    recordHour: getTime(now),
    recordTime: getTime(now),
    latitude: loc.latitude || "",
    longitude: loc.longitude || "",
    accuracy: loc.accuracy || "",
    locationStatus: loc.status || "",
    locationError: loc.error || "",
    deviceTime,
    deviceTimeAtClick,
    deviceTimeAtPhoto,
    deviceTimeAtPhotoCompressed,
    deviceTimeAtGps,
    gpsTimestamp,
    gpsWaitMs,
    photoDelayMs,
    submitDelayMs,
    offlineCreated,
    createdOnline,
    connectionStatus: offlineCreated ? "offline" : "online",
    connectionStatusFa: offlineCreated ? "آفلاین" : "آنلاین",
    firstConnectionAfterOfflineRecord: "",
    lastConnectionBeforeUpload: "",
    uploadedAt: "",
    delayAfterFirstConnectionMs: "",
    clockRisk: risk.clockRisk,
    clockRiskReason: risk.clockRiskReason,
    sessionClockDriftMs,
    networkClockDriftMs: networkClockDriftMs ?? "",
    attendancePolicy,
    policyVersion: Number(policyInfo.policyVersion || 0),
    policyFetchedAt: policyInfo.policyFetchedAt || "",
    policySource: policyInfo.policySource || "",
    photo: currentPhoto || "",
    status: "pending",
    createdAt: now.toISOString(),
    lastSyncTryAt: "",
    syncTryCount: 0,
    syncedAt: "",
    serverResponse: ""
  };

  await dbPut(STORE_RECORDS, record);

  showGpsToast("✅ تردد با موفقیت ثبت شد", 3000, "success");
  setStatus("تردد با GPS ذخیره شد.");
  await refreshUi();

  if (navigator.onLine) scheduleSyncPendingRecords(500);
}

function createClientRecordId(personnelCode, baseMs) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${personnelCode}-${baseMs}-${randomPart}`;
}

/* =========================
   Sync (CORS-SAFE)
========================= */

async function markFirstConnectionForOfflineRecords() {
  if (!db || !navigator.onLine) return;

  try {
    const nowIso = new Date().toISOString();
    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter(
      (r) =>
        r.offlineCreated === true &&
        (r.status === "pending" || r.status === "failed") &&
        !r.firstConnectionAfterOfflineRecord
    );

    for (const r of list) {
      r.firstConnectionAfterOfflineRecord = nowIso;
      await dbPut(STORE_RECORDS, r);
    }

    if (list.length) await refreshUi();
  } catch (_) {}
}

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;
  syncRunning = true;

  try {
    const policyInfo = (await refreshPolicyIfPossible()) || (await getAttendancePolicyInfo());
    const syncGate = evaluateAttendancePolicy(policyInfo?.attendancePolicy, true);

    if (!syncGate.ok) {
      setSyncStatus(syncGate.message);
      return;
    }

    await markFirstConnectionForOfflineRecords();

    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter((r) => r.status === "pending" || r.status === "failed");

    if (!list.length) {
      setSyncStatus("چیزی برای ارسال نیست");
      return;
    }

    setSyncStatus("در حال ارسال...");

    for (const r of list) {
      if (r.status === "sent" || r.status === "syncing") continue;

      const uploadStartIso = new Date().toISOString();
      const uploadStartMs = new Date(uploadStartIso).getTime();

      r.status = "syncing";
      r.lastSyncTryAt = uploadStartIso;
      r.lastConnectionBeforeUpload = uploadStartIso;
      r.syncTryCount = Number(r.syncTryCount || 0) + 1;

      if (!r.connectionStatus) {
        r.connectionStatus = r.offlineCreated ? "offline" : "online";
        r.connectionStatusFa = r.offlineCreated ? "آفلاین" : "آنلاین";
        r.createdOnline = !r.offlineCreated;
      }

      if (r.offlineCreated === true && !r.firstConnectionAfterOfflineRecord) {
        r.firstConnectionAfterOfflineRecord = uploadStartIso;
      }

      if (r.firstConnectionAfterOfflineRecord) {
        const firstConnectionMs = new Date(r.firstConnectionAfterOfflineRecord).getTime();
        if (firstConnectionMs && !isNaN(firstConnectionMs)) {
          r.delayAfterFirstConnectionMs = Math.max(0, uploadStartMs - firstConnectionMs);
        }
      }

      await dbPut(STORE_RECORDS, r);
      await refreshUi();

      try {
        const payload = buildServerPayload(r);

        await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          mode: "no-cors",
          headers: {
            "Content-Type": "text/plain;charset=utf-8"
          },
          body: JSON.stringify(payload)
        });

        const sentIso = new Date().toISOString();
        r.status = "sent";
        r.syncedAt = sentIso;
        r.uploadedAt = sentIso;
        r.serverResponse = "opaque_no_cors";
        await dbPut(STORE_RECORDS, r);
      } catch (err) {
        r.status = "failed";
        r.serverResponse = JSON.stringify({
          ok: false,
          error: err?.message || "network_error"
        });
        await dbPut(STORE_RECORDS, r);
      }
    }

    setSyncStatus("ارسال انجام شد");
    await refreshUi();
    await fetchMessages();
  } finally {
    syncRunning = false;
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

/* =========================
   Records UI
========================= */

async function refreshUi() {
  const rec = await dbGetAll(STORE_RECORDS);

  if ($("pendingCount")) $("pendingCount").textContent = rec.filter((r) => r.status === "pending").length;
  if ($("sentCount")) $("sentCount").textContent = rec.filter((r) => r.status === "sent").length;
  if ($("failedCount")) $("failedCount").textContent = rec.filter((r) => r.status === "failed").length;

  renderRecords(rec);
}

function renderRecords(records) {
  const el = $("recordsList");
  if (!el) return;

  if (!records.length) {
    el.innerHTML = "<p>ترددی ثبت نشده</p>";
    return;
  }

  const sorted = [...records].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  el.innerHTML = sorted
    .slice(0, 20)
    .map((r) => {
      const riskText = r.clockRisk ? ` - ${escapeHtml(r.clockRisk)}` : "";
      const connectionText = r.connectionStatusFa
        ? ` - ${escapeHtml(r.connectionStatusFa)}`
        : r.offlineCreated
          ? " - آفلاین"
          : " - آنلاین";

      return `
        <div class="record-item compact-record">
          <span>${escapeHtml(r.recordDate || "")}</span>
          <span>${escapeHtml(r.recordHour || r.recordTime || "")}${connectionText}${riskText}</span>
        </div>
      `;
    })
    .join("");
}

/* =========================
   Admin Messages
========================= */
function showAdminMessage(message) {
  const msg = String(message == null ? "" : message).trim();
  if (!msg) return;

  const oldOverlay = document.getElementById("admin-message-overlay");
  if (oldOverlay) oldOverlay.remove();

  const oldStyle = document.getElementById("admin-message-style");
  if (!oldStyle) {
    const style = document.createElement("style");
    style.id = "admin-message-style";
    style.textContent = `
      #admin-message-overlay{
        position:fixed !important;
        inset:0 !important;
        width:100vw !important;
        height:100vh !important;
        background:rgba(0,0,0,.55) !important;
        display:flex !important;
        align-items:center !important;
        justify-content:center !important;
        padding:16px !important;
        box-sizing:border-box !important;
        z-index:2147483647 !important;
        -webkit-backdrop-filter:blur(2px);
        backdrop-filter:blur(2px);
      }
      #admin-message-modal{
        width:min(92vw,380px) !important;
        max-height:80vh !important;
        overflow:auto !important;
        background:#fff !important;
        color:#111 !important;
        border-radius:14px !important;
        box-shadow:0 20px 50px rgba(0,0,0,.35) !important;
        padding:18px !important;
        direction:rtl !important;
        font-family:inherit !important;
        transform:translateZ(0);
        -webkit-transform:translateZ(0);
      }
      #admin-message-title{
        margin:0 0 12px 0 !important;
        font-size:18px !important;
        font-weight:700 !important;
        color:#c62828 !important;
        line-height:1.5 !important;
      }
      #admin-message-body{
        margin:0 0 16px 0 !important;
        font-size:16px !important;
        line-height:1.9 !important;
        white-space:pre-wrap !important;
        word-break:break-word !important;
      }
      #admin-message-btn{
        display:block !important;
        width:100% !important;
        border:0 !important;
        border-radius:10px !important;
        padding:12px 14px !important;
        background:#0d6efd !important;
        color:#fff !important;
        font-size:16px !important;
        font-weight:700 !important;
        cursor:pointer !important;
        -webkit-appearance:none !important;
        appearance:none !important;
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.id = "admin-message-overlay";

  const modal = document.createElement("div");
  modal.id = "admin-message-modal";

  const title = document.createElement("div");
  title.id = "admin-message-title";
  title.textContent = "پیام مدیر";

  const body = document.createElement("div");
  body.id = "admin-message-body";
  body.textContent = msg;

  const btn = document.createElement("button");
  btn.id = "admin-message-btn";
  btn.type = "button";
  btn.textContent = "تایید";

  btn.addEventListener("click", function () {
    overlay.remove();
  });

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) overlay.remove();
  });

  modal.appendChild(title);
  modal.appendChild(body);
  modal.appendChild(btn);
  overlay.appendChild(modal);

  if (!document.body) {
    alert(msg);
    return;
  }

  document.body.appendChild(overlay);

  requestAnimationFrame(function () {
    try { btn.focus({ preventScroll: true }); } catch (_) {}
  });

  setTimeout(function () {
    const exists = document.getElementById("admin-message-overlay");
    if (!exists && msg) {
      alert(msg);
    }
  }, 1200);
}

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await dbGet(STORE_PROFILE, "main");
    if (!profile || !profile.personnelCode) return;

    const personnelCode = String(profile.personnelCode || "").trim();
    if (!personnelCode) return;

    const url =
      `${APPS_SCRIPT_URL}?action=getMessages&personnelCode=${encodeURIComponent(personnelCode)}&_=${Date.now()}`;

    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      redirect: "follow",
      credentials: "omit",
      headers: {
        "Accept": "application/json, text/plain, */*"
      }
    });

    if (!res.ok) return;

    const raw = (await res.text() || "").trim();
    if (!raw) return;

    let messages = [];

    const normalizeMessage = function (value) {
      let v = String(value == null ? "" : value).trim();

      if (!v) return "";
      if (v === "[]" || v === "{}") return "";

      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1).trim();
      }

      if (!v) return "";

      const lower = v.toLowerCase();
      if (
        lower === "false" ||
        lower === "null" ||
        lower === "undefined" ||
        lower === "0" ||
        lower === "none" ||
        lower === "no message" ||
        lower === "no messages"
      ) {
        return "";
      }

      return v;
    };

    const collectMessages = function (input) {
      if (Array.isArray(input)) {
        return input.map(normalizeMessage).filter(Boolean);
      }

      if (typeof input === "string") {
        const one = normalizeMessage(input);
        return one ? [one] : [];
      }

      if (input && typeof input === "object") {
        if (Array.isArray(input.messages)) {
          return input.messages.map(normalizeMessage).filter(Boolean);
        }
        if (Array.isArray(input.data)) {
          return input.data.map(normalizeMessage).filter(Boolean);
        }
        if (Array.isArray(input.result)) {
          return input.result.map(normalizeMessage).filter(Boolean);
        }
        if (typeof input.message === "string") {
          const one = normalizeMessage(input.message);
          return one ? [one] : [];
        }
        if (typeof input.msg === "string") {
          const one = normalizeMessage(input.msg);
          return one ? [one] : [];
        }
      }

      return [];
    };

    try {
      const parsed = JSON.parse(raw);
      messages = collectMessages(parsed);
    } catch (_) {
      messages = collectMessages(raw);

      if (!messages.length && raw.startsWith("[") && raw.endsWith("]")) {
        try {
          const parsedArray = JSON.parse(raw);
          messages = collectMessages(parsedArray);
        } catch (_) {}
      }
    }

    if (!messages.length) return;

    const combined = messages.join("\n\n").trim();
    if (!combined) return;

    if (combined === lastAdminMessage) return;

    lastAdminMessage = combined;
    adminMessageShownOnEntry = true;

    setTimeout(function () {
      showAdminMessage(combined);
    }, 150);
  } catch (err) {
    console.error("fetchMessages failed:", err);
  }
}

/* =========================
   Time / Date
========================= */

function getIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function getTime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/* =========================
   Clock Risk
========================= */

function getSessionClockDriftMs() {
  const realElapsedMs = performance.now() - APP_SESSION_START_PERF_MS;
  const wallElapsedMs = Date.now() - APP_SESSION_START_WALL_MS;
  return Math.round(wallElapsedMs - realElapsedMs);
}

async function getNetworkTimeDriftMs(deviceNowMs) {
  try {
    const networkMs = Date.now();
    if (!networkMs || isNaN(networkMs)) return null;
    return Math.abs(networkMs - deviceNowMs);
  } catch (_) {
    return null;
  }
}

function calculateClockRisk(data) {
  const reasons = [];
  let score = 0;

  const sessionDrift = Math.abs(Number(data.sessionClockDriftMs) || 0);
  if (sessionDrift > CLOCK_DRIFT_SESSION_LIMIT_MS) {
    score += 6;
    reasons.push("تغییر ساعت در حین برنامه (Session Drift)");
  }

  if (data.offlineCreated) {
    score += 1;
    reasons.push("ثبت آفلاین");
  }

  if (String(data.locationStatus || "").toLowerCase() !== "ok") {
    score += 4;
    reasons.push("GPS نامعتبر/خاموش");
  }

  return {
    clockRisk: score >= 6 ? "high" : score >= 3 ? "medium" : "low",
    clockRiskReason: reasons.length ? reasons.join(" | ") : "نرمال"
  };
}

/* =========================
   Geolocation
========================= */

function isGeolocationUsable() {
  return !!navigator.geolocation && window.isSecureContext;
}

function hasValidLocation(l) {
  return l && l.status === "ok" && l.latitude !== "" && l.longitude !== "";
}

function emptyLocation(status, error) {
  return {
    latitude: "",
    longitude: "",
    accuracy: "",
    timestamp: null,
    status,
    error
  };
}

function chooseBetterLocation(a, b) {
  if (!a) return b;
  if (!b) return a;

  if (!hasValidLocation(a)) return b;
  if (!hasValidLocation(b)) return a;

  return (Number(b.accuracy) || 999999) <= (Number(a.accuracy) || 999999) ? b : a;
}

function geoErrorToLocation(err) {
  if (err.code === 1) return emptyLocation("denied", "دسترسی رد شد");
  if (err.code === 2) return emptyLocation("unavailable", "موقعیت در دسترس نیست");
  if (err.code === 3) return emptyLocation("timeout", "زمان تمام شد");
  return emptyLocation("error", "خطای GPS");
}

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    let done = false;

    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(emptyLocation("timeout", "زمان تمام شد"));
    }, (options.timeout || 20000) + 3000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);

        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
          status: "ok",
          error: ""
        });
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        resolve(geoErrorToLocation(err));
      },
      options
    );
  });
}

function getLocationWithWatch(waitMs) {
  return new Promise((resolve) => {
    let done = false;
    let best = null;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const loc = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
          status: "ok",
          error: ""
        };

        best = chooseBetterLocation(best, loc);
        if (loc.accuracy <= GOOD_ACCURACY_METERS) finish(loc);
      },
      (err) => finish(geoErrorToLocation(err)),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: waitMs
      }
    );

    const timeoutId = setTimeout(() => finish(best), waitMs + 3000);

    function finish(loc) {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timeoutId);
      resolve(loc || emptyLocation("timeout", "GPS دریافت نشد"));
    }
  });
}

async function getLocationIOSFriendly() {
  if (!isGeolocationUsable()) return emptyLocation("unavailable", "GPS در دسترس نیست");

  const firstLocation = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 25000
  });

  if (hasValidLocation(firstLocation) && firstLocation.accuracy <= GOOD_ACCURACY_METERS) {
    return firstLocation;
  }

  if (firstLocation?.status === "denied") return firstLocation;

  const secondLocation = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 15000
  });

  if (secondLocation?.status === "denied") return secondLocation;

  let bestLocation = chooseBetterLocation(firstLocation, secondLocation);

  if (hasValidLocation(bestLocation) && bestLocation.accuracy <= GOOD_ACCURACY_METERS) {
    return bestLocation;
  }

  const watchedLocation = await getLocationWithWatch(GPS_RETRY_MS);
  bestLocation = chooseBetterLocation(bestLocation, watchedLocation);

  return bestLocation;
}

/* =========================
   Image
========================= */

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const img = new Image();

      img.onload = () => {
        const OUT_W = 1080;
        const OUT_H = 1350;

        const canvas = document.createElement("canvas");
        canvas.width = OUT_W;
        canvas.height = OUT_H;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, OUT_W, OUT_H);

        const scale = Math.min(OUT_W / img.width, OUT_H / img.height);
        const drawW = Math.round(img.width * scale);
        const drawH = Math.round(img.height * scale);
        const dx = Math.round((OUT_W - drawW) / 2);
        const dy = Math.round((OUT_H - drawH) / 2);

        ctx.drawImage(img, dx, dy, drawW, drawH);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("خطا در ساخت تصویر فشرده"));
              return;
            }

            const r = new FileReader();
            r.onloadend = () => resolve(r.result);
            r.onerror = () => reject(new Error("خطا در خواندن تصویر فشرده"));
            r.readAsDataURL(blob);
          },
          "image/jpeg",
          0.7
        );
      };

      img.onerror = () => reject(new Error("خطا در بارگذاری تصویر"));
      img.src = e.target.result;
    };

    reader.onerror = () => reject(new Error("خطا در خواندن فایل تصویر"));
    reader.readAsDataURL(file);
  });
}

function jalaliToGregorian_(jy, jm, jd) {
  const salA = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const jy2 = (jy === 979) ? 0 : jy - 979;
  let leapJ = -14;
  let jp = salA[0];

  for (let i = 1; i < 20; i += 1) {
    const temp = salA[i];
    const dy = temp - jp;
    if (jy2 < temp) {
      const q = Math.floor(jy2 / 33);
      const r = jy2 % 33;
      leapJ += q * 8 + Math.floor((r + 4) / 4);
      if (dy - r > 0 && r === 30) leapJ += 1;
      break;
    }
    leapJ += Math.floor(dy / 33) * 8 + Math.floor(((dy % 33) + 3) / 4);
    jp = temp;
  }

  const q = Math.floor(jy2 / 33);
  leapJ += q * 8 + Math.floor(((jy2 % 33) + 3) / 4);

  const gDays = 365 * jy2 + leapJ + 79;
  const gy2 = 1600 + 400 * Math.floor(gDays / 146097);
  let gdm = gDays % 146097;

  let leapG = true;
  if (gdm >= 36525) {
    gdm -= 1;
    gdm %= 36524;
    if (gdm >= 365) {
      gdm += 1;
    } else {
      leapG = false;
    }
  }

  let gy = gy2 + 4 * Math.floor(gdm / 1461);
  gdm %= 1461;

  if (gdm >= 366) {
    leapG = false;
    gdm -= 1;
    gy += Math.floor(gdm / 365);
    gdm %= 365;
  }

  let i = 0;
  const salG = [0, 31, (leapG ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (i = 1; i <= 12; i += 1) {
    if (gdm < salG[i]) break;
    gdm -= salG[i];
  }

  return [gy, i, gdm + 1];
}

function parsePersianDateTimeToGregorian_(dateStr, timeStr) {
  try {
    const cleanD = dateStr.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^\d/]/g, "");
    const cleanT = timeStr.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^\d:]/g, "");

    const dp = cleanD.split("/");
    const tp = cleanT.split(":");

    if (dp.length < 3 || tp.length < 2) return null;

    const jy = parseInt(dp[0], 10);
    const jm = parseInt(dp[1], 10);
    const jd = parseInt(dp[2], 10);

    const th = parseInt(tp[0], 10);
    const tm = parseInt(tp[1], 10);
    const ts = tp[2] ? parseInt(tp[2], 10) : 0;

    const [gy, gm, gd] = jalaliToGregorian_(jy, jm, jd);

    return new Date(gy, gm - 1, gd, th, tm, ts);
  } catch (e) {
    return null;
  }
}
