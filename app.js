const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {

  db = await openDb();

  bindEvents();
  await loadProfile();
  await refreshUi();

  updateOnlineBadge();

  if (navigator.onLine) {
    syncPendingRecords();
  }

  window.addEventListener("online", () => {
    updateOnlineBadge();
    syncPendingRecords();
  });

  window.addEventListener("offline", updateOnlineBadge);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

});

function bindEvents() {

  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);

}

function startAttendanceCapture() {

  const personnelCode = $("personnelCode")?.value.trim() || "";
  const firstName = $("firstName")?.value.trim() || "";
  const lastName = $("lastName")?.value.trim() || "";

  if (!personnelCode || !firstName || !lastName) {
    setStatus("مشخصات پرسنلی کامل نیست.");
    return;
  }

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

    await saveProfileSilent();

    setStatus("در حال آماده‌سازی عکس، صبور باشید ...");

    currentPhoto = await compressImage(file);

    if ($("photoPreview")) {
      $("photoPreview").src = currentPhoto;
      $("photoPreview").style.display = "block";
    }

    if (!isGeolocationUsable()) {
      setStatus(
        "GPS در دسترس نیست.\n" +
        "لطفاً مطمئن شوید سایت با HTTPS باز شده و Location گوشی روشن است."
      );
      return;
    }

    setStatus("در حال دریافت GPS... اگر پیام دسترسی آمد، گزینه Allow یا مجاز را بزنید.");

    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {

      if (pendingLocation?.status === "denied") {
        setStatus(
          "دسترسی GPS رد شد.\n" +
          "تردد ذخیره نمی‌شود. لطفاً Location را برای این سایت مجاز کنید و دوباره تلاش کنید."
        );
        return;
      }

      if (pendingLocation?.status === "unavailable") {
        setStatus(
          "موقعیت مکانی در دسترس نیست.\n" +
          "لطفاً GPS گوشی را روشن کنید، اینترنت را بررسی کنید و دوباره تلاش کنید."
        );
        return;
      }

      if (pendingLocation?.status === "timeout") {
        setStatus(
          "زمان دریافت GPS تمام شد.\n" +
          "لطفاً GPS را روشن بگذارید، کمی در فضای بازتر قرار بگیرید و دوباره تلاش کنید."
        );
        return;
      }

      setStatus(
        "GPS دریافت نشد.\n" +
        "لطفاً Location گوشی را روشن کنید، دسترسی Location را مجاز کنید و دوباره تلاش کنید."
      );
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

    req.onupgradeneeded = e => {

      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {

        const store = db.createObjectStore(STORE_RECORDS, { keyPath: "id", autoIncrement: true });
        store.createIndex("status", "status");

      }

      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
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

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

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

  const record = {

    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,

    type: type,

    recordDate: getPersianDate(now),
    recordHour: getTime(now),

    latitude: loc.latitude || "",
    longitude: loc.longitude || "",
    accuracy: loc.accuracy || "",

    deviceTime: now.toISOString(),

    photo: currentPhoto,

    status: "pending",

    createdAt: now.toISOString()

  };

  await dbPut(STORE_RECORDS, record);

  setStatus("تردد با GPS ذخیره شد.");

  await refreshUi();

  if (navigator.onLine) {
    syncPendingRecords();
  }

}

function isGeolocationUsable() {

  if (!navigator.geolocation) return false;
  if (!window.isSecureContext) return false;

  return true;

}

async function checkLocationPermission() {

  if (!navigator.permissions) return "unknown";

  try {

    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state;

  } catch {

    return "unknown";

  }

}

async function getLocationIOSFriendly() {

  if (!isGeolocationUsable()) {
    return emptyLocation("unavailable", "GPS در دسترس نیست");
  }

  let firstLocation = await getCurrentPositionSafe({
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

  let secondLocation = await getCurrentPositionSafe({
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

  if (watchedLocation?.status === "denied") {
    return watchedLocation;
  }

  bestLocation = chooseBetterLocation(bestLocation, watchedLocation);

  if (hasValidLocation(bestLocation)) {
    return bestLocation;
  }

  if (firstLocation?.status === "unavailable" || secondLocation?.status === "unavailable" || watchedLocation?.status === "unavailable") {
    return emptyLocation("unavailable", "موقعیت مکانی در دسترس نیست");
  }

  if (firstLocation?.status === "timeout" || secondLocation?.status === "timeout" || watchedLocation?.status === "timeout") {
    return emptyLocation("timeout", "زمان دریافت GPS تمام شد");
  }

  return emptyLocation("timeout", "GPS دریافت نشد");

}

function getCurrentPositionSafe(options) {

  return new Promise(resolve => {

    if (!isGeolocationUsable()) {
      resolve(emptyLocation("unavailable", "GPS در دسترس نیست"));
      return;
    }

    let done = false;
    let timeoutId = null;

    const finish = loc => {

      if (done) return;

      done = true;

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      resolve(loc);

    };

    timeoutId = setTimeout(() => {
      finish(emptyLocation("timeout", "زمان دریافت GPS تمام شد"));
    }, (options.timeout || 20000) + 3000);

    try {

      navigator.geolocation.getCurrentPosition(

        pos => {

          finish({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            status: "ok"
          });

        },

        err => {
          finish(geoErrorToLocation(err));
        },

        options

      );

    } catch (error) {

      finish(emptyLocation("error", "خطا در شروع GPS"));

    }

  });

}

function getLocationWithWatch(waitMs) {

  return new Promise(resolve => {

    if (!isGeolocationUsable()) {
      resolve(emptyLocation("unavailable", "GPS در دسترس نیست"));
      return;
    }

    let done = false;
    let best = null;
    let watchId = null;
    let timeoutId = null;

    const finish = loc => {

      if (done) return;

      done = true;

      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      if (hasValidLocation(loc)) {
        resolve(loc);
      } else if (hasValidLocation(best)) {
        resolve(best);
      } else {
        resolve(loc || emptyLocation("timeout", "GPS دریافت نشد"));
      }

    };

    try {

      watchId = navigator.geolocation.watchPosition(

        pos => {

          const loc = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            status: "ok"
          };

          best = chooseBetterLocation(best, loc);

          if (loc.accuracy <= GOOD_ACCURACY_METERS) {
            finish(loc);
          }

        },

        err => {

          const errorLocation = geoErrorToLocation(err);

          if (hasValidLocation(best) && errorLocation.status !== "denied") {
            finish(best);
            return;
          }

          finish(errorLocation);

        },

        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: waitMs
        }

      );

      timeoutId = setTimeout(() => {
        finish(best || emptyLocation("timeout", "GPS دریافت نشد"));
      }, waitMs + 3000);

    } catch (error) {

      finish(emptyLocation("error", "خطا در شروع GPS"));

    }

  });

}

function geoErrorToLocation(err) {

  if (err.code === 1) {
    return emptyLocation("denied", "کاربر دسترسی GPS را رد کرده است");
  }

  if (err.code === 2) {
    return emptyLocation("unavailable", "موقعیت مکانی در دسترس نیست");
  }

  if (err.code === 3) {
    return emptyLocation("timeout", "زمان دریافت GPS تمام شد");
  }

  return emptyLocation("error", "خطا در دریافت GPS");

}

function hasValidLocation(l) {

  if (!l) return false;
  if (l.status !== "ok") return false;

  return l.latitude !== "" && l.longitude !== "";

}

function emptyLocation(status, error) {

  return {
    latitude: "",
    longitude: "",
    accuracy: "",
    status,
    error
  };

}

function chooseBetterLocation(a, b) {

  if (!a) return b;
  if (!b) return a;

  if (!hasValidLocation(a)) return b;
  if (!hasValidLocation(b)) return a;

  return (b.accuracy || 999999) <= (a.accuracy || 999999) ? b : a;

}

async function syncPendingRecords() {

  if (syncRunning) return;

  if (!navigator.onLine) return;

  syncRunning = true;

  const records = await dbGetAll(STORE_RECORDS);

  const list = records.filter(r => r.status === "pending" || r.status === "failed");

  if (!list.length) {

    setSyncStatus("چیزی برای ارسال نیست");
    syncRunning = false;
    return;

  }

  setSyncStatus("در حال ارسال...");

  for (const r of list) {

    try {

      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(r)
      });

      let result = {};

      try {
        result = await res.json();
      } catch {}

      if (result.ok) {

        r.status = "sent";
        await dbPut(STORE_RECORDS, r);

        if (result.message) {
          showAdminMessage(result.message);
        }

      } else {

        r.status = "failed";
        await dbPut(STORE_RECORDS, r);

      }

    } catch {

      r.status = "failed";
      await dbPut(STORE_RECORDS, r);

    }

  }

  syncRunning = false;

  setSyncStatus("ارسال انجام شد");

  refreshUi();

}

async function refreshUi() {

  const rec = await dbGetAll(STORE_RECORDS);

  if ($("pendingCount")) {
    $("pendingCount").textContent = rec.filter(r => r.status === "pending").length;
  }

  if ($("sentCount")) {
    $("sentCount").textContent = rec.filter(r => r.status === "sent").length;
  }

  if ($("failedCount")) {
    $("failedCount").textContent = rec.filter(r => r.status === "failed").length;
  }

  renderRecords(rec);

}

function renderRecords(records) {

  if (!$("recordsList")) return;

  if (!records.length) {

    $("recordsList").innerHTML = "<p>ترددی ثبت نشده</p>";
    return;

  }

  const sorted = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  $("recordsList").innerHTML = sorted.slice(0, 20).map(r => `
    <div class="record-item compact-record">
      <span>${escapeHtml(r.recordDate)}</span>
      <span>${escapeHtml(r.recordHour)}</span>
    </div>
  `).join("");

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

  alert(msg);

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

    reader.onerror = () => reject(reader.error);

    reader.onload = e => {

      const img = new Image();

      img.onerror = () => reject(new Error("خطا در خواندن عکس"));

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

        canvas.toBlob(blob => {

          if (!blob) {
            reject(new Error("خطا در فشرده‌سازی عکس"));
            return;
          }

          const r = new FileReader();

          r.onerror = () => reject(r.error);
          r.onloadend = () => resolve(r.result);

          r.readAsDataURL(blob);

        }, "image/jpeg", 0.7);

      };

      img.src = e.target.result;

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
