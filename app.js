/**  <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
 *   Google Apps Script - Attendance Admin Panel
 *   FULL FILE – lookup policy only by PersonnelCode (name is ignored)
 *   >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 
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
   UPDATED doGet
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
   NEW MESSAGE API
========================= */

function getMessagesForPersonnel_(personnelCode) {
  var pcode = String(personnelCode || "").trim();
  if (!pcode) return [];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MESSAGES_SHEET_NAME);

  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var msgIdx = headers.indexOf("Message");
  var activeIdx = headers.indexOf("IsActive");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return [];

  var messages = [];

  for (var i = 1; i < data.length; i++) {
    var rowCode = String(data[i][pIdx]).trim();
    var active =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true" ||
      String(data[i][activeIdx]) === "1";

    if (rowCode === pcode && active) {
      var msg = String(data[i][msgIdx] || "").trim();
      if (msg) {
        messages.push(msg);
      }
    }
  }

  return messages;
}

function getUserGeoFence_(personnelCode) {
  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();

  if (data.length < 2) return null;

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var minLatIdx = headers.indexOf("MinLatitude");
  var maxLatIdx = headers.indexOf("MaxLatitude");
  var minLngIdx = headers.indexOf("MinLongitude");
  var maxLngIdx = headers.indexOf("MaxLongitude");

  if (pIdx === -1) return null;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]).trim() === String(personnelCode).trim()) {
      return {
        minLat: Number(data[i][minLatIdx] || 0),
        maxLat: Number(data[i][maxLatIdx] || 0),
        minLng: Number(data[i][minLngIdx] || 0),
        maxLng: Number(data[i][maxLngIdx] || 0)
      };
    }
  }

  return null;
}

function isInsideGeoFence_(latitude, longitude, fence) {
  if (!fence) return true;
  if (!latitude || !longitude) return false;

  return (
    latitude >= fence.minLat &&
    latitude <= fence.maxLat &&
    longitude >= fence.minLng &&
    longitude <= fence.maxLng
  );
}

function doPost(e) {
  try {
    var payload = parsePayload(e);
    var now = new Date();

    var normalized = normalizeAttendancePayload(payload);
    
    var geoFence = getUserGeoFence_(normalized.personnelCode);
    var insideGeoFence = isInsideGeoFence_(
      Number(normalized.latitude),
      Number(normalized.longitude),
      geoFence
    );
    var geoFenceStatus = insideGeoFence ? "داخل محدوده" : "خارج از محدوده";

    var policyCheck = validateAttendancePolicy_(normalized, now);

    normalized.attendancePolicy = policyCheck.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;
    normalized.policyVersion = Number(policyCheck.policyVersion || 0);
    normalized.policyFetchedAt = policyCheck.checkedAt
      ? policyCheck.checkedAt.toISOString()
      : (normalized.policyFetchedAt || "");
    normalized.policySource = "server";

    if (!policyCheck.ok) {
      return jsonResponse({
        ok: false,
        error: policyCheck.error || "POLICY_VIOLATION",
        code: "POLICY_VIOLATION",
        attendancePolicy: normalized.attendancePolicy,
        policyVersion: normalized.policyVersion
      });
    }

    var photoAsset = resolvePhotoAsset_(normalized.photo, normalized.personnelCode, now);

    var recordsSheet = getRecordsSheet();
    var indexSheet = getRecordIndexSheet();
    var matchingSheet = getMatchingSheet();

    var signature = buildRecordSignature_(normalized, photoAsset.signatureSource);

    if (isDuplicateRecord_(indexSheet, signature)) {
      return jsonResponse({
        ok: true,
        message: "قبلاً ثبت شده",
        duplicate: true,
        signature: signature,
        attendancePolicy: normalized.attendancePolicy,
        policyVersion: normalized.policyVersion
      });
    }

    var history = getPersonnelHistory_(indexSheet, normalized.personnelCode);
    var clockRiskResult = calculateClockRisk(normalized, history);

    var rowData = [
      now,
      normalized.personnelCode,
      normalized.firstName,
      normalized.lastName,
      normalized.recordDate,
      normalized.recordHour,
      normalized.latitude,
      normalized.longitude,
      normalized.accuracy,
      normalized.deviceTime,
      normalized.offlineCreated,
      clockRiskResult.clockRisk,
      "", // Placeholder for Photo formula/URL to match standard RECORD_HEADERS
      geoFenceStatus
    ];

    recordsSheet.appendRow(rowData);

    var recordRow = recordsSheet.getLastRow();

    // Photo column is index 13 (1-based index)
    if (photoAsset.formula) {
      recordsSheet
        .getRange(recordRow, 13)
        .setFormula(photoAsset.formula);
    } else if (photoAsset.url) {
      recordsSheet
        .getRange(recordRow, 13)
        .setValue(photoAsset.url);
    }

    appendRecordIndexRow_(indexSheet, {
      signature: signature,
      row: recordRow,
      now: now,
      normalized: normalized,
      photoUrl: photoAsset.url,
      gpsTrueTimeDiffMs: normalized.gpsTrueTimeDiffMs
    });

    appendMatchingRow_(matchingSheet, {
      recordRow: recordRow,
      now: now,
      normalized: normalized,
      clockRiskResult: clockRiskResult,
      photoUrl: photoAsset.url
    });

    return jsonResponse({
      ok: true,
      message: "ثبت شد",
      duplicate: false,
      signature: signature,
      clockRisk: clockRiskResult.clockRisk,
      clockRiskReason: clockRiskResult.clockRiskReason,
      gpsTrueTimeDiffMs: normalized.gpsTrueTimeDiffMs,
      photoUrl: photoAsset.url,
      attendancePolicy: normalized.attendancePolicy,
      policyVersion: normalized.policyVersion
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err && err.stack ? err.stack : err)
    });
  }
}

