const DB_NAME = "attendance-pwa-db"; 
const DB_VERSION = 3;

const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw9tfkpuRCpEM9HBvARnyX4N-NRLiJqNWaeEknXh2fnk7Qf6Tvix-NqfDQoRaL4PWv-/exec";

const GPS_RETRY_MS = 8000; 
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
let cameraStream = null;
let isProcessingPhoto_ = false;
// کش حافظه‌ای پروفایل و سیاست تردد - هدف این است که در لحظه کلیک روی دکمه
// دوربین، هیچ await ای قبل از فراخوانی photoInput.click() وجود نداشته باشد.
// در iOS Safari حتی چند await سریع IndexedDB هم می‌تواند «فعال‌سازی کاربر»
// (user activation) لازم برای باز شدن دوربین را از بین ببرد و باعث شود
// دوربین اصلا باز نشود، بدون هیچ خطایی.
let cachedProfile_ = null;
let cachedPolicyInfo_ = null;
let faceApiReady_ = false;

async function ensureFaceApiReady_() {
  if (faceApiReady_) return true;
  if (typeof faceapi === "undefined") {
    console.error("face-api.js not loaded");
    return false;
  }
  try {
    const MODEL_URL = "models";
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    faceApiReady_ = true;
    console.log("face-api models ready");
    return true;
  } catch (e) {
    console.error("face-api load failed", e);
    return false;
  }
}

let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;


const $ = (id) => document.getElementById(id);
const DEVICE_ID_KEY = "attendance_device_id";

function getOrCreateDeviceId_() {
  try {
    var id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && String(id).length > 8) return String(id);
    id =
      "dev_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 12);
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch (_) {
    return "dev_fallback_" + Date.now();
  }
}

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
async function getLocalTodayAttendanceCount_() {
  const today = getJalaliIsoDate();
  const records = await dbGetAll(STORE_RECORDS);
  let count = 0;
  for (const r of records) {
    if (
      r.recordDate === today &&
      (r.status === "pending" ||
        r.status === "sent" ||
        r.status === "failed" ||
        r.status === "syncing")
    ) {
      count++;
    }
  }
  return count;
}
/* =========================
   Boot
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    setTimeout(() => {
      showGpsToast(
        "★ حتماً GPS و اینترنت را روشن کنید.\nدسترسی‌ها را مجاز کنید؛ وگرنه تردد ثبت نمی‌شود.",
        8000,
        "error"
      );
    }, 800);
  } catch (_) {}

  try {
    const work = $("workLocationInput");
    if (work) work.setAttribute("list", "workLocationHistoryList");
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
    const work = $("workLocationInput");
    if (work) work.setAttribute("list", "workLocationHistoryList");
    await refreshWorkLocationDatalist_();
  } catch (_) {}
  try {
    await loadProfile();
  } catch (_) {}
try {
    ensureFaceApiReady_().catch(() => {});
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

  try {
    registerForPushNotifications();
  } catch (_) {}
});

/* =========================
   UI Helpers
========================= */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAgg2uymSkPPZamlbqNMWtuXs1VtWtDKsY",
  authDomain: "moradi-832db.firebaseapp.com",
  projectId: "moradi-832db",
  storageBucket: "moradi-832db.firebasestorage.app",
  messagingSenderId: "898814696792",
  appId: "1:898814696792:web:3e5c6d59d301dfa67c192d"
};
const FCM_VAPID_KEY = "BDzshylAUVJJZTApj3cK8xBD3YMl2IAlZ8PG_KHcP3saIUGa39huTUPe9M33TEsBxqFp26ndXChbm_0NSoiHEHM";

let firebaseMessagingInstance_ = null;

async function getFirebaseMessaging_() {
  if (firebaseMessagingInstance_) return firebaseMessagingInstance_;
  if (typeof firebase === "undefined") {
    console.warn("Firebase SDK not loaded — check index.html script tags");
    return null;
  }

  try {
    if (firebase.messaging && typeof firebase.messaging.isSupported === "function") {
      const supported = await firebase.messaging.isSupported();
      if (!supported) {
        console.warn("Firebase Messaging reports this browser as unsupported.");
        return null;
      }
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    firebaseMessagingInstance_ = firebase.messaging();
    return firebaseMessagingInstance_;
  } catch (err) {
    console.error("Firebase init failed:", err);
    return null;
  }
}

async function registerForPushNotifications() {
  const profile = await dbGet(STORE_PROFILE, "main");
  if (!profile || !profile.personnelCode) return;

  try {
    const missingApis = [];
    if (!("serviceWorker" in navigator)) missingApis.push("ServiceWorker");
    if (!("PushManager" in window)) missingApis.push("PushManager");
    if (!("Notification" in window)) missingApis.push("Notification");

    if (missingApis.length) {
      await reportPushStatus_(profile.personnelCode, "unsupported_no_push_api:missing=" + missingApis.join(","));
      return;
    }

    // وضعیت دسترسی همین الان مشخص است - قفل را فورا اعمال یا بردار، بدون
    // منتظر ماندن برای پاسخ شبکه. گزارش وضعیت به سرور در پس‌زمینه انجام
    // می‌شود و تاخیر شبکه دیگر روی سرعت نمایش/رفع قفل تاثیری ندارد.
    enforceNotificationGate();
    reportPushStatus_(profile.personnelCode, Notification.permission).catch(() => {});

    if (Notification.permission === "denied") {
      return;
    }

    const messaging = await getFirebaseMessaging_();
    if (!messaging) {
      reportPushStatus_(profile.personnelCode, "unsupported_firebase_init_failed").catch(() => {});
      return;
    }

    const permission = await Notification.requestPermission();
    enforceNotificationGate();
    reportPushStatus_(profile.personnelCode, permission).catch(() => {});

    if (permission !== "granted") {
      return;
    }

    const swRegistration = await navigator.serviceWorker.ready;

    const token = await messaging.getToken({
      vapidKey: FCM_VAPID_KEY,
      serviceWorkerRegistration: swRegistration
    });

    if (!token) {
      await reportPushStatus_(profile.personnelCode, "granted_but_no_token");
      return;
    }

    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
        type: "RegisterPushToken",
        personnelCode: profile.personnelCode,
        token: token,
        deviceId: getOrCreateDeviceId_()
      })
    });
  } catch (err) {
    console.error("Push registration failed:", err);
    try {
      await reportPushStatus_(profile.personnelCode, "error:" + String(err && err.message || err).slice(0, 120));
    } catch (_) {}
  } finally {
    // همیشه در پایان اجرا می‌شود، صرف‌نظر از این‌که کدام مسیر بالا طی شده -
    // این تنها جایی است که وضعیت قفل دکمه «ذخیره مشخصات» به‌روزرسانی می‌شود.
    enforceNotificationGate();
  }
}

