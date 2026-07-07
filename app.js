/* FILE: /app.js */ 
/* REPLACE FULL FILE */

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 7;

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

const HEARTBEAT_INTERVAL_MS = 60 * 1000;

let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;
let syncTimer = null;
let lastAdminMessage = null;
let heartbeatTimer = null;

let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

/* =========================
   Boot
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    setTimeout(() => {
      showGpsToast("★ حتما جی پی اس و اینترنت خود را روشن کنید تمامی مناطق تحت پوشش اینترنت هستند", 5000, "error");
    }, 4200);
  } catch (_) {}

  try {
    const testDb = await openDb();
    testDb.close();
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

  updateOnlineBadge();

  if (navigator.onLine) {
    startHeartbeat();
    scheduleSyncPendingRecords(1000);
  }
});

/* =========================
   UI Helpers
========================= */

function setBusy(isBusy, message = "در حال پردازش...") {
  const overlay = $("busyOverlay");
  const text = $("busyText");
  if (!overlay || !text) return;

  text.textContent = message;
  overlay.style.display = isBusy ? "flex" : "none";
}

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
   Jalali Date
========================= */

function getJalaliDateParts(date = new Date()) {
  const g_y = date.getFullYear();
  const g_m = date.getMonth() + 1;
  const g_d = date.getDate();

  const g_days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const jy_days_in_month = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

  let gy = g_y - 1600;
  let gm = g_m - 1;
  let gd = g_d - 1;

  let g_day_no =
    365 * gy +
    Math.floor((gy + 3) / 4) -
    Math.floor((gy + 99) / 100) +
    Math.floor((gy + 399) / 400);

  for (let i = 0; i < gm; ++i) g_day_no += g_days_in_month[i];

  if (gm > 1 && ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0)) {
    g_day_no++;
  }

  g_day_no += gd;

  let j_day_no = g_day_no - 79;
  const j_np = Math.floor(j_day_no / 12053);
  j_day_no %= 12053;

  let jy = 979 + 33 * j_np + 4 * Math.floor(j_day_no / 1461);
  j_day_no %= 1461;

  if (j_day_no >= 366) {
    jy += Math.floor((j_day_no - 1) / 365);
    j_day_no = (j_day_no - 1) % 365;
  }

  let i = 0;
  for (i = 0; i < 11 && j_day_no >= jy_days_in_month[i]; ++i) {
    j_day_no -= jy_days_in_month[i];
  }

  const jm = i + 1;
  const jd = j_day_no + 1;

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
   IndexedDB
========================= */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: "clientRecordId" });
      }

      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        db.close();
      };

      resolve(db);
    };

    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

async function dbPut(store, value) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let settled = false;

    try {
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.put(value);

      tx.oncomplete = () => {
        settled = true;
        db.close();
        resolve(req.result);
      };

      tx.onerror = () => {
        settled = true;
        db.close();
        reject(tx.error || req.error || new Error("IndexedDB put failed"));
      };

      tx.onabort = () => {
        settled = true;
        db.close();
        reject(tx.error || new Error("IndexedDB transaction aborted"));
      };
    } catch (err) {
      if (!settled) {
        db.close();
        reject(err);
      }
    }
  });
}

async function dbGet(store, key) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let settled = false;

    try {
      const tx = db.transaction(store, "readonly");
      const st = tx.objectStore(store);
      const req = st.get(key);

      tx.oncomplete = () => {
        settled = true;
        db.close();
        resolve(req.result);
      };

      tx.onerror = () => {
        settled = true;
        db.close();
        reject(tx.error || req.error || new Error("IndexedDB get failed"));
      };

      tx.onabort = () => {
        settled = true;
        db.close();
        reject(tx.error || new Error("IndexedDB transaction aborted"));
      };
    } catch (err) {
      if (!settled) {
        db.close();
        reject(err);
      }
    }
  });
}