function handleGetUserPolicy_(e) {
  try {
    var personnelCode = stringifyOrBlank(
      e && e.parameter ? e.parameter.personnelCode : ""
    );

    if (!personnelCode) {
      return jsonResponse({
        ok: false,
        error: "PersonnelCode الزامی است."
      });
    }

    var userPolicy = getUserPolicy_(personnelCode);

    return jsonResponse({
      ok: true,
      personnelCode: personnelCode,
      attendancePolicy: userPolicy.attendancePolicy,
      policyVersion: userPolicy.policyVersion,
      updatedAt: userPolicy.updatedAt
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err)
    });
  }
}

function getUserPolicy_(personnelCode) {
  var pcode = String(personnelCode || "").trim();
  if (!pcode) {
    return {
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      updatedAt: ""
    };
  }

  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();

  if (data.length < 2) {
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
    return {
      attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
      policyVersion: 0,
      updatedAt: ""
    };
  }

  for (var i = 1; i < data.length; i++) {
    var rowCode = String(data[i][personnelIdx]).trim();
    if (rowCode === pcode) {
      return {
        attendancePolicy: normalizeAttendancePolicy_(data[i][policyIdx]),
        policyVersion: versionIdx === -1 ? 0 : Number(data[i][versionIdx] || 0),
        updatedAt: updatedIdx === -1 ? "" : data[i][updatedIdx]
      };
    }
  }

  return {
    attendancePolicy: DEFAULT_ATTENDANCE_POLICY,
    policyVersion: 0,
    updatedAt: ""
  };
}

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

  var gpsTimestamp = stringifyOrBlank(
    payload.gpsTimestamp || payload.geoTimestamp
  );

  var gpsWaitMs = normalizeIntegerOrBlank(payload.gpsWaitMs);
  var photoDelayMs = normalizeIntegerOrBlank(payload.photoDelayMs);

  var offlineCreated = parseBoolean(payload.offlineCreated);
  var createdAt = stringifyOrBlank(payload.createdAt);
  var photo = stringifyOrBlank(payload.photo);

  var locationStatus = stringifyOrBlank(payload.locationStatus);
  var locationError = stringifyOrBlank(payload.locationError);

  var sessionClockDriftMs = normalizeIntegerOrBlank(
    payload.sessionClockDriftMs
  );

  var networkClockDriftMs = normalizeIntegerOrBlank(
    payload.networkClockDriftMs
  );

  var attendancePolicy = normalizeAttendancePolicy_(
    payload.attendancePolicy
  );

  var policyVersion = normalizeIntegerOrBlank(payload.policyVersion);
  var policyFetchedAt = stringifyOrBlank(payload.policyFetchedAt);
  var policySource = stringifyOrBlank(payload.policySource);

  var gpsTrueTimeDiffMs = calculateGpsTrueTimeDiffMs(
    gpsTimestamp,
    deviceTimeAtGps
  );

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

