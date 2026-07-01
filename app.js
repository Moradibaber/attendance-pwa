/**
 * Google Apps Script - Attendance Admin Panel
 * FIXED FULL FILE
 * - Syntax cleaned
 * - jsonResponse fixed
 * - doPost fixed
 * - duplicate/stray code removed
 */

const RECORDS_SHEET_NAME = "Records";
const MESSAGES_SHEET_NAME = "Messages";
const RECORD_INDEX_SHEET_NAME = "RecordIndex";
const MATCHING_SHEET_NAME = "Matching";
const USERS_SHEET_NAME = "Users";
const PHOTO_FOLDER_PROPERTY_KEY = "ATTENDANCE_PHOTO_FOLDER_ID";

const POLICY_ONLINE_ONLY = "ONLINE_ONLY";
const POLICY_OFFLINE_ONLY = "OFFLINE_ONLY";
const POLICY_ONLINE_PREFERRED = "ONLINE_PREFERRED";
const POLICY_ONLINE_OR_OFFLINE = "ONLINE_OR_OFFLINE";
const POLICY_OFFLINE_ALLOWED_IMMEDIATE = "OFFLINE_ALLOWED_IMMEDIATE";
const DEFAULT_ATTENDANCE_POLICY = POLICY_ONLINE_OR_OFFLINE;
const POLICY_NOT_ALLOWED = "NOT_ALLOWED";

const USERS_HEADERS = [
  "PersonnelCode",
  "FirstName",
  "LastName",
  "AttendancePolicy",
  "PolicyVersion",
  "UpdatedAt",
  "MinLatitude",
  "MaxLatitude",
  "MinLongitude",
  "MaxLongitude"
];

const RECORD_HEADERS = [
  "Timestamp",
  "PersonnelCode",
  "FirstName",
  "LastName",
  "RecordDate",
  "RecordHour",
  "Latitude",
  "Longitude",
  "Accuracy",
  "DeviceTime",
  "OfflineCreated",
  "ClockRisk",
  "Photo",
  "GeoFenceStatus"
];

const RECORD_INDEX_HEADERS = [
  "Signature",
  "PersonnelCode",
  "ServerTimestamp",
  "OfflineCreated",
  "RecordDate",
  "RecordHour",
  "RecordTime",
  "CreatedAt",
  "DeviceTime",
  "DeviceTimeAtClick",
  "DeviceTimeAtGps",
  "GpsTimestamp",
  "Latitude",
  "Longitude",
  "Accuracy",
  "SessionClockDriftMs",
  "NetworkClockDriftMs",
  "GpsTrueTimeDiffMs",
  "AttendancePolicy",
  "PolicyVersion",
  "PolicyFetchedAt",
  "PhotoUrl",
  "SheetRow"
];

const MATCHING_HEADERS = [
  "RecordRow",
  "ServerTimestamp",
  "PersonnelCode",
  "OfflineCreated",
  "CreatedAt",
  "FirstInternetAt",
  "FirstOfflineAt",
  "InternetAfterOfflineAt",
  "SequenceMatch",
  "ReconnectAfterOffline",
  "ClockRisk",
  "ClockRiskReason",
  "Photo"
];

const CLOCK_DRIFT_SESSION_LIMIT_MS = 60 * 1000;
const GPS_TRUE_DIFF_LIMIT_MS = 2 * 60 * 1000;
const NETWORK_DRIFT_LIMIT_MS = 2 * 60 * 1000;
const OFFLINE_UPLOAD_GRACE_MS = 15 * 60 * 1000;

/* =========================
   doGet
========================= */