async function dbGetAll(store) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let settled = false;

    try {
      const tx = db.transaction(store, "readonly");
      const st = tx.objectStore(store);
      const req = st.getAll();

      tx.oncomplete = () => {
        settled = true;
        db.close();
        resolve(req.result || []);
      };

      tx.onerror = () => {
        settled = true;
        db.close();
        reject(tx.error || req.error || new Error("IndexedDB getAll failed"));
      };

      tx.onabort = () => {
        settled = true;
        db.close();
        reject(tx.error || new Error("IndexedDB transaction aborted"));
      };
    } catch (err) {
      if (!settled) {
        db.close();
        reject(err);
      }
    }
  });
}

async function dbDelete(store, key) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.delete(key);

      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error || req.error || new Error("IndexedDB delete failed"));
      };

      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("IndexedDB transaction aborted"));
      };
    } catch (err) {
      db.close();
      reject(err);
    }
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
    if (!profile.personnelCode || !profile.firstName || !profile.lastName) return;

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
      startHeartbeat();
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
    policyFetchedAt: data.policyFetchedAt || new Date().toISOString(),
    policySource: data.policySource || "server",
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

    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
    });

    if (!response.ok) return null;

    const text = await response.text();
    const data = JSON.parse(text);

    if (data && typeof data === "object" && data.ok !== false) {
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
    setStatus("ورودی عکس پیدا نشد.");
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
      setStatus("GPS در دسترس نیست.");
      return;
    }

    setBusy(true, "در حال دریافت GPS...");
    setStatus("در حال دریافت GPS...");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      setBusy(false);

      if (pendingLocation?.status === "denied") {
        setStatus("دسترسی GPS رد شد.");
        return;
      }

      setStatus("GPS دریافت نشد.");
      return;
    }

    setBusy(true, "در حال ذخیره تردد...");
    await createRecord("تردد");
    setBusy(false);
  } catch (err) {
    console.error(err);
    setBusy(false);
    setStatus("خطا در پردازش");
  }
}

async function createRecord(type) {
  try {
    const profile = await getProfile();
    const now = new Date();
    const jalaliDateStr = getJalaliIsoDate(now);
    const timeStr = getTime(now);

    const deviceTimeAtGps = pendingLocation?.timestamp ? new Date(pendingLocation.timestamp).toISOString() : "";
    const gpsWaitMs = pendingLocation?.timestamp ? Math.round(pendingLocation.timestamp - captureStartedAtMs) : "";

    const policyInfo = await getAttendancePolicyInfo();

    const localRecord = {
      clientRecordId: createClientRecordId(profile.personnelCode, captureStartedAtMs),
      personnelCode: profile.personnelCode,
      firstName: profile.firstName,
      lastName: profile.lastName,

      type: type,
      recordType: type,

      recordDate: jalaliDateStr,
      recordHour: timeStr,
      recordTime: timeStr,

      latitude: pendingLocation ? String(pendingLocation.latitude) : "",
      longitude: pendingLocation ? String(pendingLocation.longitude) : "",
      accuracy: pendingLocation ? String(pendingLocation.accuracy) : "",

      locationStatus: pendingLocation ? pendingLocation.status : "unknown",
      locationError: pendingLocation ? pendingLocation.error || "" : "",

      deviceTime: now.toISOString(),
      deviceTimeAtClick: new Date(captureStartedAtMs).toISOString(),
      deviceTimeAtPhoto: photoSelectedAtMs ? new Date(photoSelectedAtMs).toISOString() : "",
      deviceTimeAtPhotoCompressed: photoCompressedAtMs ? new Date(photoCompressedAtMs).toISOString() : "",
      deviceTimeAtGps,
      gpsTimestamp: deviceTimeAtGps,
      gpsWaitMs,

      photoDelayMs: photoSelectedAtMs ? Math.round(photoSelectedAtMs - captureStartedAtMs) : "",
      submitDelayMs: Math.round(now.getTime() - captureStartedAtMs),

      offlineCreated: !navigator.onLine,
      createdOnline: navigator.onLine,
      connectionStatus: navigator.onLine ? "online" : "offline",
      connectionStatusFa: navigator.onLine ? "آنلاین" : "آفلاین",

      firstConnectionAfterOfflineRecord: "",
      lastConnectionBeforeUpload: navigator.onLine ? now.toISOString() : "",
      uploadedAt: "",
      delayAfterFirstConnectionMs: "",

      photo: currentPhoto || "",
      createdAt: now.toISOString(),

      lastSyncTryAt: "",
      syncTryCount: 0,
      status: "pending",

      sessionClockDriftMs: getSessionClockDriftMs(),
      networkClockDriftMs: await getNetworkTimeDriftMs(now.getTime()),

      attendancePolicy: policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
      policyVersion: policyInfo.policyVersion || 0,
      policyFetchedAt: policyInfo.policyFetchedAt || "",
      policySource: policyInfo.policySource || "",
    };

    const risk = calculateClockRisk(localRecord);
    localRecord.clockRisk = risk.clockRisk;
    localRecord.clockRiskReason = risk.clockRiskReason;

    await dbPut(STORE_RECORDS, localRecord);

    setStatus("تردد در دیتابیس محلی ذخیره شد.");
    await refreshUi();

    if (navigator.onLine) {
      scheduleSyncPendingRecords(500);
    } else {
      showGpsToast("تردد به صورت آفلاین ذخیره شد. در اولین اتصال ارسال خواهد شد.", 4000, "success");
    }
  } catch (err) {
    console.error("Error creating record:", err);
    setStatus("خطا در ایجاد رکورد: " + err.message);
  }
}

