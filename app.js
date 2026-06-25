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
let syncTimer = null;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  showGpsToast("📍 حتما جی پی اس خود را روشن کنید", 3000, "error");

  db = await openDb();

  bindEvents();
  await loadProfile();
  await refreshUi();

  setupAutoSync();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(() => {
      registerBackgroundSync();
    }).catch(() => {});
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

    setTimeout(() => {
      toast.remove();
    }, 400);
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
    registerBackgroundSync();
  });

  window.addEventListener("offline", updateOnlineBadge);

  window.addEventListener("focus", () => {
    if (navigator.onLine) {
      scheduleSyncPendingRecords(500);
      registerBackgroundSync();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && navigator.onLine) {
      scheduleSyncPendingRecords(500);
      registerBackgroundSync();
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
        setSynStatus("ارسال خودکار کامل نشد");
      }
    });
  }

  setInterval(() => {
    if (navigator.onLine) {
      scheduleSyncPendingRecords(0);
      registerBackgroundSync();
    }
  }, 60000);

  if (navigator.onLine) {
    scheduleSyncPendingRecords(1000);
    registerBackgroundSync();
  }
}

function scheduleSyncPendingRecords(delay = 0) {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncPendingRecords();
  }, delay);
}

async function registerBackgroundSync() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.ready;

    if ("sync" in registration) {
      await registration.sync.register("attendance-sync");
    }
  } catch {
    // Background Sync may not be available in all browsers.
  }
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
      }

      if (!openedDb.objectStoreNames.contains(STORE_PROFILE)) {
        openedDb.createObjectStore(STORE_PROFILE, {
          keyPath: "id"
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = 
