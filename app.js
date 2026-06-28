const DB_NAME = “attendance-pwa-db”;

const DB_VERSION = 3;

const STORE_RECORDS = “records”;

const STORE_PROFILE = “profile”;

const STORE_CONFIG = “config”;

const APPS_SCRIPT_URL = “https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec”;

const GPS_WAIT_MS = 90000;

const GPS_RETRY_MS = 30000;

const GOOD_ACCURACY_METERS = 1000;

const GPS_REQUIRED = true;

const CLOCK_RISK_GPS_CLICK_DIFF_MS = 5 * 60 * 1000;

const HIGH_GPS_WAIT_MS = 2 * 60 * 1000;

const CLOCK_DRIFT_SESSION_LIMIT_MS = 10 * 1000;

const CLOCK_DRIFT_NETWORK_LIMIT_MS = 2 * 60 * 1000;

const DEFAULT_ATTENDANCE_POLICY = “ONLINE_OR_OFFLINE”;

const POLICY_NOT_ALLOWED = “NOT_ALLOWED”;

const POLICY_ONLINE_ONLY = “ONLINE_ONLY”;

const POLICY_OFFLINE_ONLY = “OFFLINE_ONLY”;

const POLICY_ONLINE_PREFERRED = “ONLINE_PREFERRED”;

const POLICY_ONLINE_OR_OFFLINE = “ONLINE_OR_OFFLINE”;

const POLICY_OFFLINE_ALLOWED_IMMEDIATE = “OFFLINE_ALLOWED_IMMEDIATE”;

const APP_SESSION_START_WALL_MS = Date.now();

const APP_SESSION_START_PERF_MS = performance.now();

let db = null;

let currentPhoto = “”;

let pendingLocation = null;

let syncRunning = false;

let syncTimer = null;

let adminMessageShownOnEntry = false;

let captureStartedAtMs = 0;

let photoSelectedAtMs = 0;

let photoCompressedAtMs = 0;

const $ = (id) => document.getElementById(id);

document.addEventListener(“DOMContentLoaded”, async () => {

showGpsToast(“📍 حتما جی پی اس و اینترنت خود را روشن کنید تمامی مناطق تحت پوشش اینترنت هستند”, 5000, “error”);

db = await openDb();

bindEvents();

await loadProfile();

await ensurePolicyLoadedAtStartup();

await refreshUi();

await fetchMessages();

setupAutoSync();

if (“serviceWorker” in navigator) {

navigator.serviceWorker.register(“sw.js”).catch(() => {});

}

});

function bindEvents() {

$(“saveProfileBtn”)?.addEventListener(“click”, saveProfile);

$(“recordBtn”)?.addEventListener(“click”, startAttendanceCapture);

$(“photoInput”)?.addEventListener(“change”, handlePhotoSelected);

}

// Js.html

async function saveProfile() {
  const loading = $("saveLoading");
  if (loading) loading.style.display = "flex";

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      setStatus("اطلاعات پرسنلی کامل نیست.");
      return;
    }

    await dbPut(STORE_PROFILE, {
      id: "main",
      ...profile
    });

    await refreshPolicyIfPossible();

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
  } finally {
    if (loading) loading.style.display = "none";
  }
}

async function saveProfileSilent() {
  const loading = $("saveLoading");
  if (loading) loading.style.display = "flex";

  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      throw new Error("مشخصات پرسنلی کامل نیست.");
    }

    await dbPut(STORE_PROFILE, {
      id: "main",
      ...profile
    });
  } finally {
    if (loading) loading.style.display = "none";
  }
}

function startAttendanceCapture() {
  const loading = $("recordLoading");
  if (loading) loading.style.display = "flex";

  const personnelCode = $("personnelCode")?.value.trim() || "";
  const firstName = $("firstName")?.value.trim() || "";
  const lastName = $("lastName")?.value.trim() || "";

  if (!personnelCode || !firstName || !lastName) {
    setStatus("مشخصات پرسنلی کامل نیست.");
    if (loading) loading.style.display = "none";
    return;
  }

  saveProfileSilent()
    .then(async () => {
      const { gate } = await getCurrentAttendanceGate();
      if (!gate.ok) {
        setStatus(gate.message);
        if (loading) loading.style.display = "none";
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
        setStatus("ورودی عکس پیدا نشد.");
        if (loading) loading.style.display = "none";
        return;
      }

      photoInput.value = "";
      setStatus("دوربین باز می‌شود. لطفاً عکس بگیرید.");
      photoInput.click();
    })
    .catch((err) => {
      setStatus(err?.message || "خطا در ثبت مشخصات.");
    })
    .finally(() => {
      if (loading) loading.style.display = "none";
    });
}

