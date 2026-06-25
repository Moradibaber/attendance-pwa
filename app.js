/******************************************************************************
 *   نسخه کامل app.js با اصلاحات درخواست GPS + پیام زیبا در مرکز صفحه
 *   نوشته شده مخصوص نسخه فرم شما — بدون دستکاری منطق اصلی
 ******************************************************************************/

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;

const $ = (id) => document.getElementById(id);

/*******************************************************************************
 *                                صفحه اصلی
 *******************************************************************************/

document.addEventListener("DOMContentLoaded", async () => {
  showGpsToast("📍 حتما GPS گوشی را روشن کنید", 3000);

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

/*******************************************************************************
 *                     1) تابع جدید و اصلاح‌شده: چک کردن دسترسی
 *******************************************************************************/

async function checkLocationPermission() {
  if (!navigator.permissions || !navigator.permissions.query) return "unknown";

  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state; // granted | denied | prompt
  } catch (e) {
    return "unknown";
  }
}

/*******************************************************************************
 *                                  2) روال انتخاب عکس و GPS
 *******************************************************************************/

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

  $("photoPreview").style.display = "none";

  const photoInput = $("photoInput");
  photoInput.value = "";
  setStatus("در حال باز کردن دوربین...");
  photoInput.click();
}

/******************************************************************************
 *   نسخه کامل app.js با اصلاحات درخواست GPS + پیام زیبا در مرکز صفحه
 *   نوشته شده مخصوص نسخه فرم شما — بدون دستکاری منطق اصلی
 ******************************************************************************/

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;

const $ = (id) => document.getElementById(id);

/*******************************************************************************
 *                                صفحه اصلی
 *******************************************************************************/

document.addEventListener("DOMContentLoaded", async () => {
  showGpsToast("📍 حتما GPS گوشی را روشن کنید", 3000);

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

/*******************************************************************************
 *                     1) تابع جدید و اصلاح‌شده: چک کردن دسترسی
 *******************************************************************************/

async function checkLocationPermission() {
  if (!navigator.permissions || !navigator.permissions.query) return "unknown";

  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state; // granted | denied | prompt
  } catch (e) {
    return "unknown";
  }
}

/*******************************************************************************
 *                                  2) روال انتخاب عکس و GPS
 *******************************************************************************/

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

  $("photoPreview").style.display = "none";

  const photoInput = $("photoInput");
  photoInput.value = "";
  setStatus("در حال باز کردن دوربین...");
  photoInput.click();
}

async function handlePhotoSelected() {
  const file = $("photoInput")?.files?.[0];
  if (!file) {
    setStatus("عکسی انتخاب نشد.");
    return;
  }

  try {
    const permission = await checkLocationPermission();

    if (permission === "denied") {
      showGpsToast(
        "🚫 دسترسی GPS برای این سایت مسدود شده است. روی آیکون قفل کنار آدرس زده و Location را Allow کنید.",
        6500
      );
      setStatus("GPS مسدود شده — باید دستی آزاد شود.");
      return;
    }

    await saveProfileSilent();
    setStatus("در حال پردازش عکس...");
    currentPhoto = await compressImage(file);

    $("photoPreview").src = currentPhoto;
    $("photoPreview").style.display = "block";

    setStatus("در حال دریافت GPS...");

       pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      if (pendingLocation?.status === "denied") {
        showGpsToast("🚫 دسترسی GPS مسدود است. لطفاً از تنظیمات مرورگر آن را باز کنید.", 6000);
        return;
      }

      // اینجا پیام دقیق را به کاربر نشان می‌دهیم
      if (pendingLocation?.error.includes("GPS خاموش است")) {
         showGpsToast("📍 GPS گوشی شما خاموش است یا سیگنال ندارد. آن را روشن کنید.", 5000);
      }
      
      setStatus("خطا: " + pendingLocation?.error);
      return;
    }
    
    await createRecord("تردد");
  } catch (err) {
    console.error(err);
    setStatus("خطا در ثبت تردد.");
  }
}

/*******************************************************************************
 *                            IndexedDB
 *******************************************************************************/

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, {
          keyPath: "id",
          autoIncrement: true,
        });
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

