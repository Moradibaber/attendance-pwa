/******************************************************************************
 * app.js کامل و اصلاح‌شده
 * رفع مشکل تکرار کد، گیر کردن روی GPS، پیام واضح برای خاموش بودن Location
 ******************************************************************************/

const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

const GPS_RETRY_MS = 12000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let syncRunning = false;
let recordBusy = false;

const $ = (id) => document.getElementById(id);

/*******************************************************************************
 * صفحه اصلی
 ******************************************************************************/

document.addEventListener("DOMContentLoaded", async () => {
  try {
    showGpsToast("📍 لطفاً GPS گوشی را روشن کنید", 3000, "info");

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
  } catch (err) {
    console.error(err);
    setStatus("خطا در راه‌اندازی برنامه.");
    showGpsToast("خطا در راه‌اندازی برنامه", 5000, "error");
  }
});

/*******************************************************************************
 * رویدادها
 ******************************************************************************/

function bindEvents() {
  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);
}

function setRecordButtonLoading(isLoading) {
  const btn = $("recordBtn");
  if (!btn) return;

  btn.disabled = isLoading;
  btn.style.opacity = isLoading ? "0.65" : "1";
  btn.style.cursor = isLoading ? "not-allowed" : "pointer";
}

/*******************************************************************************
 * شروع ثبت تردد
 ******************************************************************************/

function startAttendanceCapture() {
  if (recordBusy) return;

  const personnelCode = $("personnelCode")?.value.trim() || "";
  const firstName = $("firstName")?.value.trim() || "";
  const lastName = $("lastName")?.value.trim() || "";

  if (!personnelCode || !firstName || !lastName) {
    setStatus("مشخصات پرسنلی کامل نیست.");
    showGpsToast("لطفاً مشخصات پرسنلی را کامل کنید", 4000, "error");
    return;
  }

  currentPhoto = "";
  pendingLocation = null;

  const preview = $("photoPreview");
  if (preview) {
    preview.style.display = "none";
    preview.removeAttribute("src");
  }

  const photoInput = $("photoInput");
  if (!photoInput) {
    setStatus("ورودی عکس پیدا نشد.");
    showGpsToast("خطا: ورودی عکس پیدا نشد", 4000, "error");
    return;
  }

  photoInput.value = "";
  setStatus("در حال باز کردن دوربین...");
  photoInput.click();
}

/*******************************************************************************
 * انتخاب عکس و گرفتن GPS
 ******************************************************************************/

async function handlePhotoSelected() {
  const file = $("photoInput")?.files?.[0];

  if (!file) {
    setStatus("عکسی انتخاب نشد.");
    return;
  }

  if (recordBusy) return;

  recordBusy = true;
  setRecordButtonLoading(true);

  try {
    const permission = await checkLocationPermission();

    if (permission === "denied") {
      const msg =
        "دسترسی GPS برای این سایت مسدود است. از تنظیمات مرورگر Location را Allow کنید.";
      setStatus(msg);
      showGpsToast("🚫 " + msg, 7000, "error");
      return;
    }

    await saveProfileSilent();

    setStatus("در حال پردازش عکس...");
    currentPhoto = await compressImage(file);

    const preview = $("photoPreview");
    if (preview) {
      preview.src = currentPhoto;
      preview.style.display = "block";
    }

    setStatus("در حال دریافت GPS...");
    showGpsToast("📍 در حال دریافت موقعیت مکانی...", 2500, "info");

    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      const msg = getLocationErrorMessage(pendingLocation);
      setStatus(msg);
      showGpsToast(msg, 8000, "error");
      return;
    }

    await createRecord("تردد");
    showGpsToast("✅ تردد با موفقیت ذخیره شد", 4000, "success");
  } catch (err) {
    console.error(err);
    setStatus("خطا در ثبت تردد.");
    showGpsToast("خطا در ثبت تردد. دوباره تلاش کنید.", 6000, "error");
  } finally {
    recordBusy = false;
    setRecordButtonLoading(false);
  }
}

/*******************************************************************************
 * بررسی مجوز GPS
 ******************************************************************************/

async function checkLocationPermission() {
  if (!navigator.permissions || !navigator.permissions.query) return "unknown";

  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state;
  } catch {
    return "unknown";
  }
}

/*******************************************************************************
 * IndexedDB
 ******************************************************************************/

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
      }

      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) {
        openedDb.createObjectStore(STORE_PROFILE, { keyPath: "id" });
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
 * پروفایل
 ******************************************************************************/

async function saveProfile() {
  try {
    const profile = getProfileFromInputs();

    if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
      setStatus("اطلاعات پرسنلی کامل نیست.");
      showGpsToast("اطلاعات پرسنلی کامل نیست", 4000, "error");
      return;
    }

    await dbPut(STORE_PROFILE, { id: "main", ...profile });

    if ($("profileStatus")) {
      $("profileStatus").textContent = "مشخصات ذخیره شد.";
      setTimeout(() => {
        if ($("profileStatus")) $("profileStatus").textContent = "";
      }, 3000);
    }

    showGpsToast("مشخصات ذخیره شد", 3000, "success");
  } catch (err) {
    console.error(err);
    setStatus("خطا در ذخیره مشخصات.");
    showGpsToast("خطا در ذخیره مشخصات", 4000, "error");
  }
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

  if ($("personnelCode")) $("personnelCode").value = p.personnelCode || "";
  if ($("firstName")) $("firstName").value = p.firstName || "";
  if ($("lastName")) $("lastName").value = p.lastName || "";
}

