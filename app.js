/* ========= FILE: app.js ========= */

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
let lastAdminMessage = null;
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
    showGpsToast("مشخصات با موفقیت ثبت شد", 3000, "success");

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

    if (data && typeof data === "object") {
      await saveAttendancePolicyInfo(data);
      console.log("[Policy] Successfully updated and saved:", data);

      if (typeof updateOnlineBadge === "function") {
        updateOnlineBadge();
      }
    }

    return await getAttendancePolicyInfo();
  } catch (error) {
    console.error("[Policy] Failed to refresh policy on iOS/Safari:", error);
    return await getAttendancePolicyInfo();
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

  const jalaliNow = getJalaliDateTime(now);
  const jalaliClick = getJalaliDateTime(new Date(clickMs));
  const jalaliPhoto = photoMs ? getJalaliDateTime(new Date(photoMs)) : null;
  const jalaliPhotoCompressed = photoCompressedMs ? getJalaliDateTime(new Date(photoCompressedMs)) : null;
  const jalaliGps = gpsMs ? getJalaliDateTime(new Date(gpsMs)) : null;

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

    recordDate: jalaliNow.date,
    recordHour: jalaliNow.time,
    recordTime: jalaliNow.time,
    recordDateTime: jalaliNow.full,

    recordDateGregorian: getIsoDate(now),
    recordTimeGregorian: getTime(now),

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

    deviceTimeJalali: jalaliNow.full,
    deviceDateJalali: jalaliNow.date,
    deviceClockJalali: jalaliNow.time,

    deviceTimeAtClickJalali: jalaliClick.full,
    deviceDateAtClickJalali: jalaliClick.date,
    deviceClockAtClickJalali: jalaliClick.time,

    deviceTimeAtPhotoJalali: jalaliPhoto ? jalaliPhoto.full : "",
    deviceDateAtPhotoJalali: jalaliPhoto ? jalaliPhoto.date : "",
    deviceClockAtPhotoJalali: jalaliPhoto ? jalaliPhoto.time : "",

    deviceTimeAtPhotoCompressedJalali: jalaliPhotoCompressed ? jalaliPhotoCompressed.full : "",
    deviceDateAtPhotoCompressedJalali: jalaliPhotoCompressed ? jalaliPhotoCompressed.date : "",
    deviceClockAtPhotoCompressedJalali: jalaliPhotoCompressed ? jalaliPhotoCompressed.time : "",

    deviceTimeAtGpsJalali: jalaliGps ? jalaliGps.full : "",
    deviceDateAtGpsJalali: jalaliGps ? jalaliGps.date : "",
    deviceClockAtGpsJalali: jalaliGps ? jalaliGps.time : "",

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
    createdAtJalali: jalaliNow.full,
    lastSyncTryAt: "",
    syncTryCount: 0,
    syncedAt: "",
    syncedAtJalali: "",
    serverResponse: ""
  };

  await dbPut(STORE_RECORDS, record);

  showGpsToast("✅ تردد با موفقیت ثبت شد", 3000, "success");
  setStatus(`تردد با GPS ذخیره شد - ${jalaliNow.full}`);
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
    const now = new Date();
    const nowIso = now.toISOString();
    const nowJalali = getJalaliDateTime(now).full;

    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter(
      (r) =>
        r.offlineCreated === true &&
        (r.status === "pending" || r.status === "failed") &&
        !r.firstConnectionAfterOfflineRecord
    );

    for (const r of list) {
      r.firstConnectionAfterOfflineRecord = nowIso;
      r.firstConnectionAfterOfflineRecordJalali = nowJalali;
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

      const uploadStart = new Date();
      const uploadStartIso = uploadStart.toISOString();
      const uploadStartMs = uploadStart.getTime();
      const uploadStartJalali = getJalaliDateTime(uploadStart).full;

      r.status = "syncing";
      r.lastSyncTryAt = uploadStartIso;
      r.lastSyncTryAtJalali = uploadStartJalali;
      r.lastConnectionBeforeUpload = uploadStartIso;
      r.lastConnectionBeforeUploadJalali = uploadStartJalali;
      r.syncTryCount = Number(r.syncTryCount || 0) + 1;

      if (!r.connectionStatus) {
        r.connectionStatus = r.offlineCreated ? "offline" : "online";
        r.connectionStatusFa = r.offlineCreated ? "آفلاین" : "آنلاین";
        r.createdOnline = !r.offlineCreated;
      }

      if (r.offlineCreated === true && !r.firstConnectionAfterOfflineRecord) {
        r.firstConnectionAfterOfflineRecord = uploadStartIso;
        r.firstConnectionAfterOfflineRecordJalali = uploadStartJalali;
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

        const sentDate = new Date();
        const sentIso = sentDate.toISOString();
        const sentJalali = getJalaliDateTime(sentDate).full;

        r.status = "sent";
        r.syncedAt = sentIso;
        r.syncedAtJalali = sentJalali;
        r.uploadedAt = sentIso;
        r.uploadedAtJalali = sentJalali;
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
    recordDateTime: record.recordDateTime || "",

    recordDateGregorian: record.recordDateGregorian || "",
    recordTimeGregorian: record.recordTimeGregorian || "",

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

    deviceTimeJalali: record.deviceTimeJalali || "",
    deviceDateJalali: record.deviceDateJalali || "",
    deviceClockJalali: record.deviceClockJalali || "",

    deviceTimeAtClickJalali: record.deviceTimeAtClickJalali || "",
    deviceDateAtClickJalali: record.deviceDateAtClickJalali || "",
    deviceClockAtClickJalali: record.deviceClockAtClickJalali || "",

    deviceTimeAtPhotoJalali: record.deviceTimeAtPhotoJalali || "",
    deviceDateAtPhotoJalali: record.deviceDateAtPhotoJalali || "",
    deviceClockAtPhotoJalali: record.deviceClockAtPhotoJalali || "",

    deviceTimeAtPhotoCompressedJalali: record.deviceTimeAtPhotoCompressedJalali || "",
    deviceDateAtPhotoCompressedJalali: record.deviceDateAtPhotoCompressedJalali || "",
    deviceClockAtPhotoCompressedJalali: record.deviceClockAtPhotoCompressedJalali || "",

    deviceTimeAtGpsJalali: record.deviceTimeAtGpsJalali || "",
    deviceDateAtGpsJalali: record.deviceDateAtGpsJalali || "",
    deviceClockAtGpsJalali: record.deviceClockAtGpsJalali || "",

    gpsWaitMs: record.gpsWaitMs ?? "",
    photoDelayMs: record.photoDelayMs ?? "",
    submitDelayMs: record.submitDelayMs ?? "",
    offlineCreated: !!record.offlineCreated,
    createdOnline: record.createdOnline === true,
    connectionStatus: record.connectionStatus || (record.offlineCreated ? "offline" : "online"),
    connectionStatusFa: record.connectionStatusFa || (record.offlineCreated ? "آفلاین" : "آنلاین"),

    firstConnectionAfterOfflineRecord: record.firstConnectionAfterOfflineRecord || "",
    firstConnectionAfterOfflineRecordJalali: record.firstConnectionAfterOfflineRecordJalali || "",

    lastConnectionBeforeUpload: record.lastConnectionBeforeUpload || "",
    lastConnectionBeforeUploadJalali: record.lastConnectionBeforeUploadJalali || "",

    uploadedAt: record.uploadedAt || "",
    uploadedAtJalali: record.uploadedAtJalali || "",

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
    createdAtJalali: record.createdAtJalali || "",
    lastSyncTryAt: record.lastSyncTryAt || "",
    lastSyncTryAtJalali: record.lastSyncTryAtJalali || "",
    syncTryCount: Number(record.syncTryCount || 0),
    syncedAt: record.syncedAt || "",
    syncedAtJalali: record.syncedAtJalali || ""
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

      const dateText = r.recordDate || "";
      const timeText = r.recordHour || r.recordTime || "";

      return `
        <div class="record-item compact-record">
          <span>${escapeHtml(dateText)}</span>
          <span>${escapeHtml(timeText)}${connectionText}${riskText}</span>
        </div>
      `;
    })
    .join("");
}