/*******************************************************************************
 *                                   پروفایل
 *******************************************************************************/

async function saveProfile() {
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    setStatus("اطلاعات پرسنلی کامل نیست.");
    return;
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

  $("profileStatus").textContent = "مشخصات ذخیره شد.";
  setTimeout(() => ($("profileStatus").textContent = ""), 3000);
}

async function saveProfileSilent() {
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات ناقص است.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (!p) return;

  $("personnelCode").value = p.personnelCode || "";
  $("firstName").value = p.firstName || "";
  $("lastName").value = p.lastName || "";
}

function getProfileFromInputs() {
  return {
    personnelCode: $("personnelCode").value.trim(),
    firstName: $("firstName").value.trim(),
    lastName: $("lastName").value.trim(),
  };
}

async function getProfile() {
  const saved = await dbGet(STORE_PROFILE, "main");
  const input = getProfileFromInputs();

  const profile = {
    personnelCode: input.personnelCode || saved?.personnelCode || "",
    firstName: input.firstName || saved?.firstName || "",
    lastName: input.lastName || saved?.lastName || "",
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

  return profile;
}

/*******************************************************************************
 *                              ثبت تردد
 *******************************************************************************/

async function createRecord(type) {
  const profile = await getProfile();

  if (GPS_REQUIRED && !hasValidLocation(pendingLocation)) {
    setStatus("GPS معتبر نیست.");
    return;
  }

  const now = new Date();

  const r = {
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type,
    recordDate: getPersianDate(now),
    recordHour: getTime(now),

    latitude: pendingLocation.latitude,
    longitude: pendingLocation.longitude,
    accuracy: pendingLocation.accuracy,

    deviceTime: now.toISOString(),
    createdAt: now.toISOString(),

    photo: currentPhoto,
    status: "pending",
  };

  await dbPut(STORE_RECORDS, r);

  setStatus("تردد ذخیره شد.");
  refreshUi();

  if (navigator.onLine) syncPendingRecords();
}

/*******************************************************************************
 *                               GPS
 *******************************************************************************/

function isGeolocationUsable() {
  return !!navigator.geolocation && window.isSecureContext;
}

async function getLocationIOSFriendly() {
  if (!isGeolocationUsable())
    return emptyLocation("unavailable", "GPS فعال نیست");

  let loc1 = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 25000,
  });

  if (hasValidLocation(loc1) && loc1.accuracy <= GOOD_ACCURACY_METERS)
    return loc1;

  if (loc1.status === "denied") return loc1;

  let loc2 = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 15000,
  });

  if (loc2.status === "denied") return loc2;

  let best = chooseBetterLocation(loc1, loc2);

  if (hasValidLocation(best) && best.accuracy <= GOOD_ACCURACY_METERS)
    return best;

  const watchLoc = await getLocationWithWatch(GPS_RETRY_MS);

  best = chooseBetterLocation(best, watchLoc);

  return best;
}

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    let finished = false;

    let timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(emptyLocation("timeout", "زمان GPS تمام شد"));
      }
    }, (options.timeout || 20000) + 3000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          status: "ok",
        });
      },
      (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

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
          status: "ok",
        };

        best = chooseBetterLocation(best, loc);

        if (loc.accuracy <= GOOD_ACCURACY_METERS) finish(loc);
      },
      (err) => finish(geoErrorToLocation(err)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: waitMs }
    );

    const timeout = setTimeout(() => finish(best), waitMs + 2000);

    function finish(loc) {
      if (done) return;
      done = true;

      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timeout);

      resolve(loc || emptyLocation("timeout", "GPS ناکام"));
    }
  });
}

/*******************************************************************************
 *                         GPS Helpers
 *******************************************************************************/

function geoErrorToLocation(err) {
  // اگر کاربر کلاً دسترسی را بلاک کرده باشد
  if (err.code === 1) return emptyLocation("denied", "دسترسی مسدود شده است");
  
  // اگر GPS خاموش باشد یا سیگنال ضعیف باشد، معمولاً کد 3 یا 2 برمی‌گردد
  if (err.code === 3 || err.code === 2) 
    return emptyLocation("timeout", "GPS خاموش است یا سیگنال ضعیف است. لطفاً GPS را چک کنید.");
    
  return emptyLocation("error", "خطای GPS");
}


