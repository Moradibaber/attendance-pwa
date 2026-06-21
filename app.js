const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

let db = null;
let currentPhoto = "";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDb();

  bindEvents();
  await loadProfile();
  await refreshUi();

  updateOnlineBadge();

  if (navigator.onLine) {
    await syncPendingRecords();
  }

  window.addEventListener("online", async () => {
    updateOnlineBadge();
    await syncPendingRecords();
  });

  window.addEventListener("offline", updateOnlineBadge);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});

function bindEvents() {
  if ($("saveProfileBtn")) {
    $("saveProfileBtn").addEventListener("click", saveProfile);
  }

  if ($("recordBtn")) {
    $("recordBtn").addEventListener("click", () => {
      if (!$("photoInput")) {
        setStatus("خطا: ورودی دوربین در صفحه پیدا نشد.");
        return;
      }

      $("photoInput").value = "";
      $("photoInput").click();
    });
  }

  if ($("photoInput")) {
    $("photoInput").addEventListener("change", async () => {
      const file = $("photoInput").files && $("photoInput").files[0];

      if (!file) {
        setStatus("عکسی انتخاب نشد.");
        return;
      }

      try {
        setStatus("در حال آماده‌سازی عکس...");
        currentPhoto = await compressImage(file);

        if ($("photoPreview")) {
          $("photoPreview").src = currentPhoto;
          $("photoPreview").style.display = "block";
        }

        await createRecord("تردد");
      } catch (error) {
        setStatus("خطا در آماده‌سازی عکس: " + error.message);
      }
    });
  }

  if ($("syncBtn")) {
    $("syncBtn").addEventListener("click", syncPendingRecords);
  }

  if ($("backupBtn")) {
    $("backupBtn").addEventListener("click", downloadBackup);
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains(STORE_RECORDS)) {
        const recordsStore = database.createObjectStore(STORE_RECORDS, {
          keyPath: "id",
          autoIncrement: true
        });

        recordsStore.createIndex("status", "status", { unique: false });
      } else {
        const transaction = event.target.transaction;
        const recordsStore = transaction.objectStore(STORE_RECORDS);

        if (!recordsStore.indexNames.contains("status")) {
          recordsStore.createIndex("status", "status", { unique: false });
        }

        if (recordsStore.indexNames.contains("duplicateKey")) {
          recordsStore.deleteIndex("duplicateKey");
        }
      }

      if (!database.objectStoreNames.contains(STORE_PROFILE)) {
        database.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.put(value);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function saveProfile() {
  const profile = {
    id: "main",
    personnelCode: ($("personnelCode")?.value || "").trim(),
    firstName: ($("firstName")?.value || "").trim(),
    lastName: ($("lastName")?.value || "").trim()
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    setStatus("لطفاً نام، نام خانوادگی و شماره پرسنلی را کامل وارد کنید.");
    return;
  }

  await dbPut(STORE_PROFILE, profile);
  setStatus("مشخصات با موفقیت ذخیره شد.");
}

async function loadProfile() {
  const profile = await dbGet(STORE_PROFILE, "main");

  if (!profile) return;

  if ($("personnelCode")) $("personnelCode").value = profile.personnelCode || "";
  if ($("firstName")) $("firstName").value = profile.firstName || "";
  if ($("lastName")) $("lastName").value = profile.lastName || "";
}

async function getProfile() {
  const savedProfile = await dbGet(STORE_PROFILE, "main");

  const profile = {
    personnelCode: ($("personnelCode")?.value || savedProfile?.personnelCode || "").trim(),
    firstName: ($("firstName")?.value || savedProfile?.firstName || "").trim(),
    lastName: ($("lastName")?.value || savedProfile?.lastName || "").trim()
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    throw new Error("لطفاً ابتدا مشخصات پرسنلی را کامل وارد و ذخیره کنید.");
  }

  await dbPut(STORE_PROFILE, { id: "main", ...profile });

  return profile;
}

async function createRecord(type) {
  try {
    setStatus("در حال دریافت موقعیت مکانی...");

    const profile = await getProfile();
    const location = await getLocation();

    const now = new Date();
    const record = {
      personnelCode: profile.personnelCode,
      firstName: profile.firstName,
      lastName: profile.lastName,
      type: type,
      recordDate: getPersianDate(now),
      recordTime: getTime(now),
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      deviceTime: now.toISOString(),
      photo: currentPhoto || "",
      status: "pending",
      createdAt: now.toISOString()
    };

    await dbPut(STORE_RECORDS, record);

    currentPhoto = "";

    setStatus("ثبت تردد با موفقیت ذخیره شد.");

    await refreshUi();

    if (navigator.onLine) {
      await syncPendingRecords();
    }
  } catch (error) {
    setStatus(error.message || "خطا در ثبت تردد.");
  }
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({
        latitude: "",
        longitude: "",
        accuracy: ""
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        });
      },
      () => {
        resolve({
          latitude: "",
          longitude: "",
          accuracy: ""
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  });
}

async function syncPendingRecords() {
  if (!navigator.onLine) {
    setSyncStatus("اینترنت قطع است. اطلاعات ذخیره می‌ماند.");
    return;
  }

  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("PASTE_YOUR")) {
    setSyncStatus("لینک Google Apps Script در app.js تنظیم نشده است.");
    return;
  }

  const records = await dbGetAll(STORE_RECORDS);
  const unsentRecords = records.filter((record) => record.status === "pending" || record.status === "failed");

  if (unsentRecords.length === 0) {
    setSyncStatus("اطلاعات ارسال‌نشده‌ای وجود ندارد.");
    await refreshUi();
    return;
  }

  setSyncStatus("در حال ارسال اطلاعات ذخیره‌شده...");

  for (const record of unsentRecords) {
    try {
      const payload = {
        personnelCode: record.personnelCode || "",
        firstName: record.firstName || "",
        lastName: record.lastName || "",
        type: record.type || "تردد",
        recordDate: record.recordDate || "",
        recordTime: record.recordTime || "",
        latitude: record.latitude || "",
        longitude: record.longitude || "",
        accuracy: record.accuracy || "",
        deviceTime: record.deviceTime || "",
        photo: record.photo || "",
        status: "sent",
        createdAt: record.createdAt || ""
      };

      const response = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (result && result.ok) {
        record.status = "sent";
        record.sentAt = new Date().toISOString();
        await dbPut(STORE_RECORDS, record);

        if (result.message) {
          showAdminMessage(result.message);
        }
      } else {
        record.status = "failed";
        record.error = result && result.error ? result.error : "خطا در پاسخ سرور";
        await dbPut(STORE_RECORDS, record);
      }
    } catch (error) {
      record.status = "failed";
      record.error = error.message || String(error);
      await dbPut(STORE_RECORDS, record);
    }
  }

  setSyncStatus("ارسال اطلاعات انجام شد.");
  await refreshUi();
}

async function refreshUi() {
  const records = await dbGetAll(STORE_RECORDS);

  const pendingCount = records.filter((record) => record.status === "pending").length;
  const sentCount = records.filter((record) => record.status === "sent").length;
  const failedCount = records.filter((record) => record.status === "failed").length;

  if ($("pendingCount")) $("pendingCount").textContent = pendingCount;
  if ($("sentCount")) $("sentCount").textContent = sentCount;
  if ($("failedCount")) $("failedCount").textContent = failedCount;

  renderRecords(records);
}

function renderRecords(records) {
  if (!$("recordsList")) return;

  if (!records.length) {
    $("recordsList").innerHTML = "<p>هنوز ترددی ثبت نشده است.</p>";
    return;
  }

  const sortedRecords = [...records].sort((a, b) => {
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  $("recordsList").innerHTML = sortedRecords
    .slice(0, 30)
    .map((record) => {
      const statusText =
        record.status === "sent"
          ? "ارسال شده"
          : record.status === "failed"
            ? "ارسال ناموفق"
            : "در انتظار ارسال";

      return `
        <div class="record-item">
          <strong>${escapeHtml(record.firstName || "")} ${escapeHtml(record.lastName || "")}</strong>
          <div>شماره پرسنلی: ${escapeHtml(record.personnelCode || "")}</div>
          <div>تاریخ: ${escapeHtml(record.recordDate || "")}</div>
          <div>ساعت: ${escapeHtml(record.recordTime || "")}</div>
          <div>وضعیت: ${statusText}</div>
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

function setStatus(message) {
  if ($("captureStatus")) {
    $("captureStatus").textContent = message;
  }
}

function setSyncStatus(message) {
  if ($("syncStatus")) {
    $("syncStatus").textContent = message;
  } else {
    setStatus(message);
  }
}

function showAdminMessage(message) {
  const finalMessage = "پیام مدیر: " + message;

  if ($("syncStatus")) {
    $("syncStatus").textContent = finalMessage;
  } else {
    setStatus(finalMessage);
  }

  alert(finalMessage);
}

function getPersianDate(date) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getTime(date) {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const image = new Image();

      image.onload = () => {
        const canvas = document.createElement("canvas");

        const maxWidth = 900;
        const maxHeight = 900;

        let width = image.width;
        let height = image.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);

        const compressed = canvas.toDataURL("image/jpeg", 0.65);
        resolve(compressed);
      };

      image.onerror = () => reject(new Error("عکس قابل خواندن نیست."));
      image.src = reader.result;
    };

    reader.onerror = () => reject(new Error("خطا در خواندن عکس."));
    reader.readAsDataURL(file);
  });
}

async function downloadBackup() {
  const records = await dbGetAll(STORE_RECORDS);

  const blob = new Blob([JSON.stringify(records, null, 2)], {
    type: "application/json;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "attendance-backup.json";
  link.click();

  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
