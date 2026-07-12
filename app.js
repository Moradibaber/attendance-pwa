const RECORDS_SHEET_NAME = "Records";
const MESSAGES_SHEET_NAME = "Messages";
const MESSAGE_RECEIPTS_SHEET_NAME = "MessageReceipts";
const PUSH_TOKENS_SHEET_NAME = "PushTokens";
const ONLINE_LOG_SHEET_NAME = "OnlineLog";
const PUSH_MESSAGES_SHEET_NAME = "PushMessages";
const PUSH_MONITOR_LIST_SHEET_NAME = "PushMonitorList";
const RECORD_INDEX_SHEET_NAME = "RecordIndex";
const MATCHING_SHEET_NAME = "Matching";
const USERS_SHEET_NAME = "Users";
const PHOTO_FOLDER_PROPERTY_KEY = "ATTENDANCE_PHOTO_FOLDER_ID";
const REPORT_SHEET_NAME = "MonthlyReport";
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

    if (String(data.type || "").trim() === "MessageReadReceipt") {
      return handleMessageReadReceipt(ss, data);
    }

    if (String(data.type || "").trim() === "RegisterPushToken") {
      return handleRegisterPushToken(ss, data);
    }

    if (String(data.type || "").trim() === "ReportPushStatus") {
      return handleReportPushStatus(ss, data);
    }

    if (String(data.type || "").trim() === "PushReceived") {
      return handlePushReceived(ss, data);
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

  var normalized = normalizeAttendancePayload(data);
  var now = new Date();

  var validation = validateAttendancePolicy_(normalized, now);
  if (!validation.ok) {
    return jsonOut({
      ok: false,
      error: validation.error,
      attendancePolicy: validation.attendancePolicy,
      policyVersion: validation.policyVersion
    });
  }

  normalized.attendancePolicy = validation.attendancePolicy;
  normalized.policyVersion = validation.policyVersion;

  var fence = getUserGeoFence_(normalized.personnelCode);
  var insideFence = isInsideGeoFence_(normalized.latitude, normalized.longitude, fence);
  var geoFenceStatus = insideFence ? "ok" : "outside";

  var recordIndexSheet = getRecordIndexSheet();
  var matchingSheet = getMatchingSheet();

  var photoAsset = resolvePhotoAsset_(normalized.photo, normalized.personnelCode, now);
  var signature = buildRecordSignature_(normalized, photoAsset.signatureSource);

  if (isDuplicateRecord_(recordIndexSheet, signature)) {
    return jsonOut({
      ok: true,
      duplicate: true,
      message: "رکورد تکراری بود و دوباره ثبت نشد."
    });
  }

  var history = getPersonnelHistory_(recordIndexSheet, normalized.personnelCode);
  var clockRiskResult = calculateClockRisk(normalized, history);

  sh.appendRow([
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
    !!normalized.offlineCreated,
    clockRiskResult.clockRisk,
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

  if (photoAsset.formula) {
    sh.getRange(rowIndex, 13).setFormula(photoAsset.formula);
  } else {
    sh.getRange(rowIndex, 13).setValue("بدون عکس");
  }

  appendRecordIndexRow_(recordIndexSheet, {
    signature: signature,
    normalized: normalized,
    now: now,
    gpsTrueTimeDiffMs: normalized.gpsTrueTimeDiffMs,
    photoUrl: photoAsset.url,
    row: rowIndex
  });

  appendMatchingRow_(matchingSheet, {
    recordRow: rowIndex,
    now: now,
    normalized: normalized,
    clockRiskResult: clockRiskResult,
    photoUrl: photoAsset.url
  });

  return jsonOut({
    ok: true,
    sheet: "Records",
    row: rowIndex,
    attendancePolicy: normalized.attendancePolicy,
    policyVersion: normalized.policyVersion,
    geoFenceStatus: geoFenceStatus,
    offlineCreated: !!normalized.offlineCreated,
    photoUrl: photoAsset.url || ""
  });
}

function handleStatusSummary(ss, data) {
  var sh = ss.getSheetByName("UserStatus");
  if (!sh) {
    sh = ss.insertSheet("UserStatus");
  }

  ensureStatusHeaders(sh);

  if (sh.getLastRow() > 1) {
    sh.getRange(2, 4, sh.getLastRow() - 1, 3).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  }

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
    rowIndex = sh.getLastRow();
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

function handleMessageReadReceipt(ss, data) {
  var sh = ss.getSheetByName(MESSAGE_RECEIPTS_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(MESSAGE_RECEIPTS_SHEET_NAME);
  }

  ensureMessageReceiptHeaders(sh);

  var personnelCode = s(data.personnelCode).trim();
  if (!personnelCode) {
    return jsonOut({ ok: false, error: "PersonnelCode missing" });
  }

  var firstName = s(data.firstName).trim();
  var lastName = s(data.lastName).trim();
  var fullName = (firstName + " " + lastName).replace(/\s+/g, " ").trim();
  var message = s(data.message).trim();
  var deviceTime = s(data.deviceTime).trim();
  var now = new Date();

  sh.appendRow([
    now,
    personnelCode,
    fullName,
    message,
    deviceTime,
    "خوانده شد و تایید شد"
  ]);

  var rowIndex = sh.getLastRow();
  sh.getRange(rowIndex, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sh.getRange(rowIndex, 5).setNumberFormat("@");

  return jsonOut({
    ok: true,
    sheet: MESSAGE_RECEIPTS_SHEET_NAME,
    row: rowIndex,
    personnelCode: personnelCode,
    readAt: now
  });
}

function ensureMessageReceiptHeaders(sh) {
  var headers = [[
    "ServerReadAt",
    "PersonnelCode",
    "FullName",
    "Message",
    "DeviceTime",
    "Status"
  ]];

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    sh.getRange(1, 1, 1, headers[0].length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
}

/* =========================
   Web Push (FCM) - background online detection
========================= */

function getFcmAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var clientEmail = props.getProperty("FCM_CLIENT_EMAIL");
  var privateKey = props.getProperty("FCM_PRIVATE_KEY");

  if (!clientEmail || !privateKey) {
    throw new Error("FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY not set in Script Properties");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  var header = { alg: "RS256", typ: "JWT" };
  var now = Math.floor(Date.now() / 1000);
  var claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  var base64Header = Utilities.base64EncodeWebSafe(JSON.stringify(header)).replace(/=+$/, "");
  var base64Claim = Utilities.base64EncodeWebSafe(JSON.stringify(claimSet)).replace(/=+$/, "");
  var signatureInput = base64Header + "." + base64Claim;

  var signatureBytes = Utilities.computeRsaSha256Signature(signatureInput, privateKey);
  var signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, "");

  var jwt = signatureInput + "." + signature;

  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (!result.access_token) {
    throw new Error("FCM auth failed: " + response.getContentText());
  }

  return result.access_token;
}

function sendPushToPersonnel_(personnelCode, title, body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PUSH_TOKENS_SHEET_NAME);
  if (!sh) return { ok: false, error: "PushTokens sheet not found" };

  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: false, error: "No tokens registered" };

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var tIdx = headers.indexOf("FCMToken");
  if (pIdx === -1 || tIdx === -1) return { ok: false, error: "PushTokens headers missing" };

  var tokens = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]).trim() === String(personnelCode).trim()) {
      var t = String(data[i][tIdx] || "").trim();
      if (t) tokens.push(t);
    }
  }

  if (!tokens.length) return { ok: false, error: "No token found for personnelCode " + personnelCode };

  var accessToken = getFcmAccessToken_();
  var projectId = PropertiesService.getScriptProperties().getProperty("FCM_PROJECT_ID");
  var results = [];

  tokens.forEach(function (token) {
    var message = {
      message: {
        token: token,
        notification: {
          title: title || "بروزرسانی سیستم",
          body: body || "لطفا اپلیکیشن حضور و غیاب را بررسی کنید"
        },
        data: {
          type: "silent_ping",
          personnelCode: String(personnelCode)
        },
        webpush: {
          headers: { Urgency: "high" }
        }
      }
    };

    var resp = UrlFetchApp.fetch(
      "https://fcm.googleapis.com/v1/projects/" + projectId + "/messages:send",
      {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + accessToken },
        payload: JSON.stringify(message),
        muteHttpExceptions: true
      }
    );

    results.push(resp.getResponseCode() + ": " + resp.getContentText());
  });

  return { ok: true, results: results };
}