function doGet(e) {
  if (e && e.parameter) {
    if (e.parameter.action === "getUserPolicy") {
      return handleGetUserPolicy_(e);
    }
    if (e.parameter.action === "getMessages") {
      return jsonResponse({
        ok: true,
        messages: getMessagesForPersonnel_(e.parameter.personnelCode)
      });
    }
  }

  return HtmlService.createTemplateFromFile("AdminPanel")
    .evaluate()
    .setTitle("پنل مدیریت تردد")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/* =========================
   doPost
========================= */
/* =============================================
   Google Apps Script - Server Side (CORS-SAFE)
   Target: Receive data from PWA (text/plain)
   ============================================= */

/* =============================================
   اصلاح تابع doPost برای پردازش JSON خام
   ============================================= */

/* =============================================
   Google Apps Script - Final Production Version
   ============================================= */
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = parseBody(e);

  if (!data) {
    return jsonOut({
      ok: false,
      error: "Invalid JSON payload"
    });
  }

  try {
    logDebug(ss, data);

    if (String(data.type || "").trim() === "ConnectionStatus") {
      return handleStatusSummary(ss, data);
    }

    return handleAttendance(ss, data);
  } catch (err) {
    logError(ss, data, err);
    return jsonOut({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
}

function handleAttendance(ss, data) {
  var sh = ss.getSheetByName("Records");
  if (!sh) {
    sh = ss.insertSheet("Records");
  }

  ensureRecordHeaders(sh);

  var now = new Date();
  var personnelCode = s(data.personnelCode);
  var firstName = s(data.firstName);
  var lastName = s(data.lastName);
  var recordDate = s(data.recordDate);
  var recordHour = s(data.recordHour);
  var latitude = n(data.latitude);
  var longitude = n(data.longitude);
  var accuracy = n(data.accuracy);
  var deviceTime = s(data.deviceTime);
  var offlineCreated = data.isOffline ? "آفلاین" : "آنلاین";
  var clockRisk = s(data.clockRisk || "low");
  var geoFenceStatus = s(data.geoFenceStatus || "ok");

  var photoUrl = "";
  if (data.photoUrl) {
    photoUrl = s(data.photoUrl).trim();
  } else if (data.photo) {
    var rawPhoto = s(data.photo).trim();
    if (rawPhoto.indexOf("data:image") === 0) {
      photoUrl = uploadBase64Image(rawPhoto, personnelCode);
    } else if (/^https?:\/\//i.test(rawPhoto)) {
      photoUrl = rawPhoto;
    }
  }

  sh.appendRow([
    now,
    personnelCode,
    firstName,
    lastName,
    recordDate,
    recordHour,
    latitude,
    longitude,
    accuracy,
    deviceTime,
    offlineCreated,
    clockRisk,
    "",
    geoFenceStatus
  ]);

  var rowIndex = sh.getLastRow();

  sh.getRange(rowIndex, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sh.getRange(rowIndex, 5).setNumberFormat("@");
  sh.getRange(rowIndex, 6).setNumberFormat("@");
  sh.getRange(rowIndex, 10).setNumberFormat("@");
  sh.getRange(rowIndex, 11).setNumberFormat("@");
  sh.getRange(rowIndex, 12).setNumberFormat("@");
  sh.getRange(rowIndex, 14).setNumberFormat("@");

  if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
    sh.getRange(rowIndex, 13).setFormula('=HYPERLINK("' + photoUrl.replace(/"/g, '""') + '","عکس")');
  } else {
    sh.getRange(rowIndex, 13).setValue("بدون عکس");
  }

  return jsonOut({
    ok: true,
    sheet: "Records",
    row: rowIndex
  });
}

function handleStatusSummary(ss, data) {
    var sh = ss.getSheetByName("UserStatus");
  if (!sh) {
    sh = ss.insertSheet("UserStatus");
  }

  // اطمینان از وجود هدرها قبل از هر کاری
  ensureStatusHeaders(sh);

  // --- اعمال قالب بندی تاریخ و زمان ---
  // فقط اگر حداقل یک ردیف داده (بیشتر از هدر) وجود داشته باشد، قالب بندی را اعمال کن
  if (sh.getLastRow() > 1) {
    // محدوده از ردیف دوم (2) تا آخرین ردیف، ستون های 4، 5، 6
    sh.getRange(2, 4, sh.getLastRow() - 1, 3).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  }
  // ------------------------------------

  var personnelCode = s(data.personnelCode).trim();
  if (!personnelCode) {
    return jsonOut({
      ok: false,
      error: "PersonnelCode missing"
    });
  }

  var firstName = s(data.firstName).trim();
  var lastName = s(data.lastName).trim();
  var fullName = (firstName + " " + lastName).replace(/\s+/g, " ").trim();

  var status = s(
    data.connectionStatusFa ||
    data.status ||
    (data.online === true ? "آنلاین" : data.online === false ? "آفلاین" : "")
  ).trim();

  if (!status) {
    status = "آفلاین";
  }

  var now = new Date();
  var lastRow = sh.getLastRow();
  var rowIndex = findRowByPersonnelCode(sh, personnelCode, lastRow);

  if (rowIndex === -1) {
    var newRow = [
      personnelCode,
      fullName,
      status,
      status === "آنلاین" ? now : "",
      status === "آفلاین" ? now : "",
      now
    ];

    sh.appendRow(newRow);
    rowIndex = sh.getLastRow(); // بروزرسانی rowIndex پس از اضافه شدن

    // اعمال قالب بندی برای ردیف جدید اضافه شده
    // اطمینان از اینکه محدوده درست است: ردیف جدید، ستون های 4، 5، 6
    sh.getRange(rowIndex, 4, 1, 3).setNumberFormat("yyyy-mm-dd hh:mm:ss");

  } else {
    if (fullName) {
      sh.getRange(rowIndex, 2).setValue(fullName);
    }

    sh.getRange(rowIndex, 3).setValue(status);

    if (status === "آنلاین") {
      sh.getRange(rowIndex, 4).setValue(now);
    }

    if (status === "آفلاین") {
      sh.getRange(rowIndex, 5).setValue(now);
    }

    sh.getRange(rowIndex, 6).setValue(now);

    // اعمال قالب بندی برای ردیف به روز شده
    // اطمینان از اینکه محدوده درست است: ردیف به روز شده، ستون های 4، 5، 6
    sh.getRange(rowIndex, 4, 1, 3).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  }

  return jsonOut({
    ok: true,
    sheet: "UserStatus",
    row: rowIndex,
    personnelCode: personnelCode,
    status: status
  });
}

function findRowByPersonnelCode(sh, personnelCode, lastRow) {
  if (lastRow < 2) { // اگر شیت فقط هدر دارد یا خالی است
    return -1;
  }

  // خواندن مقادیر از ردیف دوم تا آخرین ردیف، فقط ستون اول (PersonnelCode)
  var values = sh.getRange(2, 1, lastRow - 1, 1).getValues();

  for (var i = 0; i < values.length; i++) {
    // مقایسه مقدار ستون اول با PersonnelCode مورد نظر
    if (s(values[i][0]).trim() === personnelCode) {
      return i + 2; // برگرداندن شماره ردیف (چون از ردیف دوم شروع کردیم، i + 2)
    }
  }

  return -1; // اگر پیدا نشد
}

function uploadBase64Image(base64Str, personnelCode) {
  try {
    var folderName = "PWA_Photos";
    var folders = DriveApp.getFoldersByName(folderName);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

    var mimeType = "image/jpeg";
    var extension = "jpg";
    var matches = base64Str.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);

    if (matches && matches[1]) {
      mimeType = matches[1];

      if (mimeType === "image/png") extension = "png";
      else if (mimeType === "image/webp") extension = "webp";
      else if (mimeType === "image/gif") extension = "gif";
      else extension = "jpg";
    }

    var base64Data = base64Str.split(",")[1] || base64Str;
    var fileName = "IMG_" + (personnelCode || "UNKNOWN") + "_" + Date.now() + "." + extension;
    var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    var file = folder.createFile(blob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return "https://drive.google.com/uc?export=view&id=" + file.getId();
  } catch (err) {
    // در صورت بروز خطا، رشته خالی برگردانده می شود
    return "";
  }
}

function logDebug(ss, data) {
  var sh = ss.getSheetByName("Debug");
  if (!sh) {
    sh = ss.insertSheet("Debug");
  }

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "Timestamp",
      "Type",
      "PersonnelCode",
      "Payload"
    ]);
  }

  sh.appendRow([
    new Date(),
    s(data.type),
    s(data.personnelCode),
    JSON.stringify(data)
  ]);
}

function logError(ss, data, err) {
  var sh = ss.getSheetByName("Errors");
  if (!sh) {
    sh = ss.insertSheet("Errors");
  }

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "Timestamp",
      "PersonnelCode",
      "Type",
      "Error",
      "Payload"
    ]);
  }

  sh.appendRow([
    new Date(),
    s(data && data.personnelCode),
    s(data && data.type),
    s(err && err.message ? err.message : err),
    JSON.stringify(data || {})
  ]);
}

function ensureRecordHeaders(sh) {
  var headers = [[
    "Timestamp",
    "PersonnelCode",
    "FirstName",
    "LastName",
    "RecordDate",
    "RecordHour",
    "Latitude",
    "Longitude",
    "Accuracy",
    "DeviceTime",
    "OfflineCreated",
    "ClockRisk",
    "Photo",
    "GeoFenceStatus"
  ]];

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    sh.getRange(1, 1, 1, headers[0].length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
}

function ensureStatusHeaders(sh) {
  var headers = [[
    "PersonnelCode",
    "FullName",
    "Status",
    "LastOnline",
    "LastOffline",
    "LastUpdate"
  ]];

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    sh.getRange(1, 1, 1, headers[0].length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
}

function parseBody(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return null;
    }
    return JSON.parse(e.postData.contents);
  } catch (err) {
    // اگر پارس کردن JSON ناموفق بود، null برگردانده می شود
    return null;
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function s(v) {
  // تبدیل مقدار به رشته، اگر undefined یا null بود، رشته خالی برمی گرداند
  return v === undefined || v === null ? "" : String(v);
}

function n(v) {
  // تبدیل مقدار به عدد، اگر undefined، null یا رشته خالی بود، رشته خالی برمی گرداند
  if (v === undefined || v === null || v === "") {
    return "";
  }

  var num = Number(v);
  // اگر نتیجه NaN بود، رشته خالی برمی گرداند
  return isNaN(num) ? "" : num;
}

/* =========================
   JSON response
========================= */

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================
   Message API
========================= */

function getMessagesForPersonnel_(personnelCode) {
  var pcode = String(personnelCode || "").trim();
  if (!pcode) return []; // اگر کد پرسنلی خالی است، آرایه خالی برمی گرداند

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MESSAGES_SHEET_NAME);

  if (!sheet) return []; // اگر شیت پیام ها وجود ندارد

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return []; // اگر شیت خالی است (فقط هدر یا کاملا خالی)

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var msgIdx = headers.indexOf("Message");
  var activeIdx = headers.indexOf("IsActive");

  // اگر ستون های مورد نیاز یافت نشدند
  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return [];

  var messages = [];

  // حلقه روی ردیف های داده (از ردیف دوم به بعد)
  for (var i = 1; i < data.length; i++) {
    var rowCode = String(data[i][pIdx]).trim();
    var active =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true" ||
      String(data[i][activeIdx]) === "1";

    // اگر کد پرسنلی ردیف با کد درخواستی مطابقت داشت و پیام فعال بود
    if (rowCode === pcode && active) {
      var msg = String(data[i][msgIdx] || "").trim();
      if (msg) messages.push(msg); // اضافه کردن پیام به آرایه
    }
  }

  return messages; // برگرداندن آرایه پیام های یافت شده
}

/* =========================
   GeoFence
========================= */

function getUserGeoFence_(personnelCode) {
  var sheet = getUsersSheet(); // دریافت شیت Users
  var data = sheet.getDataRange().getValues();

  if (data.length < 2) return null; // اگر شیت کاربران خالی است

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var minLatIdx = headers.indexOf("MinLatitude");
  var maxLatIdx = headers.indexOf("MaxLatitude");
  var minLngIdx = headers.indexOf("MinLongitude");
  var maxLngIdx = headers.indexOf("MaxLongitude");

  if (pIdx === -1) return null; // اگر ستون کد پرسنلی یافت نشد

  // جستجو برای کد پرسنلی مورد نظر
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]).trim() === String(personnelCode).trim()) {
      // برگرداندن محدوده جغرافیایی (GeoFence)
      return {
        minLat: Number(data[i][minLatIdx] || 0),
        maxLat: Number(data[i][maxLatIdx] || 0),
        minLng: Number(data[i][minLngIdx] || 0),
        maxLng: Number(data[i][maxLngIdx] || 0)
      };
    }
  }

  return null; // اگر کد پرسنلی یافت نشد
}

