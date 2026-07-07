/* FILE: /app.js */
/* REPLACE FULL FILE */

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
let lastAdminMessage = null;

let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

/* =========================
   Busy Overlay (Loader)
========================= */

function setBusy(isBusy, message = "در حال پردازش...") {
  const overlay = $("busyOverlay");
  const text = $("busyText");
  if (!overlay || !text) return;

  text.textContent = message;
  overlay.style.display = isBusy ? "flex" : "none";
}

/* =========================
   Jalali (Persian) Date Converter
========================= */

function getJalaliDateParts(date = new Date()) {
  const g_y = date.getFullYear();
  const g_m = date.getMonth() + 1;
  const g_d = date.getDate();

  let g_days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let jy_days_in_month = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

  let gy = g_y - 1600;
  let gm = g_m - 1;
  let gd = g_d - 1;

  let g_day_no =
    365 * gy +
    Math.floor((gy + 3) / 4) -
    Math.floor((gy + 99) / 100) +
    Math.floor((gy + 399) / 400);

  for (let i = 0; i < gm; ++i) g_day_no += g_days_in_month[i];

  if (gm > 1 && ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0)) g_day_no++;

  g_day_no += gd;

  let j_day_no = g_day_no - 79;
  let j_np = Math.floor(j_day_no / 12053);
  j_day_no = j_day_no % 12053;

  let jy = 979 + 33 * j_np + 4 * Math.floor(j_day_no / 1461);
  j_day_no %= 1461;

  if (j_day_no >= 366) {
    jy += Math.floor((j_day_no - 1) / 365);
    j_day_no = (j_day_no - 1) % 365;
  }

  let i = 0;
  for (i = 0; i < 11 && j_day_no >= jy_days_in_month[i]; ++i) j_day_no -= jy_days_in_month[i];

  let jm = i + 1;
  let jd = j_day_no + 1;

  return {
    jy,
    jm: String(jm).padStart(2, "0"),
    jd: String(jd).padStart(2, "0"),
  };
}

function getJalaliIsoDate(d = new Date()) {
  const p = getJalaliDateParts(d);
  return `${p.jy}/${p.jm}/${p.jd}`;
}

