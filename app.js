// js.html — Part 1/4

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 4;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

const MAX_HUMAN_SPEED_MPS = 45;
const TELEPORT_DISTANCE_METERS = 100;
const MIN_TIME_FOR_LONG_DISTANCE_MS = 60000;
const ACCURACY_SUSPICIOUS_METERS = 100;

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

        store.createIndex("status", "status", { unique: false });
        store.createIndex("clientRecordId", "clientRecordId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      } else {
        const tx = e.target.transaction;
        const store = tx.objectStore(STORE_RECORDS);

        if (!store.indexNames.contains("status")) {
          store.createIndex("status", "status", { unique: false });
        }

        if (!store.indexNames.contains("clientRecordId")) {
          store.createIndex("clientRecordId", "clientRecordId", { unique: false });
        }

        if (!store.indexNames.contains("createdAt")) {
          store.createIndex("createdAt", "createdAt", { unique: false });
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

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.delete(key);

    req.onsuccess = () => resolve(true);
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
// js.html — Part 2/4

async function ensurePolicyLoadedAtStartup() {
  const cached = await dbGet(STORE_CONFIG, "attendancePolicy");
  if (cached?.attendancePolicy) return;

  if (navigator.onLine) {
    await refreshPolicyIfPossible();
  } else {
    await dbPut(STORE_CONFIG, {
      id: "attendancePolicy",
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      source: "default-offline",
      fetchedAt: new Date().toISOString()
    });
  }
}

function normalizeAttendancePolicy(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase();

  if (
    v === POLICY_NOT_ALLOWED ||
    v === POLICY_ONLINE_ONLY ||
    v === POLICY_OFFLINE_ONLY ||
    v === POLICY_ONLINE_PREFERRED ||
    v === POLICY_ONLINE_OR_OFFLINE ||
    v === POLICY_OFFLINE_ALLOWED_IMMEDIATE
  ) {
    return v;
  }

  return DEFAULT_ATTENDANCE_POLICY;
}

async function getAttendancePolicyInfo() {
  const config = await dbGet(STORE_CONFIG, "attendancePolicy");
  return {
    attendancePolicy: normalizeAttendancePolicy(config?.attendancePolicy),
    fetchedAt: config?.fetchedAt || "",
    source: config?.source || "default"
  };
}

async function refreshPolicyIfPossible() {
  if (!navigator.onLine) return false;

  try {
    const profile = await getProfile();
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", "employee");
    url.searchParams.set("personnelCode", profile.personnelCode);

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) throw new Error("policy fetch failed");

    const data = await res.json();
    const employee = data?.employee || data?.data || data || {};
    const attendancePolicy = normalizeAttendancePolicy(
      employee.AttendancePolicy ||
      employee.attendancePolicy ||
      employee.Policy ||
      employee.policy ||
      DEFAULT_ATTENDANCE_POLICY
    );

    await dbPut(STORE_CONFIG, {
      id: "attendancePolicy",
      attendancePolicy,
      source: "server",
      fetchedAt: new Date().toISOString(),
      employee: {
        personnelCode: profile.personnelCode
      }
    });

    return true;
  } catch (err) {
    return false;
  }
}

function updateOnlineBadge() {
  const onlineEl = $("onlineBadge");
  if (!onlineEl) return;

  if (navigator.onLine) {
    onlineEl.textContent = "آنلاین";
    onlineEl.className = "badge online";
  } else {
    onlineEl.textContent = "آفلاین";
    onlineEl.className = "badge offline";
  }
}

function setStatus(message) {
  const el = $("status");
  if (el) el.textContent = message || "";
}

function setSyncStatus(message) {
  const el = $("syncStatus");
  if (el) el.textContent = message || "";
}

async function refreshUi() {
  await renderPendingCount();
  updateOnlineBadge();
}

async function renderPendingCount() {
  const all = await dbGetAll(STORE_RECORDS);
  const pending = all.filter((x) => x.status === "pending" || x.status === "failed");
  const el = $("pendingCount");
  if (el) el.textContent = String(pending.length);
}

function isGeolocationUsable() {
  return location.protocol === "https:" && "geolocation" in navigator;
}

function getLocationIOSFriendly() {
  return new Promise((resolve) => {
    let settled = false;
    let best = null;
    let watchId = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
      } catch (_) {}
      resolve(result);
    };

    const onSuccess = (pos) => {
      const lat = pos?.coords?.latitude;
      const lng = pos?.coords?.longitude;
      const accuracy = Number(pos?.coords?.accuracy || 999999);
      const timestamp = pos?.timestamp || Date.now();

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const point = {
        status: "ok",
        lat,
        lng,
        accuracy,
        speed: Number.isFinite(pos?.coords?.speed) ? pos.coords.speed : null,
        heading: Number.isFinite(pos?.coords?.heading) ? pos.coords.heading : null,
        altitude: Number.isFinite(pos?.coords?.altitude) ? pos.coords.altitude : null,
        gpsTimestamp: timestamp,
        capturedAt: new Date().toISOString()
      };

      if (!best || accuracy < (best.accuracy || 999999)) {
        best = point;
      }

      if (accuracy <= GOOD_ACCURACY_METERS) {
        finish(best);
      }
    };

    const onError = (err) => {
      if (err?.code === 1) {
        finish({ status: "denied" });
        return;
      }

      if (err?.code === 2) {
        if (best) {
          finish(best);
        } else {
          finish({ status: "unavailable" });
        }
        return;
      }

      if (err?.code === 3) {
        if (best) {
          finish(best);
        } else {
          finish({ status: "timeout" });
        }
        return;
      }

      finish({ status: "error", message: err?.message || "gps error" });
    };

    try {
      watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: GPS_WAIT_MS
      });

      setTimeout(() => {
        if (best) {
          finish(best);
        } else {
          navigator.geolocation.getCurrentPosition(onSuccess, onError, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: GPS_RETRY_MS
          });
        }
      }, HIGH_GPS_WAIT_MS);
    } catch (_) {
      finish({ status: "error", message: "geolocation exception" });
    }
  });
}