// Run this manually from the Apps Script editor to send a push,
// or wire it to the PushMessages sheet's onEdit checkbox (see onEdit below).
function sendTestPushTo200020() {
  sendPushToPersonnel_("200020", "بروزرسانی سیستم", "لطفا اپلیکیشن را باز کنید");
}

// Sends a fresh push to everyone marked Active=TRUE in the PushMonitorList
// sheet. Wire this to a time-driven trigger (e.g. every 15 minutes) so that
// every time it successfully lands on a device, a new timestamp is appended
// to that person's row in OnlineLog — giving you a running log of every time
// they were actually online that day, not just a single one-off check.
//
// PushMonitorList sheet columns: PersonnelCode | Active | Title | Body
// Run this ONCE manually (select it in the toolbar dropdown next to the Run
// button, then click Run) to create the 15-minute ping trigger via code —
// this avoids the Triggers page dropdown entirely.
// Safe to run again later: it removes any old ping trigger first so you
// never end up with duplicates.
function installPingTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "pingAllMonitoredPersonnel") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger("pingAllMonitoredPersonnel")
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log("Ping trigger installed: runs every 15 minutes.");
}

function pingAllMonitoredPersonnel() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PUSH_MONITOR_LIST_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(PUSH_MONITOR_LIST_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([["PersonnelCode", "Active", "Title", "Body"]]);
    sh.getRange(1, 1, 1, 4).setFontWeight("bold");
    sh.setFrozenRows(1);
    return;
  }

  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var aIdx = headers.indexOf("Active");
  var tIdx = headers.indexOf("Title");
  var bIdx = headers.indexOf("Body");

  if (pIdx === -1 || aIdx === -1) return;

  for (var i = 1; i < data.length; i++) {
    var personnelCode = String(data[i][pIdx] || "").trim();
    var active = data[i][aIdx] === true || String(data[i][aIdx]).toUpperCase() === "TRUE";
    if (!personnelCode || !active) continue;

    var title = tIdx !== -1 ? String(data[i][tIdx] || "") : "";
    var body = bIdx !== -1 ? String(data[i][bIdx] || "") : "";

    try {
      var pingResult = sendPushToPersonnel_(personnelCode, title, body);

      if (!pingResult.ok) {
        logError(ss, { type: "pingAllMonitoredPersonnel", personnelCode: personnelCode }, new Error(pingResult.error || "unknown push failure"));
      } else if (pingResult.results) {
        pingResult.results.forEach(function (r) {
          if (!/^2\d\d:/.test(r)) {
            logError(ss, { type: "pingAllMonitoredPersonnel", personnelCode: personnelCode }, new Error("FCM send failed: " + r));
          }
        });
      }
    } catch (err) {
      logError(ss, { type: "pingAllMonitoredPersonnel", personnelCode: personnelCode }, err);
    }
  }
}