async function createRecord(type) {
  const loading = $("recordLoading");
  if (loading) loading.style.display = "flex";

  try {
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
      photo: currentPhoto || "",
      status: "pending",
      createdAt: now.toISOString()
    };

    await dbPut(STORE_RECORDS, record);

    showGpsToast("✅ تردد با موفقیت ثبت شد", 3000, "success");
    setStatus("تردد با GPS ذخیره شد.");
    await refreshUi();

    if (navigator.onLine) {
      scheduleSyncPendingRecords(500);
    }
  } finally {
    if (loading) loading.style.display = "none";
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

async function markFirstConnectionForOfflineRecords() {
  if (!db || !navigator.onLine) return;

  try {
    const nowIso = new Date().toISOString();
    const records = await dbGetAll(STORE_RECORDS);
    const list = records.filter((r) =>
      r.offlineCreated === true &&
      (r.status === "pending" || r.status === "failed") &&
      !r.firstConnectionAfterOfflineRecord
    );

    for (const r of list) {
      r.firstConnectionAfterOfflineRecord = nowIso;
      await dbPut(STORE_RECORDS, r);
    }

    if (list.length) {
      await refreshUi();
    }
  } catch (e) {}
}

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;

  syncRunning = true;

  try {
    const policyInfo = await refreshPolicyIfPossible() || await getAttendancePolicyInfo();
    const syncGate = evaluateAttendancePolicy(policyInfo?.attendancePolicy, navigator.onLine);

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

      if (r.offlineCreated !== true && !r.connectionStatus) {
        r.connectionStatus = "online";
        r.connectionStatusFa = "آنلاین";
        r.createdOnline = true;
      } else if (r.offlineCreated === true && !r.connectionStatus) {
         r.connectionStatus = "offline";
         r.connectionStatusFa = "آفلاین";
         r.createdOnline = false;
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

        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=utf-8"
          },
          body: JSON.stringify(payload)
        });

        const result = await res.json().catch(() => ({}));

        if (result.attendancePolicy || result.policyVersion !== undefined) {
          await saveAttendancePolicyInfo({
            personnelCode: r.personnelCode || "",
            attendancePolicy: result.attendancePolicy || policyInfo?.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
            policyVersion: Number(result.policyVersion || 0),
            policyFetchedAt: new Date().toISOString(),
            policySource: "server_response"
          });
        }

        r.serverResponse = JSON.stringify(result || {});

        if (result.ok) {
          const sentIso = new Date().toISOString();

          r.status = "sent";
          r.syncedAt = sentIso;
          r.uploadedAt = sentIso;

          // ***** بلاک نمایش result.message حذف شد *****

        } else {
          r.status = "failed";

          if (result?.error === "POLICY_VIOLATION") {
            setSyncStatus("ارسال توسط سیاست حضور و غیاب مجاز نیست.");
          }
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
    await fetchMessages(); // ***** این تابع پیام‌ها را می‌فرستد *****
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

let lastAdminMessage = "";

// Original showAdminMessage function (lines 954–957)
// function showAdminMessage(m) {
//   const msg = "پیام مدیر: " + m;
//   setSyncStatus(msg);
// }

// function showAdminMessage(m) {

//   if (adminMessageShownThisSession) return;

//   if (!m || String(m).trim() === "" || m === "undefined" || m === "null") {
//     return;
//   }

//   const msg = String(m).trim();

//   if (msg === lastAdminMessage) return;

//   lastAdminMessage = msg;
//   adminMessageShownThisSession = true;

//   const overlay = document.createElement("div");
//   overlay.style =
//     "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; font-family:inherit;";

//   const modal = document.createElement("div");
//   modal.style =
//     "background:#FFFFFF; padding:20px; border-radius:15px; width:85%; max-width:400px; text-align:center; box-shadow:0 4px 15px rgba(0,0,0,0.2); direction:rtl;";

//   modal.innerHTML = `
//     <h3 style="margin-top:0; color:#333;">پیام مدیر</h3>
//     <p style="color:#555; line-height:1.6;">${msg}</p>
//     <button id="closeAdminMsg" style="background:#007bff; color:#fff; border:none; padding:10px 25px; border-radius:10px; cursor:pointer; width:100%; font-weight:bold;">تایید</button>
//   `;

//   overlay.appendChild(modal);
//   document.body.appendChild(overlay);

//   document.getElementById("closeAdminMsg").onclick = function () {
//     document.body.removeChild(overlay);
//   };
// }
function showAdminMessage(m) {

  if (!m || String(m).trim() === "" || m === "undefined" || m === "null") {
    return;
  }

  const msg = String(m).trim();

  const overlay = document.createElement("div");
  overlay.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; font-family:inherit;";

  const modal = document.createElement("div");
  modal.style = "background:#FFFFFF; padding:20px; border-radius:15px; width:85%; max-width:400px; text-align:center; box-shadow:0 4px 15px rgba(0,0,0,0.2); direction:rtl;";

  modal.innerHTML = `
    <h3 style="margin-top:0; color:#333;">پیام مدیر</h3>
    <p style="color:#555; line-height:1.6;">${msg}</p>
    <button id="closeAdminMsg" style="background:#007bff; color:#fff; border:none; padding:10px 25px; border-radius:10px; cursor:pointer; width:100%; font-weight:bold;">تایید</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById("closeAdminMsg").onclick = function() {
    document.body.removeChild(overlay);
  };
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

async function fetchMessages() {
  if (!navigator.onLine) return;

  try {
    const profile = await getProfile().catch(() => null);
    if (!profile?.personnelCode) return;

    const url =
      APPS_SCRIPT_URL +
      "?action=getMessages&personnelCode=" +
      encodeURIComponent(profile.personnelCode);

    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) return;

    const result = await res.json().catch(() => null);
    if (!result || result.ok !== true) return;

    const messages = Array.isArray(result.messages) ? result.messages : [];
    const cleaned = messages
      .map((m) => String(m ?? "").trim())
      .filter(
        (m) =>
          m &&
          m !== "false" &&
          m !== "null" &&
          m !== "undefined" &&
          m !== "0" &&
          m !== "تردد"
      );

    if (!cleaned.length) return;

    // const msg = cleaned.join(" | ");
    // showAdminMessage(msg);
    const msg = cleaned.join(" | ");

if (!adminMessageShownOnEntry && msg !== lastAdminMessage) {
  lastAdminMessage = msg;
  adminMessageShownOnEntry = true;
  showAdminMessage(msg);
}

  } catch (e) {
    console.error("Error fetching messages:", e); // برای دیباگ بهتر
  }
}

function escapeHtml(v) {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