function hasValidLocation(loc) {
  return !!(
    loc &&
    loc.status === "ok" &&
    Number.isFinite(loc.lat) &&
    Number.isFinite(loc.lng)
  );
}

async function compressImage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const maxW = 1280;
  const maxH = 1280;
  let { width, height } = img;

  const ratio = Math.min(maxW / width, maxH / height, 1);
  width = Math.round(width * ratio);
  height = Math.round(height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.82;
  let out = canvas.toDataURL("image/jpeg", quality);

  while (out.length > 500000 && quality > 0.4) {
    quality -= 0.08;
    out = canvas.toDataURL("image/jpeg", quality);
  }

  return out;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function generateClientRecordId(personnelCode) {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  const ts = Date.now();
  return `${personnelCode || "EMP"}-${ts}-${rand}`;
}

function getSessionClockDriftInfo() {
  const wallNow = Date.now();
  const perfNow = performance.now();
  const expectedWallNow = APP_SESSION_START_WALL_MS + (perfNow - APP_SESSION_START_PERF_MS);
  const driftMs = Math.round(wallNow - expectedWallNow);

  return {
    sessionWallNow: wallNow,
    sessionPerfNow: perfNow,
    expectedWallNow,
    driftMs,
    suspicious: Math.abs(driftMs) > CLOCK_DRIFT_SESSION_LIMIT_MS
  };
}

async function getNetworkClockInfo() {
  if (!navigator.onLine) {
    return {
      available: false,
      reason: "offline"
    };
  }

  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "HEAD",
      cache: "no-store"
    });

    const dateHeader = res.headers.get("Date");
    if (!dateHeader) {
      return {
        available: false,
        reason: "no-date-header"
      };
    }

    const serverMs = new Date(dateHeader).getTime();
    const clientMs = Date.now();

    if (!Number.isFinite(serverMs)) {
      return {
        available: false,
        reason: "invalid-date-header"
      };
    }

    const diffMs = clientMs - serverMs;

    return {
      available: true,
      serverTimeIso: new Date(serverMs).toISOString(),
      clientTimeIso: new Date(clientMs).toISOString(),
      diffMs,
      suspicious: Math.abs(diffMs) > CLOCK_DRIFT_NETWORK_LIMIT_MS
    };
  } catch (err) {
    return {
      available: false,
      reason: "network-error"
    };
  }
}