function validateAttendancePolicy_(normalized, now) {
  var userPolicy = getUserPolicy_(normalized.personnelCode);
  var attendancePolicy = normalizeAttendancePolicy_(
    userPolicy.attendancePolicy
  );

  var policyVersion = Number(userPolicy.policyVersion || 0);
  var isOfflineRecord = normalized.offlineCreated === true;

  if (attendancePolicy === POLICY_NOT_ALLOWED) {
    return {
      ok: false,
      error: "برای این کاربر هیچ نوع ثبت ترددی مجاز نیست.",
      attendancePolicy,
      policyVersion,
      checkedAt: now || new Date()
    };
  }

  if (attendancePolicy === POLICY_ONLINE_ONLY && isOfflineRecord) {
    return {
      ok: false,
      error: "برای این کاربر فقط ثبت آنلاین مجاز است.",
      attendancePolicy,
      policyVersion,
      checkedAt: now || new Date()
    };
  }

  if (attendancePolicy === POLICY_OFFLINE_ONLY && !isOfflineRecord) {
    return {
      ok: false,
      error: "برای این کاربر فقط ثبت آفلاین مجاز است.",
      attendancePolicy,
      policyVersion,
      checkedAt: now || new Date()
    };
  }

  return {
    ok: true,
    attendancePolicy,
    policyVersion,
    checkedAt: now || new Date()
  };
}

function calculateClockRisk(data, history) {
  var score = 0;
  var reasons = [];

  var offlineCreated = data.offlineCreated === true;
  var locationStatus = stringifyOrBlank(data.locationStatus).toLowerCase();
  var locationError = stringifyOrBlank(data.locationError);

  var sessionClockDriftMs = Math.abs(
    Number(data.sessionClockDriftMs) || 0
  );

  var networkClockDriftMs = Math.abs(
    Number(data.networkClockDriftMs) || 0
  );

  var gpsTrueTimeDiffMs = Math.abs(
    Number(data.gpsTrueTimeDiffMs) || 0
  );

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

    if (
      offlineDelayMs !== null &&
      offlineDelayMs > OFFLINE_UPLOAD_GRACE_MS
    ) {
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
      clockRiskReason:
        reasons.length ? reasons.join(" | ") : "ریسک بالا"
    };
  }

  if (score >= 3) {
    return {
      clockRisk: "medium",
      clockRiskReason:
        reasons.length ? reasons.join(" | ") : "ریسک متوسط"
    };
  }

  return {
    clockRisk: "low",
    clockRiskReason:
      reasons.length ? reasons.join(" | ") : "نرمال"
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

  if (ms === null) {
    return null;
  }

  return Math.abs(Date.now() - ms);
}

function calculateGpsTrueTimeDiffMs(gpsTimestamp, deviceTimeAtGps) {
  if (!gpsTimestamp || !deviceTimeAtGps) {
    return "";
  }

  var gpsMs = parseDateToMs(gpsTimestamp);
  var deviceMs = parseDateToMs(deviceTimeAtGps);

  if (gpsMs === null || deviceMs === null) {
    return "";
  }

  return Math.round(gpsMs - deviceMs);
}

function getRecordsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(RECORDS_SHEET_NAME);
  }

  ensureHeaders(sheet, RECORD_HEADERS);
  return sheet;
}

function getUsersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
  }

  ensureHeaders(sheet, USERS_HEADERS);
  return sheet;
}

function getRecordIndexSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORD_INDEX_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(RECORD_INDEX_SHEET_NAME);
  }

  ensureHeaders(sheet, RECORD_INDEX_HEADERS);
  hideSheetSafely_(sheet);

  return sheet;
}

function getMatchingSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MATCHING_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(MATCHING_SHEET_NAME);
  }

  ensureHeaders(sheet, MATCHING_HEADERS);

  return sheet;
}

function ensureHeaders(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();

  if (lastRow < 1) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers]);
    styleHeader_(sheet, headers.length);
    return;
  }

  var currentHeaders =
    lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      : [];

  var mismatch = false;

  if (lastCol !== headers.length) {
    mismatch = true;
  }

  for (var i = 0; i < headers.length; i++) {
    if (String(currentHeaders[i] || "") !== String(headers[i])) {
      mismatch = true;
      break;
    }
  }

  if (!mismatch) {
    styleHeader_(sheet, headers.length);
    return;
  }

  if (lastCol > 0) {
    sheet
      .getRange(1, 1, 1, lastCol)
      .clearFormat();
  }

  sheet
    .getRange(1, 1, 1, headers.length)
    .setValues([headers]);
  styleHeader_(sheet, headers.length);

  if (lastCol > headers.length) {
    sheet.deleteColumns(headers.length + 1, lastCol - headers.length);
  }
}