function isInsideGeoFence_(latitude, longitude, fence) {
  if (!fence) return true; // اگر محدوده ای تعریف نشده، همیشه درست است
  if (latitude === "" || longitude === "" || latitude === null || longitude === null) return false; // اگر مختصات خالی است

  // بررسی اینکه مختصات ورودی در محدوده تعریف شده قرار دارد
  return (
    Number(latitude) >= fence.minLat &&
    Number(latitude) <= fence.maxLat &&
    Number(longitude) >= fence.minLng &&
    Number(longitude) <= fence.maxLng
  );
}

/* =========================
   Policy
========================= */

function handleGetUserPolicy_(e) {
  try {
    var personnelCode = stringifyOrBlank(
      e && e.parameter ? e.parameter.personnelCode : ""
    );

    if (!personnelCode) {
      // اگر کد پرسنلی الزامی است و ارسال نشده
      return jsonResponse({
        ok: false,
        error: "PersonnelCode الزامی است."
      });
    }

    var userPolicy = getUserPolicy_(personnelCode); // دریافت سیاست کاربر

    // برگرداندن اطلاعات سیاست کاربر
    return jsonResponse({
      ok: true,
      personnelCode: personnelCode,
      attendancePolicy: userPolicy.attendancePolicy,
      policyVersion: userPolicy.policyVersion,
      updatedAt: userPolicy.updatedAt
    });
  } catch (err) {
    // در صورت بروز خطا
    return jsonResponse({
      ok: false,
      error: String(err)
    });
  }
}

function getUserPolicy_(personnelCode) {
  var pcode = String(personnelCode || "").trim();
  if (!pcode) {
    // اگر کد پرسنلی خالی است، سیاست پیش فرض را برمی گرداند
    return {
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      updatedAt: ""
    };
  }

  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    // اگر شیت کاربران خالی است، سیاست پیش فرض را برمی گرداند
    return {
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      updatedAt: ""
    };
  }

  var headers = data[0];
  var personnelIdx = headers.indexOf("PersonnelCode");
  var policyIdx = headers.indexOf("AttendancePolicy");
  var versionIdx = headers.indexOf("PolicyVersion");
  var updatedIdx = headers.indexOf("UpdatedAt");

  if (personnelIdx === -1 || policyIdx === -1) {
    // اگر ستون های مورد نیاز یافت نشدند، سیاست پیش فرض را برمی گرداند
    return {
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      updatedAt: ""
    };
  }

  // جستجو برای کد پرسنلی کاربر
  for (var i = 1; i < data.length; i++) {
    var rowCode = String(data[i][personnelIdx]).trim();
    if (rowCode === pcode) {
      // برگرداندن سیاست کاربر یافت شده
      return {
        attendancePolicy: normalizeAttendancePolicy_(data[i][policyIdx]), // نرمال سازی سیاست
        policyVersion: versionIdx === -1 ? 0 : Number(data[i][versionIdx] || 0), // دریافت نسخه سیاست
        updatedAt: updatedIdx === -1 ? "" : data[i][updatedIdx] // تاریخ آخرین بروزرسانی
      };
    }
  }

  // اگر کد پرسنلی یافت نشد، سیاست پیش فرض را برمی گرداند
  return {
    attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
    policyVersion: 0,
    updatedAt: ""
  };
}

function validateAttendancePolicy_(normalized, now) {
  var userPolicy = getUserPolicy_(normalized.personnelCode);
  var attendancePolicy = normalizeAttendancePolicy_(userPolicy.attendancePolicy);
  var policyVersion = Number(userPolicy.policyVersion || 0);
  var isOfflineRecord = normalized.offlineCreated === true;

  // بررسی سیاست ها و بازگرداندن نتیجه اعتبارسنجی
  if (attendancePolicy === POLICY_NOT_ALLOWED) {
    return { ok: false, error: "برای این کاربر هیچ نوع ثبت ترددی مجاز نیست.", attendancePolicy, policyVersion, checkedAt: now || new Date() };
  }
  if (attendancePolicy === POLICY_ONLINE_ONLY && isOfflineRecord) {
    return { ok: false, error: "برای این کاربر فقط ثبت آنلاین مجاز است.", attendancePolicy, policyVersion, checkedAt: now || new Date() };
  }
  if (attendancePolicy === POLICY_OFFLINE_ONLY && !isOfflineRecord) {
    return { ok: false, error: "برای این کاربر فقط ثبت آفلاین مجاز است.", attendancePolicy, policyVersion, checkedAt: now || new Date() };
  }

  return { ok: true, attendancePolicy, policyVersion, checkedAt: now || new Date() };
}

/* =========================
   Normalization
========================= */