async function runLocationSecurityChecks(locationFix) {
  const warnings = [];
  const flags = {
    suspiciousAccuracy: false,
    teleport: false,
    clockDriftSession: false,
    clockDriftNetwork: false,
    gpsClickGapHigh: false
  };

  if (!locationFix || !hasValidLocation(locationFix)) {
    warnings.push("gps_missing");
    return {
      ok: false,
      flags,
      warnings
    };
  }

  if (Number(locationFix.accuracy || 999999) > ACCURACY_SUSPICIOUS_METERS) {
    flags.suspiciousAccuracy = true;
    warnings.push("gps_accuracy_suspicious");
  }

  const last = await dbGet(STORE_CONFIG, "lastLocationFix");
  if (last && hasValidLocation(last)) {
    const teleport = detectLocationTeleport(last, locationFix);
    if (teleport.suspicious) {
      flags.teleport = true;
      warnings.push("location_teleport");
    }
  }

  const sessionDrift = getSessionClockDriftInfo();
  if (sessionDrift.suspicious) {
    flags.clockDriftSession = true;
    warnings.push("clock_drift_session");
  }

  const networkClock = await getNetworkClockInfo();
  if (networkClock.available && networkClock.suspicious) {
    flags.clockDriftNetwork = true;
    warnings.push("clock_drift_network");
  }

  if (captureStartedAtMs && locationFix.gpsTimestamp) {
    const gap = Math.abs(Number(locationFix.gpsTimestamp) - Number(captureStartedAtMs));
    if (gap > CLOCK_RISK_GPS_CLICK_DIFF_MS) {
      flags.gpsClickGapHigh = true;
      warnings.push("gps_click_gap_high");
    }
  }

  await dbPut(STORE_CONFIG, {
    id: "lastLocationFix",
    ...locationFix,
    savedAt: new Date().toISOString()
  });

  return {
    ok: true,
    flags,
    warnings,
    sessionDrift,
    networkClock
  };
}

