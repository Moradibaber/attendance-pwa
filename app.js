const CONFIG = {
  appsScriptUrl: "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec",
  retentionDaysForSentRecords: 90,
  geoTimeoutMs: 120000,
  geoMaximumAgeMs: 600000,
  imageMaxWidth: 360,
  imageQuality: 0.45
};

const DB_NAME = "attendance-offline-db";
const DB_VERSION = 1;
const STORE_RECORDS = "records";
const STORE_SETTINGS = "settings";
let db;
let compressedPhotoDataUrl = "";

const $ = (id) => document.getElementById(id);

window.addEventListener("load", async () => {
  db = await openDb();
  await registerServiceWorker();
  await requestPersistentStorage();
  await loadProfile();
  bindEvents();
  updateOnlineBadge();
  await refreshUi();
});

window.addEventListener("online", updateOnlineBadge);
window.addEventListener("offline", updateOnlineBadge);

function bindEvents() {
  $("saveProfileBtn").addEventListener("click", saveProfile);
  $("photoInput").addEventListener("change", handlePhoto);
  $("startBtn").addEventListener("click", () => createRecord("شروع"));
  $("endBtn").addEventListener("click", () => createRecord("پایان"));
  $("syncBtn").addEventListener("click", syncPendingRecords);
  $("backupBtn").addEventListener("click", downloadBackup);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_RECORDS)) {
        const store = database.createObjectStore(STORE_RECORDS, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("duplicateKey", "duplicateKey", { unique: true });
      }
      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode = "readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = tx(storeName, "readwrite").delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (_) {}
  }
}

async function requestPersistentStorage() {
  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persisted();
    if (!persisted) await navigator.storage.persist();
  }
}

function updateOnlineBadge() {
  const badge = $("onlineBadge");
  badge.textContent = navigator.onLine ? "وضعیت: آنلاین" : "وضعیت: آفلاین";
}

async function saveProfile() {
  const profile = getProfile();
  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    alert("لطفاً شماره پرسنلی، نام و نام خانوادگی را کامل کنید.");
    return;
  }
  await dbPut(STORE_SETTINGS, { key: "profile", value: profile });
  alert("مشخصات روی همین گوشی ذخیره شد.");
}

function getProfile() {
  return {
    personnelCode: $("personnelCode").value.trim(),
    firstName: $("firstName").value.trim(),
    lastName: $("lastName").value.trim()
  };
}

async function loadProfile() {
  const row = await dbGet(STORE_SETTINGS, "profile");
  if (!row?.value) return;
  $("personnelCode").value = row.value.personnelCode || "";
  $("firstName").value = row.value.firstName || "";
  $("lastName").value = row.value.lastName || "";
}

async function handlePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  compressedPhotoDataUrl = await compressImage(file);
  $("photoPreview").innerHTML = `<img alt="پیش‌نمایش عکس" src="${compressedPhotoDataUrl}">`;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(reader.error);
    img.onload = () => {
      const scale = Math.min(1, CONFIG.imageMaxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", CONFIG.imageQuality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function createRecord(recordType) {
  const profile = getProfile();
  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    alert("ابتدا مشخصات پرسنلی را کامل و ذخیره کنید.");
    return;
  }
  if (!compressedPhotoDataUrl) {
    alert("لطفاً ابتدا عکس چهره را بگیرید.");
    return;
  }

  $("captureStatus").textContent = "در حال دریافت موقعیت مکانی؛ لطفاً صبر کنید...";
  let position;
  try {
    position = await getLocation();
  } catch (error) {
    const confirmSave = confirm("موقعیت مکانی دریافت نشد. آیا ثبت بدون موقعیت انجام شود؟");
    if (!confirmSave) {
      $("captureStatus").textContent = "ثبت لغو شد.";
      return;
    }
  }

  const now = new Date();
  const recordDate = toLocalDate(now);
  const recordTime = toLocalTime(now);
  const recordHour = now.getHours();
  const duplicateKey = `${profile.personnelCode}-${recordDate}-${recordHour}-${recordType}`;
  const existing = await findByDuplicateKey(duplicateKey);
  if (existing) {
    alert(`برای این تاریخ و ساعت، ثبت «${recordType}» قبلاً انجام شده است.`);
    $("captureStatus").textContent = "ثبت تکراری انجام نشد.";
    return;
  }

  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    duplicateKey,
    personnelCode: profile.personnelCode,
    firstName: profile.firstName,
    lastName: profile.lastName,
    recordType,
    recordDate,
    recordTime,
    recordHour,
    deviceTime: now.toISOString(),
    latitude: position?.coords?.latitude ?? "",
    longitude: position?.coords?.longitude ?? "",
    accuracy: position?.coords?.accuracy ?? "",
    photo: compressedPhotoDataUrl,
    status: "pending",
    note: "",
    createdAt: now.toISOString(),
    sentAt: ""
  };

  try {
    await dbPut(STORE_RECORDS, record);
  } catch (error) {
    alert("ثبت تکراری یا خطای ذخیره‌سازی رخ داد.");
    $("captureStatus").textContent = "ثبت انجام نشد.";
    return;
  }

  compressedPhotoDataUrl = "";
  $("photoInput").value = "";
  $("photoPreview").innerHTML = "";
  $("captureStatus").textContent = "اطلاعات با موفقیت روی گوشی ذخیره شد.";
  await cleanupSentRecords();
  await refreshUi();
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) reject(new Error("Geolocation is not supported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: CONFIG.geoTimeoutMs,
      maximumAge: CONFIG.geoMaximumAgeMs
    });
  });
}