function normalizeAttendancePayload(payload) {
  var personnelCode = stringifyOrBlank(payload.personnelCode);
  var firstName = stringifyOrBlank(payload.firstName);
  var lastName = stringifyOrBlank(payload.lastName);

  var recordDate = stringifyOrBlank(payload.recordDate);
  var recordHour = stringifyOrBlank(payload.recordHour);
  var recordTime = stringifyOrBlank(payload.recordTime);

  var latitude = normalizeDecimalOrBlank(payload.latitude);
  var longitude = normalizeDecimalOrBlank(payload.longitude);
  var accuracy = normalizeDecimalOrBlank(payload.accuracy);

  var deviceTime = stringifyOrBlank(payload.deviceTime);
  var deviceTimeAtClick = stringifyOrBlank(payload.deviceTimeAtClick);
  var deviceTimeAtGps = stringifyOrBlank(payload.deviceTimeAtGps);

  var gpsTimestamp = stringifyOrBlank(payload.gpsTimestamp || payload.geoTimestamp);

  var gpsWaitMs = normalizeIntegerOrBlank(payload.gpsWaitMs);
  var photoDelayMs = normalizeIntegerOrBlank(payload.photoDelayMs);

  var offlineCreated = parseBoolean(payload.offlineCreated);
  var createdAt = stringifyOrBlank(payload.createdAt);
  var photo = stringifyOrBlank(payload.photo);

  var locationStatus = stringifyOrBlank(payload.locationStatus);
  var locationError = stringifyOrBlank(payload.locationError);

  var sessionClockDriftMs = normalizeIntegerOrBlank(payload.sessionClockDriftMs);
  var networkClockDriftMs = normalizeIntegerOrBlank(payload.networkClockDriftMs);

  var attendancePolicy = normalizeAttendancePolicy_(payload.attendancePolicy);
  var policyVersion = normalizeIntegerOrBlank(payload.policyVersion);
  var policyFetchedAt = stringifyOrBlank(payload.policyFetchedAt);
  var policySource = stringifyOrBlank(payload.policySource);

  var gpsTrueTimeDiffMs = calculateGpsTrueTimeDiffMs(gpsTimestamp, deviceTimeAtGps);

  return {
    personnelCode: personnelCode,
    firstName: firstName,
    lastName: lastName,
    recordDate: recordDate,
    recordHour: recordHour,
    recordTime: recordTime,
    latitude: latitude,
    longitude: longitude,
    accuracy: accuracy,
    deviceTime: deviceTime,
    deviceTimeAtClick: deviceTimeAtClick,
    deviceTimeAtGps: deviceTimeAtGps,
    gpsTimestamp: gpsTimestamp,
    gpsWaitMs: gpsWaitMs,
    photoDelayMs: photoDelayMs,
    offlineCreated: offlineCreated,
    createdAt: createdAt,
    photo: photo,
    locationStatus: locationStatus,
    locationError: locationError,
    sessionClockDriftMs: sessionClockDriftMs,
    networkClockDriftMs: networkClockDriftMs,
    gpsTrueTimeDiffMs: gpsTrueTimeDiffMs,
    attendancePolicy: attendancePolicy,
    policyVersion: policyVersion === "" ? 0 : Number(policyVersion),
    policyFetchedAt: policyFetchedAt,
    policySource: policySource
  };
}

/* =========================
   Risk
========================= */

function calculateClockRisk(data, history) {
  var score = 0;
  var reasons = [];

  var offlineCreated = data.offlineCreated === true;
  var locationStatus = stringifyOrBlank(data.locationStatus).toLowerCase();
  var locationError = stringifyOrBlank(data.locationError);

  var sessionClockDriftMs = Math.abs(Number(data.sessionClockDriftMs) || 0);
  var networkClockDriftMs = Math.abs(Number(data.networkClockDriftMs) || 0);
  var gpsTrueTimeDiffMs = Math.abs(Number(data.gpsTrueTimeDiffMs) || 0);

  if (sessionClockDriftMs > CLOCK_DRIFT_SESSION_LIMIT_MS) {
    score += 6;
    reasons.push("تغییر ساعت در حین باز بودن برنامه");
  }

  if (networkClockDriftMs > NETWORK_DRIFT_LIMIT_MS) {
    score += 4;
    reasons.push("اختلاف قابل توجه با ساعت شبکه");
  }

  if (locationStatus && locationStatus !== "ok") {
    score += 4;
    reasons.push("وضعیت GPS نامعتبر");
  }

  if (locationError) {
    score += 2;
    reasons.push("خطای موقعیت");
  }

  if (gpsTrueTimeDiffMs > GPS_TRUE_DIFF_LIMIT_MS) {
    score += 6;
    reasons.push("اختلاف زمان GPS با زمان ثبت‌شده");
  }

  if (offlineCreated) {
    reasons.push("ثبت آفلاین");

    if (history && history.hasPriorOnline) {
      reasons.push("قبل از این ثبت، اتصال آنلاین وجود داشته");
    }

    var offlineDelayMs = estimateOfflineUploadDelayMs(data);

    if (offlineDelayMs !== null && offlineDelayMs > OFFLINE_UPLOAD_GRACE_MS) {
      score += 1;
      reasons.push("ارسال با تأخیر بعد از ثبت آفلاین");
    }
  }

  if (!offlineCreated && history && history.hasPriorOffline) {
    reasons.push("اتصال آنلاین بعد از ثبت آفلاین");
  }

  if (score >= 6) {
    return {
      clockRisk: "high",
      clockRiskReason: reasons.length ? reasons.join(" | ") : "ریسک بالا"
    };
  }

  if (score >= 3) {
    return {
      clockRisk: "medium",
      clockRiskReason: reasons.length ? reasons.join(" | ") : "ریسک متوسط"
    };
  }

  return {
    clockRisk: "low",
    clockRiskReason: reasons.length ? reasons.join(" | ") : "نرمال"
  };
}

function estimateOfflineUploadDelayMs(data) {
  var source = "";

  if (data.createdAt) {
    source = data.createdAt;
  } else if (data.recordDate && (data.recordTime || data.recordHour)) {
    source = data.recordDate + " " + (data.recordTime || data.recordHour);
  } else if (data.deviceTime) {
    source = data.deviceTime;
  }

  var ms = parseDateToMs(source);
  if (ms === null) return null;

  return Math.abs(Date.now() - ms);
}

function calculateGpsTrueTimeDiffMs(gpsTimestamp, deviceTimeAtGps) {
  if (!gpsTimestamp || !deviceTimeAtGps) return "";
  var gpsMs = parseDateToMs(gpsTimestamp);
  var deviceMs = parseDateToMs(deviceTimeAtGps);
  if (gpsMs === null || deviceMs === null) return "";
  return Math.round(gpsMs - deviceMs);
}

/* =========================
   Sheets
========================= */

function getRecordsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(RECORDS_SHEET_NAME);
  ensureHeaders(sheet, RECORD_HEADERS);
  return sheet;
}

function getUsersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(USERS_SHEET_NAME);
  ensureHeaders(sheet, USERS_HEADERS);
  return sheet;
}

function getRecordIndexSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORD_INDEX_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(RECORD_INDEX_SHEET_NAME);
  ensureHeaders(sheet, RECORD_INDEX_HEADERS);
  hideSheetSafely_(sheet);
  return sheet;
}

function getMatchingSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MATCHING_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(MATCHING_SHEET_NAME);
  ensureHeaders(sheet, MATCHING_HEADERS);
  return sheet;
}

function ensureHeaders(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();

  if (lastRow < 1) { // اگر شیت کاملا خالی است
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]); // نوشتن هدرها
    styleHeader_(sheet, headers.length); // استایل دهی هدر
    return;
  }

  // گرفتن هدرهای فعلی شیت
  var currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var mismatch = false; // متغیر برای تشخیص عدم تطابق هدرها

  if (lastCol !== headers.length) mismatch = true; // اگر تعداد ستون ها متفاوت است

  // مقایسه هدرهای فعلی با هدرهای مورد نیاز
  for (var i = 0; i < headers.length; i++) {
    if (String(currentHeaders[i] || "") !== String(headers[i])) {
      mismatch = true;
      break;
    }
  }

  if (!mismatch) { // اگر هدرها مطابقت دارند
    styleHeader_(sheet, headers.length); // فقط استایل دهی هدر
    return;
  }

  // اگر هدرها مطابقت ندارند
  if (lastCol > 0) {
    sheet.getRange(1, 1, 1, lastCol).clearFormat(); // پاک کردن فرمت هدرهای قبلی
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]); // نوشتن هدرهای جدید
  styleHeader_(sheet, headers.length); // استایل دهی هدرهای جدید

  // اگر تعداد هدرهای جدید کمتر از قبلی بود، ستون های اضافی را حذف کن
  if (lastCol > headers.length) {
    sheet.deleteColumns(headers.length + 1, lastCol - headers.length);
  }
}

function styleHeader_(sheet, headerLength) {
  // استایل دهی به ردیف هدر: فونت ضخیم، پس زمینه خاکستری روشن
  sheet.getRange(1, 1, 1, headerLength).setFontWeight("bold").setBackground("#f3f3f3");
  sheet.setFrozenRows(1); // ثابت کردن ردیف هدر
}