/* =========================
   Boot
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    setTimeout(() => {
      try {
        showGpsToast("★ حتما جی پی اس و اینترنت خود را روشن کنید تمامی مناطق تحت پوشش اینترنت هستند", 5000, "error");
      } catch (_) {}
    }, 4200);
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
    backgroundColor: isSuccess ? "rgba(22, 163, 74, 0.96)" : "rgba(220, 38, 38, 0.95)",
    color: "#ffffff",
    padding: "25px 40px",
    borderRadius: "20px",
    fontSize: "22px",
    fontWeight: "bold",
    fontFamily: "Tahoma, sans-serif",
    boxShadow: isSuccess ? "0 15px 50px rgba(22, 163, 74, 0.45)" : "0 15px 50px rgba(0, 0, 0, 0.5)",
    zIndex: "10000",
    opacity: "0",
    transition: "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
    direction: "rtl",
    textAlign: "center",
    width: "80%",
    maxWidth: "400px",
    border: "3px solid #ffffff",
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
          autoIncrement: true,
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

async function dbPut(store, value) {
  if (!db) db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  if (!db) db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  if (!db) db = await openDb();
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
    lastName: $("lastName")?.value.trim() || "",
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
  try {
    const profile = getProfileFromInputs();
    if (!profile.personnelCode || !profile.firstName || !profile.lastName) throw new Error("مشخصات پرسنلی کامل نیست.");
    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    await refreshPolicyIfPossible();
    await fetchMessages();
  } catch (err) {
    console.error("Silent profile save failed:", err);
  }
}

async function getProfile() {
  const saved = await dbGet(STORE_PROFILE, "main");
  const inputProfile = getProfileFromInputs();

  const profile = {
    personnelCode: inputProfile.personnelCode || saved?.personnelCode || "",
    firstName: inputProfile.firstName || saved?.firstName || "",
    lastName: inputProfile.lastName || saved?.lastName || "",
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
    await loadProfile();
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

  if (normalized === POLICY_NOT_ALLOWED) return { ok: false, message: "ثبت تردد برای شما مجاز نیست." };
  if (normalized === POLICY_ONLINE_ONLY && !isOnline) return { ok: false, message: "برای این کاربر فقط ثبت آنلاین مجاز است." };
  if (normalized === POLICY_OFFLINE_ONLY && isOnline) return { ok: false, message: "برای این کاربر فقط ثبت آفلاین مجاز است." };

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
      policySource: "default",
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
    policySource: data.policySource || "",
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
      policySource: "default_offline",
    });
  }
}

async function refreshPolicyIfPossible() {
  if (!navigator.onLine) return null;

  try {
    const profile = await dbGet(STORE_PROFILE, "main");
    if (!profile || !profile.personnelCode) return null;

    const personnelCode = encodeURIComponent(profile.personnelCode.toString().trim());
    const url = `${APPS_SCRIPT_URL}?action=getUserPolicy&personnelCode=${personnelCode}&_nocache=${Date.now()}`;

    const response = await fetch(url, { method: "GET", mode: "cors", redirect: "follow" });
    if (!response.ok) return null;

    const text = await response.text();
    const data = JSON.parse(text);

    if (data && typeof data === "object") {
      await saveAttendancePolicyInfo(data);
      return data;
    }

    return null;
  } catch (error) {
    console.error("[Policy] refresh failed:", error);
    return null;
  }
}

async function getCurrentAttendanceGate() {
  if (navigator.onLine) await refreshPolicyIfPossible();
  const policyInfo = await getAttendancePolicyInfo();
  const policy = policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;

  return {
    policyInfo,
    gate: evaluateAttendancePolicy(policy, navigator.onLine),
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
    setBusy(true, "در حال آماده‌سازی عکس...");
    photoSelectedAtMs = Date.now();

    await saveProfileSilent();

    const { gate } = await getCurrentAttendanceGate();
    if (!gate.ok) {
      setBusy(false);
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
      setBusy(false);
      setStatus("GPS در دسترس نیست.\nلطفاً مطمئن شوید سایت با HTTPS باز شده و Location گوشی روشن است.");
      return;
    }

    setBusy(true, "در حال دریافت GPS...");
    setStatus("در حال دریافت GPS... اگر پیام دسترسی آمد، گزینه Allow یا مجاز را بزنید.");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      setBusy(false);

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

    setBusy(true, "در حال ذخیره تردد...");
    await createRecord("تردد");
    setBusy(false);
  } catch (err) {
    console.error(err);
    setBusy(false);
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
    sessionClockDriftMs,
  });

  const clientRecordId = createClientRecordId(profile.personnelCode, clickMs);

  const jalaliDateStr = getJalaliIsoDate(now);
  const hourStr = getTime(now);

  const record = {
    clientRecordId,
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type,
    recordType: type,
    recordDate: jalaliDateStr,
    recordHour: hourStr,
    recordTime: hourStr,

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
    serverResponse: "",
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
    const refreshed = await refreshPolicyIfPossible();
    const policyInfo = refreshed || (await getAttendancePolicyInfo());
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
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
        });

        const sentIso = new Date().toISOString();
        r.status = "sent";
        r.syncedAt = sentIso;
        r.uploadedAt = sentIso;
        r.serverResponse = "opaque_no_cors";
        await dbPut(STORE_RECORDS, r);
      } catch (err) {
        r.status = "failed";
        r.serverResponse = JSON.stringify({ ok: false, error: err?.message || "network_error" });
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
    syncTryCount: Number(record.syncTryCount || 0),
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

  const sorted = [...records].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

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

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await dbGet(STORE_PROFILE, "main");
    if (!profile || !profile.personnelCode) return;

    const pCode = encodeURIComponent(profile.personnelCode.toString().trim());
    const url = `${APPS_SCRIPT_URL}?action=getMessages&personnelCode=${pCode}&_=${Date.now()}`;

    const response = await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
    if (!response.ok) return;

    const rawText = await response.text();
    if (!rawText || rawText.trim() === "" || rawText === "[]" || rawText === "false" || rawText === "null") return;

    let finalMsg = "";
    try {
      const data = JSON.parse(rawText);
      if (data && typeof data === "object") {
        const msgSource = data.messages || data.message || data;
        if (Array.isArray(msgSource)) finalMsg = msgSource[msgSource.length - 1];
        else if (typeof msgSource === "string") finalMsg = msgSource;
        else finalMsg = JSON.stringify(msgSource);
      } else if (Array.isArray(data)) {
        finalMsg = data[data.length - 1];
      } else {
        finalMsg = String(data);
      }
    } catch (e) {
      finalMsg = rawText.replace(/["\[\]]/g, "").trim();
    }

    if (typeof finalMsg === "string") finalMsg = finalMsg.trim();

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
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement("div");
  overlay.id = "admin-message-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
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
    box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3), 0 8px 10px -6px rgba(0,0,0,0.3);
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
    clockRiskReason: reasons.length ? reasons.join(" | ") : "نرمال",
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
    error,
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
          error: "",
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
          error: "",
        };

        best = chooseBetterLocation(best, loc);
        if (loc.accuracy <= GOOD_ACCURACY_METERS) finish(loc);
      },
      (err) => finish(geoErrorToLocation(err)),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: waitMs,
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
    timeout: 25000,
  });

  if (hasValidLocation(firstLocation) && firstLocation.accuracy <= GOOD_ACCURACY_METERS) return firstLocation;
  if (firstLocation?.status === "denied") return firstLocation;

  const secondLocation = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 15000,
  });

  if (secondLocation?.status === "denied") return secondLocation;

  let bestLocation = chooseBetterLocation(firstLocation, secondLocation);
  if (hasValidLocation(bestLocation) && bestLocation.accuracy <= GOOD_ACCURACY_METERS) return bestLocation;

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
            if (!blob) return reject(new Error("خطا در ساخت تصویر فشرده"));

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

/* =========================
   Jalali -> Gregorian (helpers)
========================= */

