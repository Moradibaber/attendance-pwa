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

  await dbPut(STORE_PROFILE, { id: "main", ...profile });
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
  const input = getProfileFromInputs();

  const profile = {
    personnelCode: input.personnelCode || saved?.personnelCode || "",
    firstName: input.firstName || saved?.firstName || "",
    lastName: input.lastName || saved?.lastName || ""
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });
  return profile;
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
      const acc = Number(pos?.coords?.accuracy || 999999);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const point = {
        status: "ok",
        lat,
        lng,
        accuracy: acc,
        speed: pos?.coords?.speed ?? "",
        heading: pos?.coords?.heading ?? "",
        altitude: pos?.coords?.altitude ?? "",
        gpsTimestamp: pos?.timestamp || Date.now(),
        capturedAt: new Date().toISOString()
      };

      if (!best || acc < (best.accuracy || 999999)) best = point;

      if (acc <= GOOD_ACCURACY_METERS) finish(best);
    };

    const onError = (err) => {
      if (err.code === 1) return finish({ status: "denied" });
      if (err.code === 2) return finish(best || { status: "unavailable" });
      if (err.code === 3) return finish(best || { status: "timeout" });
      finish({ status: "error" });
    };

    try {
      watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: GPS_WAIT_MS
      });

      setTimeout(() => {
        if (best) finish(best);
        else {
          navigator.geolocation.getCurrentPosition(onSuccess, onError, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: GPS_RETRY_MS
          });
        }
      }, HIGH_GPS_WAIT_MS);
    } catch (_) {
      finish({ status: "error" });
    }
  });
}

function hasValidLocation(loc) {
  return loc &&
    loc.status === "ok" &&
    Number.isFinite(loc.lat) &&
    Number.isFinite(loc.lng);
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

    setStatus("در حال آماده‌سازی عکس، لطفاً صبر کنید...");
    currentPhoto = await compressImage(file);
    photoCompressedAtMs = Date.now();

    if ($("photoPreview")) {
      $("photoPreview").src = currentPhoto;
      $("photoPreview").style.display = "block";
    }

    if (!isGeolocationUsable()) {
      setStatus("GPS در دسترس نیست. لطفاً HTTPS و Location را فعال کنید.");
      return;
    }

    setStatus("در حال دریافت GPS...");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      setStatus("GPS معتبر دریافت نشد.");
      return;
    }

    await createRecord("تردد");
  } catch (err) {
    console.error(err);
    setStatus("خطا در ثبت تردد");
  }
}

async function compressImage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  let w = img.width;
  let h = img.height;
  const max = 1280;

  const scale = Math.min(max / w, max / h, 1);
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  let quality = 0.82;
  let out = canvas.toDataURL("image/jpeg", quality);

  while (out.length > 300000 && quality > 0.3) {
    quality -= 0.08;
    out = canvas.toDataURL("image/jpeg", quality);
  }

  return out;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
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

function generateClientRecordId(code) {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  const ts = Date.now();
  return `${code || "EMP"}-${ts}-${rand}`;
}

function getSessionClockDriftInfo() {
  const wall = Date.now();
  const perf = performance.now();
  const expected = APP_SESSION_START_WALL_MS + (perf - APP_SESSION_START_PERF_MS);
  const drift = Math.round(wall - expected);

  return {
    driftMs: drift,
    suspicious: Math.abs(drift) > CLOCK_DRIFT_SESSION_LIMIT_MS
  };
}

async function getNetworkClockInfo() {
  if (!navigator.onLine) return { available: false };

  try {
    const res = await fetch(APPS_SCRIPT_URL, { method: "HEAD", cache: "no-store" });
    const date = res.headers.get("Date");

    if (!date) return { available: false };

    const serverMs = new Date(date).getTime();
    const clientMs = Date.now();
    const diff = clientMs - serverMs;

    return {
      available: true,
      diffMs: diff,
      suspicious: Math.abs(diff) > CLOCK_DRIFT_NETWORK_LIMIT_MS
    };
  } catch (_) {
    return { available: false };
  }
}