function createClientRecordId(personnelCode, baseMs) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${personnelCode}-${baseMs}-${randomPart}`;
}

/* =========================
   Sync
========================= */

function setupAutoSync() {
  updateOnlineBadge();

  window.addEventListener("online", async () => {
    updateOnlineBadge();
    startHeartbeat();
    await refreshPolicyIfPossible();
    await markFirstConnectionForOfflineRecords();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
  });

  window.addEventListener("offline", () => {
    updateOnlineBadge();
    stopHeartbeat();
  });

  window.addEventListener("focus", async () => {
    if (!navigator.onLine) return;

    startHeartbeat();
    await refreshPolicyIfPossible();
    scheduleSyncPendingRecords(500);
    await fetchMessages();
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      stopHeartbeat();
      return;
    }

    if (!navigator.onLine) return;

    startHeartbeat();
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

async function markFirstConnectionForOfflineRecords() {
  if (!navigator.onLine) return;

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
  setSyncStatus("در حال ارسال...");

  try {
    const records = await dbGetAll(STORE_RECORDS);
    const pending = records.filter(
      (r) => r.status === "pending" || r.status === "failed" || r.status === "syncing"
    );

    if (!pending.length) {
      setSyncStatus("بروز");
      syncRunning = false;
      return;
    }

    let successCount = 0;

    for (const record of pending) {
      record.status = "syncing";
      record.lastSyncTryAt = new Date().toISOString();
      record.syncTryCount = Number(record.syncTryCount || 0) + 1;

      await dbPut(STORE_RECORDS, record);

      const now = new Date();

      if (record.offlineCreated && record.firstConnectionAfterOfflineRecord) {
        const firstConnMs = new Date(record.firstConnectionAfterOfflineRecord).getTime();
        record.delayAfterFirstConnectionMs = Math.max(0, now.getTime() - firstConnMs);
      }

      record.lastConnectionBeforeUpload = now.toISOString();

      const payload = buildServerPayload(record);

      try {
        const response = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
          },
          body: JSON.stringify(payload),
        });

        let resJson = null;

        try {
          const txt = await response.text();
          resJson = txt ? JSON.parse(txt) : null;
        } catch (_) {
          resJson = null;
        }

        if (response.ok && resJson && (resJson.ok === true || resJson.success === true || resJson.status === "success")) {
          record.status = "sent";
          record.uploadedAt = new Date().toISOString();
          await dbPut(STORE_RECORDS, record);
          successCount++;
          continue;
        }

        record.status = "failed";
        await dbPut(STORE_RECORDS, record);
      } catch (err) {
        console.error("Sync fetch failed for clientRecordId:", record.clientRecordId, err);
        record.status = "failed";
        await dbPut(STORE_RECORDS, record);
      }
    }

    if (successCount > 0) {
      showGpsToast(`تعداد ${successCount} تردد با موفقیت ارسال شد.`, 3000, "success");
    }

    await refreshUi();
    setSyncStatus("بروز");
  } catch (err) {
    console.error("Sync failed:", err);
    setSyncStatus("خطا در ارسال");
  } finally {
    syncRunning = false;
  }
}

function buildServerPayload(record) {
  return {
    action: "attendance",

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

    deviceTime: record.deviceTime || "",
    offlineCreated: !!record.offlineCreated,
    clockRisk: record.clockRisk || "",

    photo: record.photo || "",

    locationStatus: record.locationStatus || "",
    locationError: record.locationError || "",

    deviceTimeAtClick: record.deviceTimeAtClick || "",
    deviceTimeAtPhoto: record.deviceTimeAtPhoto || "",
    deviceTimeAtPhotoCompressed: record.deviceTimeAtPhotoCompressed || "",
    deviceTimeAtGps: record.deviceTimeAtGps || "",

    gpsTimestamp: record.gpsTimestamp || "",
    gpsWaitMs: record.gpsWaitMs ?? "",

    photoDelayMs: record.photoDelayMs ?? "",
    submitDelayMs: record.submitDelayMs ?? "",

    createdOnline: record.createdOnline === true,
    connectionStatus: record.connectionStatus || (record.offlineCreated ? "offline" : "online"),
    connectionStatusFa: record.connectionStatusFa || (record.offlineCreated ? "آفلاین" : "آنلاین"),

    firstConnectionAfterOfflineRecord: record.firstConnectionAfterOfflineRecord || "",
    lastConnectionBeforeUpload: record.lastConnectionBeforeUpload || "",
    uploadedAt: record.uploadedAt || "",
    delayAfterFirstConnectionMs: record.delayAfterFirstConnectionMs ?? "",

    clockRiskReason: record.clockRiskReason || "",
    sessionClockDriftMs: record.sessionClockDriftMs ?? "",
    networkClockDriftMs: record.networkClockDriftMs ?? "",

    attendancePolicy: record.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
    policyVersion: Number(record.policyVersion || 0),
    policyFetchedAt: record.policyFetchedAt || "",
    policySource: record.policySource || "",

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

  if ($("pendingCount")) {
    $("pendingCount").textContent = rec.filter((r) => r.status === "pending" || r.status === "syncing").length;
  }

  if ($("sentCount")) {
    $("sentCount").textContent = rec.filter((r) => r.status === "sent").length;
  }

  if ($("failedCount")) {
    $("failedCount").textContent = rec.filter((r) => r.status === "failed").length;
  }

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
      const conn = r.connectionStatusFa || (r.offlineCreated ? "آفلاین" : "آنلاین");
      const statusFa =
        r.status === "sent"
          ? "ارسال‌شده"
          : r.status === "failed"
            ? "ناموفق"
            : r.status === "syncing"
              ? "در حال ارسال"
              : "در انتظار";

      return `
        <div class="record-item compact-record">
          <span>${escapeHtml(r.recordDate || "")}</span>
          <span>${escapeHtml(r.recordHour || r.recordTime || "")} - ${escapeHtml(conn)} - ${escapeHtml(statusFa)}</span>
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
      cache: "no-store",
    });

    if (!response.ok) return;

    const rawText = await response.text();
    if (!rawText || rawText.trim() === "" || rawText === "[]") return;

    let finalMsg = "";

    try {
      const data = JSON.parse(rawText);

      if (Array.isArray(data)) {
        finalMsg = data[data.length - 1] || "";
      } else if (data && Array.isArray(data.messages)) {
        finalMsg = data.messages[data.messages.length - 1] || "";
      } else if (data && typeof data.message === "string") {
        finalMsg = data.message;
      } else if (typeof data === "string") {
        finalMsg = data;
      }
    } catch (_) {
      finalMsg = rawText;
    }

    if (finalMsg && finalMsg !== lastAdminMessage) {
      lastAdminMessage = finalMsg;
      showAdminMessage(finalMsg);
    }
  } catch (_) {}
}