function handleRegisterPushToken(ss, data) {
  var sh = ss.getSheetByName(PUSH_TOKENS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(PUSH_TOKENS_SHEET_NAME);

  ensurePushTokensHeaders_(sh);

  var personnelCode = s(data.personnelCode).trim();
  var token = s(data.token).trim();
  if (!personnelCode || !token) {
    return jsonOut({ ok: false, error: "personnelCode/token missing" });
  }

  var values = sh.getDataRange().getValues();
  var pIdx = 0, tIdx = 1;
  var foundRow = -1;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][pIdx]).trim() === personnelCode) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow > 0) {
    var oldToken = String(values[foundRow - 1][tIdx] || "").trim();
    if (oldToken && oldToken !== token) {
      logError(
        ss,
        { type: "RegisterPushToken", personnelCode: personnelCode },
        new Error("Token changed for " + personnelCode + " (old ends: ..." + oldToken.slice(-8) + ", new ends: ..." + token.slice(-8) + ")")
      );
    }
    sh.getRange(foundRow, 2).setValue(token);
    sh.getRange(foundRow, 3).setValue(new Date());
    sh.getRange(foundRow, 4).setValue("granted");
    sh.getRange(foundRow, 7).setValue(new Date());
  } else {
    sh.appendRow([personnelCode, token, new Date(), "granted", "", "", new Date()]);
  }

  ensureMonitoredByPushList_(ss, personnelCode);

  return jsonOut({ ok: true });
}

// Records permission status (granted/denied/default) + platform info even
// when there's no token at all - this is what makes "who denied" visible
// in the sheet instead of just an unexplained missing token.
function handleReportPushStatus(ss, data) {
  var sh = ss.getSheetByName(PUSH_TOKENS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(PUSH_TOKENS_SHEET_NAME);

  ensurePushTokensHeaders_(sh);

  var personnelCode = s(data.personnelCode).trim();
  if (!personnelCode) {
    return jsonOut({ ok: false, error: "personnelCode missing" });
  }

  var permissionStatus = s(data.permissionStatus).trim() || "unknown";
  var platform = s(data.platform).trim() || "";
  var isStandalone = !!data.isStandalone;

  var values = sh.getDataRange().getValues();
  var pIdx = 0;
  var foundRow = -1;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][pIdx]).trim() === personnelCode) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow > 0) {
    sh.getRange(foundRow, 4).setValue(permissionStatus);
    sh.getRange(foundRow, 5).setValue(platform);
    sh.getRange(foundRow, 6).setValue(isStandalone);
    sh.getRange(foundRow, 7).setValue(new Date());
  } else {
    sh.appendRow([personnelCode, "", "", permissionStatus, platform, isStandalone, new Date()]);
  }

  return jsonOut({ ok: true });
}

function ensurePushTokensHeaders_(sh) {
  var headers = ["PersonnelCode", "FCMToken", "RegisteredAt", "PermissionStatus", "Platform", "IsStandalone", "LastCheckedAt"];

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sh.setFrozenRows(1);
    return;
  }

  var existingLastCol = Math.max(sh.getLastColumn(), 1);
  var existingHeaders = sh.getRange(1, 1, 1, existingLastCol).getValues()[0];

  for (var i = 0; i < headers.length; i++) {
    var col = i + 1;
    var current = col <= existingHeaders.length ? existingHeaders[col - 1] : "";
    if (!current) {
      sh.getRange(1, col).setValue(headers[i]);
      sh.getRange(1, col).setFontWeight("bold");
    }
  }
}

