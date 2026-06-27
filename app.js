<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#0f172a" />
  <title>Attendance PWA</title>

  <style>
    :root{
      --bg:#0b1220;
      --card:#111a2e;
      --card2:#0f172a;
      --text:#e5e7eb;
      --muted:#94a3b8;
      --primary:#38bdf8;
      --success:#22c55e;
      --warning:#f59e0b;
      --danger:#ef4444;
      --border:rgba(148,163,184,.18);
      --shadow:0 10px 30px rgba(0,0,0,.25);
      --radius:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:Tahoma, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background:linear-gradient(180deg, #08101d, #0b1220 45%, #0f172a);
      color:var(--text);
    }
    .app{
      max-width:980px;
      margin:0 auto;
      padding:16px;
    }
    .topbar, .card{
      background:rgba(17,26,46,.84);
      backdrop-filter: blur(10px);
      border:1px solid var(--border);
      box-shadow:var(--shadow);
      border-radius:var(--radius);
    }
    .topbar{
      padding:16px;
      margin-bottom:16px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .title{
      font-size:1.1rem;
      font-weight:700;
      margin:0;
    }
    .badge{
      padding:6px 10px;
      border-radius:999px;
      font-size:.85rem;
      border:1px solid var(--border);
      color:var(--text);
      background:rgba(255,255,255,.04);
    }
    .badge.online{ background:rgba(34,197,94,.15); color:#bbf7d0; border-color:rgba(34,197,94,.3); }
    .badge.offline{ background:rgba(239,68,68,.15); color:#fecaca; border-color:rgba(239,68,68,.3); }
    .grid{
      display:grid;
      grid-template-columns: 1fr;
      gap:16px;
    }
    @media(min-width:900px){
      .grid.two{ grid-template-columns: 1fr 1fr; }
    }
    .card{
      padding:16px;
    }
    .card h2{
      margin:0 0 14px;
      font-size:1rem;
    }
    label{
      display:block;
      margin:10px 0 6px;
      color:var(--muted);
      font-size:.92rem;
    }
    input, select, button, textarea{
      width:100%;
      border-radius:14px;
      border:1px solid var(--border);
      background:rgba(255,255,255,.03);
      color:var(--text);
      padding:12px 14px;
      font:inherit;
      outline:none;
    }
    input::placeholder{ color:#64748b; }
    button{
      cursor:pointer;
      font-weight:700;
    }
    .btn-primary{ background:linear-gradient(135deg, #0284c7, #38bdf8); color:#fff; border:none; }
    .btn-success{ background:linear-gradient(135deg, #16a34a, #22c55e); color:#fff; border:none; }
    .btn-danger{ background:linear-gradient(135deg, #dc2626, #ef4444); color:#fff; border:none; }
    .btn-ghost{ background:rgba(255,255,255,.04); }
    .row{ display:grid; grid-template-columns:1fr; gap:12px; }
    @media(min-width:700px){ .row.cols2{ grid-template-columns:1fr 1fr; } .row.cols3{ grid-template-columns:1fr 1fr 1fr; } }
    .actions{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px; }
    .muted{ color:var(--muted); font-size:.9rem; }
    .toast{
      position:fixed;
      bottom:18px;
      left:18px;
      right:18px;
      max-width:720px;
      margin:0 auto;
      padding:14px 16px;
      border-radius:14px;
      background:#0b1220;
      border:1px solid var(--border);
      box-shadow:var(--shadow);
      z-index:9999;
      display:none;
    }
    .toast.show{ display:block; }
    .list{
      display:flex;
      flex-direction:column;
      gap:10px;
      margin-top:12px;
    }
    .item{
      padding:12px;
      border:1px solid var(--border);
      border-radius:14px;
      background:rgba(255,255,255,.03);
    }
    .item-head{
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:center;
      margin-bottom:8px;
    }
    .pill{
      font-size:.78rem;
      padding:4px 8px;
      border-radius:999px;
      border:1px solid var(--border);
      color:var(--muted);
    }
    .pill.pending{ color:#fde68a; border-color:rgba(245,158,11,.35); background:rgba(245,158,11,.08); }
    .pill.synced{ color:#bbf7d0; border-color:rgba(34,197,94,.35); background:rgba(34,197,94,.08); }
    .pill.failed{ color:#fecaca; border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); }
    .small{ font-size:.82rem; color:var(--muted); line-height:1.8; }
    video, img.preview{
      width:100%;
      border-radius:16px;
      background:#020617;
      border:1px solid var(--border);
      display:block;
      max-height:320px;
      object-fit:cover;
    }
    .hidden{ display:none !important; }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <h1 class="title">سیستم ثبت تردد</h1>
      <div id="onlineBadge" class="badge offline">آفلاین</div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>اطلاعات پرسنل</h2>

        <div class="row cols2">
          <div>
            <label for="personnelCode">کد پرسنلی</label>
            <input id="personnelCode" type="text" placeholder="مثلاً 1234" />
          </div>
          <div>
            <label for="recordType">نوع ثبت</label>
            <select id="recordType">
              <option value="IN">ورود</option>
              <option value="OUT">خروج</option>
            </select>
          </div>
        </div>

        <div class="row cols2">
          <div>
            <label for="firstName">نام</label>
            <input id="firstName" type="text" placeholder="نام" />
          </div>
          <div>
            <label for="lastName">نام خانوادگی</label>
            <input id="lastName" type="text" placeholder="نام خانوادگی" />
          </div>
        </div>

        <div class="actions">
          <button id="btnSaveProfile" class="btn-ghost">ذخیره پروفایل</button>
          <button id="btnCapture" class="btn-primary">ثبت تردد</button>
        </div>

        <p id="statusText" class="small">آماده</p>
        <p id="syncStatusText" class="small">همگام‌سازی: آماده</p>
      </div>

      <div class="card">
        <h2>عکس و GPS</h2>

        <video id="cameraPreview" autoplay playsinline muted class="hidden"></video>
        <img id="photoPreview" class="preview hidden" alt="preview" />

        <div class="row cols2" style="margin-top:12px;">
          <div>
            <label for="photoInput">انتخاب عکس</label>
            <input id="photoInput" type="file" accept="image/*" capture="environment" />
          </div>
          <div>
            <label for="gpsInfo">وضعیت GPS</label>
            <input id="gpsInfo" type="text" disabled value="در انتظار..." />
          </div>
        </div>

        <div class="row cols3">
          <div>
            <label for="latitude">Latitude</label>
            <input id="latitude" type="text" disabled />
          </div>
          <div>
            <label for="longitude">Longitude</label>
            <input id="longitude" type="text" disabled />
          </div>
          <div>
            <label for="accuracy">Accuracy</label>
            <input id="accuracy" type="text" disabled />
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h2>رکوردها</h2>
      <div id="recordsList" class="list"></div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

<script>
(() => {
  "use strict";

  const DB_NAME = "attendance-pwa-db";
  const DB_VERSION = 2;
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";
  const GPS_REQUIRED = true;
  const GPS_WAIT_MS = 15000;
  const GPS_RETRY_MS = 3000;
  const GOOD_ACCURACY_METERS = 50;
  const CLOCK_RISK_MAX_MS = 10 * 60 * 1000;

  let db = null;
  let currentPhotoBase64 = "";
  let currentLocation = null;
  let syncTimer = null;

  const el = (id) => document.getElementById(id);

  function setStatus(msg) { el("statusText").textContent = msg; }
  function setSyncStatus(msg) { el("syncStatusText").textContent = msg; }
  function showToast(msg, ms=3500) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove("show"), ms);
  }
  function updateOnlineBadge() {
    const b = el("onlineBadge");
    const online = navigator.onLine;
    b.textContent = online ? "آنلاین" : "آفلاین";
    b.classList.toggle("online", online);
    b.classList.toggle("offline", !online);
  }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function nowIso(){ return new Date().toISOString(); }
  function formatDateParts(d = new Date()) {
    return {
      date: `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`,
      hour: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
      time: d.toISOString()
    };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const dbx = req.result;
        if (!dbx.objectStoreNames.contains("records")) dbx.createObjectStore("records", { keyPath: "clientRecordId" });
        if (!dbx.objectStoreNames.contains("profile")) dbx.createObjectStore("profile", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode="readonly") {
    return db.transaction(store, mode).objectStore(store);
  }
  function dbPut(store, value) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const req = tx(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const req = tx(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveProfileSilent(profile) {
    await dbPut("profile", { id: "main", ...profile, updatedAt: nowIso() });
  }
  async function saveProfile() {
    const profile = {
      personnelCode: el("personnelCode").value.trim(),
      firstName: el("firstName").value.trim(),
      lastName: el("lastName").value.trim(),
      recordTypeDefault: el("recordType").value
    };
    await saveProfileSilent(profile);
    showToast("پروفایل ذخیره شد");
  }
  async function loadProfile() {
    const p = await dbGet("profile", "main");
    if (!p) return;
    el("personnelCode").value = p.personnelCode || "";
    el("firstName").value = p.firstName || "";
    el("lastName").value = p.lastName || "";
    if (p.recordTypeDefault) el("recordType").value = p.recordTypeDefault;
  }

  async function getSessionClockDriftMs() { return 0; }
  async function getNetworkTimeDriftMs() { return 0; }

  function calculateClockRisk({ sessionClockDriftMs=0, networkClockDriftMs=0, locationStatus="", offlineCreated=false, gpsTrueTimeDiffMs=0 }) {
    let score = 0;
    const reasons = [];

    const absSession = Math.abs(Number(sessionClockDriftMs) || 0);
    const absNetwork = Math.abs(Number(networkClockDriftMs) || 0);
    const absGpsDiff = Math.abs(Number(gpsTrueTimeDiffMs) || 0);

    if (absSession > 30 * 1000) { score += 20; reasons.push("session drift"); }
    if (absNetwork > 30 * 1000) { score += 20; reasons.push("network drift"); }
    if (absGpsDiff > 30 * 1000) { score += 15; reasons.push("gps diff"); }
    if (locationStatus !== "ok") { score += 10; reasons.push("gps status"); }
    if (offlineCreated) { score += 10; reasons.push("offline"); }

    return {
      clockRisk: score >= 40 ? "HIGH" : score >= 20 ? "MEDIUM" : "LOW",
      clockRiskReason: reasons.join(", "),
      clockRiskScore: score
    };
  }

  function isGeolocationUsable() {
    return !!navigator.geolocation;
  }

  function getLocationIOSFriendly() {
    return new Promise((resolve, reject) => {
      if (!isGeolocationUsable()) return reject(new Error("Geolocation not supported"));
      const start = Date.now();
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("GPS timeout"));
      }, GPS_WAIT_MS);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            gpsTimestamp: pos.timestamp,
            locationStatus: pos.coords.accuracy <= GOOD_ACCURACY_METERS ? "ok" : "poor",
            locationError: ""
          });
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        },
        { enableHighAccuracy: true, timeout: GPS_WAIT_MS, maximumAge: 0 }
      );
    });
  }

  function handlePhotoSelected(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        currentPhotoBase64 = reader.result;
        const img = el("photoPreview");
        img.src = currentPhotoBase64;
        img.classList.remove("hidden");
        resolve(currentPhotoBase64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function createRecord() {
    const personnelCode = el("personnelCode").value.trim();
    const firstName = el("firstName").value.trim();
    const lastName = el("lastName").value.trim();
    const recordType = el("recordType").value;

    if (!personnelCode) throw new Error("کد پرسنلی را وارد کنید");
    if (!firstName) throw new Error("نام را وارد کنید");
    if (!lastName) throw new Error("نام خانوادگی را وارد کنید");
    if (!currentPhotoBase64) throw new Error("عکس را انتخاب کنید");
    if (GPS_REQUIRED && !currentLocation) throw new Error("GPS دریافت نشده است");

    const deviceNow = new Date();
    const parts = formatDateParts(deviceNow);
    const sessionClockDriftMs = await getSessionClockDriftMs();
    const networkClockDriftMs = await getNetworkTimeDriftMs();
    const offlineCreated = !navigator.onLine;

    const clock = calculateClockRisk({
      sessionClockDriftMs,
      networkClockDriftMs,
      locationStatus: currentLocation?.locationStatus || "",
      offlineCreated,
      gpsTrueTimeDiffMs: 0
    });

    return {
      clientRecordId: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      personnelCode,
      firstName,
      lastName,
      type: recordType,
      recordType,
      recordDate: parts.date,
      recordHour: parts.hour,
      recordTime: parts.time,

      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      accuracy: currentLocation.accuracy,
      locationStatus: currentLocation.locationStatus,
      locationError: currentLocation.locationError || "",

      deviceTime: nowIso(),
      deviceTimeAtClick: nowIso(),
      deviceTimeAtPhoto: nowIso(),
      deviceTimeAtPhotoCompressed: nowIso(),
      deviceTimeAtGps: new Date(currentLocation.gpsTimestamp || Date.now()).toISOString(),
      gpsTimestamp: currentLocation.gpsTimestamp || Date.now(),

      gpsWaitMs: GPS_WAIT_MS,
      photoDelayMs: 0,
      submitDelayMs: 0,
      offlineCreated,
      clockRisk: clock.clockRisk,
      clockRiskReason: clock.clockRiskReason,
      sessionClockDriftMs,
      networkClockDriftMs,

      photo: currentPhotoBase64,
      status: "pending",
      createdAt: nowIso(),
      lastSyncTryAt: "",
      syncTryCount: 0,
      syncedAt: "",
      serverResponse: null,

      gpsTrueTimeDiffMs: 0
    };
  }

  async function saveRecord(record) {
    await dbPut("records", record);
    await renderRecords();
  }

  function buildServerPayload(record) {
    return {
      clientRecordId: record.clientRecordId,
      personnelCode: record.personnelCode,
      firstName: record.firstName,
      lastName: record.lastName,
      type: record.type,
      recordType: record.recordType,
      recordDate: record.recordDate,
      recordHour: record.recordHour,
      recordTime: record.recordTime,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracy: record.accuracy,
      locationStatus: record.locationStatus,
      locationError: record.locationError,
      deviceTime: record.deviceTime,
      deviceTimeAtClick: record.deviceTimeAtClick,
      deviceTimeAtGps: record.deviceTimeAtGps,
      gpsTimestamp: record.gpsTimestamp,
      gpsWaitMs: record.gpsWaitMs,
      offlineCreated: record.offlineCreated,
      clockRisk: record.clockRisk,
      clockRiskReason: record.clockRiskReason,
      sessionClockDriftMs: record.sessionClockDriftMs,
      networkClockDriftMs: record.networkClockDriftMs,
      gpsTrueTimeDiffMs: record.gpsTrueTimeDiffMs,
      photo: record.photo,
      createdAt: record.createdAt
    };
  }

  async function syncPendingRecords() {
    if (!navigator.onLine) {
      setSyncStatus("همگام‌سازی: آفلاین");
      return;
    }
    const records = await dbGetAll("records");
    const pending = records.filter(r => r.status === "pending" || r.status === "failed");
    if (!pending.length) {
      setSyncStatus("همگام‌سازی: هیچ رکوردی برای ارسال نیست");
      return;
    }

    for (const record of pending) {
      try {
        record.lastSyncTryAt = nowIso();
        record.syncTryCount = (record.syncTryCount || 0) + 1;
        await dbPut("records", record);

        const payload = buildServerPayload(record);
        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}

        if (!res.ok || (json && json.success === false)) {
          record.status = "failed";
          record.serverResponse = text;
          await dbPut("records", record);
          continue;
        }

        record.status = "synced";
        record.syncedAt = nowIso();
        record.serverResponse = text;
        await dbPut("records", record);
      } catch (err) {
        record.status = "failed";
        record.serverResponse = String(err?.message || err);
        await dbPut("records", record);
      }
    }

    await renderRecords();
    setSyncStatus("همگام‌سازی: انجام شد");
  }

  async function scheduleSyncPendingRecords() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncPendingRecords, 1500);
  }

  async function setupAutoSync() {
    window.addEventListener("online", () => {
      updateOnlineBadge();
      setSyncStatus("به شبکه متصل شد");
      scheduleSyncPendingRecords();
    });
    window.addEventListener("offline", () => {
      updateOnlineBadge();
      setSyncStatus("آفلاین");
    });

    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
    }

    setInterval(() => {
      if (navigator.onLine) syncPendingRecords();
    }, 2 * 60 * 1000);
  }

  async function renderRecords() {
    const list = el("recordsList");
    const records = (await dbGetAll("records")).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!records.length) {
      list.innerHTML = `<div class="muted">رکوردی ثبت نشده است</div>`;
      return;
    }

    list.innerHTML = records.map(r => `
      <div class="item">
        <div class="item-head">
          <strong>${escapeHtml(r.firstName || "")} ${escapeHtml(r.lastName || "")}</strong>
          <span class="pill ${r.status || "pending"}">${escapeHtml(r.status || "pending")}</span>
        </div>
        <div class="small">
          کد: ${escapeHtml(r.personnelCode || "")}<br/>
          نوع: ${escapeHtml(r.recordType || "")}<br/>
          زمان: ${escapeHtml(r.recordDate || "")} ${escapeHtml(r.recordHour || "")}<br/>
          GPS: ${escapeHtml(r.latitude ?? "")}, ${escapeHtml(r.longitude ?? "")} / ${escapeHtml(r.accuracy ?? "")}m<br/>
          ریسک: ${escapeHtml(r.clockRisk || "")} - ${escapeHtml(r.clockRiskReason || "")}
        </div>
      </div>
    `).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
  }

  async function startAttendanceCapture() {
    try {
      setStatus("در حال دریافت GPS...");
      if (GPS_REQUIRED) {
        currentLocation = await getLocationIOSFriendly();
        el("gpsInfo").value = `${currentLocation.locationStatus} (${currentLocation.accuracy.toFixed(1)}m)`;
        el("latitude").value = currentLocation.latitude;
        el("longitude").value = currentLocation.longitude;
        el("accuracy").value = currentLocation.accuracy;
      }

      setStatus("در حال ایجاد رکورد...");
      const record = await createRecord();
      await saveRecord(record);
      setStatus("ثبت شد");
      showToast("تردد با موفقیت ثبت شد");

      currentPhotoBase64 = "";
      currentLocation = null;
      el("photoPreview").classList.add("hidden");
      el("photoPreview").src = "";
      el("photoInput").value = "";
      el("gpsInfo").value = "در انتظار...";
      el("latitude").value = "";
      el("longitude").value = "";
      el("accuracy").value = "";

      await scheduleSyncPendingRecords();
    } catch (err) {
      setStatus("خطا در ثبت");
      showToast(err.message || String(err), 5000);
    }
  }

  function bindEvents() {
    el("btnSaveProfile").addEventListener("click", saveProfile);
    el("btnCapture").addEventListener("click", startAttendanceCapture);
    el("photoInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handlePhotoSelected(file);
      showToast("عکس بارگذاری شد");
    });
  }

  async function init() {
    updateOnlineBadge();
    showToast("GPS و اینترنت را بررسی کنید", 2500);
    db = await openDb();
    bindEvents();
    await loadProfile();
    await renderRecords();
    await setupAutoSync();
    if (navigator.onLine) scheduleSyncPendingRecords();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
</script>
</body>
</html>