function appendRecordIndexRow_(sheet, info) {
  ensureHeaders(sheet, RECORD_INDEX_HEADERS); // اطمینان از وجود هدرها

  // اضافه کردن ردیف جدید با داده های نرمال شده و اطلاعات مرتبط
  sheet.appendRow([
    info.signature || "",
    info.normalized.personnelCode || "",
    info.now || new Date(),
    !!info.normalized.offlineCreated,
    info.normalized.recordDate || "",
    info.normalized.recordHour || "",
    info.normalized.recordTime || "",
    info.normalized.createdAt || "",
    info.normalized.deviceTime || "",
    info.normalized.deviceTimeAtClick || "",
    info.normalized.deviceTimeAtGps || "",
    info.normalized.gpsTimestamp || "",
    info.normalized.latitude || "",
    info.normalized.longitude || "",
    info.normalized.accuracy || "",
    info.normalized.sessionClockDriftMs || "",
    info.normalized.networkClockDriftMs || "",
    info.gpsTrueTimeDiffMs || "",
    info.normalized.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
    Number(info.normalized.policyVersion || 0),
    info.normalized.policyFetchedAt || "",
    info.photoUrl || "",
    info.row || ""
  ]);
}

function appendMatchingRow_(sheet, info) {
  ensureHeaders(sheet, MATCHING_HEADERS); // اطمینان از وجود هدرها

  // اضافه کردن ردیف جدید با داده های اولیه
  sheet.appendRow([
    info.recordRow || "",
    info.now || new Date(),
    info.normalized.personnelCode || "",
    !!info.normalized.offlineCreated,
    info.normalized.createdAt || "",
    "", // FirstInternetAt
    "", // FirstOfflineAt
    "", // InternetAfterOfflineAt
    "", // SequenceMatch
    "", // ReconnectAfterOffline
    info.clockRiskResult.clockRisk || "",
    info.clockRiskResult.clockRiskReason || "",
    info.photoUrl || ""
  ]);

  var row = sheet.getLastRow(); // شماره ردیف جدید
  var fmt = "yyyy-mm-dd hh:mm:ss"; // فرمت تاریخ و زمان

  // تنظیم فرمول ها برای ستون های محاسبه ای
  sheet.getRange(row, 6).setFormula(
    '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
      row +
      ',RecordIndex!$D:$D,FALSE),"' +
      fmt +
      '"),"")'
  );

  sheet.getRange(row, 7).setFormula(
    '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
      row +
      ',RecordIndex!$D:$D,TRUE),"' +
      fmt +
      '"),"")'
  );

  sheet.getRange(row, 8).setFormula(
    '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
      row +
      ',RecordIndex!$D:$D,FALSE,RecordIndex!$C:$C,">"&$G' +
      row +
      '),"' +
      fmt +
      '"),"")'
  );

  sheet.getRange(row, 9).setFormula(
    '=AND($F' +
      row +
      '<>"",$G' +
      row +
      '<>"",$H' +
      row +
      '<>"",VALUE($F' +
      row +
      ')<VALUE($G' +
      row +
      '),VALUE($G' +
      row +
      ')<VALUE($H' +
      row +
      '))'
  );

  sheet.getRange(row, 10).setFormula(
    '=AND($D' + row + '=TRUE,$G' + row + '<>"",$H' + row + '<>"")'
  );

  sheet.getRange(row, 11).setFormula(
    '=IF($D' + row + '=TRUE, IFERROR(VALUE($H' + row + ')-VALUE($G' + row + '), ""), "")'
  );

  // اضافه کردن فرمول لینک عکس در صورت وجود
  if (info.photoUrl) {
    sheet.getRange(row, 13).setFormula(
      '=HYPERLINK("' + escapeFormulaString_(info.photoUrl) + '","مشاهده عکس")'
    );
  }
}

function getPersonnelHistory_(sheet, personnelCode) {
  var result = {
    hasPriorOnline: false,
    hasPriorOffline: false,
    firstOnlineAt: "",
    firstOfflineAt: "",
    lastOnlineAt: "",
    lastOfflineAt: ""
  };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return result; // اگر شیت خالی است

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var tsIdx = headers.indexOf("ServerTimestamp");
  var offIdx = headers.indexOf("OfflineCreated");

  if (pIdx === -1 || tsIdx === -1 || offIdx === -1) return result; // اگر ستون های مورد نیاز یافت نشدند

  var target = String(personnelCode);
  var firstOnline = null;
  var firstOffline = null;
  var lastOnline = null;
  var lastOffline = null;

  // حلقه روی ردیف ها برای یافتن تاریخچه کاربر
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]) !== target) continue; // رد کردن ردیف هایی که کد پرسنلی مطابقت ندارند

    var ts = normalizeDateValue_(data[i][tsIdx]); // تبدیل زمان سرور به آبجکت تاریخ
    if (!ts) continue; // رد کردن ردیف هایی که زمان سرور معتبر ندارند

    var isOffline = parseBoolean(data[i][offIdx]); // بررسی اینکه آیا رکورد آفلاین است

    // به روز رسانی تاریخچه بر اساس آنلاین یا آفلاین بودن
    if (isOffline) {
      result.hasPriorOffline = true;
      if (!firstOffline || ts.getTime() < firstOffline.getTime()) firstOffline = ts;
      if (!lastOffline || ts.getTime() > lastOffline.getTime()) lastOffline = ts;
    } else {
      result.hasPriorOnline = true;
      if (!firstOnline || ts.getTime() < firstOnline.getTime()) firstOnline = ts;
      if (!lastOnline || ts.getTime() > lastOnline.getTime()) lastOnline = ts;
    }
  }

  result.firstOnlineAt = firstOnline || "";
  result.firstOfflineAt = firstOffline || "";
  result.lastOnlineAt = lastOnline || "";
  result.lastOfflineAt = lastOffline || "";

  return result;
}

function isDuplicateRecord_(sheet, signature) {
  if (!signature) return false; // اگر امضا (signature) خالی است، تکراری نیست
  ensureHeaders(sheet, RECORD_INDEX_HEADERS); // اطمینان از وجود هدرها

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false; // اگر شیت فقط هدر دارد یا خالی است

  // خواندن تمام امضاها از ستون اول شیت RecordIndex
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var target = String(signature).trim(); // امضای مورد نظر برای جستجو

  // جستجو برای امضای تکراری
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === target) return true; // اگر امضا یافت شد، تکراری است
  }

  return false; // اگر امضا یافت نشد
}

function buildRecordSignature_(normalized, photoSignatureSource) {
  // ایجاد آرایه ای از داده هایی که برای تولید امضا استفاده می شوند
  var parts = [
    normalized.personnelCode,
    normalized.recordDate,
    normalized.recordHour,
    normalized.recordTime,
    normalized.createdAt,
    normalized.deviceTime,
    normalized.deviceTimeAtClick,
    normalized.gpsTimestamp,
    normalized.latitude,
    normalized.longitude,
    normalized.offlineCreated ? "online" : "offline", // وضعیت آفلاین/آنلاین
    normalized.attendancePolicy || DEFAULT_ATTENDANCE_POLICY, // سیاست تردد
    normalized.policyVersion || 0, // نسخه سیاست
    photoSignatureSource || "" // منبع امضای عکس
  ];

  // تبدیل آرایه به یک رشته خام با جداکننده "|"
  var raw = parts.map(function (item) {
    return stringifyOrBlank(item);
  }).join("|");

  // ایجاد امضای SHA-256 از رشته خام و برگرداندن آن به صورت کدگذاری شده وب ایمن
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      raw
    )
  );
}