// Parses "OS 16_4" style version strings out of the iOS user agent, so we
// get the real iOS version automatically in every report instead of having
// to ask someone to go check Settings on each phone by hand.
function getIosVersionLabel_() {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)(?:_(\d+))?/);
  if (!m) return "";
  return "iOS " + m[1] + "." + m[2] + (m[3] ? "." + m[3] : "");
}

async function reportPushStatus_(personnelCode, permissionStatus) {
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

    const platform = isIOS
      ? (getIosVersionLabel_() || "iOS")
      : (/Android/.test(navigator.userAgent) ? "Android" : "Other");

    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        type: "ReportPushStatus",
        personnelCode: personnelCode,
        permissionStatus: permissionStatus,
        platform: platform,
        isStandalone: !!isStandalone
      })
    });
  } catch (err) {
    console.error("reportPushStatus_ failed:", err);
  }
}

let notificationGateOverlay_ = null;
const NOTIFICATION_GATE_TARGET_ID = "recordBtn"; // قفل روی دکمه «عکس سلفی خود را بگیرید»

function positionGateOverlay_() {
  if (!notificationGateOverlay_) return;
  const btn = document.getElementById(NOTIFICATION_GATE_TARGET_ID);
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  Object.assign(notificationGateOverlay_.style, {
    position: "fixed",
    top: rect.top + "px",
    left: rect.left + "px",
    width: rect.width + "px",
    height: rect.height + "px"
  });
}

// دقیقا روی دکمه «عکس سلفی خود را بگیرید» قرار می‌گیرد و آن را غیرفعال
// می‌کند تا کاربر نتواند تردد ثبت کند مگر اینکه اعلان‌ها را واقعا فعال کند.
function enforceNotificationGate() {
  const btn = document.getElementById(NOTIFICATION_GATE_TARGET_ID);
  if (!btn) return;

  const hasNotificationApi = "Notification" in window;
  const shouldBlock = hasNotificationApi && Notification.permission === "denied";

  if (!shouldBlock) {
    btn.disabled = false;
    if (notificationGateOverlay_) {
      notificationGateOverlay_.remove();
      notificationGateOverlay_ = null;
      window.removeEventListener("scroll", positionGateOverlay_, true);
      window.removeEventListener("resize", positionGateOverlay_);
    }
    return;
  }

  btn.disabled = true;

  if (!notificationGateOverlay_) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const steps = isIOS
      ? "تنظیمات آیفون ← Notifications ← نام این اپلیکیشن ← فعال کردن Allow Notifications."
      : "تنظیمات گوشی ← اعلان‌ها ← این مرورگر/اپلیکیشن ← فعال کردن اعلان‌ها.";

    const overlay = document.createElement("div");
    overlay.id = "notification-gate-overlay";
    overlay.style.cssText =
      "z-index:99998;background:#7c2d12;color:#fff;border-radius:10px;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "text-align:center;padding:6px 8px;font-size:11px;line-height:1.4;direction:rtl;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.4);";
    overlay.innerHTML =
      '<div style="font-weight:700;">⚠️ برای ادامه، اعلان‌ها را فعال کنید</div>' +
      '<div style="font-size:9.5px;margin-top:2px;">' + steps + "</div>" +
      '<button id="notification-gate-recheck" style="margin-top:5px;background:#fff;color:#7c2d12;' +
      'border:none;border-radius:6px;padding:3px 12px;font-size:10.5px;font-weight:700;">بررسی مجدد</button>';

    document.body.appendChild(overlay);
    notificationGateOverlay_ = overlay;

    document.getElementById("notification-gate-recheck")?.addEventListener("click", enforceNotificationGate);
    window.addEventListener("scroll", positionGateOverlay_, true);
    window.addEventListener("resize", positionGateOverlay_);
  }

  positionGateOverlay_();
}

// وقتی کاربر از تنظیمات گوشی برمی‌گردد (بعد از فعال کردن اعلان‌ها)، این
// رویداد اجازه می‌دهد قفل بدون نیاز به لمس دکمه «بررسی مجدد» خودش باز شود.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) enforceNotificationGate();
});