function getProfileFromInputs() {
  return {
    personnelCode: $("personnelCode")?.value.trim() || "",
    firstName: $("firstName")?.value.trim() || "",
    lastName: $("lastName")?.value.trim() || "",
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
 * ثبت تردد
 ******************************************************************************/

async function createRecord(type) {
  const profile = await getProfile();

  if (GPS_REQUIRED && !hasValidLocation(pendingLocation)) {
    const msg = getLocationErrorMessage(pendingLocation);
    setStatus(msg);
    showGpsToast(msg, 7000, "error");
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
  await refreshUi();

  if (navigator.onLine) {
    syncPendingRecords();
  }
}

/*******************************************************************************
 * GPS
 ******************************************************************************/

function isGeolocationUsable() {
  return !!navigator.geolocation && window.isSecureContext;
}

async function getLocationIOSFriendly() {
  if (!isGeolocationUsable()) {
    return emptyLocation(
      "unavailable",
      "GPS در این صفحه فعال نیست. برنامه باید با HTTPS اجرا شود."
    );
  }

  const loc1 = await getCurrentPositionSafe({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 12000,
  });

  if (hasValidLocation(loc1) && loc1.accuracy <= GOOD_ACCURACY_METERS) {
    return loc1;
  }

  if (loc1.status === "denied") {
    return loc1;
  }

  const loc2 = await getCurrentPositionSafe({
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 8000,
  });

  if (loc2.status === "denied") {
    return loc2;
  }

  let best = chooseBetterLocation(loc1, loc2);

  if (hasValidLocation(best) && best.accuracy <= GOOD_ACCURACY_METERS) {
    return best;
  }

  const watchLoc = await getLocationWithWatch(GPS_RETRY_MS);
  best = chooseBetterLocation(best, watchLoc);

  if (hasValidLocation(best)) {
    return best;
  }

  return emptyLocation(
    "timeout",
    "GPS دریافت نشد. از برنامه خارج شوید، GPS گوشی را روشن کنید و مجدداً ثبت تردد کنید."
  );
}

function getCurrentPositionSafe(options) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(emptyLocation("unavailable", "GPS در مرورگر پشتیبانی نمی‌شود."));
      return;
    }

    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(
        emptyLocation(
          "timeout",
          "GPS دریافت نشد. GPS گوشی را روشن کنید و دوباره تلاش کنید."
        )
      );
    }, (options.timeout || 10000) + 2000);

    try {
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
            error: "",
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
    } catch {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      resolve(emptyLocation("error", "خطا در اجرای GPS."));
    }
  });
}

function getLocationWithWatch(waitMs) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(emptyLocation("unavailable", "GPS در مرورگر پشتیبانی نمی‌شود."));
      return;
    }

    let done = false;
    let best = null;
    let watchId = null;

    const timeout = setTimeout(() => {
      finish(best || emptyLocation("timeout", "GPS دریافت نشد."));
    }, waitMs + 1000);

    function finish(loc) {
      if (done) return;
      done = true;

      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }

      clearTimeout(timeout);
      resolve(loc || emptyLocation("timeout", "GPS دریافت نشد."));
    }

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const loc = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            status: "ok",
            error: "",
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
          timeout: waitMs,
        }
      );
    } catch {
      finish(emptyLocation("error", "خطا در دریافت GPS."));
    }
  });
}

/*******************************************************************************
 * GPS Helpers
 ******************************************************************************/

function geoErrorToLocation(err) {
  if (!err) {
    return emptyLocation("error", "خطای نامشخص GPS.");
  }

  if (err.code === 1) {
    return emptyLocation(
      "denied",
      "دسترسی GPS مسدود است. از تنظیمات مرورگر Location را Allow کنید."
    );
  }

  if (err.code === 2) {
    return emptyLocation(
      "unavailable",
      "GPS گوشی خاموش است یا موقعیت مکانی در دسترس نیست. GPS را روشن کنید."
    );
  }

  if (err.code === 3) {
    return emptyLocation(
      "timeout",
      "GPS دریافت نشد. از برنامه خارج شوید، GPS گوشی را روشن کنید و مجدداً ثبت تردد کنید."
    );
  }

  return emptyLocation("error", "خطای GPS.");
}

