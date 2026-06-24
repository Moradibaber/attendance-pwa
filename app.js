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
    setStatus("ورودی عکس پیدا نشد.");
    return;
  }

  photoInput.value = "";
  setStatus("دوربین باز می‌شود. لطفاً عکس بگیرید.");
  photoInput.click();
}

async function handlePhotoSelected() {
  const file = $("photoInput")?.files?.[0];
  if (!file) return;

  try {
    await saveProfileSilent();
    setStatus("در حال آماده‌سازی عکس...");
    currentPhoto = await compressImage(file);

    if ($("photoPreview")) {
      $("photoPreview").src = currentPhoto;
      $("photoPreview").style.display = "block";
    }

    if (!isGeolocationUsable()) {
      setStatus("GPS در دسترس نیست. مطمئن شوید سایت با HTTPS باز شده و Location روشن است.");
      return;
    }

    setStatus("در حال دریافت مکان...");
    pendingLocation = await getLocationIOSFriendly();

    if (!hasValidLocation(pendingLocation)) {
      if (pendingLocation?.status === "denied") {
        // تغییر اینجا انجام شد:
        alert("دسترسی به GPS مسدود شده است! \nبرای ثبت تردد، باید به تنظیمات مرورگر (آیکون قفل کنار آدرس سایت) بروید، بخش Permissions یا Location را پیدا کرده و اجازه دسترسی (Allow) را فعال کنید.");
        setStatus("دسترسی GPS رد شده است. لطفاً در تنظیمات مرورگر دسترسی را به سایت بدهید.");
        return;
      }

      if (pendingLocation?.status === "unavailable") {
        setStatus("موقعیت مکانی در دسترس نیست. GPS گوشی را چک کنید.");
        return;
      }

      if (pendingLocation?.status === "timeout") {
        setStatus("خطای زمان انتظار GPS. لطفا در فضای بازتر تلاش کنید.");
        return;
      }

      setStatus("GPS دریافت نشد. دسترسی‌ها را بررسی کنید.");
      return;
    }

    await createRecord("تردد");
  } catch (err) {
    console.error(err);
    setStatus("خطا در ثبت تردد");
  }
}

// ... باقی کدهای شما دست نخورده باقی می‌ماند ...
// (برای جلوگیری از طولانی شدن بیش از حد پاسخ، سایر توابع را که تغییر نکردند حفظ کنید)