function showGpsToast(message, duration = 3000, type = "success") {
  const oldToast = document.getElementById("gps-toast");
  if (oldToast) oldToast.remove();

  // Inject styles once
  if (!document.getElementById("gps-toast-style")) {
    const style = document.createElement("style");
    style.id = "gps-toast-style";
    style.textContent = `
      @keyframes gpsToastIn {
        0%   { opacity: 0; transform: translate(-50%, -46%) scale(0.85); }
        100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes gpsToastOut {
        0%   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -46%) scale(0.85); }
      }
      #gps-toast {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #fff;
        padding: 22px 28px;
        border-radius: 18px;
        font-size: 18px;
        font-weight: 700;
        font-family: Tahoma, Vazirmatn, sans-serif;
        z-index: 10000;
        direction: rtl;
        text-align: center;
        width: 82%;
        max-width: 380px;
        border: 2px solid rgba(255,255,255,0.85);
        line-height: 1.7;
        white-space: pre-line;
        animation: gpsToastIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
      }
      #gps-toast.success {
        background: rgba(22, 163, 74, 0.96);
        box-shadow: 0 14px 40px rgba(22, 163, 74, 0.4);
      }
      #gps-toast.error {
        background: rgba(220, 38, 38, 0.95);
        box-shadow: 0 14px 40px rgba(220, 38, 38, 0.35);
      }
      #gps-toast.hiding {
        animation: gpsToastOut 0.3s ease forwards;
      }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement("div");
  toast.id = "gps-toast";
  toast.className = type === "success" ? "success" : "error";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    setTimeout(() => toast.remove(), 320);
  }, duration);
}

function setStatus(m) {
  const el = $("captureStatus");
  if (el) el.textContent = m;
}

function setSyncStatus(m) {
  const el = $("syncStatus");
  if (!el) return;
  el.textContent = m || "";

  const t = String(m || "");
  if (t.indexOf("در حال ارسال") !== -1) {
    el.style.color = "#dc2626";
    el.style.fontWeight = "800";
    el.style.fontSize = "1.05rem";
  } else if (t.indexOf("ارسال انجام شد") !== -1 || t.indexOf("ارسال شد") !== -1) {
    el.style.color = "#16a34a";
    el.style.fontWeight = "700";
    el.style.fontSize = "0.95rem";
  } else {
    el.style.color = "";
    el.style.fontWeight = "";
    el.style.fontSize = "";
  }
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
const WORK_LOC_KEY = "workLocationHistory";
const WORK_LOC_MAX = 3;

async function getWorkLocationHistory_() {
  try {
    const row = await dbGet(STORE_CONFIG, WORK_LOC_KEY);
    const list = row && Array.isArray(row.items) ? row.items : [];
    return list.map((x) => String(x || "").trim()).filter(Boolean).slice(0, WORK_LOC_MAX);
  } catch (_) {
    return [];
  }
}

async function pushWorkLocationHistory_(place) {
  const p = String(place || "").trim();
  if (!p) return;
  let list = await getWorkLocationHistory_();
  list = [p].concat(list.filter((x) => x !== p)).slice(0, WORK_LOC_MAX);
  await dbPut(STORE_CONFIG, { id: WORK_LOC_KEY, items: list });
}

async function refreshWorkLocationDatalist_() {
  const list = await getWorkLocationHistory_();
  let dl = document.getElementById("workLocationHistoryList");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "workLocationHistoryList";
    document.body.appendChild(dl);
  }
  dl.innerHTML = list
    .map((x) => '<option value="' + escapeHtml(x) + '"></option>')
    .join("");

  const input = $("workLocationInput");
  if (input) input.setAttribute("list", "workLocationHistoryList");
}
function injectWorkLocationField() {
  const recordBtn = $("recordBtn");
  if (!recordBtn || document.getElementById("workLocationInput")) return;

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "margin-bottom:10px;";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "workLocationInput";
  input.placeholder = "محل عملیات";
  input.maxLength = 20;
  input.autocomplete = "off";
  input.style.cssText =
    "width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;" +
    "border:1.5px solid #64b5f6;font-size:15px;text-align:center;direction:rtl;" +
    "font-family:inherit;background:#fff;";

  wrapper.appendChild(input);
       input.setAttribute("list", "workLocationHistoryList");
  recordBtn.parentNode.insertBefore(wrapper, recordBtn);
    refreshWorkLocationDatalist_();
}

function bindEvents() {
  $("saveProfileBtn")?.addEventListener("click", saveProfile);

  // Main attendance button
  $("recordBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    startAttendanceCapture();
  });

  // Old file input (keep for safety, but we no longer use it)
  $("photoInput")?.addEventListener("change", handlePhotoSelected);

  // New live camera buttons
  $("captureBtn")?.addEventListener("click", captureFromVideo);
  $("cancelCameraBtn")?.addEventListener("click", closeCamera);

  injectWorkLocationField();
  ["personnelCode", "firstName", "lastName", "userPassword"].forEach((id) => {
  $(id)?.addEventListener("input", () => {
    const b = $("saveProfileBtn");
    if (!b) return;
    b.style.backgroundColor = "#ff9800";
    b.textContent = "ذخیره مشخصات";
  });
});
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
    password: $("userPassword")?.value || "",
  };
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (!p) return;

  cachedProfile_ = p;

  if ($("personnelCode")) $("personnelCode").value = p.personnelCode || "";
  if ($("firstName")) $("firstName").value = p.firstName || "";
  if ($("lastName")) $("lastName").value = p.lastName || "";
  // Restore masked password if saved
  if ($("userPassword")) $("userPassword").value = p.password || "";
  }
async function verifyPasswordWithServer_(personnelCode, password) {
  if (!navigator.onLine) {
    return { ok: false, error: "برای تایید رمز به اینترنت نیاز است." };
  }

  // normalize Persian/Arabic digits → Latin
  const normalize = (s) =>
    String(s || "")
      .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
      .trim();

  const code = normalize(personnelCode);
  const pass = String(password || "").trim();

  if (!code) {
    return { ok: false, error: "کد پرسنلی وارد نشده است." };
  }
  if (!pass) {
    return { ok: false, error: "رمز عبور وارد نشده است." };
  }

  // ---------- Prefer GET (most reliable on iPhone) ----------
  try {
    const url =
      APPS_SCRIPT_URL +
      "?action=verifyPassword" +
      "&personnelCode=" + encodeURIComponent(code) +
      "&password=" + encodeURIComponent(pass) +
      "&_=" + Date.now();

    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  "Pragma": "no-cache"
}
    });

    const text = await res.text();
    console.log("verifyPassword GET:", res.status, text.slice(0, 200));

    if (text && text.trim()) {
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            data = JSON.parse(m[0]);
          } catch (_) {}
        }
      }
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch (err) {
    console.warn("verifyPassword GET failed, trying POST", err);
  }

  // ---------- Fallback POST ----------
  try {
      const payload = {
    type: "VerifyPassword",
    personnelCode: String(personnelCode || "").trim(),
    password: String(password || ""),
    deviceId: getOrCreateDeviceId_(),
  };

    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    console.log("verifyPassword POST:", res.status, text.slice(0, 200));

    if (!text || !text.trim()) {
      return { ok: false, error: "پاسخ خالی از سرور (آیفون)" };
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (_) {}
      }
    }

    if (data && typeof data === "object") {
      return data;
    }

    return {
      ok: false,
      error: "پاسخ سرور معتبر نیست: " + String(text).replace(/\s+/g, " ").slice(0, 80),
    };
  } catch (err) {
    console.error("verifyPassword error:", err);
    return {
      ok: false,
      error: "ارتباط با سرور برقرار نشد. اینترنت آیفون را بررسی کنید.",
    };
  }
}
async function saveProfileSilent() {
  try {
    const profile = getProfileFromInputs();
    const saved = await dbGet(STORE_PROFILE, "main");
    if (!profile.password && saved && saved.password) {
      profile.password = saved.password;
    }
    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      throw new Error("مشخصات پرسنلی کامل نیست.");
    }
    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    cachedProfile_ = { id: "main", ...profile };

    if ($("personnelCode")) $("personnelCode").value = profile.personnelCode || "";
    if ($("firstName")) $("firstName").value = profile.firstName || "";
    if ($("lastName")) $("lastName").value = profile.lastName || "";
    if ($("userPassword")) $("userPassword").value = profile.password || "";

    await refreshPolicyIfPossible();
    await fetchMessages();
    registerForPushNotifications();
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
    password: inputProfile.password || saved?.password || "",
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
  const st = $("profileStatus");
  if (!btn) return;

  const originalText = "ذخیره مشخصات";
  const originalBg = "#ff9800";

  btn.disabled = true;
  btn.style.backgroundColor = "#6c757d";
  btn.textContent = "در حال ذخیره...";
  if (st) st.textContent = "در حال بررسی...";

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      if (st) st.textContent = "کد، نام و نام خانوادگی الزامی است";
      showGpsToast("اطلاعات پرسنلی کامل نیست", 3000, "error");
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    if (!profile.password) {
      if (st) st.textContent = "رمز عبور را وارد کنید";
      showGpsToast("رمز عبور الزامی است", 3000, "error");
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    if (!navigator.onLine) {
      if (st) st.textContent = "برای ذخیره مشخصات اینترنت لازم است";
      showGpsToast("اینترنت را روشن کنید", 3000, "error");
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    let check;
    try {
      check = await verifyPasswordWithServer_(profile.personnelCode, profile.password);
    } catch (e) {
      console.error(e);
      if (st) st.textContent = "خطا در ارتباط با سرور";
      showGpsToast("خطا در ارتباط با سرور برای تایید رمز", 3500, "error");
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    if (!check || !check.ok) {
      const msg = (check && check.error) || "رمز عبور اشتباه است";
      if (st) st.textContent = msg;
      showGpsToast(msg, 3500, "error");
      btn.disabled = false;
      btn.style.backgroundColor = originalBg;
      btn.textContent = originalText;
      return;
    }

    await dbPut(STORE_PROFILE, { id: "main", ...profile });
    cachedProfile_ = { id: "main", ...profile };

    if ($("personnelCode")) $("personnelCode").value = profile.personnelCode;
    if ($("firstName")) $("firstName").value = profile.firstName;
    if ($("lastName")) $("lastName").value = profile.lastName;
    if ($("userPassword")) $("userPassword").value = profile.password;

    btn.style.backgroundColor = "#28a745";
    btn.textContent = "ذخیره شد ✓";
    btn.disabled = false;
    if (st) st.textContent = "ذخیره شد";
    showGpsToast("مشخصات با موفقیت ثبت شد", 3000, "success");

    registerForPushNotifications();
    setTimeout(() => {
      refreshPolicyIfPossible();
      fetchMessages();
    }, 500);
  } catch (err) {
    console.error(err);
    if (st) st.textContent = "خطا: " + (err.message || String(err));
    showGpsToast("خطا در ذخیره مشخصات", 3000, "error");
    btn.disabled = false;
    btn.style.backgroundColor = originalBg;
    btn.textContent = originalText;
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
    const fallback = {
      id: "attendancePolicy",
      personnelCode: "",
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      policyFetchedAt: "",
      policySource: "default",
    };
    cachedPolicyInfo_ = fallback;
    return fallback;
  }
  cachedPolicyInfo_ = policy;
  return policy;
}

async function saveAttendancePolicyInfo(data) {
  const toSave = {
    id: "attendancePolicy",
    personnelCode: data.personnelCode || "",
    attendancePolicy: normalizeAttendancePolicy(data.attendancePolicy),
    policyVersion: Number(data.policyVersion || 0),
    policyFetchedAt: data.policyFetchedAt || "",
    policySource: data.policySource || "",
    maxAttendances: Number(data.maxAttendances) || 0,
    usedToday: Number(data.usedToday) || 0,
    dailyAllowed: data.dailyAllowed !== false
  };
  await dbPut(STORE_CONFIG, toSave);
  cachedPolicyInfo_ = toSave;
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

  const isConfirmed =
    cachedProfile_ &&
    cachedProfile_.personnelCode === personnelCode &&
    cachedProfile_.firstName === firstName &&
    cachedProfile_.lastName === lastName;

  if (!isConfirmed) {
    setStatus("لطفا ابتدا مشخصات پرسنلی را با دکمه «ذخیره مشخصات» تایید کنید.");
    showGpsToast("⚠️ ابتدا مشخصات را ذخیره کنید", 3000, "warning");
    return;
  }

  if ("Notification" in window && Notification.permission === "denied") {
    setStatus("برای ثبت تردد، ابتدا باید اعلان‌ها را در تنظیمات گوشی فعال کنید.");
    enforceNotificationGate();
    return;
  }

  const workLocationEl = document.getElementById("workLocationInput");
  const workLocation = (workLocationEl?.value || "").trim();
  if (workLocation.length < 5 || workLocation.length > 20) {
    setStatus("محل عملیات را وارد کنید (حداقل ۵ و حداکثر ۲۰ کاراکتر).");
    showGpsToast("⚠️ محل عملیات را کامل کنید", 3000, "warning");
    workLocationEl?.focus();
    return;
  }

  // ========== DAILY LIMIT CHECK (client-side) ==========
  try {
    const policyInfo = cachedPolicyInfo_ || {};
    const maxDaily = Number(policyInfo.maxAttendances) || 0; // 0 = unlimited

    if (maxDaily > 0) {
      // 1) Local count (works offline)
      const localUsed = await getLocalTodayAttendanceCount_();

      // 2) Prefer server value if available and fresher
      let used = localUsed;
      if (typeof policyInfo.usedToday === "number" && policyInfo.usedToday > used) {
        used = policyInfo.usedToday;
      }

      if (used >= maxDaily) {
        const msg = `سقف تردد روزانه پر شده است (${used}/${maxDaily})`;
        setStatus(msg);
        showGpsToast(`⚠️ ${msg}\nنمی‌توانید بیشتر از ${maxDaily} تردد در روز ثبت کنید.`, 4500, "error");
        return; // ← camera never opens
      }
    }
  } catch (e) {
    console.warn("daily limit check failed", e);
  }
  // ====================================================

  const policyInfo = cachedPolicyInfo_ || { attendancePolicy: DEFAULT_ATTENDANCE_POLICY };
  const policy = policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;
  const gate = evaluateAttendancePolicy(policy, navigator.onLine);

  if (!gate.ok) {
    setStatus(gate.message);
    return;
  }

  if (navigator.onLine) refreshPolicyIfPossible().catch(() => {});

  // ... rest of your original function stays the same
  captureStartedAtMs = Date.now();
  photoSelectedAtMs = 0;
  photoCompressedAtMs = 0;
  currentPhoto = "";
  pendingLocation = null;

  // ... continue with opening camera exactly as before
  setStatus("در حال باز کردن دوربین سلفی...");
  showGpsToast(
    "دوربین را در فاصله ۲۰ تا ۲۵ سانتی‌متر و دقیقاً روبه‌روی صورت قرار دهید.",
    2500,
    "error"
  );
  setTimeout(() => openFrontCamera(), 2500);
}

async function handlePhotoSelected() {
  const file = $("photoInput")?.files?.[0];
  if (!file) {
    setStatus("عکسی انتخاب نشد.");
    return;
  }
  // Same path as live camera — one createRecord only, inside processCapturedPhoto
  await processCapturedPhoto(file);
  try {
    $("photoInput").value = "";
  } catch (_) {}
}

/* =========================
   Record Creation
========================= */
async function createRecord(type, faceDescriptor) {
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
  const deviceTimeAtPhotoCompressed = photoCompressedMs
    ? new Date(photoCompressedMs).toISOString()
    : "";
  const deviceTimeAtGps = gpsMs ? new Date(gpsMs).toISOString() : "";
  const gpsTimestamp = deviceTimeAtGps;

  const gpsWaitMs = gpsMs ? Math.max(0, gpsMs - clickMs) : "";
  const photoDelayMs = photoMs ? Math.max(0, photoMs - clickMs) : "";
  const submitDelayMs = Math.max(0, nowMs - clickMs);

  const offlineCreated = !navigator.onLine;
  const createdOnline = navigator.onLine;

  const sessionClockDriftMs = getSessionClockDriftMs();
  const networkClockDriftMs = navigator.onLine
    ? await getNetworkTimeDriftMs(nowMs)
    : null;

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
    password: profile.password || "",
    type,
    recordType: type,
    recordDate: jalaliDateStr,
    recordHour: hourStr,
    recordTime: hourStr,
    workLocation: (document.getElementById("workLocationInput")?.value || "").trim(),

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
    faceDescriptor: Array.isArray(faceDescriptor) ? faceDescriptor : null,
    status: "pending",
    createdAt: now.toISOString(),
    lastSyncTryAt: "",
    syncTryCount: 0,
    syncedAt: "",
    serverResponse: "",
  };

  await dbPut(STORE_RECORDS, record);
  const place = (document.getElementById("workLocationInput")?.value || "").trim();
  if (place) {
    try {
      await pushWorkLocationHistory_(place);
      await refreshWorkLocationDatalist_();
    } catch (_) {}
  }
  // Option 1 — honest toast (local save; upload may still be pending)
  showGpsToast(
    "✅ تردد ذخیره شد\nدر حال ارسال به سرور...\nادمین سیستم، عکس را بررسی خواهد کرد",
    5000,
    "success"
  );
  setStatus("تردد ذخیره شد — در حال ارسال...");
  setSyncStatus("در حال ارسال...");
  setBusy(false);
  await refreshUi();

  if (navigator.onLine) {
    scheduleSyncPendingRecords(300);
  } else {
    setSyncStatus("آفلاین — بعداً ارسال می‌شود");
  }

    setTimeout(() => {
    currentPhoto = "";
    pendingLocation = null;
    photoSelectedAtMs = 0;
    photoCompressedAtMs = 0;
    captureStartedAtMs = 0;

    const preview = $("photoPreview");
    if (preview) {
      preview.src = "";
      preview.style.display = "none";
    }

    const work = $("workLocationInput");
    if (work) work.value = "";

    setStatus("");
    setBusy(false);
  }, 2000);
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

    // Sync = upload of records already saved.
    // OFFLINE_ONLY only blocks NEW attendance while online, not uploading old offline ones.
    const syncPolicy = normalizeAttendancePolicy(policyInfo?.attendancePolicy);
    if (syncPolicy === POLICY_NOT_ALLOWED) {
      setSyncStatus("ثبت تردد برای شما مجاز نیست.");
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
        let confirmed = false;
        let serverMsg = "";

        try {
          const res = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            mode: "cors",
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload),
          });

          const text = await res.text();
          serverMsg = (text || "").slice(0, 500);

          let data = null;
          try {
            data = JSON.parse(text);
          } catch (_) {}

          if (data && data.ok === true) {
            confirmed = true;
                    } else if (data && data.ok === false) {
            const errText = (data.error || serverMsg || "").toString();
            if (errText.indexOf("سقف تردد روزانه") !== -1) {
              r.status = "failed_permanent";
            } else {
              r.status = "failed";
            }
            r.serverResponse = serverMsg || JSON.stringify(data);
            await dbPut(STORE_RECORDS, r);
            continue;
          } else {
            r.status = "failed";
            r.serverResponse = "http_" + res.status + ":" + serverMsg;
            await dbPut(STORE_RECORDS, r);
            continue;
          }
        } catch (corsErr) {
          try {
            await fetch(APPS_SCRIPT_URL, {
              method: "POST",
              mode: "no-cors",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify(payload),
            });
            r.status = "pending";
            r.serverResponse = "cors_blocked_opaque_retry";
            await dbPut(STORE_RECORDS, r);
            continue;
          } catch (e2) {
            r.status = "failed";
            r.serverResponse = JSON.stringify({
              ok: false,
              error: (e2 && e2.message) || (corsErr && corsErr.message) || "network_error",
            });
            await dbPut(STORE_RECORDS, r);
            continue;
          }
        }

        if (confirmed) {
          const sentIso = new Date().toISOString();
          r.status = "sent";
          r.syncedAt = sentIso;
          r.uploadedAt = sentIso;
          r.serverResponse = serverMsg || "ok";
          await dbPut(STORE_RECORDS, r);
        }
      } catch (err) {
        r.status = "failed";
        r.serverResponse = JSON.stringify({
          ok: false,
          error: (err && err.message) || "network_error",
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
    password: record.password || "",
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
    faceDescriptor: record.faceDescriptor || null,
    createdAt: record.createdAt || "",
    lastSyncTryAt: record.lastSyncTryAt || "",
    syncTryCount: Number(record.syncTryCount || 0),
    workLocation: record.workLocation || "",
  };
}

/* =========================
   Records UI
========================= */

async function refreshUi() {
  const rec = await dbGetAll(STORE_RECORDS);

   const pendingEl = $("pendingCount");
  if (pendingEl) {
    const pendingN = rec.filter((r) => r.status === "pending").length;
    pendingEl.textContent = pendingN;
    if (pendingN >= 1) {
      pendingEl.style.color = "#dc2626";
      pendingEl.style.fontWeight = "800";
      pendingEl.style.fontSize = "1.45rem";
      pendingEl.classList.add("pending-pulse");
    } else {
      pendingEl.style.color = "";
      pendingEl.style.fontWeight = "";
      pendingEl.style.fontSize = "";
      pendingEl.classList.remove("pending-pulse");
    }
  }
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
      const st = r.status || "";
      const icon =
        st === "sent" ? "✅" : st === "failed" ? "❌" : st === "syncing" ? "⏳" : "▪️";
      const riskText = r.clockRisk ? ` - ${escapeHtml(r.clockRisk)}` : "";
      const connectionText = r.connectionStatusFa
        ? ` - ${escapeHtml(r.connectionStatusFa)}`
        : r.offlineCreated
          ? " - آفلاین"
          : " - آنلاین";

      return `
        <div class="record-item compact-record">
          <span>${icon} ${escapeHtml(r.recordDate || "")}</span>
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

    // اگر بعد از رفرش صفحه هنوز پیام آخرین تاییدشده بارگذاری نشده، از
    // پروفایل ذخیره‌شده بخوان تا همان پیام دوباره نمایش داده نشود.
    if (lastAdminMessage === null && profile.lastConfirmedMessage) {
      lastAdminMessage = profile.lastConfirmedMessage;
    }

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
  btn.textContent = "تایید";

  const dismiss = (e) => {
    e.preventDefault();
    if (btn.disabled) return; // جلوگیری از اجرای دوباره در صورت شلیک همزمان رویدادها
    btn.disabled = true;

    // بستن فوری صفحه - بدون منتظر ماندن برای پاسخ شبکه
    overlay.remove();
    lastAdminMessage = message;

    // ذخیره تایید و ارسال رسید در پس‌زمینه - تاخیر شبکه دیگر تاثیری روی
    // بسته شدن صفحه ندارد
    (async () => {
      try {
        const profile = await dbGet(STORE_PROFILE, "main");
        if (profile) await dbPut(STORE_PROFILE, { ...profile, lastConfirmedMessage: message });
      } catch (_) {}
      try {
        await sendMessageReadReceipt(message);
      } catch (_) {}
    })();
  };
  btn.addEventListener("click", dismiss, { passive: false, once: true });

  container.appendChild(title);
  container.appendChild(body);
  container.appendChild(btn);
  overlay.appendChild(container);

  document.body.appendChild(overlay);
}

async function sendMessageReadReceipt(message) {
  try {
    const profile = await dbGet(STORE_PROFILE, "main");
    if (!profile || !profile.personnelCode) return;

    const payload = {
      type: "MessageReadReceipt",
      personnelCode: profile.personnelCode,
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      message: message,
      deviceTime: new Date().toISOString()
    };

    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Failed to send message read receipt:", err);
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
  // Higher resolution for better Face++ matching
  const MAX_SIDE = 900;           // was 400
  let OUT_W, OUT_H;

  if (img.width >= img.height) {
    OUT_W = Math.min(img.width, MAX_SIDE);
    OUT_H = Math.round(OUT_W * (img.height / img.width));
  } else {
    OUT_H = Math.min(img.height, MAX_SIDE);
    OUT_W = Math.round(OUT_H * (img.width / img.height));
  }

  // Keep minimum size so Face++ still works well
  if (OUT_W < 480) { OUT_W = 480; OUT_H = Math.round(480 * (img.height / img.width)); }
  if (OUT_H < 640) { OUT_H = 640; OUT_W = Math.round(640 * (img.width / img.height)); }

  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  ctx.drawImage(img, 0, 0, OUT_W, OUT_H);

  try {
    // Higher JPEG quality (0.82 instead of 0.65)
    resolve(canvas.toDataURL("image/jpeg", 0.82));
  } catch (e) {
    reject(e);
  }
};
           
      img.onerror = () => reject(new Error("خطا در بارگذاری تصویر"));
      img.src = e.target.result;
    };

    reader.onerror = () => reject(new Error("خطا در خواندن فایل تصویر"));
    reader.readAsDataURL(file);
  });
}
/**
 * Input: dataURL (jpeg) or HTMLImageElement / canvas
 * Output: { descriptor: number[128], box } or null
 */