// Makes sure every personnel code that ever successfully registers a push
// token is automatically added to PushMonitorList with Active=TRUE, so the
// admin doesn't have to manually add each employee by hand. If the row
// already exists, it's left untouched (so an admin who deliberately set
// Active=FALSE to pause monitoring for someone won't get overridden).
function ensureMonitoredByPushList_(ss, personnelCode) {
  var sh = ss.getSheetByName(PUSH_MONITOR_LIST_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(PUSH_MONITOR_LIST_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([["PersonnelCode", "Active", "Title", "Body"]]);
    sh.getRange(1, 1, 1, 4).setFontWeight("bold");
    sh.setFrozenRows(1);
  }

  var data = sh.getDataRange().getValues();
  var pIdx = 0;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]).trim() === personnelCode) return; // already listed, leave as-is
  }

  sh.appendRow([personnelCode, true, "بروزرسانی سیستم", "لطفا اپلیکیشن حضور و غیاب را بررسی کنید"]);
}

function handlePushReceived(ss, data) {
  var personnelCode = s(data.personnelCode).trim();
  if (!personnelCode) return jsonOut({ ok: false, error: "personnelCode missing" });

  var now = new Date();
  logOnlineEvent_(personnelCode, now);

  return jsonOut({ ok: true, loggedAt: now });
}

// Appends a timestamp to today's row for this personnelCode.
// One row per person per day; every online event that day gets appended
// to the same "Times" cell, comma-separated, with a running count.
function logOnlineEvent_(personnelCode, now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ONLINE_LOG_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(ONLINE_LOG_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([["PersonnelCode", "Date", "Times", "Count"]]);
    sh.getRange(1, 1, 1, 4).setFontWeight("bold");
    sh.setFrozenRows(1);
  }

  var tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  var timeStr = Utilities.formatDate(now, tz, "HH:mm:ss");

  var data = sh.getDataRange().getValues();
  var pIdx = 0, dIdx = 1, tIdx = 2, cIdx = 3;
  var foundRow = -1;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]).trim() === personnelCode && String(data[i][dIdx]).trim() === dateStr) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow > 0) {
    var existingTimes = String(sh.getRange(foundRow, tIdx + 1).getValue() || "").trim();
    var newTimes = existingTimes ? existingTimes + " , " + timeStr : timeStr;
    var existingCount = Number(sh.getRange(foundRow, cIdx + 1).getValue()) || 0;

    sh.getRange(foundRow, tIdx + 1).setValue(newTimes);
    sh.getRange(foundRow, cIdx + 1).setValue(existingCount + 1);
  } else {
    sh.appendRow([personnelCode, dateStr, timeStr, 1]);
  }
}