async function runLocationSecurityChecks(loc) {
  const flags = {
    suspiciousAccuracy: false,
    teleport: false,
    clockDriftSession: false,
    clockDriftNetwork: false
  };

  const warnings = [];

  if (!hasValidLocation(loc)) {
    return { ok: false, flags, warnings };
  }

  if (loc.accuracy > ACCURACY_SUSPICIOUS_METERS) {
    flags.suspiciousAccuracy = true;
    warnings.push("gps_accuracy_suspicious");
  }

  const last = await dbGet(STORE_CONFIG, "lastLocationFix");
  if (last) {
    const tele = detectLocationTeleport(last, loc);
    if (tele.suspicious) {
      flags.teleport = true;
      warnings.push("location_teleport");
    }
  }

  const drift = getSessionClockDriftInfo();
  if (drift.suspicious) {
    flags.clockDriftSession = true;
    warnings.push("clock_drift_session");
  }

  const network = await getNetworkClockInfo();
  if (network.available && network.suspicious) {
    flags.clockDriftNetwork = true;
    warnings.push("clock_drift_network");
  }

  await dbPut(STORE_CONFIG, {
    id: "lastLocationFix",
    ...loc,
    savedAt: new Date().toISOString()
  });

  return { ok: true, flags, warnings };
}

function detectLocationTeleport(a, b) {
  const dt = Math.max(1, (b.gpsTimestamp - a.gpsTimestamp));
  const dist = distanceMeters(a.lat, a.lng, b.lat, b.lng);
  const speed = dist / (dt / 1000);

  const suspicious =
    dist >= TELEPORT_DISTANCE_METERS &&
    (dt < MIN_TIME_FOR_LONG_DISTANCE_MS || speed > MAX_HUMAN_SPEED_MPS);

  return { suspicious, dist, dt, speed };
}

function distanceMeters(a1, o1, a2, o2) {
  const R = 6371000;
  const dA = (a2 - a1) * Math.PI / 180;
  const dO = (o2 - o1) * Math.PI / 180;

  const x =
    Math.sin(dA / 2) ** 2 +
    Math.cos(a1 * Math.PI / 180) *
    Math.cos(a2 * Math.PI / 180) *
    Math.sin(dO / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
async function createRecord(type) {
  try {
    const profile = await getProfile();

    if (!currentPhoto) {
      setStatus("عکسی ثبت نشده است.");
      return;
    }

    if (!hasValidLocation(pendingLocation)) {
      setStatus("GPS معتبر دریافت نشد.");
      return;
    }

    const policy = await getAttendancePolicyInfo();
    const gate = evaluateAttendancePolicy(policy.attendancePolicy, navigator.onLine);

    if (!gate.ok) {
      setStatus(gate.message);
      return;
    }

    const security = await runLocationSecurityChecks(pendingLocation);
    const id = generateClientRecordId(profile.personnelCode);
    const now = new Date();

    const rec = {
      clientRecordId: id,
      type,
      personnelCode: profile.personnelCode,
      firstName: profile.firstName,
      lastName: profile.lastName,
      createdAt: now.toISOString(),
      createdAtMs: now.getTime(),
      date: now.toLocaleDateString("fa-IR"),
      time: now.toLocaleTimeString("fa-IR"),
      photo: currentPhoto,
      ...pendingLocation,
      securityFlags: security.flags,
      securityWarnings: security.warnings,
      status: "pending"
    };

    await dbPut(STORE_RECORDS, rec);

    currentPhoto = "";
    pendingLocation = null;

    if ($("photoInput")) $("photoInput").value = "";
    if ($("photoPreview")) {
      $("photoPreview").style.display = "none";
      $("photoPreview").src = "";
    }

    await refreshUiFull();

    if (navigator.onLine) {
      scheduleSyncPendingRecords(200);
      setStatus("تردد ثبت و در حال ارسال است...");
    } else {
      setStatus("تردد آفلاین ذخیره شد.");
    }
  } catch (err) {
    console.error(err);
    setStatus("خطا در ساخت رکورد");
  }
}

function normalizeAttendancePayload(r) {
  return {
    action: "recordAttendance",
    PersonnelCode: r.personnelCode,
    FirstName: r.firstName,
    LastName: r.lastName,
    RecordType: r.type,
    Date: r.date,
    Time: r.time,
    Latitude: r.lat,
    Longitude: r.lng,
    Accuracy: r.accuracy,
    GpsTimestamp: r.gpsTimestamp,
    PhotoBase64: r.photo,
    SecurityFlagsJson: JSON.stringify(r.securityFlags || {}),
    SecurityWarningsJson: JSON.stringify(r.securityWarnings || {})
  };
}

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;

  syncRunning = true;
  setSyncStatus("در حال ارسال...");

  try {
    const all = await dbGetAll(STORE_RECORDS);
    const pending = all
      .filter(r => r.status === "pending" || r.status === "failed")
      .sort((a, b) => a.createdAtMs - b.createdAtMs);

    if (!pending.length) {
      setSyncStatus("موردی برای ارسال نیست");
      syncRunning = false;
      return;
    }

    for (const r of pending) {
      try {
        const payload = normalizeAttendancePayload(r);
        const form = new URLSearchParams();

        for (const [k, v] of Object.entries(payload)) {
          form.append(k, v ?? "");
        }

        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString()
        });

        const txt = await res.text();
        let data;
        try {
          data = JSON.parse(txt);
        } catch (_) {
          data = { ok: false };
        }

        if (!res.ok || data.ok === false) {
          r.status = "failed";
          r.serverResponse = txt;
          await dbPut(STORE_RECORDS, r);
          continue;
        }

        r.status = "synced";
        r.serverResponse = txt;
        r.syncedAt = new Date().toISOString();
        await dbPut(STORE_RECORDS, r);

      } catch (err) {
        r.status = "failed";
        r.serverResponse = err.message;
        await dbPut(STORE_RECORDS, r);
      }
    }

    setSyncStatus("همگام‌سازی کامل شد");
    await refreshUiFull();
  } catch (_) {
    setSyncStatus("خطا در همگام‌سازی");
  }

  syncRunning = false;
}