async function extractFaceDescriptor_(dataUrl) {
  const ok = await ensureFaceApiReady_();
  if (!ok) return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const detection = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({
            inputSize: 416,
            scoreThreshold: 0.5
          }))
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (!detection || !detection.descriptor) {
          resolve(null);
          return;
        }

        resolve({
          descriptor: Array.from(detection.descriptor), // 128 numbers
          box: detection.detection.box
        });
      } catch (e) {
        console.error("extractFaceDescriptor_ error", e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function hasStrongGlare_(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 100;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        let veryBright = 0;
        let total = 0;

        for (let i = 0; i < data.length; i += 16) {
          const r = data[i], g = data[i+1], b = data[i+2];
          const bright = (r + g + b) / 3;
          total++;
          if (bright > 245) veryBright++;
        }

        const ratio = veryBright / total;
        console.log("Glare ratio:", (ratio * 100).toFixed(1) + "%");
        resolve(ratio > 0.012);
      } catch (e) {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

/* =========================
   Live Front Camera – Forced 1-second capture
   (No movement / head-turn check)
========================= */

let autoCaptureTimer_ = null;
let countdownInterval_ = null;
let faceMesh_ = null;
let faceMeshReady_ = false;
let faceMeshRaf_ = null;
let faceOkStreak_ = 0;
let captureArmed_ = false; // true = 1s timer already started
let captureLocked_ = false; // true while waiting 1s for photo
let motionSamples_ = [];
const MOTION_SAMPLES_NEEDED = 10;
const MIN_NOSE_SHIFT = 0.045; // relative micro head move

const FACE_RATIO_MIN = 0.22; // too far if smaller
const FACE_RATIO_MAX = 0.42; // too close if larger
const FACE_OK_FRAMES = 3;    // ~stable for a short moment
async function ensureFaceMesh_() {
  if (faceMesh_) return faceMesh_;
  if (typeof FaceMesh === "undefined") {
    console.warn("FaceMesh SDK not loaded");
    return null;
  }

  faceMesh_ = new FaceMesh({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh_.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });

  faceMesh_.onResults(onFaceMeshResults_);
  faceMeshReady_ = true;
  return faceMesh_;
}
function onFaceMeshResults_(results) {
  const instruction = $("cameraInstruction");
  const video = $("cameraVideo");

  if (instruction) {
    instruction.style.cssText =
      "color:#fff;font-size:18px;font-weight:700;line-height:1.7;margin:0;" +
      "background:rgba(0,0,0,0.75);padding:14px 16px;border-radius:12px;" +
      "max-width:340px;text-align:center;";
  }

  function cancelDuringWait_() {
    if (!captureLocked_) return;
    if (autoCaptureTimer_) {
      clearTimeout(autoCaptureTimer_);
      autoCaptureTimer_ = null;
    }
    if (countdownInterval_) {
      clearInterval(countdownInterval_);
      countdownInterval_ = null;
    }
    captureLocked_ = false;
    captureArmed_ = false;
    faceOkStreak_ = 0;
    motionSamples_ = [];
    if (instruction) {
      instruction.innerHTML =
        "صورت از کادر خارج شد<br><span style=\"color:#f87171;\">دوباره تلاش کنید — تا لحظه عکس صورت در کادر بماند</span>";
    }
  }

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    faceOkStreak_ = 0;
    motionSamples_ = [];
    cancelDuringWait_();
    if (video) {
      video.style.opacity = "0";
      video.style.filter = "brightness(0)";
    }
    if (instruction) {
      instruction.innerHTML =
        "صورت در کادر دیده نشد<br><span style=\"color:#fbbf24;\">کمی نزدیک‌تر و روبه‌رو بایستید</span>";
    }
    return;
  }

  const lm = results.multiFaceLandmarks[0];
  const top = lm[10];
  const bottom = lm[152];
  const nose = lm[1];
  const faceRatio = Math.abs(bottom.y - top.y);
  const faceCenterX = (lm[234].x + lm[454].x) / 2;
  const noseOffsetX = nose.x - faceCenterX;

  if (faceRatio < FACE_RATIO_MIN) {
    faceOkStreak_ = 0;
    motionSamples_ = [];
    cancelDuringWait_();
    if (video) {
      video.style.opacity = "0";
      video.style.filter = "brightness(0)";
    }
    if (instruction) {
      instruction.innerHTML =
        "فاصله زیاد است<br><span style=\"color:#fbbf24;\">موبایل را به حدود ۲۰–۲۵ سانتی‌متر نزدیک کنید</span>";
    }
    return;
  }

  if (faceRatio > FACE_RATIO_MAX) {
    faceOkStreak_ = 0;
    motionSamples_ = [];
    cancelDuringWait_();
    if (video) {
      video.style.opacity = "0";
      video.style.filter = "brightness(0)";
    }
    if (instruction) {
      instruction.innerHTML =
        "خیلی نزدیک است<br><span style=\"color:#fbbf24;\">کمی عقب‌تر بروید (۲۰–۲۵ سانتی‌متر)</span>";
    }
    return;
  }

  // Face still OK during the 1s wait → do not require more head movement
  if (captureLocked_) {
    if (instruction) {
      instruction.innerHTML =
        "ثابت بمانید<br><span style=\"color:#4ade80;\">عکس تا لحظاتی دیگر...</span>";
    }
    return;
  }

  motionSamples_.push(noseOffsetX);
  if (motionSamples_.length > MOTION_SAMPLES_NEEDED) {
    motionSamples_.shift();
  }

  let minO = motionSamples_[0];
  let maxO = motionSamples_[0];
  for (let i = 1; i < motionSamples_.length; i++) {
    if (motionSamples_[i] < minO) minO = motionSamples_[i];
    if (motionSamples_[i] > maxO) maxO = motionSamples_[i];
  }
  const hasMicroMotion =
    motionSamples_.length >= MOTION_SAMPLES_NEEDED &&
    maxO - minO >= MIN_NOSE_SHIFT;

  if (!hasMicroMotion) {
    faceOkStreak_ = 0;
    if (instruction) {
      instruction.innerHTML =
        "فاصله مناسب است<br><span style=\"color:#fbbf24;\">سر را کمی به چپ یا راست بچرخانید، بعد ثابت بمانید</span>";
    }
    return;
  }

  faceOkStreak_++;
  if (instruction) {
    instruction.innerHTML =
      "حرکت ثبت شد<br><span style=\"color:#4ade80;\">عکس تا ۱ ثانیه — صورت را در کادر نگه دارید</span>";
  }

  if (!captureArmed_ && faceOkStreak_ >= FACE_OK_FRAMES) {
    captureArmed_ = true;
    captureLocked_ = true;
    // Keep Face Mesh running during the 1s (do NOT stop the loop here)
    startOneSecondCapture_();
  }
}
async function tickFaceMesh_() {
  const video = $("cameraVideo");
  if (!video || !faceMesh_ || video.readyState < 2) {
    faceMeshRaf_ = requestAnimationFrame(tickFaceMesh_);
    return;
  }
  try {
    await faceMesh_.send({ image: video });
  } catch (e) {}
  faceMeshRaf_ = requestAnimationFrame(tickFaceMesh_);
}

function stopFaceMeshLoop_() {
  if (faceMeshRaf_) {
    cancelAnimationFrame(faceMeshRaf_);
    faceMeshRaf_ = null;
  }
  faceOkStreak_ = 0;
  captureArmed_ = false;
  captureLocked_ = false;
  motionSamples_ = [];
}
function startOneSecondCapture_() {
  const countdownEl = $("countdownText");
  const instruction = $("cameraInstruction");

  if (instruction) {
    instruction.innerHTML =
      'صورت خود را روبه‌روی دوربین نگه دارید<br>' +
      '<span style="color:#fbbf24;">عکس بعد از ۱ ثانیه گرفته می‌شود</span>';
  }
  if (countdownEl) {
    countdownEl.textContent = "۱";
    countdownEl.style.color = "#4ade80";
  }

  let remaining = 1;
  if (countdownInterval_) clearInterval(countdownInterval_);
  countdownInterval_ = setInterval(() => {
    remaining--;
    if (countdownEl) {
      countdownEl.textContent = remaining > 0 ? String(remaining) : "۰";
      if (remaining <= 0) countdownEl.style.color = "#f87171";
    }
    if (remaining <= 0) {
      clearInterval(countdownInterval_);
      countdownInterval_ = null;
    }
  }, 1000);

    if (autoCaptureTimer_) clearTimeout(autoCaptureTimer_);
  autoCaptureTimer_ = setTimeout(() => {
    autoCaptureTimer_ = null;
    if (!captureLocked_) {
      return;
    }
    captureLocked_ = false;
    stopFaceMeshLoop_();
    captureFromVideo();
  }, 1000);
}
async function openFrontCamera() {
  const overlay = $("cameraOverlay");
  const video = $("cameraVideo");
  const instruction = $("cameraInstruction");
  const countdownEl = $("countdownText");

  if (!overlay || !video) {
    setStatus("خطا: المان دوربین پیدا نشد");
    return;
  }

  // Clear previous timers
  if (autoCaptureTimer_) {
    clearTimeout(autoCaptureTimer_);
    autoCaptureTimer_ = null;
  }
  if (countdownInterval_) {
    clearInterval(countdownInterval_);
    countdownInterval_ = null;
  }

  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }

       const constraints = {
  audio: false,
  video: {
    facingMode: { ideal: "user" },
    width:  { ideal: 1280, min: 640, max: 1920 },
    height: { ideal: 720,  min: 480, max: 1080 }
  }
};

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = cameraStream;
        video.style.opacity = "0";
    video.style.filter = "brightness(0)";
    if (instruction) {
      instruction.innerHTML =
        'صورت خود را روبه‌روی دوربین نگه دارید<br>' +
        '<span style="color:#fbbf24;">عکس بعد از ۱ ثانیه گرفته می‌شود</span>';
    }
    if (countdownEl) {
      countdownEl.textContent = "۱";
      countdownEl.style.color = "#4ade80";
    }

    overlay.style.display = "flex";
    setStatus("لطفاً ثابت بمانید...");

    // Countdown 1 → 0
    let remaining = 1;
    countdownInterval_ = setInterval(() => {
      remaining--;
      if (countdownEl) {
        countdownEl.textContent = remaining > 0 ? remaining : "۰";
        if (remaining <= 0) countdownEl.style.color = "#f87171";
      }
      if (remaining <= 0) {
        clearInterval(countdownInterval_);
        countdownInterval_ = null;
      }
    }, 1000);

       captureArmed_ = false;
    faceOkStreak_ = 0;
    if (countdownEl) countdownEl.textContent = "—";

    if (instruction) {
      instruction.innerHTML =
        'صورت را در کادر قرار دهید<br>' +
        '<span style="color:#fbbf24;">فاصله حدود ۲۰–۲۵ سانتی‌متر</span>';
    }

    await ensureFaceMesh_();
    if (faceMesh_) {
      stopFaceMeshLoop_();
      tickFaceMesh_();
    } else {
      // SDK missing → fallback old behavior
      startOneSecondCapture_();
    }

  } catch (err) {
    console.error("Camera error:", err);
    setStatus("نمی‌توان دوربین سلفی را باز کرد. لطفاً دسترسی دوربین را مجاز کنید.");
    closeCamera();
  }
}

