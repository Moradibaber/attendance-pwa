const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

const CLOCK_RISK_GPS_CLICK_DIFF_MS = 5 * 60 * 1000;
const HIGH_GPS_WAIT_MS = 2 * 60 * 1000;
const CLOCK_DRIFT_SESSION_LIMIT_MS = 30 * 1000;
const CLOCK_DRIFT_NETWORK_LIMIT_MS = 2 * 60 * 1000;

const APP_SESSION_START_WALL_MS = Date.now();
const APP_SESSION_START_PERF_MS = performance.now();

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;
let syncTimer = null;
let captureStartedAtMs = 0;
let photoSelectedAtMs = 0;
let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  showGpsToast("📍 حتما جی پی اس خود را روشن کنید", 3000, "error");

  db = await openDb();

  bindEvents();
  await loadProfile();
  await refreshUi();

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

  window.addEventListener("online", () => {
    updateOnlineBadge();
    scheduleSyncPendingRecords(500);
  });

  window.addEventListener("offline", updateOnlineBadge);

  window.addEventListener("focus", () => {
    if (navigator.onLine) scheduleSyncPendingRecords(500);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && navigator.onLine) scheduleSyncPendingRecords(500);
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

  if (navigator.onLine) scheduleSyncPendingRecords(1000);
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

function startAttendanceCapture() {
  const personnelCode = $("personnelCode")?.value.trim() || "";
  const firstName = $("firstName")?.value.trim() || "";
  const lastName = $("lastName")?.value.trim() || "";

  if (!personnelCode || !firstName || !lastName) {
    setStatus("مشخصات پرسنلی کامل نیست.");
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
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    setStatus("اطلاعات پرسنلی کامل نیست.");
    return;
  }

  await dbPut(STORE_PROFILE, {
    id: "main",
    ...profile
  });

  showGpsToast("✅ مشخصات با موفقیت ثبت شد", 3000, "success");

  const profileStatus = $("profileStatus");

  if (profileStatus) {
    profileStatus.textContent = "مشخصات با موفقیت ثبت شد ✅";
    profileStatus.className = "status online small-status";

    setTimeout(() => {
      profileStatus.textContent = "";
      profileStatus.className = "status small-status";
    }, 3000);
  } else {
    setStatus("مشخصات با موفقیت ثبت شد.");
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

async function createRecord(type) {
  const profile = await getProfile();

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
    clockRisk: risk.clockRisk,
    clockRiskReason: risk.clockRiskReason,

    sessionClockDriftMs,
    networkClockDriftMs: networkClockDriftMs ?? "",

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
  // زمان واقعی سپری شده از ابتدای باز شدن اپلیکیشن (بدون وابستگی به ساعت گوشی)
  const realElapsedMs = performance.now() - APP_SESSION_START_PERF_MS;
  
  // زمان سپری شده بر اساس ساعت گوشی (که کاربر می‌تواند آن را عقب بکشد)
  const wallElapsedMs = Date.now() - APP_SESSION_START_WALL_MS;
  
  // اختلاف این دو، مقدار دقیق دستکاری ساعت در حین باز بودن برنامه را نشان می‌دهد
  // ما مقدار مطلق (Math.abs) را نمی‌گیریم تا بفهمیم عقب کشیده یا جلو
  const drift = wallElapsedMs - realElapsedMs;
  
  return Math.round(drift); 
}
function calculateClockRisk(d) {
  let score = 0;
  let reasons = [];
  
  // اگر کاربر ساعت گوشی را بیش از 10 ثانیه جابجا کند
  if (Math.abs(d.sessionClockDriftMs) > 10000) { 
    score += 5; 
    reasons.push("دستکاری ساعت (Clock Tampering)"); 
  }
  
  if (d.offlineCreated) { score += 1; reasons.push("آفلاین"); }
  
  // سایر شروط...
  return { 
    clockRisk: score >= 4 ? "High" : score >= 2 ? "Medium" : "Low", 
    clockRiskReason: reasons.join(" | ") 
  };
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

  if (typeof data.sessionClockDriftMs === "number" && data.sessionClockDriftMs > CLOCK_DRIFT_SESSION_LIMIT_MS) {
    score += 4;
    reasons.push("تغییر مشکوک ساعت گوشی در همین جلسه");
  }

  if (typeof data.networkClockDriftMs === "number" && data.networkClockDriftMs > CLOCK_DRIFT_NETWORK_LIMIT_MS) {
    score += 4;
    reasons.push("اختلاف زیاد ساعت گوشی با زمان شبکه");
  }

  if (!data.gpsMs) {
    score += 3;
    reasons.push("زمان موقعیت مکانی دریافت نشده است");
  }

  if (data.gpsMs && Math.abs(data.gpsMs - data.clickMs) > CLOCK_RISK_GPS_CLICK_DIFF_MS) {
    score += 3;
    reasons.push("اختلاف زمان کلیک و زمان موقعیت مکانی زیاد است");
  }

  if (data.gpsWaitMs !== "" && Number(data.gpsWaitMs) > HIGH_GPS_WAIT_MS) {
    score += 1;
    reasons.push("زمان انتظار GPS زیاد است");
  }

  if (data.photoDelayMs !== "" && Number(data.photoDelayMs) > 5 * 60 * 1000) {
    score += 1;
    reasons.push("تاخیر غیرعادی در انتخاب عکس");
  }

  if (data.submitDelayMs !== "" && Number(data.submitDelayMs) > 10 * 60 * 1000) {
    score += 1;
    reasons.push("تاخیر غیرعادی در ثبت نهایی");
  }

  if (data.offlineCreated) {
    score += 1;
    reasons.push("رکورد در حالت آفلاین ایجاد شده است");
  }

  if (data.locationStatus !== "ok") {
    score += 3;
    reasons.push("وضعیت GPS معتبر نیست");
  }

  if (data.accuracy && Number(data.accuracy) > GOOD_ACCURACY_METERS) {
    score += 1;
    reasons.push("دقت GPS پایین است");
  }

  let clockRisk = "low";

  if (score >= 6) {
    clockRisk = "high";
  } else if (score >= 3) {
    clockRisk = "medium";
  }

  return {
    clockRisk,
    clockRiskReason: reasons.join(" | ")
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

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;

  syncRunning = true;

  try {
    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter((r) => r.status === "pending" || r.status === "failed");

    if (!list.length) {
      setSyncStatus("چیزی برای ارسال نیست");
      return;
    }

    setSyncStatus("در حال ارسال...");

    for (const r of list) {
      if (r.status === "sent" || r.status === "syncing") continue;

      r.status = "syncing";
      r.lastSyncTryAt = new Date().toISOString();
      r.syncTryCount = Number(r.syncTryCount || 0) + 1;

      await dbPut(STORE_RECORDS, r);
      await refreshUi();

      try {
        const payload = buildServerPayload(r);

        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=utf-8"
          },
          body: JSON.stringify(payload)
        });

        const result = await res.json().catch(() => ({}));

        r.serverResponse = JSON.stringify(result || {});

        if (result.ok) {
          r.status = "sent";
          r.syncedAt = new Date().toISOString();

          if (result.message) {
            showAdminMessage(result.message);
          }
        } else {
          r.status = "failed";
        }

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
    clockRisk: record.clockRisk || "",
    clockRiskReason: record.clockRiskReason || "",
    sessionClockDriftMs: record.sessionClockDriftMs ?? "",
    networkClockDriftMs: record.networkClockDriftMs ?? "",

    photo: record.photo || "",

    createdAt: record.createdAt || "",
    lastSyncTryAt: record.lastSyncTryAt || "",
    syncTryCount: Number(record.syncTryCount || 0)
  };
}

async function refreshUi() {
  const rec = await dbGetAll(STORE_RECORDS);

  if ($("pendingCount")) {
    $("pendingCount").textContent = rec.filter((r) => r.status === "pending").length;
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
  if (!$("recordsList")) return;

  if (!records.length) {
    $("recordsList").innerHTML = "<p>ترددی ثبت نشده</p>";
    return;
  }

  const sorted = [...records].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  $("recordsList").innerHTML = sorted
    .slice(0, 20)
    .map((r) => {
      const riskText = r.clockRisk ? ` - ${escapeHtml(r.clockRisk)}` : "";

      return `
        <div class="record-item compact-record">
          <span>${escapeHtml(r.recordDate || "")}</span>
          <span>${escapeHtml(r.recordHour || r.recordTime || "")}${riskText}</span>
        </div>
      `;
    })
    .join("");
}

function updateOnlineBadge() {
  if (!$("onlineBadge")) return;

  if (navigator.onLine) {
    $("onlineBadge").textContent = "آنلاین";
    $("onlineBadge").className = "status online";
  } else {
    $("onlineBadge").textContent = "آفلاین";
    $("onlineBadge").className = "status offline";
  }
}

function setStatus(m) {
  if ($("captureStatus")) {
    $("captureStatus").textContent = m;
  }
}

function setSyncStatus(m) {
  if ($("syncStatus")) {
    $("syncStatus").textContent = m;
  }
}

function showAdminMessage(m) {
  const msg = "پیام مدیر: " + m;
  setSyncStatus(msg);
}

function getPersianDate(d) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function getTime(d) {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX = 400;

        let w = img.width;
        let h = img.height;

        if (w > h) {
          if (w > MAX) {
            h = h * (MAX / w);
            w = MAX;
          }
        } else {
          if (h > MAX) {
            w = w * (MAX / h);
            h = MAX;
          }
        }

        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            const r = new FileReader();

            r.onloadend = () => {
              resolve(r.result);
            };

            r.onerror = () => {
              reject(new Error("خطا در خواندن تصویر فشرده"));
            };

            r.readAsDataURL(blob);
          },
          "image/jpeg",
          0.3
        );
      };

      img.onerror = () => {
        reject(new Error("خطا در بارگذاری تصویر"));
      };

      img.src = e.target.result;
    };

    reader.onerror = () => {
      reject(new Error("خطا در خواندن فایل تصویر"));
    };

    reader.readAsDataURL(file);
  });
}

function escapeHtml(v) {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