function findRowByPersonnelCode(sh, personnelCode, lastRow) {
  if (lastRow < 2) {
    return -1;
  }

  var values = sh.getRange(2, 1, lastRow - 1, 1).getValues();

  for (var i = 0; i < values.length; i++) {
    if (s(values[i][0]).trim() === personnelCode) {
      return i + 2;
    }
  }

  return -1;
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
    return null;
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function s(v) {
  return v === undefined || v === null ? "" : String(v);
}

function n(v) {
  if (v === undefined || v === null || v === "") {
    return "";
  }

  var num = Number(v);
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
  var silentIdx = headers.indexOf("Silent");
  var deliveredIdx = headers.indexOf("DeliveredAt");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return [];

  var visibleMessages = [];
  var now = new Date();

  for (var i = 1; i < data.length; i++) {
    var rowCode = String(data[i][pIdx]).trim();
    if (rowCode !== pcode) continue;

    var active =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true" ||
      String(data[i][activeIdx]) === "1";
    if (!active) continue;

    var msg = String(data[i][msgIdx] || "").trim();
    if (!msg) continue;

    var isSilent = silentIdx !== -1 && (
      data[i][silentIdx] === true ||
      String(data[i][silentIdx]).toLowerCase() === "true" ||
      String(data[i][silentIdx]) === "1"
    );

    if (isSilent) {
      var alreadyDelivered = deliveredIdx !== -1 && s(data[i][deliveredIdx]).trim() !== "";

      if (!alreadyDelivered) {
        logSilentMessageReceipt_(pcode, msg, now);

        if (deliveredIdx !== -1) {
          sheet.getRange(i + 1, deliveredIdx + 1).setValue(now);
          sheet.getRange(i + 1, deliveredIdx + 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
        }
      }

      continue;
    }

    visibleMessages.push(msg);
  }

  return visibleMessages;
}

function logSilentMessageReceipt_(personnelCode, message, now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MESSAGE_RECEIPTS_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(MESSAGE_RECEIPTS_SHEET_NAME);
  }

  ensureMessageReceiptHeaders(sh);

  sh.appendRow([
    now,
    personnelCode,
    "",
    message,
    "",
    "آنلاین تشخیص داده شد (پیام مخفی)"
  ]);

  var rowIndex = sh.getLastRow();
  sh.getRange(rowIndex, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sh.getRange(rowIndex, 5).setNumberFormat("@");
}

/* =========================
   GeoFence
========================= */

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
  if (latitude === "" || longitude === "" || latitude === null || longitude === null) return false;

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

function validateAttendancePolicy_(normalized, now) {
  var userPolicy = getUserPolicy_(normalized.personnelCode);
  var attendancePolicy = normalizeAttendancePolicy_(userPolicy.attendancePolicy);
  var policyVersion = Number(userPolicy.policyVersion || 0);
  var isOfflineRecord = normalized.offlineCreated === true;

  if (attendancePolicy === POLICY_NOT_ALLOWED) {
    return { ok: false, error: "برای این کاربر هیچ نوع ثبت ترددی مجاز نیست.", attendancePolicy: attendancePolicy, policyVersion: policyVersion, checkedAt: now || new Date() };
  }
  if (attendancePolicy === POLICY_ONLINE_ONLY && isOfflineRecord) {
    return { ok: false, error: "برای این کاربر فقط ثبت آنلاین مجاز است.", attendancePolicy: attendancePolicy, policyVersion: policyVersion, checkedAt: now || new Date() };
  }
  if (attendancePolicy === POLICY_OFFLINE_ONLY && !isOfflineRecord) {
    return { ok: false, error: "برای این کاربر فقط ثبت آفلاین مجاز است.", attendancePolicy: attendancePolicy, policyVersion: policyVersion, checkedAt: now || new Date() };
  }

  return { ok: true, attendancePolicy: attendancePolicy, policyVersion: policyVersion, checkedAt: now || new Date() };
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

  if (lastRow < 1) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader_(sheet, headers.length);
    return;
  }

  var currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var mismatch = false;

  if (lastCol !== headers.length) mismatch = true;

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
    sheet.getRange(1, 1, 1, lastCol).clearFormat();
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sheet, headers.length);

  if (lastCol > headers.length) {
    sheet.deleteColumns(headers.length + 1, lastCol - headers.length);
  }
}

function styleHeader_(sheet, headerLength) {
  sheet.getRange(1, 1, 1, headerLength).setFontWeight("bold").setBackground("#f3f3f3");
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
  if (data.length < 2) return result;

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var tsIdx = headers.indexOf("ServerTimestamp");
  var offIdx = headers.indexOf("OfflineCreated");

  if (pIdx === -1 || tsIdx === -1 || offIdx === -1) return result;

  var target = String(personnelCode);
  var firstOnline = null;
  var firstOffline = null;
  var lastOnline = null;
  var lastOffline = null;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][pIdx]) !== target) continue;

    var ts = normalizeDateValue_(data[i][tsIdx]);
    if (!ts) continue;

    var isOffline = parseBoolean(data[i][offIdx]);

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
  if (!signature) return false;
  ensureHeaders(sheet, RECORD_INDEX_HEADERS);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var target = String(signature).trim();

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === target) return true;
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

  var raw = parts.map(function (item) {
    return stringifyOrBlank(item);
  }).join("|");

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
    return { url: "", formula: "", signatureSource: "" };
  }

  if (/^https?:\/\//i.test(cleanPhoto)) {
    return {
      url: cleanPhoto,
      formula: '=HYPERLINK("' + escapeFormulaString_(cleanPhoto) + '","مشاهده عکس")',
      signatureSource: cleanPhoto
    };
  }

  if (cleanPhoto.indexOf("data:image/") === 0) {
    var uploaded = uploadBase64PhotoToDrive_(cleanPhoto, personnelCode, now);
    return {
      url: uploaded.url,
      formula: '=HYPERLINK("' + escapeFormulaString_(uploaded.url) + '","مشاهده عکس")',
      signatureSource: uploaded.fileId
    };
  }

  return { url: cleanPhoto, formula: "", signatureSource: cleanPhoto };
}

function uploadBase64PhotoToDrive_(dataUrl, personnelCode, now) {
  var matches = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matches) throw new Error("فرمت عکس معتبر نیست.");

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
  var fileName = "attendance_" + safePersonnelCode + "_" + timestamp + extension;
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var folder = getOrCreatePhotoFolder_();
  var file = folder.createFile(blob);

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    fileId: file.getId(),
    url: "https://drive.google.com/uc?export=view&id=" + file.getId()
  };
}

function getOrCreatePhotoFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(PHOTO_FOLDER_PROPERTY_KEY);

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
    properties.setProperty(PHOTO_FOLDER_PROPERTY_KEY, existingFolder.getId());
    return existingFolder;
  }

  var newFolder = DriveApp.createFolder(folderName);
  properties.setProperty(PHOTO_FOLDER_PROPERTY_KEY, newFolder.getId());
  return newFolder;
}

function getImageExtensionFromMime_(mimeType) {
  var text = String(mimeType || "").toLowerCase();

  if (text === "image/jpeg" || text === "image/jpg") return ".jpg";
  if (text === "image/png") return ".png";
  if (text === "image/webp") return ".webp";
  if (text === "image/gif") return ".gif";
  return ".jpg";
}

function normalizeAttendancePolicy_(value) {
  var text = String(value || "").trim().toUpperCase();

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
      return JSON.parse(contents);
    } catch (err) {
      try {
        var cleanStr = contents.substring(contents.indexOf("{"), contents.lastIndexOf("}") + 1);
        return JSON.parse(cleanStr);
      } catch (e2) {
        throw new Error("خطا در پارس کردن JSON ورودی: " + err.message);
      }
    }
  }

  return contents;
}

function parseDateToMs(value) {
  if (value === null || value === undefined || value === "") return null;

  if (Object.prototype.toString.call(value) === "[object Date]") {
    var directTime = value.getTime();
    return isNaN(directTime) ? null : directTime;
  }

  if (typeof value === "number") {
    return isFinite(value) ? value : null;
  }

  var text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    var numericValue = Number(text);
    return isFinite(numericValue) ? numericValue : null;
  }

  var dateMs = new Date(text).getTime();
  if (!isNaN(dateMs)) return dateMs;

  return null;
}

function normalizeDateValue_(value) {
  var ms = parseDateToMs(value);
  if (ms === null) return null;

  var date = new Date(ms);
  if (isNaN(date.getTime())) return null;

  return date;
}

function normalizeDecimalOrBlank(value) {
  if (value === null || value === undefined || value === "") return "";
  var numberValue = Number(value);
  if (!isFinite(numberValue)) return "";
  return numberValue;
}

function normalizeIntegerOrBlank(value) {
  if (value === null || value === undefined || value === "") return "";
  var numberValue = Number(value);
  if (!isFinite(numberValue)) return "";
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
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeFormulaString_(value) {
  return String(value || "").replace(/"/g, '""');
}

function hideSheetSafely_(sheet) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss.getSheets().length > 1) sheet.hideSheet();
  } catch (err) {
    Logger.log(err);
  }
}

/* =========================
   UI
========================= */

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

/* =========================
   Reports
========================= */

function getPersonnelRecords(personnelCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) {
    return { error: "شیت Records یافت نشد." };
  }

  var personalMessage = getActiveMessageForPersonnel(personnelCode);
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
      var bKey = String(b[dateIdx]) + String(b[hourIdx]);
      var aKey = String(a[dateIdx]) + String(a[hourIdx]);
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

  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;

  var headers = data[0];
  var pIdx = headers.indexOf("PersonnelCode");
  var msgIdx = headers.indexOf("Message");
  var activeIdx = headers.indexOf("IsActive");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return null;

  for (var i = 1; i < data.length; i++) {
    var rowPersonnelCode = String(data[i][pIdx]);
    var isActive =
      data[i][activeIdx] === true ||
      String(data[i][activeIdx]).toLowerCase() === "true";

    if (rowPersonnelCode === String(personnelCode) && isActive) {
      return data[i][msgIdx];
    }
  }

  return null;
}