function getLocationErrorMessage(loc) {
  if (!loc) {
    return "GPS دریافت نشد. از برنامه خارج شوید، GPS گوشی را روشن کنید و مجدداً ثبت تردد کنید.";
  }

  if (loc.status === "denied") {
    return "دسترسی GPS مسدود است. از تنظیمات مرورگر Location را Allow کنید.";
  }

  if (loc.status === "unavailable") {
    return "GPS گوشی خاموش است یا در دسترس نیست. GPS را روشن کنید و دوباره ثبت تردد کنید.";
  }

  if (loc.status === "timeout") {
    return "GPS دریافت نشد. از برنامه خارج شوید، GPS گوشی را روشن کنید و مجدداً ثبت تردد کنید.";
  }

  return loc.error || "خطا در دریافت GPS.";
}

function hasValidLocation(l) {
  return (
    l &&
    l.status === "ok" &&
    l.latitude !== "" &&
    l.longitude !== "" &&
    l.latitude !== null &&
    l.longitude !== null &&
    !Number.isNaN(Number(l.latitude)) &&
    !Number.isNaN(Number(l.longitude))
  );
}

function emptyLocation(status, error) {
  return {
    latitude: "",
    longitude: "",
    accuracy: "",
    status,
    error,
  };
}

function chooseBetterLocation(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (!hasValidLocation(a)) return b;
  if (!hasValidLocation(b)) return a;

  const accA = Number(a.accuracy) || 999999;
  const accB = Number(b.accuracy) || 999999;

  return accA <= accB ? a : b;
}

/*******************************************************************************
 * Sync ارسال
 ******************************************************************************/

async function syncPendingRecords() {
  if (syncRunning || !navigator.onLine || !db) return;

  syncRunning = true;

  try {
    const all = await dbGetAll(STORE_RECORDS);

    const list = all.filter(
      (r) => r.status === "pending" || r.status === "failed"
    );

    if (!list.length) {
      setSyncStatus("همه چیز ارسال شده");
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

          if (json.message) {
            showAdminMessage(json.message);
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

    setSyncStatus("ارسال شد");
    await refreshUi();
  } catch (err) {
    console.error(err);
    setSyncStatus("خطا در ارسال");
  } finally {
    syncRunning = false;
  }
}

/*******************************************************************************
 * UI
 ******************************************************************************/

async function refreshUi() {
  if (!db) return;

  const list = await dbGetAll(STORE_RECORDS);

  if ($("pendingCount")) {
    $("pendingCount").textContent = list.filter(
      (r) => r.status === "pending"
    ).length;
  }

  if ($("sentCount")) {
    $("sentCount").textContent = list.filter((r) => r.status === "sent").length;
  }

  if ($("failedCount")) {
    $("failedCount").textContent = list.filter(
      (r) => r.status === "failed"
    ).length;
  }

  renderRecords(list);
}

function renderRecords(records) {
  const box = $("recordsList");
  if (!box) return;

  if (!records.length) {
    box.innerHTML = "<p>ترددی ثبت نشده</p>";
    return;
  }

  const sorted = [...records].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  box.innerHTML = sorted
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
  const badge = $("onlineBadge");
  if (!badge) return;

  if (navigator.onLine) {
    badge.textContent = "آنلاین";
    badge.className = "status online";
  } else {
    badge.textContent = "آفلاین";
    badge.className = "status offline";
  }
}

function setStatus(msg) {
  const el = $("captureStatus");
  if (el) el.textContent = msg;
}

function setSyncStatus(msg) {
  const el = $("syncStatus");
  if (el) el.textContent = msg;
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
 * فشرده‌سازی عکس
 ******************************************************************************/

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("خطا در خواندن عکس"));

    reader.onload = (e) => {
      const img = new Image();

      img.onerror = () => reject(new Error("خطا در پردازش عکس"));

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
            if (!blob) {
              reject(new Error("خطا در فشرده‌سازی عکس"));
              return;
            }

            const fr = new FileReader();
            fr.onerror = () => reject(new Error("خطا در تبدیل عکس"));
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
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*******************************************************************************
 * Toast زیبا
 ******************************************************************************/

function showGpsToast(message, duration = 5000, type = "error") {
  const oldToast = document.getElementById("gps-toast");
  if (oldToast) oldToast.remove();

  const toast = document.createElement("div");
  toast.id = "gps-toast";
  toast.textContent = message;

  const colors = {
    info: "rgba(15, 118, 110, 0.96)",
    success: "rgba(22, 163, 74, 0.96)",
    error: "rgba(220, 38, 38, 0.96)",
  };

  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%) scale(0.85)",
    backgroundColor: colors[type] || colors.error,
    color: "#fff",
    padding: "22px 28px",
    borderRadius: "20px",
    fontSize: "20px",
    fontWeight: "bold",
    lineHeight: "1.8",
    textAlign: "center",
    width: "82%",
    maxWidth: "430px",
    zIndex: "99999",
    opacity: "0",
    border: "2px solid rgba(255,255,255,0.9)",
    boxShadow: "0 18px 45px rgba(0,0,0,0.35)",
    transition: "all 0.35s ease",
    direction: "rtl",
    fontFamily: "inherit",
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, -50%) scale(1)";
  }, 50);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translate(-50%, -50%) scale(0.9)";
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 400);
  }, duration);
}