/* =========================
   Admin Messages
========================= */

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await dbGet(STORE_PROFILE, "main");
    if (!profile || !profile.personnelCode) return;

    const pCode = encodeURIComponent(profile.personnelCode.toString().trim());
    const url = `${APPS_SCRIPT_URL}?action=getMessages&personnelCode=${pCode}&_=${Date.now()}`;

    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit"
    });

    if (!response.ok) return;

    const rawText = await response.text();
    if (!rawText || rawText.trim() === "" || rawText === "[]" || rawText === "false" || rawText === "null") {
      return;
    }

    let finalMsg = "";
    try {
      const data = JSON.parse(rawText);

      if (data && typeof data === "object") {
        const msgSource = data.messages || data.message || data;
        if (Array.isArray(msgSource)) {
          finalMsg = msgSource[msgSource.length - 1];
        } else if (typeof msgSource === "string") {
          finalMsg = msgSource;
        } else {
          finalMsg = JSON.stringify(msgSource);
        }
      } else if (Array.isArray(data)) {
        finalMsg = data[data.length - 1];
      } else {
        finalMsg = data.toString();
      }
    } catch (e) {
      finalMsg = rawText.replace(/["\[\]]/g, "").trim();
    }

    if (typeof finalMsg === "string") {
      finalMsg = finalMsg.trim();
    }

    if (finalMsg && finalMsg !== "false" && finalMsg !== "null" && finalMsg !== "undefined") {
      if (finalMsg !== lastAdminMessage) {
        lastAdminMessage = finalMsg;
        showAdminMessage(finalMsg);
      }
    }
  } catch (err) {
    console.error("Fetch messages failed:", err);
  }
}