function detectLocationTeleport(prev, current) {
  const prevTs = Number(prev.gpsTimestamp || new Date(prev.capturedAt || 0).getTime() || 0);
  const currentTs = Number(current.gpsTimestamp || new Date(current.capturedAt || 0).getTime() || 0);

  const dtMs = Math.max(0, currentTs - prevTs);
  const dist = distanceMeters(prev.lat, prev.lng, current.lat, current.lng);
  const speedMps = dtMs > 0 ? dist / (dtMs / 1000) : Infinity;

  const suspicious =
    dist >= TELEPORT_DISTANCE_METERS &&
    (dtMs < MIN_TIME_FOR_LONG_DISTANCE_MS || speedMps > MAX_HUMAN_SPEED_MPS);

  return {
    suspicious,
    distanceMeters: Math.round(dist),
    deltaMs: dtMs,
    speedMps: Number.isFinite(speedMps) ? Math.round(speedMps * 100) / 100 : null
  };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(v) {
  return v * Math.PI / 180;
}

function isPointInPolygon(point, polygon) {
  const x = point.lng;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersect =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}
// js.html — Part 3/4

async function createRecord(type) {
  try {
    const profile = await getProfile();

    if (!currentPhoto) {
      setStatus("عکس ثبت نشده است.");
      return;
    }

    if (!hasValidLocation(pendingLocation)) {
      setStatus("GPS معتبر دریافت نشد.");
      return;
    }

    const policyInfo = await getAttendancePolicyInfo();
    const gate = evaluateAttendancePolicy(policyInfo.attendancePolicy, navigator.onLine);

    if (!gate.ok) {
      setStatus(gate.message);
      return;
    }

    const security = await runLocationSecurityChecks(pendingLocation);

    const clientRecordId = generateClientRecordId(profile.personnelCode);
    const now = new Date();

    const record = {
      clientRecordId,
      type: type || "تردد",
      personnelCode: profile.personnelCode,
      firstName: profile.firstName,
      lastName: profile.lastName,
      photo: currentPhoto,
      createdAt: now.toISOString(),
      createdAtMs: now.getTime(),
      date: now.toLocaleDateString("fa-IR"),
      time: now.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      latitude: pendingLocation.lat,
      longitude: pendingLocation.lng,
      accuracy: pendingLocation.accuracy ?? "",
      speed: pendingLocation.speed ?? "",
      heading: pendingLocation.heading ?? "",
      altitude: pendingLocation.altitude ?? "",
      gpsTimestamp: pendingLocation.gpsTimestamp || "",
      gpsCapturedAt: pendingLocation.capturedAt || "",
      captureStartedAtMs,
      photoSelectedAtMs,
      photoCompressedAtMs,
      onlineAtCreation: navigator.onLine,
      attendancePolicy: policyInfo.attendancePolicy,
      policyFetchedAt: policyInfo.fetchedAt || "",
      policySource: policyInfo.source || "",
      securityFlags: security.flags || {},
      securityWarnings: security.warnings || [],
      sessionClockDriftMs: security.sessionDrift?.driftMs ?? "",
      networkClockDiffMs: security.networkClock?.diffMs ?? "",
      networkClockAvailable: !!security.networkClock?.available,
      status: navigator.onLine ? "pending" : "pending",
      syncedAt: "",
      serverResponse: ""
    };

    await dbPut(STORE_RECORDS, record);

    currentPhoto = "";
    pendingLocation = null;

    if ($("photoInput")) $("photoInput").value = "";

    if ($("photoPreview")) {
      $("photoPreview").removeAttribute("src");
      $("photoPreview").style.display = "none";
    }

   await refreshUi();

const recordBtn = $("recordBtn");

if (navigator.onLine) {

  if (recordBtn) {
    recordBtn.disabled = true;
    recordBtn.innerHTML = 'در حال ارسال <span class="dots"></span>';
  }

  setStatus("تردد ثبت شد. در حال ارسال به سرور ...");

  scheduleSyncPendingRecords(100);

} else {
  setStatus("تردد آفلاین ذخیره شد و بعداً ارسال می‌شود.");
}

  } catch (err) {
    console.error(err);
    setStatus("خطا در ساخت رکورد");
  }
}

function normalizeAttendancePayload(record) {
  return {
    action: "recordAttendance",
    clientRecordId: record.clientRecordId || "",
    PersonnelCode: record.personnelCode || "",
    FirstName: record.firstName || "",
    LastName: record.lastName || "",
    RecordType: record.type || "تردد",
    Date: record.date || "",
    Time: record.time || "",
    Latitude: record.latitude ?? "",
    Longitude: record.longitude ?? "",
    Accuracy: record.accuracy ?? "",
    Speed: record.speed ?? "",
    Heading: record.heading ?? "",
    Altitude: record.altitude ?? "",
    GpsTimestamp: record.gpsTimestamp || "",
    GpsCapturedAt: record.gpsCapturedAt || "",
    CaptureStartedAtMs: record.captureStartedAtMs || "",
    PhotoSelectedAtMs: record.photoSelectedAtMs || "",
    PhotoCompressedAtMs: record.photoCompressedAtMs || "",
    OnlineAtCreation: record.onlineAtCreation ? "true" : "false",
    AttendancePolicy: record.attendancePolicy || "",
    PolicyFetchedAt: record.policyFetchedAt || "",
    PolicySource: record.policySource || "",
    SessionClockDriftMs: record.sessionClockDriftMs ?? "",
    NetworkClockDiffMs: record.networkClockDiffMs ?? "",
    NetworkClockAvailable: record.networkClockAvailable ? "true" : "false",
    SecurityFlagsJson: JSON.stringify(record.securityFlags || {}),
    SecurityWarningsJson: JSON.stringify(record.securityWarnings || []),
    PhotoBase64: record.photo || ""
  };
}

async function markFirstConnectionForOfflineRecords() {
  const all = await dbGetAll(STORE_RECORDS);
  const changed = [];

  for (const rec of all) {
    if ((rec.status === "pending" || rec.status === "failed") && !rec.firstOnlineAt && !rec.onlineAtCreation) {
      rec.firstOnlineAt = new Date().toISOString();
      changed.push(rec);
    }
  }

  for (const item of changed) {
    await dbPut(STORE_RECORDS, item);
  }
}

async function syncPendingRecords() {
  if (syncRunning) return;
  if (!navigator.onLine) return;

  syncRunning = true;
  setSyncStatus("در حال همگام‌سازی...");
const recordBtn = $("recordBtn");
if (recordBtn) {
  recordBtn.disabled = false;
  recordBtn.textContent = "ثبت تردد";
}

  try {
    const all = await dbGetAll(STORE_RECORDS);
    const pending = all
      .filter((x) => x.status === "pending" || x.status === "failed")
      .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));

    if (!pending.length) {
      setSyncStatus("موردی برای ارسال وجود ندارد");
      await refreshUi();
      syncRunning = false;
      return;
    }

    for (const rec of pending) {
      try {
        const payload = normalizeAttendancePayload(rec);

        const form = new URLSearchParams();
        Object.entries(payload).forEach(([k, v]) => {
          form.append(k, v == null ? "" : String(v));
        });

        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body: form.toString()
        });

        const text = await res.text();
        let data = null;

        try {
          data = JSON.parse(text);
        } catch (_) {
          data = { ok: false, raw: text };
        }

        if (!res.ok || data?.ok === false) {
          rec.status = "failed";
          rec.serverResponse = text || "";
          await dbPut(STORE_RECORDS, rec);
          continue;
        }

        rec.status = "synced";
        rec.syncedAt = new Date().toISOString();
        rec.serverResponse = text || "";
        rec.serverRecordId = data?.recordId || data?.id || "";
        await dbPut(STORE_RECORDS, rec);
      } catch (err) {
        rec.status = "failed";
        rec.serverResponse = err?.message || "sync error";
        await dbPut(STORE_RECORDS, rec);
      }
    }

    await refreshUi();
    setSyncStatus("همگام‌سازی انجام شد");
  } catch (err) {
    setSyncStatus("خطا در همگام‌سازی");
  } finally {
    syncRunning = false;
  }
}

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await getProfile();
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", "employee");
    url.searchParams.set("personnelCode", profile.personnelCode);

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return;

    const data = await res.json();
    const employee = data?.employee || data?.data || data || {};
    const message = (
      employee.AdminMessage ||
      employee.adminMessage ||
      employee.Message ||
      employee.message ||
      ""
    ).trim();

    if (message && !adminMessageShownOnEntry) {
      adminMessageShownOnEntry = true;
      showAdminMessage(message);
    }
  } catch (_) {}
}