function styleHeader_(sheet, headerLength) {
  sheet
    .getRange(1, 1, 1, headerLength)
    .setFontWeight("bold")
    .setBackground("#f3f3f3");

  sheet.setFrozenRows(1);
}

function appendRecordIndexRow_(sheet, info) {
  ensureHeaders(sheet, RECORD_INDEX_HEADERS);

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
  ensureHeaders(sheet, MATCHING_HEADERS);

  sheet.appendRow([
    info.recordRow || "",
    info.now || new Date(),
    info.normalized.personnelCode || "",
    !!info.normalized.offlineCreated,
    info.normalized.createdAt || "",
    "",
    "",
    "",
    "",
    "",
    info.clockRiskResult.clockRisk || "",
    info.clockRiskResult.clockRiskReason || "",
    info.photoUrl || ""
  ]);

  var row = sheet.getLastRow();
  var fmt = "yyyy-mm-dd hh:mm:ss";

  sheet
    .getRange(row, 6)
    .setFormula(
      '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
        row +
        ',RecordIndex!$D:$D,FALSE),"' +
        fmt +
        '"),"")'
    );

  sheet
    .getRange(row, 7)
    .setFormula(
      '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
        row +
        ',RecordIndex!$D:$D,TRUE),"' +
        fmt +
        '"),"")'
    );

  sheet
    .getRange(row, 8)
    .setFormula(
      '=IFERROR(TEXT(MINIFS(RecordIndex!$C:$C,RecordIndex!$B:$B,$C' +
        row +
        ',RecordIndex!$D:$D,FALSE,RecordIndex!$C:$C,">"&$G' +
        row +
        '),"' +
        fmt +
        '"),"")'
    );

  sheet
    .getRange(row, 9)
    .setFormula(
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

  sheet
    .getRange(row, 10)
    .setFormula(
      '=AND($D' +
        row +
        '=TRUE,$G' +
        row +
        '<>"",$H' +
        row +
        '<>"")'
    );

  sheet
    .getRange(row, 11)
    .setFormula(
      '=IF($D' +
        row +
        '=TRUE, IFERROR(VALUE($H' +
        row +
        ')-VALUE($G' +
        row +
        '), ""), "")'
    );

  if (info.photoUrl) {
    sheet
      .getRange(row, 13)
      .setFormula(
        '=HYPERLINK("' +
          escapeFormulaString_(info.photoUrl) +
          '","مشاهده عکس")'
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

  if (data.length < 2) {
    return result;
  }

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var tsIdx = headers.indexOf("ServerTimestamp");
  var offIdx = headers.indexOf("OfflineCreated");

  if (pIdx === -1 || tsIdx === -1 || offIdx === -1) {
    return result;
  }

  var target = String(personnelCode);
  var firstOnline = null;
  var firstOffline = null;
  var lastOnline = null;
  var lastOffline = null;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]) !== target) {
      continue;
    }

    var ts = normalizeDateValue_(data[i][tsIdx]);

    if (!ts) {
      continue;
    }

    var isOffline = parseBoolean(data[i][offIdx]);

    if (isOffline) {
      result.hasPriorOffline = true;

      if (!firstOffline || ts.getTime() < firstOffline.getTime()) {
        firstOffline = ts;
      }

      if (!lastOffline || ts.getTime() > lastOffline.getTime()) {
        lastOffline = ts;
      }
    } else {
      result.hasPriorOnline = true;

      if (!firstOnline || ts.getTime() < firstOnline.getTime()) {
        firstOnline = ts;
      }

      if (!lastOnline || ts.getTime() > lastOnline.getTime()) {
        lastOnline = ts;
      }
    }
  }

  result.firstOnlineAt = firstOnline || "";
  result.firstOfflineAt = firstOffline || "";
  result.lastOnlineAt = lastOnline || "";
  result.lastOfflineAt = lastOffline || "";

  return result;
}

function isDuplicateRecord_(sheet, signature) {
  if (!signature) {
    return false;
  }

  ensureHeaders(sheet, RECORD_INDEX_HEADERS);

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return false;
  }

  var values = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues();

  var target = String(signature).trim();

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === target) {
      return true;
    }
  }

  return false;
}