function handleSheetEdit(e) {
  const sheet = e.range.getSheet();

  if (sheet.getName() === "PushMessages") {
    handlePushMessagesEdit_(e, sheet);
    return;
  }

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

// PushMessages sheet columns: PersonnelCode | Title | Body | SendNow | LastSentAt | LastResult
function handlePushMessagesEdit_(e, sheet) {
  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row === 1) return;

  const SENDNOW_COL = 4;
  if (col !== SENDNOW_COL) return;
  if (e.value !== "TRUE") return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // serialize so rapid multi-row checkbox clicks can't race each other
  } catch (err) {
    return; // couldn't get the lock in time - safer to skip than risk writing to the wrong row
  }

  try {
    const personnelCode = String(sheet.getRange(row, 1).getValue() || "").trim();
    const title = String(sheet.getRange(row, 2).getValue() || "").trim();
    const body = String(sheet.getRange(row, 3).getValue() || "").trim();

    if (!personnelCode) {
      sheet.getRange(row, SENDNOW_COL).setValue(false);
      return;
    }

    const result = sendPushToPersonnel_(personnelCode, title, body);

    sheet.getRange(row, SENDNOW_COL).setValue(false);
    sheet.getRange(row, 5).setValue(new Date());
    sheet.getRange(row, 5).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    sheet.getRange(row, 6).setValue(JSON.stringify(result));
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   Monthly Report
========================= */

// FILE: Code.gs

function buildMonthlyReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var recordsSheet = ss.getSheetByName(RECORDS_SHEET_NAME);
  var usersSheet = ss.getSheetByName(USERS_SHEET_NAME);
  var reportSheet = ss.getSheetByName(REPORT_SHEET_NAME) || ss.insertSheet(REPORT_SHEET_NAME);

  if (!recordsSheet || !usersSheet || !reportSheet) return;

  reportSheet.setRightToLeft(true);

  var selectedUserText = String(reportSheet.getRange("A1").getDisplayValue() || "").trim();
  var monthText = String(reportSheet.getRange("B1").getDisplayValue() || "").trim();
  var startLimitText = String(reportSheet.getRange("C1").getDisplayValue() || "").trim();
  var endLimitText = String(reportSheet.getRange("D1").getDisplayValue() || "").trim();

  var monthYear = normalizeMonthYear_(monthText);
  if (!monthYear) return;

  var startLimit = normalizeTime_(startLimitText) || "07:00:00";
  var endLimit = normalizeTime_(endLimitText) || "15:00:00";

  var startLimitSec = timeToSeconds_(startLimit);
  var endLimitSec = timeToSeconds_(endLimit);

  var users = getUsersFromSheet_(usersSheet);
  var selectedUsers = resolveSelectedUsers_(selectedUserText, users);
  var records = recordsSheet.getDataRange().getValues();

  var header = ["نام و نام خانوادگی", "شماره پرسنلی"];
  for (var day = 1; day <= 31; day++) header.push(day);

  reportSheet.getRange(2, 1, reportSheet.getMaxRows() - 1, Math.max(reportSheet.getMaxColumns(), header.length)).clearContent().clearFormat();
  reportSheet.getRange(2, 1, 1, header.length).setValues([header]);

  var output = [];
  var meta = [];

  for (var u = 0; u < selectedUsers.length; u++) {
    var user = selectedUsers[u];
    var perDay = collectUserMonthData_(records, user.code, monthYear);
    var rowValues = [user.fullName, user.code];
    var rowMeta = [];

    for (var d = 1; d <= 31; d++) {
      var dayItems = perDay[d] || [];
      if (!dayItems.length) {
        rowValues.push("");
        rowMeta.push(null);
        continue;
      }

      dayItems.sort(function (a, b) {
        return a.time.localeCompare(b.time);
      });

      var firstIn = dayItems[0].time;
      var lastOut = dayItems[dayItems.length - 1].time;
      var hasOffline = dayItems.some(function (item) { return item.offline; });

      rowValues.push(firstIn + "\n" + lastOut);
      rowMeta.push({
        firstIn: firstIn,
        lastOut: lastOut,
        firstLate: timeToSeconds_(firstIn) > startLimitSec,
        lastEarly: timeToSeconds_(lastOut) < endLimitSec,
        hasOffline: hasOffline
      });
    }

    output.push(rowValues);
    meta.push(rowMeta);
  }

  if (output.length > 0) {
    var dataRange = reportSheet.getRange(3, 1, output.length, header.length);
    dataRange.setValues(output);
    dataRange.setWrap(true);
    dataRange.setVerticalAlignment("middle");
    dataRange.setHorizontalAlignment("center");
    dataRange.setFontFamily("Tahoma");
    dataRange.setFontSize(6);
  }

  setupMonthlyReportValidation_(reportSheet, users);

  reportSheet.getRange("A1").setValue(selectedUserText || "همه");
  reportSheet.getRange("B1").setValue(monthYear);
  reportSheet.getRange("C1").setValue(startLimit);
  reportSheet.getRange("D1").setValue(endLimit);

  formatReportSheet_(reportSheet, header.length, output.length);
  applyAttendanceStyles_(reportSheet, meta);
}

function collectUserMonthData_(records, userCode, monthYear) {
  var perDay = {};

  for (var i = 1; i < records.length; i++) {
    var row = records[i];
    var code = normalizeDigits_(String(row[1] || "").trim());
    if (code !== userCode) continue;

    var rowDate = normalizeMonthYearDay_(row[4]);
    if (!rowDate || rowDate.indexOf(monthYear + "/") !== 0) continue;

    var day = Number(rowDate.split("/")[2]);
    if (!day || day < 1 || day > 31) continue;

    var rowTime = normalizeTime_(row[5]);
    if (!rowTime) continue;

    if (!perDay[day]) perDay[day] = [];
    perDay[day].push({
      time: rowTime,
      offline: isOfflineRecord_(row)
    });
  }

  return perDay;
}