function showAdminMessage(message) {
  const box = $("adminMessage");
  if (!box) return;

  box.textContent = message;
  box.style.display = "block";
}

async function clearSyncedRecordsIfNeeded(maxKeep = 200) {
  const all = await dbGetAll(STORE_RECORDS);
  const synced = all
    .filter((x) => x.status === "synced")
    .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));

  if (synced.length <= maxKeep) return;

  const toDelete = synced.slice(0, synced.length - maxKeep);
  for (const item of toDelete) {
    await dbDelete(STORE_RECORDS, item.id);
  }
}
// js.html — Part 4/4

async function forceManualSync() {
  if (!navigator.onLine) {
    setSyncStatus("اینترنت قطع است");
    return;
  }

  await refreshPolicyIfPossible();
  await markFirstConnectionForOfflineRecords();
  await syncPendingRecords();
  await clearSyncedRecordsIfNeeded();
  await refreshUi();
}

window.forceManualSync = forceManualSync;

async function exportLocalRecords() {
  const all = await dbGetAll(STORE_RECORDS);
  const blob = new Blob(
    [JSON.stringify(all, null, 2)],
    { type: "application/json;charset=utf-8" }
  );

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `attendance-records-${Date.now()}.json`;
  a.click();

  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

window.exportLocalRecords = exportLocalRecords;

async function showLocalDebugInfo() {
  const all = await dbGetAll(STORE_RECORDS);
  const profile = await dbGet(STORE_PROFILE, "main");
  const policy = await dbGet(STORE_CONFIG, "attendancePolicy");
  const lastFix = await dbGet(STORE_CONFIG, "lastLocationFix");

  const info = {
    online: navigator.onLine,
    profile,
    policy,
    lastFix,
    totalRecords: all.length,
    pending: all.filter((x) => x.status === "pending").length,
    failed: all.filter((x) => x.status === "failed").length,
    synced: all.filter((x) => x.status === "synced").length,
    sample: all.slice(-5)
  };

  console.log(info);
  alert(JSON.stringify(info, null, 2));
}

window.showLocalDebugInfo = showLocalDebugInfo;

async function retryFailedRecords() {
  const all = await dbGetAll(STORE_RECORDS);
  const failed = all.filter((x) => x.status === "failed");

  for (const rec of failed) {
    rec.status = "pending";
    await dbPut(STORE_RECORDS, rec);
  }

  await refreshUi();
  scheduleSyncPendingRecords(100);
}

window.retryFailedRecords = retryFailedRecords;

async function deleteAllLocalRecords() {
  const all = await dbGetAll(STORE_RECORDS);
  for (const rec of all) {
    await dbDelete(STORE_RECORDS, rec.id);
  }
  await refreshUi();
  setSyncStatus("همه رکوردهای محلی حذف شدند");
}

window.deleteAllLocalRecords = deleteAllLocalRecords;

async function resendLastRecord() {
  const all = await dbGetAll(STORE_RECORDS);
  const last = all.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))[0];

  if (!last) {
    setSyncStatus("رکوردی وجود ندارد");
    return;
  }

  last.status = "pending";
  await dbPut(STORE_RECORDS, last);
  await syncPendingRecords();
}