function jalaliToGregorian_(jy, jm, jd) {
  const salA = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const jy2 = jy === 979 ? 0 : jy - 979;
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
    if (gdm >= 365) gdm += 1;
    else leapG = false;
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
  const salG = [0, 31, leapG ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (i = 1; i <= 12; i += 1) {
    if (gdm < salG[i]) break;
    gdm -= salG[i];
  }

  return [gy, i, gdm + 1];
}

function parsePersianDateTimeToGregorian_(dateStr, timeStr) {
  try {
    const cleanD = dateStr
      .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[^\d/]/g, "");
    const cleanT = timeStr
      .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[^\d:]/g, "");

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
// --- HEARTBEAT SYSTEM ---
let heartbeatInterval = null;

// Frontend.js (Append to end of file)

// Frontend.js
// REPLACE the fetch inside sendHeartbeat with this exact code

// app.js
// ADD TO END OF FILE, OUTSIDE ALL OTHER FUNCTIONS

let heartbeatInterval = null;

// Ensure this function is defined or use the one from the frontend code.
function getTime(d) {
  if (!d) d = new Date();
  var hh = String(d.getHours()).padStart(2, "0");
  var mm = String(d.getMinutes()).padStart(2, "0");
  var ss = String(d.getSeconds()).padStart(2, "0");
  return hh + ":" + mm + ":" + ss;
}

// Function to send heartbeat data
function sendHeartbeat() {
  const personnelCode = localStorage.getItem("personnelCode") || "";
  const url = APPS_SCRIPT_URL; // Use the defined APPS_SCRIPT_URL from the file

  if (!personnelCode || !url) {
    console.error("Heartbeat not sent: Missing personnelCode or APPS_SCRIPT_URL");
    return;
  }

  if (!navigator.onLine) {
    // console.log("Heartbeat skipped: Offline");
    return;
  }

  const payload = {
    type: "Heartbeat",
    personnelCode: personnelCode,
    firstName: localStorage.getItem("firstName") || "",
    lastName: localStorage.getItem("lastName") || "",
    clientTime: new Date().toISOString()
  };

  // Using URLSearchParams for the body as per backend expectation
  const body = new URLSearchParams(payload).toString();

  fetch(url, {
    method: "POST",
    mode: "no-cors", // Necessary for Apps Script POST without CORS issues
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  }).catch(function(err) {
    // console.error("Heartbeat fetch failed:", err);
  });
}

// Function to start the heartbeat interval
function startHeartbeat() {
  if (heartbeatInterval) return; // Already running

  // Initial send
  sendHeartbeat();

  // Set interval to send heartbeat every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

// Function to stop the heartbeat interval
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// --- Event Listeners ---

// Start heartbeat when the DOM is ready
document.addEventListener("DOMContentLoaded", function() {
  // Ensure policy is loaded before starting potentially conditional heartbeat
  // This part might need adjustment based on exact policy loading logic
  // For now, assume we start it and let the backend handle policy checks.
  startHeartbeat();
});

// Send heartbeat and restart interval when connection is back online
window.addEventListener("online", function() {
  // console.log("Went online. Sending heartbeat and potentially restarting interval.");
  sendHeartbeat();
  startHeartbeat(); // Ensure it's running if it was stopped
});

// Stop sending heartbeat when offline (or handle differently if needed)
window.addEventListener("offline", function() {
  // console.log("Went offline. Stopping heartbeat interval.");
  stopHeartbeat();
});

// Send heartbeat when the tab becomes visible again
document.addEventListener("visibilitychange", function() {
  if (!document.hidden) {
    // console.log("Tab became visible. Sending heartbeat.");
    sendHeartbeat();
    startHeartbeat(); // Ensure it's running
  }
});
