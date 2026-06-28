const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 3;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0J1JTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

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

const ACCURACY_SUSPICIOUS_METERS = 5;
const DISTANCE_JUMP_LIMIT = 2000;

// ثابت‌های امنیتی ضد تقلب
const MAX_HUMAN_SPEED_MPS = 45;
const TELEPORT_DISTANCE_METERS = 2000;
const MIN_TIME_FOR_LONG_DISTANCE_MS = 60000;

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
    await refreshGeoFenceIfPossible();
    await markFirstConnectionForOfflineRecords();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
  });

  window.addEventListener("offline", updateOnlineBadge);

  window.addEventListener("focus", async () => {
    if (navigator.onLine) {
      await refreshPolicyIfPossible();
      await refreshGeoFenceIfPossible();
      scheduleSyncPendingRecords(500);
      await fetchMessages();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && navigator.onLine) {
      await refreshPolicyIfPossible();
      await refreshGeoFenceIfPossible();
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
    Promise.all([refreshPolicyIfPossible(), refreshGeoFenceIfPossible()]).finally(() => {
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
  const originalBg = "#ff9800";

  btn.disabled = true;
  btn.style.backgroundColor = "#6c757d"; 
  btn.innerHTML = 'در حال ذخیره <span class="dots"></span>';

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      btn.classList.add("shake");
      setTimeout(() => btn.classList.remove("shake"), 500);
      
      if (typeof setStatus === "function") setStatus("اطلاعات پرسنلی کامل نیست.");
      
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    if (typeof refreshPolicyIfPossible === "function") await refreshPolicyIfPossible();
    if (typeof refreshGeoFenceIfPossible === "function") await refreshGeoFenceIfPossible();

    btn.style.backgroundColor = "#28a745";
    btn.textContent = "✅ ذخیره شد";
    if (typeof showGpsToast === "function") showGpsToast("✅ مشخصات با موفقیت ثبت شد", 3000, "success");

    setTimeout(() => {
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
    }, 2500);

  } catch (e) {
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
      await refreshGeoFenceIfPossible();
    }
    return;
  }

  if (navigator.onLine) {
    await refreshPolicyIfPossible();
    await refreshGeoFenceIfPossible();
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

async function getGeoFence() {
  const geo = await dbGet(STORE_CONFIG, "geoFence").catch(() => null);
  return geo || { enabled: false, lat: 0, lng: 0, radius: 0 };
}

async function refreshGeoFenceIfPossible() {
  if (!navigator.onLine) return null;
  try {
    const profile = await getProfile().catch(() => null);
    if (!profile?.personnelCode) return null;
    const url = `${APPS_SCRIPT_URL}?action=getGeoFence&personnelCode=${encodeURIComponent(profile.personnelCode)}`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });
    if (!res.ok) return null;
    const result = await res.json().catch(() => null);
    if (!result || result.ok !== true) return null;
    const geo = {
      id: "geoFence",
      enabled: result.enabled === true,
      lat: Number(result.lat || 0),
      lng: Number(result.lng || 0),
      radius: Number(result.radius || 0),
      updatedAt: new Date().toISOString()
    };
    await dbPut(STORE_CONFIG, geo).catch(() => null);
    return geo;
  } catch (e) {
    return null;
  }
}

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

  // چک کردن ضد تقلب (Anti-Spoofing)
  const security = await runLocationSecurityChecks(loc);
  if (!security.ok) {
    showGpsToast("⚠️ موقعیت مکانی مشکوک شناسایی شد", 4000, "error");
    setStatus("موقعیت مکانی مشکوک: " + security.reason);
    return;
  }

  // چک کردن محدوده جغرافیایی (Geo-fencing)
  try {
    const geo = await refreshGeoFenceIfPossible() || await getGeoFence();
    if (geo && geo.enabled && hasValidLocation(loc)) {
      const dist = distanceMeters(loc.latitude, loc.longitude, geo.lat, geo.lng);
      if (dist > geo.radius) {
        showGpsToast(`❌ خارج از محدوده مجاز (فاصله: ${Math.round(dist)} متر)`, 4000, "error");
        setStatus(`خارج از محدوده مجاز (فاصله: ${Math.round(dist)} متر)`);
        return;
      }
    }
  } catch (e) {
    console.error("Geo-fence execution check failed:", e);
  }

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
  const connectionStatus = offlineCreated ? "offline" : "online";
  const connectionStatusFa = offlineCreated ? "آفلاین" : "آنلاین";

  const firstConnectionAfterOfflineRecord = "";
  const lastConnectionBeforeUpload = "";
  const uploadedAt = "";
  const delayAfterFirstConnectionMs = "";

  const sessionClockDriftMs = getSessionClockDriftMs();
  const networkClockDriftMs = navigator.onLine ? await getNetworkTimeDriftMs(nowMs) : null;

  const risk = calculateClockRisk({
    clickMs,
    gpsMs,
    gpsWaitMs,
    photoDelayMs,
    submitDelayMs,
    offlineCreated,
    locationStatus: loc.status,
    accuracy: loc.accuracy,
    sessionClockDriftMs,
    networkClockDriftMs
  });

  const clientRecordId = createClientRecordId(profile.personnelCode, clickMs);

  const record = {
    clientRecordId,
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type,
    recordType: type,
    recordDate: getPersianDate(now),
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
    connectionStatus,
    connectionStatusFa,
    firstConnectionAfterOfflineRecord,
    lastConnectionBeforeUpload,
    uploadedAt,
    delayAfterFirstConnectionMs,
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

  if (navigator.onLine) {
    scheduleSyncPendingRecords(500);
  }
}

function createClientRecordId(personnelCode, baseMs) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${personnelCode}-${baseMs}-${randomPart}`;
}

function getSessionClockDriftMs() {
  const realElapsedMs = performance.now() - APP_SESSION_START_PERF_MS;
  const wallElapsedMs = Date.now() - APP_SESSION_START_WALL_MS;
  const drift = wallElapsedMs - realElapsedMs;
  return Math.round(drift);
}

async function getNetworkTimeDriftMs(deviceNowMs) {
  try {
    const controller = "AbortController" in window ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 3000) : null;

    const response = await fetch("https://worldtimeapi.org/api/timezone/Etc/UTC", {
      signal: controller ? controller.signal : undefined,
      cache: "no-store"
    });

    if (timeoutId) clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.utc_datetime) return null;

    const networkMs = new Date(data.utc_datetime).getTime();
    if (!networkMs || isNaN(networkMs)) return null;

    return Math.abs(networkMs - deviceNowMs);
  } catch (e) {
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

  if (data.gpsMs && data.clickMs) {
    const gpsDiff = Math.abs(data.gpsMs - data.clickMs);
    if (gpsDiff > 2 * 60 * 1000) {
      score += 6;
      reasons.push(`اختلاف با زمان واقعی جی‌پی‌اس (${Math.round(gpsDiff / 60000)} دقیقه)`);
    }
  }

  if (data.offlineCreated) {
    score += 1;
    reasons.push("ثبت آفلاین");
  }

  if (data.locationStatus !== "ok") {
    score += 4;
    reasons.push("GPS نامعتبر/خاموش");
  }

  return {
    clockRisk: score >= 6 ? "high" : score >= 3 ? "medium" : "low",
    clockRiskReason: reasons.length ? reasons.join(" | ") : "نرمال"
  };
}

function isGeolocationUsable() {
  return !!navigator.geolocation && window.isSecureContext;
}

async function getLocationIOSFriendly() {
  if (!isGeolocationUsable()) {
    return emptyLocation("unavailable", "GPS در دسترس نیست");
  }

  const firstLocation = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 25000
  });

  if (hasValidLocation(firstLocation) && firstLocation.accuracy <= GOOD_ACCURACY_METERS) {
    return firstLocation;
  }

  if (firstLocation?.status === "denied") {
    return firstLocation;
  }

  const secondLocation = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 15000
  });

  if (secondLocation?.status === "denied") {
    return secondLocation;
  }

  let bestLocation = chooseBetterLocation(firstLocation, secondLocation);

  if (hasValidLocation(bestLocation) && bestLocation.accuracy <= GOOD_ACCURACY_METERS) {
    return bestLocation;
  }

  const watchedLocation = await getLocationWithWatch(GPS_RETRY_MS);
  bestLocation = chooseBetterLocation(bestLocation, watchedLocation);

  return bestLocation;
}

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    let done = false;

    const timeoutId = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(emptyLocation("timeout", "زمان تمام شد"));
      }
    }, (options.timeout || 20000) + 3000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!done) {
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
        }
      },
      (err) => {
        if (!done) {
          done = true;
          clearTimeout(timeoutId);
          resolve(geoErrorToLocation(err));
        }
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

        if (loc.accuracy <= GOOD_ACCURACY_METERS) {
          finish(loc);
        }
      },
      (err) => {
        finish(geoErrorToLocation(err));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: waitMs
      }
    );

    const timeoutId = setTimeout(() => {
      finish(best);
    }, waitMs + 3000);

    function finish(loc) {
      if (!done) {
        done = true;
        navigator.geolocation.clearWatch(watchId);
        clearTimeout(timeoutId);
        resolve(loc || emptyLocation("timeout", "GPS دریافت نشد"));
      }
    }
  });
}

function geoErrorToLocation(err) {
  if (err.code === 1) {
    return emptyLocation("denied", "دسترسی رد شد");
  }

  if (err.code === 2) {
    return emptyLocation("unavailable", "موقعیت در دسترس نیست");
  }

  if (err.code === 3) {
    return emptyLocation("timeout", "زمان تمام شد");
  }

  return emptyLocation("error", "خطای GPS");
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

function toRad(v) {
  return v * Math.PI / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) *
    Math.sin(dLon/2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function getLastLocationRecord() {
  const list = await dbGetAll(STORE_RECORDS);
  const valid = list
    .filter(r =>
      r.latitude &&
      r.longitude &&
      r.deviceTime
    )
    .sort((a,b) =>
      String(b.deviceTime).localeCompare(String(a.deviceTime))
    );

  if (!valid.length) return null;
  return valid[0];
}

async function detectLocationTeleport(currentLoc) {
  const last = await getLastLocationRecord();
  if (!last) return { ok: true };

  const lat1 = Number(last.latitude);
  const lon1 = Number(last.longitude);
  const lat2 = Number(currentLoc.latitude);
  const lon2 = Number(currentLoc.longitude);

  if (!lat1 || !lon1 || !lat2 || !lon2) {
    return { ok: true }