function showAdminMessage(message) {
  const existing = document.getElementById("admin-message-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "admin-message-overlay";
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);backdrop-filter:blur(5px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;";

  const container = document.createElement("div");
  container.style.cssText =
    "background:#fff7ed;border:2px solid #ea580c;border-radius:16px;padding:24px;width:100%;max-width:450px;text-align:right;direction:rtl;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:bold;color:#c2410c;margin-bottom:12px;";
  title.textContent = "🔔 پیام مدیریت";

  const body = document.createElement("div");
  body.style.cssText =
    "font-size:15px;color:#431407;line-height:1.6;margin-bottom:20px;white-space:pre-wrap;";
  body.textContent = message;

  const btn = document.createElement("button");
  btn.style.cssText =
    "width:100%;background:#ea580c;color:#fff;border:none;padding:12px;border-radius:10px;font-weight:bold;cursor:pointer;";
  btn.textContent = "متوجه شدم";
  btn.onclick = () => overlay.remove();

  container.appendChild(title);
  container.appendChild(body);
  container.appendChild(btn);
  overlay.appendChild(container);
  document.body.appendChild(overlay);
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

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
          status: "ok",
          error: "",
        }),
      (err) => {
        const status = err && err.code === 1 ? "denied" : "error";
        resolve(emptyLocation(status, err?.message || ""));
      },
      options
    );
  });
}