function hasValidLocation(l) {
  return l && l.status === "ok" && l.latitude !== "" && l.longitude !== "";
}

function emptyLocation(status, error) {
  return { latitude: "", longitude: "", accuracy: "", status, error };
}

function chooseBetterLocation(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (!hasValidLocation(a)) return b;
  if (!hasValidLocation(b)) return a;
  return a.accuracy <= b.accuracy ? a : b;
}

/*******************************************************************************
 *                               Sync ارسال
 *******************************************************************************/

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;

  syncRunning = true;

  const all = await dbGetAll(STORE_RECORDS);

  const list = all.filter(
    (r) => r.status === "pending" || r.status === "failed"
  );

  if (!list.length) {
    setSyncStatus("همه چیز ارسال شده");
    syncRunning = false;
    return;
  }

  setSyncStatus("در حال ارسال...");

  for (const r of list) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify(r),
      });

      const json = await res.json().catch(() => ({}));

      if (json.ok) {
        r.status = "sent";
        await dbPut(STORE_RECORDS, r);
        if (json.message) showAdminMessage(json.message);
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
  setSyncStatus("ارسال شد");
  refreshUi();
}

/*******************************************************************************
 *                                UI
 *******************************************************************************/

async function refreshUi() {
  const list = await dbGetAll(STORE_RECORDS);

  $("pendingCount").textContent = list.filter((r) => r.status === "pending")
    .length;
  $("sentCount").textContent = list.filter((r) => r.status === "sent").length;
  $("failedCount").textContent = list.filter((r) => r.status === "failed")
    .length;

  renderRecords(list);
}

function renderRecords(records) {
  if (!records.length) {
    $("recordsList").innerHTML = "<p>ترددی ثبت نشده</p>";
    return;
  }

  const sorted = [...records].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  $("recordsList").innerHTML = sorted
    .slice(0, 20)
    .map(
      (r) =>
        `<div class="record-item compact-record">
           <span>${escapeHtml(r.recordDate)}</span>
           <span>${escapeHtml(r.recordHour)}</span>
         </div>`
    )
    .join("");
}

function updateOnlineBadge() {
  if (navigator.onLine) {
    $("onlineBadge").textContent = "آنلاین";
    $("onlineBadge").className = "status online";
  } else {
    $("onlineBadge").textContent = "آفلاین";
    $("onlineBadge").className = "status offline";
  }
}

function setStatus(msg) {
  $("captureStatus").textContent = msg;
}

function setSyncStatus(msg) {
  $("syncStatus").textContent = msg;
}

function showAdminMessage(msg) {
  alert("پیام مدیر: " + msg);
}

function getPersianDate(d) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function getTime(d) {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/*******************************************************************************
 *                            فشرده‌سازی عکس
 *******************************************************************************/

function compressImage(file) {
  return new Promise((resolve) => {
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
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onloadend = () => resolve(fr.result);
            fr.readAsDataURL(blob);
          },
          "image/jpeg",
          0.7
        );
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

/*******************************************************************************
 *           پیام زیبا (Toast) — مرکز صفحه + قرمز + فونت بزرگ
 *******************************************************************************/

function showGpsToast(message, duration) {
  const toast = document.createElement("div");
  toast.textContent = message;

  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%) scale(0.8)",
    backgroundColor: "rgba(220, 38, 38, 0.95)",
    color: "#fff",
    padding: "25px 40px",
    borderRadius: "20px",
    fontSize: "22px",
    fontWeight: "bold",
    textAlign: "center",
    width: "80%",
    maxWidth: "400px",
    zIndex: "99999",
    opacity: "0",
    border: "3px solid #fff",
    boxShadow: "0 15px 40px rgba(0,0,0,0.4)",
    transition: "all 0.35s ease",
    direction: "rtl",
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, -50%) scale(1)";
  }, 80);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translate(-50%, -50%) scale(0.85)";
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

/*******************************************************************************
 *                            IndexedDB
 *******************************************************************************/

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, {
          keyPath: "id",
          autoIncrement: true,
        });
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

/*******************************************************************************
 *                                   پروفایل
 *******************************************************************************/