function buildRecordSignature_(normalized, photoSignatureSource) {
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
    normalized.offlineCreated ? "offline" : "online",
    normalized.attendancePolicy || DEFAULT_ATTENDANCE_POLICY,
    normalized.policyVersion || 0,
    photoSignatureSource || ""
  ];

  var raw = parts
    .map(function (item) {
      return stringifyOrBlank(item);
    })
    .join("|");

  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      raw
    )
  );
}

function resolvePhotoAsset_(photo, personnelCode, now) {
  var cleanPhoto = stringifyOrBlank(photo);

  if (!cleanPhoto) {
    return {
      url: "",
      formula: "",
      signatureSource: ""
    };
  }

  if (/^https?:\/\//i.test(cleanPhoto)) {
    return {
      url: cleanPhoto,
      formula:
        '=HYPERLINK("' +
        escapeFormulaString_(cleanPhoto) +
        '","مشاهده عکس")',
      signatureSource: cleanPhoto
    };
  }

  if (cleanPhoto.indexOf("data:image/") === 0) {
    var uploaded = uploadBase64PhotoToDrive_(
      cleanPhoto,
      personnelCode,
      now
    );

    return {
      url: uploaded.url,
      formula:
        '=HYPERLINK("' +
        escapeFormulaString_(uploaded.url) +
        '","مشاهده عکس")',
      signatureSource: uploaded.fileId
    };
  }

  return {
    url: cleanPhoto,
    formula: "",
    signatureSource: cleanPhoto
  };
}

function uploadBase64PhotoToDrive_(dataUrl, personnelCode, now) {
  var matches = dataUrl.match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
  );

  if (!matches) {
    throw new Error("فرمت عکس معتبر نیست.");
  }

  var mimeType = matches[1];
  var base64Data = matches[2];
  var extension = getImageExtensionFromMime_(mimeType);

  var bytes = Utilities.base64Decode(base64Data);
  var safePersonnelCode = stringifyOrBlank(personnelCode) || "unknown";

  var timestamp = Utilities.formatDate(
    now || new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd_HHmmss_SSS"
  );

  var fileName =
    "attendance_" +
    safePersonnelCode +
    "_" +
    timestamp +
    extension;

  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var folder = getOrCreatePhotoFolder_();
  var file = folder.createFile(blob);

  file.setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW
  );

  return {
    fileId: file.getId(),
    url:
      "https://drive.google.com/uc?export=view&id=" +
      file.getId()
  };
}

function getOrCreatePhotoFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(
    PHOTO_FOLDER_PROPERTY_KEY
  );

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (err) {
      properties.deleteProperty(PHOTO_FOLDER_PROPERTY_KEY);
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folderName = "Attendance Photos - " + ss.getName();
  var folders = DriveApp.getFoldersByName(folderName);

  if (folders.hasNext()) {
    var existingFolder = folders.next();
    properties.setProperty(
      PHOTO_FOLDER_PROPERTY_KEY,
      existingFolder.getId()
    );
    return existingFolder;
  }

  var newFolder = DriveApp.createFolder(folderName);
  properties.setProperty(
    PHOTO_FOLDER_PROPERTY_KEY,
    newFolder.getId()
  );

  return newFolder;
}

function getImageExtensionFromMime_(mimeType) {
  var text = String(mimeType || "").toLowerCase();

  if (text === "image/jpeg" || text === "image/jpg") {
    return ".jpg";
  }

  if (text === "image/png") {
    return ".png";
  }

  if (text === "image/webp") {
    return ".webp";
  }

  if (text === "image/gif") {
    return ".gif";
  }

  return ".jpg";
}

function normalizeAttendancePolicy_(value) {
  var text = String(value || "")
    .trim()
    .toUpperCase();

  if (
    text === POLICY_NOT_ALLOWED ||
    text === POLICY_ONLINE_ONLY ||
    text === POLICY_OFFLINE_ONLY ||
    text === POLICY_ONLINE_PREFERRED ||
    text === POLICY_ONLINE_OR_OFFLINE ||
    text === POLICY_OFFLINE_ALLOWED_IMMEDIATE
  ) {
    return text;
  }

  return DEFAULT_ATTENDANCE_POLICY;
}

function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("درخواست خالی است.");
  }

  return JSON.parse(e.postData.contents);
}

function parseDateToMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (
    Object.prototype.toString.call(value) === "[object Date]"
  ) {
    var directTime = value.getTime();
    return isNaN(directTime) ? null : directTime;
  }

  if (typeof value === "number") {
    return isFinite(value) ? value : null;
  }

  var text = String(value).trim();

  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    var numericValue = Number(text);
    return isFinite(numericValue) ? numericValue : null;
  }

  var dateMs = new Date(text).getTime();

  if (!isNaN(dateMs)) {
    return dateMs;
  }

  return null;
}

function normalizeDateValue_(value) {
  var ms = parseDateToMs(value);

  if (ms === null) {
    return null;
  }

  var date = new Date(ms);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function normalizeDecimalOrBlank(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  var numberValue = Number(value);

  if (!isFinite(numberValue)) {
    return "";
  }

  return numberValue;
}

function normalizeIntegerOrBlank(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  var numberValue = Number(value);

  if (!isFinite(numberValue)) {
    return "";
  }

  return Math.round(numberValue);
}

function parseBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return false;

  var text = String(value).trim().toLowerCase();

  return (
    text === "true" ||
    text === "1" ||
    text === "yes" ||
    text === "y" ||
    text === "بله" ||
    text === "آفلاین" ||
    text === "offline"
  );
}

function stringifyOrBlank(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function escapeFormulaString_(value) {
  return String(value || "").replace(/"/g, '""');
}

function hideSheetSafely_(sheet) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (ss.getSheets().length > 1) {
      sheet.hideSheet();
    }
  } catch (err) {
    Logger.log(err);
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ============================================================
   UPDATED onOpen - Combines Original + New Report Menu
   ============================================================ */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("پنل تردد")
    .addItem("ساخت/بروزرسانی شیت‌ها", "setupAttendanceSheets")
    .addItem("نمایش شیت Users", "showUsersSheet")
    .addItem("نمایش شیت RecordIndex", "showRecordIndexSheet")
    .addItem("نمایش شیت Matching", "showMatchingSheet")
    .addSeparator()
    .addItem("ساخت گزارش ماهیانه", "buildMonthlyReport")
    .addToUi();
}

function setupAttendanceSheets() {
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
  var sheet = getUsersSheet();
  sheet.showSheet();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
}

function showRecordIndexSheet() {
  var sheet = getRecordIndexSheet();
  sheet.showSheet();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
}

function showMatchingSheet() {
  var sheet = getMatchingSheet();
  sheet.showSheet();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
}

function getPersonnelRecords(personnelCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) {
    return {
      error: "شیت Records یافت نشد."
    };
  }

  var personalMessage = getActiveMessageForPersonnel(
    personnelCode
  );

  var data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return {
      headers: [],
      rows: [],
      message: personalMessage
    };
  }

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var dateIdx = headers.indexOf("RecordDate");
  var hourIdx = headers.indexOf("RecordHour");
  var riskIdx = headers.indexOf("ClockRisk");

  if (pIdx === -1 || dateIdx === -1 || hourIdx === -1) {
    return {
      error: "ستون‌های ضروری در شیت Records یافت نشد.",
      message: personalMessage
    };
  }

  var filtered = data
    .slice(1)
    .filter(function (row) {
      return String(row[pIdx]) === String(personnelCode);
    })
    .sort(function (a, b) {
      var bKey =
        String(b[dateIdx]) + String(b[hourIdx]);
      var aKey =
        String(a[dateIdx]) + String(a[hourIdx]);
      return bKey.localeCompare(aKey);
    })
    .slice(0, 10);

  return {
    headers: ["کد پرسنلی", "تاریخ", "ساعت", "ریسک زمان"],
    rows: filtered.map(function (row) {
      return [
        row[pIdx],
        row[dateIdx],
        row[hourIdx],
        row[riskIdx] || "low"
      ];
    }),
    message: personalMessage
  };
}

function getActiveMessageForPersonnel(personnelCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MESSAGES_SHEET_NAME);

  if (!sheet) {
    return null;
  }

  var data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return null;
  }

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var msgIdx = headers.indexOf("Message");
  var activeIdx = headers.indexOf("IsActive");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) {
    return null;
  }

  for (var i = 1; i < data.length; i++) {
    var rowPersonnelCode = String(data[i][pIdx]);
    var isActive =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true";

    if (
      rowPersonnelCode === String(personnelCode) &&
      isActive
    ) {
      return data[i][msgIdx];
    }
  }

  return null;
}

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== "Users") return;
  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row === 1) return;
  const POLICY_COL = 4;
  const VERSION_COL = 5;
  const UPDATED_COL = 6;
  if (col !== POLICY_COL) return;
  const versionCell = sheet.getRange(row, VERSION_COL);
  const updatedCell = sheet.getRange(row, UPDATED_COL);
  let version = Number(versionCell.getValue());
  if (!version || isNaN(version)) version = 0;
  versionCell.setValue(version + 1);
  updatedCell.setValue(new Date());
}