async function getLocationIOSFriendly() {
  const first = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  });

  if (first.status === "ok" && Number(first.accuracy || 999999) <= GOOD_ACCURACY_METERS) {
    return first;
  }

  const second = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    timeout: GPS_RETRY_MS,
    maximumAge: 0,
  });

  return chooseBetterLocation(first, second);
}

function chooseBetterLocation(a, b) {
  if (!a || !a.latitude) return b;
  if (!b || !b.latitude) return a;
  return Number(a.accuracy || 999999) <= Number(b.accuracy || 999999) ? a : b;
}

/* =========================
   Image
========================= */

async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const OUT_W = 900;
                const OUT_H = 1350;
                canvas.width = OUT_W;
                canvas.height = OUT_H;
                const ctx = canvas.getContext("2d");
                
                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, OUT_W, OUT_H);
                
                // حفظ نسبت ابعاد تصویر
                const ratio = Math.min(OUT_W / img.width, OUT_H / img.height);
                const x = (OUT_W - img.width * ratio) / 2;
                const y = (OUT_H - img.height * ratio) / 2;
                ctx.drawImage(img, x, y, img.width * ratio, img.height * ratio);
                
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error("Canvas toBlob failed"));
                        return;
                    }
                    const reader2 = new FileReader();
                    reader2.onload = () => resolve(reader2.result);
                    reader2.onerror = () => reject(new Error("Blob reader failed"));
                    reader2.readAsDataURL(blob);
                }, "image/jpeg", 0.7);
            };
            img.onerror = () => reject(new Error("Image load failed"));
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}
// File: app.js
// Append the following code to the very end of the file, outside all existing function blocks.

window.startHeartbeat = function() {
    if (window.heartbeatInterval) return;
    
    sendHeartbeat();
    
    window.heartbeatInterval = setInterval(function() {
        if (navigator.onLine) {
            sendHeartbeat();
        }
    }, 30000);
};

window.sendHeartbeat = function() {
    const code = localStorage.getItem("personnelCode");
    const url = localStorage.getItem("APPS_SCRIPT_URL");
    
    if (!code || !url) return;

    const payload = new URLSearchParams({
        type: "Heartbeat",
        personnelCode: code,
        firstName: localStorage.getItem("firstName") || "",
        lastName: localStorage.getItem("lastName") || "",
        clientTime: new Date().toISOString()
    });

    fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload
    }).catch(err => console.error("Heartbeat error:", err));
};

document.addEventListener("DOMContentLoaded", function() {
    window.startHeartbeat();
});