async function saveProfile() {
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    setStatus("اطلاعات پرسنلی کامل نیست.");
    return;
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

  $("profileStatus").textContent = "مشخصات ذخیره شد.";
  setTimeout(() => ($("profileStatus").textContent = ""), 3000);
}

async function saveProfileSilent() {
  const profile = getProfileFromInputs();

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات ناقص است.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });
}

async function loadProfile() {
  const p = await dbGet(STORE_PROFILE, "main");
  if (!p) return;

  $("personnelCode").value = p.personnelCode || "";
  $("firstName").value = p.firstName || "";
  $("lastName").value = p.lastName || "";
}

function getProfileFromInputs() {
  return {
    personnelCode: $("personnelCode").value.trim(),
    firstName: $("firstName").value.trim(),
    lastName: $("lastName").value.trim(),
  };
}

async function getProfile() {
  const saved = await dbGet(STORE_PROFILE, "main");
  const input = getProfileFromInputs();

  const profile = {
    personnelCode: input.personnelCode || saved?.personnelCode || "",
    firstName: input.firstName || saved?.firstName || "",
    lastName: input.lastName || saved?.lastName || "",
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

  return profile;
}

/*******************************************************************************
 *                              ثبت تردد
 *******************************************************************************/

async function createRecord(type) {
  const profile = await getProfile();

  if (GPS_REQUIRED && !hasValidLocation(pendingLocation)) {
    setStatus("GPS معتبر نیست.");
    return;
  }

  const now = new Date();

  const r = {
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    type,
    recordDate: getPersianDate(now),
    recordHour: getTime(now),

    latitude: pendingLocation.latitude,
    longitude: pendingLocation.longitude,
    accuracy: pendingLocation.accuracy,

    deviceTime: now.toISOString(),
    createdAt: now.toISOString(),

    photo: currentPhoto,
    status: "pending",
  };

  await dbPut(STORE_RECORDS, r);

  setStatus("تردد ذخیره شد.");
  refreshUi();

  if (navigator.onLine) syncPendingRecords();
}

/*******************************************************************************
 *                               GPS
 *******************************************************************************/

function isGeolocationUsable() {
  return !!navigator.geolocation && window.isSecureContext;
}

async function getLocationIOSFriendly() {
  if (!isGeolocationUsable())
    return emptyLocation("unavailable", "GPS فعال نیست");

  let loc1 = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 25000,
  });

  if (hasValidLocation(loc1) && loc1.accuracy <= GOOD_ACCURACY_METERS)
    return loc1;

  if (loc1.status === "denied") return loc1;

  let loc2 = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 15000,
  });

  if (loc2.status === "denied") return loc2;

  let best = chooseBetterLocation(loc1, loc2);

  if (hasValidLocation(best) && best.accuracy <= GOOD_ACCURACY_METERS)
    return best;

  const watchLoc = await getLocationWithWatch(GPS_RETRY_MS);

  best = chooseBetterLocation(best, watchLoc);

  return best;
}

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    let finished = false;

    let timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(emptyLocation("timeout", "زمان GPS تمام شد"));
      }
    }, (options.timeout || 20000) + 3000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          status: "ok",
        });
      },
      (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

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
          status: "ok",
        };

        best = chooseBetterLocation(best, loc);

        if (loc.accuracy <= GOOD_ACCURACY_METERS) finish(loc);
      },
      (err) => finish(geoErrorToLocation(err)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: waitMs }
    );

    const timeout = setTimeout(() => finish(best), waitMs + 2000);

    function finish(loc) {
      if (done) return;
      done = true;

      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timeout);

      resolve(loc || emptyLocation("timeout", "GPS ناکام"));
    }
  });
}

/*******************************************************************************
 *                         GPS Helpers
 *******************************************************************************/

function geoErrorToLocation(err) {
  // اگر کاربر کلاً دسترسی را بلاک کرده باشد
  if (err.code === 1) return emptyLocation("denied", "دسترسی مسدود شده است");
  
  // اگر GPS خاموش باشد یا سیگنال ضعیف باشد، معمولاً کد 3 یا 2 برمی‌گردد
  if (err.code === 3 || err.code === 2) 
    return emptyLocation("timeout", "GPS خاموش است یا سیگنال ضعیف است. لطفاً GPS را چک کنید.");
    
  return emptyLocation("error", "خطای GPS");
}