function closeCamera() {
  const overlay = $("cameraOverlay");
  const video = $("cameraVideo");

  if (autoCaptureTimer_) {
    clearTimeout(autoCaptureTimer_);
    autoCaptureTimer_ = null;
  }
  if (countdownInterval_) {
    clearInterval(countdownInterval_);
    countdownInterval_ = null;
  }
  stopFaceMeshLoop_();
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
    if (video) {
    video.style.opacity = "1";
    video.style.filter = "none";
    video.srcObject = null;
  }
  if (overlay) overlay.style.display = "none";
}

function captureFromVideo() {
  if (autoCaptureTimer_) {
    clearTimeout(autoCaptureTimer_);
    autoCaptureTimer_ = null;
  }
  if (countdownInterval_) {
    clearInterval(countdownInterval_);
    countdownInterval_ = null;
  }

  const video = $("cameraVideo");
  if (!video || !video.videoWidth) {
    setStatus("ویدیو هنوز آماده نیست");
    closeCamera();
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);

  canvas.toBlob(async (blob) => {
    if (!blob) {
      setStatus("خطا در گرفتن عکس");
      closeCamera();
      return;
    }

    closeCamera();
    const file = new File([blob], "selfie.jpg", { type: "image/jpeg" });
    await processCapturedPhoto(file);
  }, "image/jpeg", 0.92);
}
async function processCapturedPhoto(file) {
  if (isProcessingPhoto_) return;
  isProcessingPhoto_ = true;

  try {
    setBusy(true, "در حال آماده‌سازی عکس...");
    setStatus("در حال آماده‌سازی عکس...");
    photoSelectedAtMs = Date.now();

    // 1) Compress FIRST — no network
    currentPhoto = await compressImage(file);
    photoCompressedAtMs = Date.now();

    const preview = $("photoPreview");
    if (preview) {
      preview.src = currentPhoto;
      preview.style.display = "block";
    }

    // 1b) face-api.js descriptor
    let faceDescriptor = null;
    try {
      setBusy(true, "در حال بررسی چهره...");
      setStatus("در حال بررسی چهره...");
      const faceRes = await extractFaceDescriptor_(currentPhoto);
      if (faceRes && faceRes.descriptor) {
        faceDescriptor = faceRes.descriptor;
      }
    } catch (e) {
      console.warn("descriptor extract failed", e);
    }

    // 2) Local profile only (no server)
    try {
      const profile = getProfileFromInputs();
      const saved = await dbGet(STORE_PROFILE, "main");
      if (!profile.password && saved && saved.password) {
        profile.password = saved.password;
      }
      if (profile.personnelCode && profile.firstName && profile.lastName) {
        await dbPut(STORE_PROFILE, { id: "main", ...profile });
        cachedProfile_ = { id: "main", ...profile };
      }
    } catch (_) {}

    // 3) Policy from cache only (no await network)
    const policyInfo = cachedPolicyInfo_ || { attendancePolicy: DEFAULT_ATTENDANCE_POLICY };
    const gate = evaluateAttendancePolicy(
      policyInfo.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
      navigator.onLine
    );
    if (!gate.ok) {
      setBusy(false);
      setStatus(gate.message);
      currentPhoto = "";
      return;
    }

    // 4) GPS
    if (!isGeolocationUsable()) {
      setBusy(false);
      setStatus(
        "GPS در دسترس نیست.\nلطفاً مطمئن شوید سایت با HTTPS باز شده و Location گوشی روشن است."
      );
      return;
    }

    setBusy(true, "در حال دریافت GPS...");
    setStatus("در حال دریافت GPS... اگر پیام دسترسی آمد، گزینه Allow یا مجاز را بزنید.");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      setBusy(false);
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
        setStatus(
          "زمان دریافت GPS تمام شد.\nلطفاً در فضای بازتر قرار بگیرید و دوباره تلاش کنید."
        );
        return;
      }
      setStatus("GPS دریافت نشد.\nلطفاً Location را روشن و دسترسی را مجاز کنید.");
      return;
    }

    // 5) Save once
    setBusy(true, "در حال ذخیره تردد...");
    setStatus("در حال ذخیره تردد...");
    await createRecord("تردد", faceDescriptor);
    setBusy(false);
  } catch (err) {
    console.error(err);
    setBusy(false);
    setStatus("خطا در پردازش عکس یا ثبت تردد");
  } finally {
    isProcessingPhoto_ = false;
  }
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