function applyAttendanceStyles_(sheet, meta) {
  var skyBlue = "#87CEEB";
  var black = "#000000";
  var red = "#FF0000";

  for (var r = 0; r < meta.length; r++) {
    for (var d = 0; d < 31; d++) {
      var info = meta[r][d];
      if (!info) continue;

      var cell = sheet.getRange(3 + r, 3 + d);
      var text = info.firstIn + "\n" + info.lastOut;

      if (info.hasOffline) {
        cell.setBackground(skyBlue);
      } else {
        cell.setBackground("#FFFFFF");
      }

      var firstTextStyle = SpreadsheetApp.newTextStyle()
        .setForegroundColor(info.firstLate ? red : black)
        .build();

      var secondTextStyle = SpreadsheetApp.newTextStyle()
        .setForegroundColor(info.lastEarly ? red : black)
        .build();

      var rich = SpreadsheetApp.newRichTextValue()
        .setText(text)
        .setTextStyle(0, info.firstIn.length, firstTextStyle)
        .setTextStyle(info.firstIn.length + 1, text.length, secondTextStyle)
        .build();

      cell.setRichTextValue(rich);
    }
  }
}

function formatReportSheet_(sheet, lastCol, rowCount) {
  var totalRows = Math.max(2, rowCount + 1);

  sheet.getRange(2, 1, totalRows, lastCol)
    .setBorder(true, true, true, true, true, true)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setFontFamily("Tahoma");

  sheet.getRange(2, 1, 1, lastCol)
    .setBackground("#F3F3F3")
    .setFontWeight("bold")
    .setFontSize(7);

  if (rowCount > 0) {
    sheet.getRange(3, 1, rowCount, lastCol).setFontSize(6);
    for (var r = 3; r < 3 + rowCount; r++) {
      sheet.setRowHeight(r, 32);
    }
  }

  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 90);

  for (var c = 3; c <= lastCol; c++) {
    sheet.setColumnWidth(c, 45);
  }
}

function getUsersFromSheet_(usersSheet) {
  var data = usersSheet.getDataRange().getValues();
  var users = [];

  for (var i = 1; i < data.length; i++) {
    var code = normalizeDigits_(String(data[i][0] || "").trim());
    var firstName = String(data[i][1] || "").trim();
    var lastName = String(data[i][2] || "").trim();

    if (!code) continue;

    var fullName = (firstName + " " + lastName).trim();
    users.push({
      code: code,
      fullName: fullName,
      label: fullName + " - " + code
    });
  }

  return users;
}

function resolveSelectedUsers_(selected, users) {
  if (!selected || selected === "همه") return users;

  var selectedCode = "";
  var codeMatch = normalizeDigits_(selected).match(/\d+/);
  if (codeMatch) selectedCode = codeMatch[0];

  var found = users.filter(function (user) {
    return user.code === selectedCode || user.label === selected || user.fullName === selected;
  });

  return found.length ? found : users;
}

function setupMonthlyReportValidation_(sheet, users) {
  var list = ["همه"].concat(users.map(function (user) {
    return user.label;
  }));

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .build();

  sheet.getRange("A1").setDataValidation(rule);
}

function isOfflineRecord_(row) {
  for (var i = 0; i < row.length; i++) {
    var value = row[i];

    if (value === true) return true;

    var text = String(value || "").toLowerCase().trim();
    if (!text) continue;

    if (text === "true") return true;
    if (text.indexOf("offline") !== -1) return true;
    if (text.indexOf("آفلاین") !== -1) return true;
    if (text.indexOf("ثبت آفلاین") !== -1) return true;
  }

  return false;
}

function normalizeMonthYear_(value) {
  var text = normalizeDigits_(String(value || ""))
    .replace(/[-.]/g, "/")
    .replace(/\s/g, "");

  var match = text.match(/^(\d{4})\/(\d{1,2})$/);
  if (!match) return null;

  return match[1] + "/" + match[2].padStart(2, "0");
}

function normalizeMonthYearDay_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy/MM/dd");
  }

  var text = normalizeDigits_(String(value || ""))
    .replace(/[-.]/g, "/")
    .replace(/\s/g, "");

  var match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;

  return match[1] + "/" + match[2].padStart(2, "0") + "/" + match[3].padStart(2, "0");
}

function normalizeTime_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "HH:mm:ss");
  }

  var text = normalizeDigits_(String(value || "")).trim();
  var match = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;

  return match[1].padStart(2, "0") + ":" + match[2].padStart(2, "0") + ":" + (match[3] || "00").padStart(2, "0");
}

function normalizeDigits_(text) {
  return String(text || "").replace(/[۰-۹]/g, function (digit) {
    return "۰۱۲۳۴۵۶۷۸۹".indexOf(digit);
  });
}

function timeToSeconds_(timeText) {
  if (!timeText) return 0;
  var parts = String(timeText).split(":");
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] || 0);
}