function hasValidLocation(l) {
  return l && l.status === "ok" && l.latitude !== "" && l.longitude !== "";
}

function emptyLocation(status, error) {
  return { latitude: "", longitude: "", accuracy: "", status, error };
}

function chooseBetterLocation(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (!hasValidLocation(a)) return b;
  if (!hasValidLocation(b)) return a;
  return a.accuracy <= b.accuracy ? a : b;
}

/*******************************************************************************
 *                               Sync ارسال
 *******************************************************************************/

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine) return;

  syncRunning = true;

  const all = await dbGetAll(STORE_RECORDS);

  const list = all.filter(
    (r) => r.status === "pending" || r.status === "failed"
  );

  if (!list.length) {
    setSyncStatus("همه چیز ارسال شده");
    syncRunning = false;
    return;
  }

  setSyncStatus("در حال ارسال...");

  for (const r of list) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify(r),
      });

      const json = await res.json().catch(() => ({}));

      if (json.ok) {
        r.status = "sent";
        await dbPut(STORE_RECORDS, r);
        if (json.message) showAdminMessage(json.message);
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
  setSyncStatus("ارسال شد");
  refreshUi();
}

/*******************************************************************************
 *                                UI
 *******************************************************************************/

async function refreshUi() {
  const list = await dbGetAll(STORE_RECORDS);

  $("pendingCount").textContent = list.filter((r) => r.status === "pending")
    .length;
  $("sentCount").textContent = list.filter((r) => r.status === "sent").length;
  $("failedCount").textContent = list.filter((r) => r.status === "failed")
    .length;

  renderRecords(list);
}

function renderRecords(records) {
  if (!records.length) {
    $("recordsList").innerHTML = "<p>ترددی ثبت نشده</p>";
    return;
  }

  const sorted = [...records].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  $("recordsList").innerHTML = sorted
    .slice(0, 20)
    .map(
      (r) =>
        `<div class="record-item compact-record">
           <span>${escapeHtml(r.recordDate)}</span>
           <span>${escapeHtml(r.recordHour)}</span>
         </div>`
    )
    .join("");
}

function updateOnlineBadge() {
  if (navigator.onLine) {
    $("onlineBadge").textContent = "آنلاین";
    $("onlineBadge").className = "status online";
  } else {
    $("onlineBadge").textContent = "آفلاین";
    $("onlineBadge").className = "status offline";
  }
}

function setStatus(msg) {
  $("captureStatus").textContent = msg;
}

function setSyncStatus(msg) {
  $("syncStatus").textContent = msg;
}

function showAdminMessage(msg) {
  alert("پیام مدیر: " + msg);
}

function getPersianDate(d) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function getTime(d) {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/*******************************************************************************
 *                            فشرده‌سازی عکس
 *******************************************************************************/

function compressImage(file) {
  return new Promise((resolve) => {
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
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            const fr = new FileReader();
            fr.onloadend = () => resolve(fr.result);
            fr.readAsDataURL(blob);
          },
          "image/jpeg",
          0.7
        );
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

/*******************************************************************************
 *           پیام زیبا (Toast) — مرکز صفحه + قرمز + فونت بزرگ
 *******************************************************************************/

function showGpsToast(message, duration) {
  const toast = document.createElement("div");
  toast.textContent = message;

  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%) scale(0.8)",
    backgroundColor: "rgba(220, 38, 38, 0.95)",
    color: "#fff",
    padding: "25px 40px",
    borderRadius: "20px",
    fontSize: "22px",
    fontWeight: "bold",
    textAlign: "center",
    width: "80%",
    maxWidth: "400px",
    zIndex: "99999",
    opacity: "0",
    border: "3px solid #fff",
    boxShadow: "0 15px 40px rgba(0,0,0,0.4)",
    transition: "all 0.35s ease",
    direction: "rtl",
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, -50%) scale(1)";
  }, 80);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translate(-50%, -50%) scale(0.85)";
    setTimeout(() => toast.remove(), 400);
  }, duration);
}