function resolvePhotoAsset_(photo, personnelCode, now) {
  var cleanPhoto = stringifyOrBlank(photo);

  if (!cleanPhoto) { // اگر عکس خالی است
    return { url: "", formula: "", signatureSource: "" };
  }

  if (/^https?:\/\//i.test(cleanPhoto)) { // اگر عکس یک URL معتبر است
    return {
      url: cleanPhoto,
      formula: '=HYPERLINK("' + escapeFormulaString_(cleanPhoto) + '","مشاهده عکس")',
      signatureSource: cleanPhoto
    };
  }

  if (cleanPhoto.indexOf("data:image/") === 0) { // اگر عکس به صورت base64 است
    var uploaded = uploadBase64PhotoToDrive_(cleanPhoto, personnelCode, now); // آپلود عکس در گوگل درایو
    return {
      url: uploaded.url,
      formula: '=HYPERLINK("' + escapeFormulaString_(uploaded.url) + '","مشاهده عکس")',
      signatureSource: uploaded.fileId // استفاده از شناسه فایل به عنوان منبع امضا
    };
  }

  // اگر عکس فرمت ناشناخته ای دارد، آن را به عنوان URL در نظر می گیرد (ممکن است اشتباه باشد)
  return { url: cleanPhoto, formula: "", signatureSource: cleanPhoto };
}

function uploadBase64PhotoToDrive_(dataUrl, personnelCode, now) {
  // استخراج نوع تصویر و داده base64 از رشته data:image/...
  var matches = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matches) throw new Error("فرمت عکس معتبر نیست.");

  var mimeType = matches[1];
  var base64Data = matches[2];
  var extension = getImageExtensionFromMime_(mimeType); // دریافت پسوند فایل بر اساس mime type

  var bytes = Utilities.base64Decode(base64Data); // دیکد کردن داده base64
  var safePersonnelCode = stringifyOrBlank(personnelCode) || "unknown"; // کد پرسنلی امن

  // ایجاد نام فایل با فرمت مشخص
  var timestamp = Utilities.formatDate(
    now || new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd_HHmmss_SSS"
  );
  var fileName = "attendance_" + safePersonnelCode + "_" + timestamp + extension;
  var blob = Utilities.newBlob(bytes, mimeType, fileName); // ایجاد Blob از داده های تصویر
  var folder = getOrCreatePhotoFolder_(); // دریافت یا ایجاد پوشه عکس ها در گوگل درایو
  var file = folder.createFile(blob); // ایجاد فایل در پوشه

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // تنظیم مجوز دسترسی به فایل (قابل مشاهده با لینک)

  // برگرداندن شناسه فایل و URL قابل اشتراک گذاری
  return {
    fileId: file.getId(),
    url: "https://drive.google.com/uc?export=view&id=" + file.getId()
  };
}

function getOrCreatePhotoFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(PHOTO_FOLDER_PROPERTY_KEY);

  if (folderId) { // اگر شناسه پوشه در properties ذخیره شده است
    try {
      return DriveApp.getFolderById(folderId); // تلاش برای دریافت پوشه با شناسه
    } catch (err) {
      // اگر پوشه حذف شده یا شناسه نامعتبر است، آن را از properties پاک کن
      properties.deleteProperty(PHOTO_FOLDER_PROPERTY_KEY);
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folderName = "Attendance Photos - " + ss.getName(); // نام پوشه بر اساس نام فایل 스프دشیت
  var folders = DriveApp.getFoldersByName(folderName);

  if (folders.hasNext()) { // اگر پوشه با این نام وجود دارد
    var existingFolder = folders.next();
    properties.setProperty(PHOTO_FOLDER_PROPERTY_KEY, existingFolder.getId()); // ذخیره شناسه پوشه
    return existingFolder;
  }

  // اگر پوشه وجود ندارد، آن را ایجاد کن
  var newFolder = DriveApp.createFolder(folderName);
  properties.setProperty(PHOTO_FOLDER_PROPERTY_KEY, newFolder.getId()); // ذخیره شناسه پوشه جدید
  return newFolder;
}

function getImageExtensionFromMime_(mimeType) {
  var text = String(mimeType || "").toLowerCase();

  // تعیین پسوند فایل بر اساس mime type
  if (text === "image/jpeg" || text === "image/jpg") return ".jpg";
  if (text === "image/png") return ".png";
  if (text === "image/webp") return ".webp";
  if (text === "image/gif") return ".gif";
  return ".jpg"; // پسوند پیش فرض
}

function normalizeAttendancePolicy_(value) {
  var text = String(value || "").trim().toUpperCase(); // تبدیل به رشته، حذف فاصله های اضافی و تبدیل به حروف بزرگ

  // بررسی اینکه آیا مقدار ورودی یکی از سیاست های معتبر است
  if (
    text === POLICY_NOT_ALLOWED ||
    text === POLICY_ONLINE_ONLY ||
    text === POLICY_OFFLINE_ONLY ||
    text === POLICY_ONLINE_PREFERRED ||
    text === POLICY_ONLINE_OR_OFFLINE ||
    text === POLICY_OFFLINE_ALLOWED_IMMEDIATE
  ) {
    return text; // برگرداندن مقدار معتبر
  }

  return DEFAULT_ATTENDANCE_POLICY; // در غیر این صورت، سیاست پیش فرض را برگردان
}

/* =========================
   Parsers
========================= */

function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("درخواست خالی است یا postData یافت نشد.");
  }

  var contents = e.postData.contents;

  if (typeof contents === "string") {
    try {
      return JSON.parse(contents); // تلاش برای پارس کردن مستقیم JSON
    } catch (err) {
      // اگر پارس کردن مستقیم ناموفق بود، تلاش برای پاکسازی و پارس کردن مجدد
      try {
        // استخراج بخشی از رشته که شبیه JSON است
        var cleanStr = contents.substring(contents.indexOf("{"), contents.lastIndexOf("}") + 1);
        return JSON.parse(cleanStr);
      } catch (e2) {
        // اگر باز هم ناموفق بود، خطا می دهد
        throw new Error("خطا در پارس کردن JSON ورودی: " + err.message);
      }
    }
  }

  return contents; // اگر محتوا از ابتدا JSON بوده (مثلا آبجکت)
}

function parseDateToMs(value) {
  if (value === null || value === undefined || value === "") return null; // اگر ورودی خالی است

  // اگر ورودی از قبل یک آبجکت Date است
  if (Object.prototype.toString.call(value) === "[object Date]") {
    var directTime = value.getTime();
    return isNaN(directTime) ? null : directTime; // برگرداندن میلی ثانیه ها یا null اگر نامعتبر بود
  }

  // اگر ورودی یک عدد است
  if (typeof value === "number") {
    return isFinite(value) ? value : null; // برگرداندن عدد اگر محدود و متناهی است
  }

  var text = String(value).trim(); // تبدیل به رشته و حذف فاصله های اضافی
  if (!text) return null; // اگر رشته خالی است

  // اگر رشته فقط شامل اعداد است (احتمالا میلی ثانیه ها)
  if (/^\d+$/.test(text)) {
    var numericValue = Number(text);
    return isFinite(numericValue) ? numericValue : null; // برگرداندن عدد اگر متناهی است
  }

  // تلاش برای تبدیل رشته به تاریخ
  var dateMs = new Date(text).getTime();
  if (!isNaN(dateMs)) return dateMs; // اگر تبدیل موفق بود، میلی ثانیه ها را برگردان

  return null; // اگر هیچ کدام از روش ها موفق نبود
}