async function findByDuplicateKey(duplicateKey) {
  return new Promise((resolve, reject) => {
    const index = tx(STORE_RECORDS).index("duplicateKey");
    const request = index.get(duplicateKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function syncPendingRecords() {
  if (!CONFIG.appsScriptUrl.startsWith("https://")) {
    alert("ابتدا آدرس Google Apps Script را در فایل app.js وارد کنید.");
    return;
  }
  if (!navigator.onLine) {
    alert("اینترنت وصل نیست. بعداً دوباره ارسال کنید.");
    return;
  }

  const records = await dbGetAll(STORE_RECORDS);
  const pending = records.filter((record) => record.status !== "sent");
  if (!pending.length) {
    $("syncStatus").textContent = "رکورد ارسال‌نشده‌ای وجود ندارد.";
    return;
  }

  let sent = 0;
  for (const record of pending) {
    $("syncStatus").textContent = `در حال ارسال ${sent + 1} از ${pending.length}...`;
    try {
      const response = await fetch(CONFIG.appsScriptUrl, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(record)
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "Upload failed");
      record.status = "sent";
      record.sentAt = new Date().toISOString();
      await dbPut(STORE_RECORDS, record);
      sent += 1;
    } catch (error) {
      record.status = "failed";
      record.note = String(error.message || error);
      await dbPut(STORE_RECORDS, record);
    }
  }

  await cleanupSentRecords();
  await refreshUi();
  $("syncStatus").textContent = `${sent} رکورد با موفقیت ارسال شد. رکوردهای ناموفق باقی می‌مانند.`;
}

async function cleanupSentRecords() {
  const records = await dbGetAll(STORE_RECORDS);
  const cutoff = Date.now() - CONFIG.retentionDaysForSentRecords * 24 * 60 * 60 * 1000;
  for (const record of records) {
    if (record.status === "sent" && record.sentAt && new Date(record.sentAt).getTime() < cutoff) {
      await dbDelete(STORE_RECORDS, record.id);
    }
  }
}

async function downloadBackup() {
  const records = await dbGetAll(STORE_RECORDS);
  const pending = records.filter((record) => record.status !== "sent");
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), records: pending }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `attendance-backup-${toLocalDate(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function refreshUi() {
  const records = await dbGetAll(STORE_RECORDS);
  $("pendingCount").textContent = records.filter((record) => record.status === "pending").length;
  $("sentCount").textContent = records.filter((record) => record.status === "sent").length;
  $("failedCount").textContent = records.filter((record) => record.status === "failed").length;

  const latest = records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
  $("recordsList").innerHTML = latest.length ? latest.map((record) => `
    <div class="record">
      <b>${record.recordType}</b> - ${record.recordDate} ساعت ${record.recordTime}<br>
      ${record.firstName} ${record.lastName} / ${record.personnelCode}<br>
      وضعیت: ${translateStatus(record.status)}
    </div>
  `).join("") : "هنوز ثبتی انجام نشده است.";
}

function translateStatus(status) {
  return { pending: "ارسال‌نشده", sent: "ارسال‌شده", failed: "ارسال ناموفق" }[status] || status;
}

function toLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLocalTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