function showAdminMessage(message) {
  const existingOverlay = document.getElementById("admin-message-overlay");
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const overlay = document.createElement("div");
  overlay.id = "admin-message-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
  `;

  const container = document.createElement("div");
  container.style.cssText = `
    background-color: #fff7ed;
    border: 2px solid #ea580c;
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    max-width: 450px;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    text-align: right;
    direction: rtl;
    box-sizing: border-box;
    animation: zoomInAdmin 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  `;

  const styleSheet = document.createElement("style");
  styleSheet.innerText = `
    @keyframes zoomInAdmin {
      from { transform: scale(0.9); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  `;
  document.head.appendChild(styleSheet);

  const title = document.createElement("div");
  title.style.cssText = `
    font-size: 18px;
    font-weight: bold;
    color: #c2410c;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  title.textContent = "🔔 پیام جدید از طرف مدیریت";

  const body = document.createElement("div");
  body.style.cssText = `
    font-size: 15px;
    color: #431407;
    line-height: 1.6;
    margin-bottom: 20px;
    white-space: pre-wrap;
    word-break: break-word;
  `;
  body.textContent = message;

  const btn = document.createElement("button");
  btn.style.cssText = `
    width: 100%;
    background-color: #ea580c;
    color: #ffffff;
    border: none;
    padding: 12px;
    border-radius: 10px;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
  `;
  btn.textContent = "متوجه شدم و تایید می‌کنم";

  const dismiss = (e) => {
    e.preventDefault();
    overlay.remove();
  };
  btn.addEventListener("click", dismiss, { passive: false });
  btn.addEventListener("touchstart", dismiss, { passive: false });

  container.appendChild(title);
  container.appendChild(body);
  container.appendChild(btn);
  overlay.appendChild(container);

  document.body.appendChild(overlay);
}

/* =========================
   Time / Date
========================= */

function toEnglishDigits(v) {
  return String(v || "").replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}

function normalizeSlashDate(v) {
  return String(v || "").replace(/\//g, "/").replace(/-/g, "/").trim();
}

function getJalaliDateTime(dateObj = new Date()) {
  const dateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const timeFormatter = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const rawDate = dateFormatter.format(dateObj);
  const rawTime = timeFormatter.format(dateObj);

  const date = normalizeSlashDate(toEnglishDigits(rawDate));
  const time = toEnglishDigits(rawTime);
  const full = `${date} ${time}`;

  return { date, time, full };
}

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