window.resendLastRecord = resendLastRecord;

function formatPersianNumber(value) {
  return String(value ?? "").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}

async function renderLastRecords(limit = 10) {
  const all = await dbGetAll(STORE_RECORDS);
  const list = $("lastRecords");
  if (!list) return;

  const rows = all
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
    .slice(0, limit);

  if (!rows.length) {
    list.innerHTML = "<div>رکوردی ثبت نشده است</div>";
    return;
  }

  list.innerHTML = rows.map((r) => {
    const statusFa =
      r.status === "synced" ? "ارسال‌شده" :
      r.status === "failed" ? "خطادار" :
      "در انتظار";

    return `
      <div class="record-row status-${r.status}">
        <div><b>${r.firstName || ""} ${r.lastName || ""}</b> - ${r.personnelCode || ""}</div>
        <div>${r.date || ""} ${r.time || ""}</div>
        <div>${statusFa}</div>
      </div>
    `;
  }).join("");
}

async function refreshUiFull() {
  await refreshUi();
  await renderLastRecords();
}

window.refreshUiFull = refreshUiFull;

document.addEventListener("DOMContentLoaded", () => {
  const manualSyncBtn = $("manualSyncBtn");
  if (manualSyncBtn) {
    manualSyncBtn.addEventListener("click", forceManualSync);
  }

  const retryBtn = $("retryFailedBtn");
  if (retryBtn) {
    retryBtn.addEventListener("click", retryFailedRecords);
  }

  const exportBtn = $("exportBtn");
  if (exportBtn) {
    exportBtn.addEventListener("click", exportLocalRecords);
  }

  const debugBtn = $("debugBtn");
  if (debugBtn) {
    debugBtn.addEventListener("click", showLocalDebugInfo);
  }

  const clearBtn = $("clearLocalBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", deleteAllLocalRecords);
  }

  refreshUiFull().catch(() => {});
});

window.addEventListener("beforeunload", () => {
  if (syncTimer) clearTimeout(syncTimer);
});

function normalizeServerEmployeeResponse(data) {
  const employee = data?.employee || data?.data || data || {};

  return {
    personnelCode: employee.PersonnelCode || employee.personnelCode || "",
    firstName: employee.FirstName || employee.firstName || "",
    lastName: employee.LastName || employee.lastName || "",
    attendancePolicy: normalizeAttendancePolicy(
      employee.AttendancePolicy ||
      employee.attendancePolicy ||
      DEFAULT_ATTENDANCE_POLICY
    ),
    adminMessage:
      employee.AdminMessage ||
      employee.adminMessage ||
      ""
  };
}

async function preloadEmployeeDataIfPossible() {
  if (!navigator.onLine) return;

  try {
    const profile = await getProfile();
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", "employee");
    url.searchParams.set("personnelCode", profile.personnelCode);

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return;

    const data = await res.json();
    const employee = normalizeServerEmployeeResponse(data);

    if ($("firstName") && !($("firstName").value || "").trim() && employee.firstName) {
      $("firstName").value = employee.firstName;
    }

    if ($("lastName") && !($("lastName").value || "").trim() && employee.lastName) {
      $("lastName").value = employee.lastName;
    }

    await dbPut(STORE_CONFIG, {
      id: "attendancePolicy",
      attendancePolicy: employee.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
      source: "server",
      fetchedAt: new Date().toISOString(),
      employee: {
        personnelCode: employee.personnelCode || profile.personnelCode
      }
    });

    if (employee.adminMessage) {
      showAdminMessage(employee.adminMessage);
    }
  } catch (_) {}
}

window.preloadEmployeeDataIfPossible = preloadEmployeeDataIfPossible;