async function renderPendingCount() {
  const all = await dbGetAll(STORE_RECORDS);
  $("pendingCount").textContent = all.filter(x => x.status === "pending").length;
}

async function renderLastRecords() {
  const c = $("recordsList");
  if (!c) return;

  const records = await dbGetAll(STORE_RECORDS);
  if (!records.length) {
    c.innerHTML = "<div>رکوردی نیست</div>";
    return;
  }

  records.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const last = records.slice(0, 10);

  c.innerHTML = last.map(r => `
    <div style="padding:8px;border-bottom:1px solid #ddd">
      <b>${r.date}</b> - ${r.time}
    </div>
  `).join("");
}

async function refreshUi() {
  await renderPendingCount();
  updateOnlineBadge();
}

async function refreshUiFull() {
  await refreshUi();
  await renderLastRecords();
}

function updateOnlineBadge() {
  const el = $("onlineBadge");
  if (!el) return;

  if (navigator.onLine) {
    el.textContent = "آنلاین";
    el.className = "badge online";
  } else {
    el.textContent = "آفلاین";
    el.className = "badge offline";
  }
}

function setStatus(m) {
  const el = $("status");
  if (el) el.textContent = m;
}

function setSyncStatus(m) {
  const el = $("syncStatus");
  if (el) el.textContent = m;
}

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await getProfile();
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", "employee");
    url.searchParams.set("personnelCode", profile.personnelCode);

    const res = await fetch(url.toString());
    if (!res.ok) return;

    const data = await res.json();
    const emp = data?.employee || data || {};
    const msg = emp.AdminMessage || emp.message || "";

    if (msg && !adminMessageShownOnEntry) {
      adminMessageShownOnEntry = true;
      $("adminMessage").textContent = msg;
      $("adminMessage").style.display = "block";
    }
  } catch (_) {}
}

window.forceManualSync = async function () {
  await syncPendingRecords();
  await refreshUiFull();
};