function normalizeDateValue_(value) {
  var ms = parseDateToMs(value); // تبدیل به میلی ثانیه
  if (ms === null) return null; // اگر تبدیل ناموفق بود

  var date = new Date(ms); // ایجاد آبجکت Date
  if (isNaN(date.getTime())) return null; // اگر آبجکت Date نامعتبر بود

  return date; // برگرداندن آبجکت Date معتبر
}

function normalizeDecimalOrBlank(value) {
  if (value === null || value === undefined || value === "") return ""; // اگر ورودی خالی است
  var numberValue = Number(value); // تبدیل به عدد
  if (!isFinite(numberValue)) return ""; // اگر عدد متناهی نیست، رشته خالی برگردان
  return numberValue; // برگرداندن عدد
}

function normalizeIntegerOrBlank(value) {
  if (value === null || value === undefined || value === "") return ""; // اگر ورودی خالی است
  var numberValue = Number(value); // تبدیل به عدد
  if (!isFinite(numberValue)) return ""; // اگر عدد متناهی نیست، رشته خالی برگردان
  return Math.round(numberValue); // برگرداندن عدد گرد شده
}

function parseBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return false; // مقادیر null/undefined به false تبدیل می شوند

  var text = String(value).trim().toLowerCase(); // تبدیل به رشته، حذف فاصله و تبدیل به حروف کوچک
  // بررسی مقادیر متنی که به true تبدیل می شوند
  return (
    text === "true" ||
    text === "1" ||
    text === "yes" ||
    text === "y" ||
    text === "بله" ||
    text === "آفلاین" || // این مورد باید بررسی شود، شاید منظور true باشد
    text === "offline"
  );
}

function stringifyOrBlank(value) {
  if (value === null || value === undefined) return ""; // اگر null یا undefined است، رشته خالی برگردان
  return String(value).trim(); // تبدیل به رشته و حذف فاصله های اضافی
}

function escapeFormulaString_(value) {
  // جایگزینی تمام گیومه های تکی با دو گیومه تکی برای استفاده در فرمول های اکسل/شیت
  return String(value || "").replace(/"/g, '""');
}

function hideSheetSafely_(sheet) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // اگر بیش از یک شیت در فایل وجود دارد، شیت را مخفی کن
    if (ss.getSheets().length > 1) sheet.hideSheet();
  } catch (err) {
    Logger.log(err); // ثبت خطا در صورت بروز مشکل
  }
}

/* =========================
   UI
========================= */

function onOpen() {
  // اضافه کردن منوی سفارشی به رابط کاربری Google Sheets
  SpreadsheetApp.getUi()
    .createMenu("پنل تردد")
    .addItem("ساخت/بروزرسانی شیت‌ها", "setupAttendanceSheets") // آیتم برای ساخت یا بروزرسانی شیت ها
    .addItem("نمایش شیت Users", "showUsersSheet") // آیتم برای نمایش شیت Users
    .addItem("نمایش شیت RecordIndex", "showRecordIndexSheet") // آیتم برای نمایش شیت RecordIndex
    .addItem("نمایش شیت Matching", "showMatchingSheet") // آیتم برای نمایش شیت Matching
    .addSeparator() // جدا کننده
    .addItem("ساخت گزارش ماهیانه", "buildMonthlyReport") // آیتم برای ساخت گزارش ماهیانه
    .addToUi(); // اضافه کردن منو به رابط کاربری
}

function setupAttendanceSheets() {
  // فراخوانی توابع برای ایجاد یا اطمینان از وجود شیت های مورد نیاز
  getRecordsSheet();
  getUsersSheet();
  getRecordIndexSheet();
  getMatchingSheet();

  return {
    ok: true,
    message: "شیت‌ها آماده شدند."
  };
}

function showUsersSheet() {
  var sheet = getUsersSheet(); // دریافت شیت Users
  sheet.showSheet(); // نمایش شیت
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet); // فعال کردن شیت
}

function showRecordIndexSheet() {
  var sheet = getRecordIndexSheet(); // دریافت شیت RecordIndex
  sheet.showSheet(); // نمایش شیت
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet); // فعال کردن شیت
}

function showMatchingSheet() {
  var sheet = getMatchingSheet(); // دریافت شیت Matching
  sheet.showSheet(); // نمایش شیت
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet); // فعال کردن شیت
}

/* =========================
   Reports
========================= */

function getPersonnelRecords(personnelCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) { // اگر شیت Records یافت نشد
    return { error: "شیت Records یافت نشد." };
  }

  var personalMessage = getActiveMessageForPersonnel(personnelCode); // دریافت پیام فعال برای کاربر
  var data = sheet.getDataRange().getValues(); // خواندن تمام داده های شیت Records

  // اگر شیت خالی است (فقط هدر یا کاملا خالی)
  if (data.length < 2) {
    return {
      headers: [],
      rows: [],
      message: personalMessage
    };
  }

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode"); // پیدا کردن ایندکس ستون کد پرسنلی
  var dateIdx = headers.indexOf("RecordDate"); // پیدا کردن ایندکس ستون تاریخ ثبت
  var hourIdx = headers.indexOf("RecordHour"); // پیدا کردن ایندکس ستون ساعت ثبت
  var riskIdx = headers.indexOf("ClockRisk"); // پیدا کردن ایندکس ستون ریسک ساعت

  // اگر ستون های ضروری یافت نشدند
  if (pIdx === -1 || dateIdx === -1 || hourIdx === -1) {
    return {
      error: "ستون‌های ضروری در شیت Records یافت نشد.",
      message: personalMessage
    };
  }

  // فیلتر کردن رکوردها بر اساس کد پرسنلی، مرتب سازی بر اساس تاریخ/ساعت (نزولی) و انتخاب 10 رکورد آخر
  var filtered = data
    .slice(1) // حذف ردیف هدر
    .filter(function (row) {
      return String(row[pIdx]) === String(personnelCode); // فیلتر بر اساس کد پرسنلی
    })
    .sort(function (a, b) { // مرتب سازی
      var bKey = String(b[dateIdx]) + String(b[hourIdx]);
      var aKey = String(a[dateIdx]) + String(a[hourIdx]);
      return bKey.localeCompare(aKey); // مرتب سازی نزولی بر اساس تاریخ و ساعت
    })
    .slice(0, 10); // انتخاب 10 رکورد آخر

  // برگرداندن داده های فیلتر شده و پیام فعال
  return {
    headers: ["کد پرسنلی", "تاریخ", "ساعت", "ریسک زمان"], // هدرهای سفارشی برای گزارش
    rows: filtered.map(function (row) { // تبدیل ردیف های فیلتر شده به فرمت مورد نظر
      return [
        row[pIdx],
        row[dateIdx],
        row[hourIdx],
        row[riskIdx] || "low" // استفاده از "low" اگر ریسک خالی است
      ];
    }),
    message: personalMessage
  };
}

function getActiveMessageForPersonnel(personnelCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MESSAGES_SHEET_NAME);

  if (!sheet) return null; // اگر شیت پیام ها وجود ندارد

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null; // اگر شیت خالی است

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var msgIdx = headers.indexOf("Message");
  var activeIdx = headers.indexOf("IsActive");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return null; // اگر ستون های مورد نیاز یافت نشدند

  // جستجو برای پیام فعال مربوط به کد پرسنلی
  for (var i = 1; i < data.length; i++) {
    var rowPersonnelCode = String(data[i][pIdx]);
    var isActive =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true";

    // اگر کد پرسنلی مطابقت داشت و پیام فعال بود
    if (rowPersonnelCode === String(personnelCode) && isActive) {
      return data[i][msgIdx]; // برگرداندن متن پیام
    }
  }

  return null; // اگر پیام فعالی یافت نشد
}