/* ============================================================
   MONTHLY REPORT ENGINE - SAFE & NON-DESTRUCTIVE
   ============================================================ */
function buildMonthlyReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var recordsSheet = ss.getSheetByName(RECORDS_SHEET_NAME);
  if (!recordsSheet) return;

  var reportSheet = ss.getSheetByName("MonthlyReport") || ss.insertSheet("MonthlyReport");
  var pCode = String(reportSheet.getRange("B4").getDisplayValue()).trim();
  var rawDate = reportSheet.getRange("C4").getDisplayValue();
  
  // Normalize Month/Year from C4
  var mYear = String(rawDate).replace(/[۰-۹]/g, function(d){return "۰۱۲۳۴۵۶۷۸۹".indexOf(d)}).replace(/-/g, "/").trim();
  var match = mYear.match(/^(\d{4})\/(\d{1,2})$/);
  if (!match) return;
  mYear = match[1] + "/" + String(Number(match[2])).padStart(2, "0");

  var data = recordsSheet.getDataRange().getValues();
  var entryByDay = {};
  var exitByDay = {};
  var fullName = "یافت نشد";

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowCode = String(row[1] || "").trim(); // Column B: PersonnelCode
    var rowDate = String(row[4] || "").replace(/[۰-۹]/g, function(d){return "۰۱۲۳۴۵۶۷۸۹".indexOf(d)}).replace(/-/g, "/").trim(); // Column E: RecordDate
    var rowTime = String(row[5] || "").replace(/[۰-۹]/g, function(d){return "۰۱۲۳۴۵۶۷۸۹".indexOf(d)}).trim(); // Column F: RecordHour

    if (rowCode === pCode && rowDate.indexOf(mYear) === 0) {
      if (fullName === "یافت نشد") fullName = (row[2] + " " + row[3]).trim();
      var day = Number(rowDate.split("/")[2]);
      if (!day) continue;
      
      var timeMatch = rowTime.match(/^(\d{1,2}):(\d{1,2})/);
      if (!timeMatch) continue;
      var timeVal = String(Number(timeMatch[1])).padStart(2, '0') + ":" + String(Number(timeMatch[2])).padStart(2, '0');

      if (!entryByDay[day] || timeVal < entryByDay[day]) entryByDay[day] = timeVal;
      if (!exitByDay[day] || timeVal > exitByDay[day]) exitByDay[day] = timeVal;
    }
  }

  // Draw
  reportSheet.clear();
  reportSheet.setRightToLeft(true);
  reportSheet.getRange("A2:A3").merge().setValue("نام و نام خانوادگی");
  reportSheet.getRange("B2:B3").merge().setValue("شماره پرسنلی");
  reportSheet.getRange("C2:C3").merge().setValue("ماه و سال");
  reportSheet.getRange("A4").setValue(fullName);
  reportSheet.getRange("B4").setValue(pCode);
  reportSheet.getRange("C4").setValue(mYear);
  reportSheet.getRange("A5:C5").merge().setValue("ورود");
  reportSheet.getRange("A6:C6").merge().setValue("خروج");

  for (var d = 1; d <= 31; d++) {
    var col = d + 3;
    reportSheet.getRange(3, col).setValue(d);
    reportSheet.getRange(5, col).setValue(entryByDay[d] || "");
    reportSheet.getRange(6, col).setValue(entryByDay[d] === exitByDay[d] ? "" : (exitByDay[d] || ""));
  }
  
  var rng = reportSheet.getRange("A2:AH6");
  rng.setBorder(true, true, true, true, true, true)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setFontFamily("Tahoma")
    .setFontSize(9);

  reportSheet.getRange("A2:AH3")
    .setBackground("#DAA520")
    .setFontWeight("bold")
    .setFontSize(8);

  reportSheet.getRange("A2:AH3").setBackground("#f3f3f3").setFontWeight("bold");
  reportSheet.setColumnWidths(4, 31, 40);
}