function onEdit(e) {
  // این تابع زمانی اجرا می شود که تغییری در شیت ها رخ دهد
  const sheet = e.range.getSheet(); // دریافت شیت تغییر یافته
  if (sheet.getName() !== "Users") return; // اگر شیت Users تغییر نکرده، خروج
  const row = e.range.getRow(); // ردیف تغییر یافته
  const col = e.range.getColumn(); // ستون تغییر یافته
  if (row === 1) return; // اگر ردیف هدر تغییر کرده، خروج

  const POLICY_COL = 4; // ستون مربوط به AttendancePolicy
  const VERSION_COL = 5; // ستون مربوط به PolicyVersion
  const UPDATED_COL = 6; // ستون مربوط به UpdatedAt

  // اگر ستون تغییر یافته، ستون سیاست (AttendancePolicy) باشد
  if (col !== POLICY_COL) return;

  const versionCell = sheet.getRange(row, VERSION_COL); // دریافت سلول نسخه سیاست
  const updatedCell = sheet.getRange(row, UPDATED_COL); // دریافت سلول تاریخ بروزرسانی
  let version = Number(versionCell.getValue()); // خواندن مقدار نسخه
  if (!version || isNaN(version)) version = 0; // اگر نسخه نامعتبر بود، مقدار 0 را تنظیم کن
  versionCell.setValue(version + 1); // افزایش نسخه به اندازه 1
  updatedCell.setValue(new Date()); // تنظیم تاریخ بروزرسانی به زمان فعلی
}

/* =========================
   Monthly Report
========================= */

function buildMonthlyReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var recordsSheet = ss.getSheetByName(RECORDS_SHEET_NAME); // دریافت شیت Records
  if (!recordsSheet) return; // اگر شیت Records وجود ندارد، خروج

  // دریافت یا ایجاد شیت گزارش ماهیانه
  var reportSheet = ss.getSheetByName("MonthlyReport") || ss.insertSheet("MonthlyReport");
  reportSheet.setRightToLeft(true); // تنظیم جهت صفحه به راست به چپ

  var pCode = String(reportSheet.getRange("B4").getDisplayValue()).trim(); // خواندن کد پرسنلی از شیت گزارش
  var rawDate = reportSheet.getRange("C4").getDisplayValue(); // خواندن تاریخ (ماه و سال) از شیت گزارش

  // نرمال سازی تاریخ به فرمت YYYY/MM
  var mYear = String(rawDate)
    .replace(/[۰-۹]/g, function (d) { // تبدیل اعداد فارسی به لاتین
      return "۰۱۲۳۴۵۶۷۸۹".indexOf(d);
    })
    .replace(/-/g, "/")
    .trim();

  var match = mYear.match(/^(\d{4})\/(\d{1,2})$/); // تطبیق با فرمت YYYY/MM
  if (!match) return; // اگر فرمت تاریخ نادرست بود، خروج
  mYear = match[1] + "/" + String(Number(match[2])).padStart(2, "0"); // اطمینان از فرمت MM

  var data = recordsSheet.getDataRange().getValues(); // خواندن تمام داده های شیت Records
  var entryByDay = {}; // آرایه برای نگهداری اولین زمان ورود در هر روز
  var exitByDay = {}; // آرایه برای نگهداری آخرین زمان خروج در هر روز
  var fullName = "یافت نشد"; // مقدار اولیه نام کامل کاربر

  // حلقه روی داده های شیت Records
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowCode = String(row[1] || "").trim(); // کد پرسنلی ردیف
    // نرمال سازی تاریخ و زمان ردیف
    var rowDate = String(row[4] || "")
      .replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
      .replace(/-/g, "/")
      .trim();
    var rowTime = String(row[5] || "")
      .replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
      .trim();

    // اگر کد پرسنلی و سال/ماه مطابقت داشت
    if (rowCode === pCode && rowDate.indexOf(mYear) === 0) {
      if (fullName === "یافت نشد") fullName = (row[2] + " " + row[3]).trim(); // تنظیم نام کامل کاربر

      var day = Number(rowDate.split("/")[2]); // استخراج روز از تاریخ
      if (!day) continue; // اگر روز نامعتبر بود، ادامه

      // نرمال سازی زمان به فرمت HH:MM
      var timeMatch = rowTime.match(/^(\d{1,2}):(\d{1,2})/);
      if (!timeMatch) continue; // اگر فرمت زمان نادرست بود، ادامه
      var timeVal = String(Number(timeMatch[1])).padStart(2, "0") + ":" + String(Number(timeMatch[2])).padStart(2, "0");

      // به روز رسانی اولین ورود و آخرین خروج برای آن روز
      if (!entryByDay[day] || timeVal < entryByDay[day]) entryByDay[day] = timeVal;
      if (!exitByDay[day] || timeVal > exitByDay[day]) exitByDay[day] = timeVal;
    }
  }

  // پاکسازی شیت گزارش قبل از نوشتن داده های جدید
  reportSheet.clear();
  reportSheet.setRightToLeft(true); // تنظیم جهت صفحه

  // تنظیم هدرهای اصلی شیت گزارش
  reportSheet.getRange("A2:A3").merge().setValue("نام و نام خانوادگی");
  reportSheet.getRange("B2:B3").merge().setValue("شماره پرسنلی");
  reportSheet.getRange("C2:C3").merge().setValue("ماه و سال");
  reportSheet.getRange("A4").setValue(fullName); // نمایش نام کامل کاربر
  reportSheet.getRange("B4").setValue(pCode); // نمایش کد پرسنلی
  reportSheet.getRange("C4").setValue(mYear); // نمایش ماه و سال
  reportSheet.getRange("A5:C5").merge().setValue("ورود"); // هدر ورود
  reportSheet.getRange("A6:C6").merge().setValue("خروج"); // هدر خروج

  // نوشتن داده های ورود و خروج برای هر روز ماه
  for (var d = 1; d <= 31; d++) {
    var col = d + 3; // محاسبه شماره ستون بر اساس روز
    reportSheet.getRange(3, col).setValue(d); // نوشتن شماره روز در ردیف سوم
    reportSheet.getRange(5, col).setValue(entryByDay[d] || ""); // نوشتن اولین ورود
    // نوشتن آخرین خروج (اگر با اولین ورود متفاوت بود)
    reportSheet.getRange(6, col).setValue(entryByDay[d] === exitByDay[d] ? "" : (exitByDay[d] || ""));
  }

  // تنظیمات ظاهر کلی شیت گزارش
  var rng = reportSheet.getRange("A2:AH6"); // محدوده کل جدول گزارش
  rng.setBorder(true, true, true, true, true, true) // اضافه کردن کادر
    .setHorizontalAlignment("center") // تراز وسط افقی
    .setVerticalAlignment("middle") // تراز وسط عمودی
    .setFontFamily("Tahoma") // فونت
    .setFontSize(9); // اندازه فونت

  // استایل دهی به هدرهای ماه و سال
  reportSheet.getRange("A2:AH3")
    .setBackground("#DAA520") // رنگ پس زمینه (طلایی)
    .setFontWeight("bold") // فونت ضخیم
    .setFontSize(8); // اندازه فونت کوچک تر

  reportSheet.getRange("A2:AH3").setBackground("#f3f3f3").setFontWeight("bold"); // استایل دهی مجدد هدرها (خاکستری)
  reportSheet.setColumnWidths(4, 31, 40); // تنظیم عرض ستون ها برای روزهای ماه
}
