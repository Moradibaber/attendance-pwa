/* =============================================================
   ATTENDANCE SYSTEM - CORE ENGINE (PART 1)
   ============================================================= */

// --- SHEET NAMES ---
var RECORDS_SHEET_NAME       = "Records";
var MESSAGES_SHEET_NAME      = "Messages";
var RECORD_INDEX_SHEET_NAME  = "RecordIndex";
var MATCHING_SHEET_NAME      = "Matching";
var USERS_SHEET_NAME         = "Users";
var USER_STATUS_SHEET_NAME   = "UserStatus";
var ONLINE_LOG_SHEET_NAME    = "OnlineLog"; // NEW

// --- HEADERS ---
var RECORD_HEADERS = [
  "Timestamp", "PersonnelCode", "FullName", "Status", 
  "Latitude", "Longitude", "Accuracy", "Source", "DateTimeStr"
];

var USER_STATUS_HEADERS = [
  "PersonnelCode", "FullName", "LastStatus", 
  "LastOnline", "LastOffline", "LastSeen"
];

var ONLINE_LOG_HEADERS = [
  "Timestamp", "Date", "Time", "PersonnelCode", "FullName", "Status"
];

var USERS_HEADERS = ["PersonnelCode", "FullName", "Department", "Role", "Active"];
var RECORD_INDEX_HEADERS = ["PersonnelCode", "LastRecordTime", "LastStatus", "LastLatitude", "LastLongitude"];
var MATCHING_HEADERS = ["Timestamp", "PersonnelCode", "FullName", "MatchedCode", "MatchedName", "Score"];

// --- POLICIES ---
var MIN_ACCURACY_METERS = 100;
var MAX_GEOFENCE_RADIUS_METERS = 200;

/**
 * ENTRY POINT: GET
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('AdminPanel');
  return template.evaluate()
    .setTitle('سیستم مدیریت تردد')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * ENTRY POINT: POST
 */
function doPost(e) {
  var result;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var action = e.parameter.action;
    var data = e.parameter;

    if (action === "syncOffline") {
      result = handleOfflineSync(ss, data);
    } else if (action === "statusUpdate") {
      result = handleStatusSummary(ss, data);
    } else {
      result = processAttendance(ss, data);
    }
  } catch (err) {
    result = { ok: false, message: "Server Error: " + err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
/* =============================================================
   ATTENDANCE SYSTEM - CORE ENGINE (PART 2)
   ============================================================= */

/**
 * Handles summary updates for user status.
 * If status is "Online", it calls writeOnlineLog.
 */
function handleStatusSummary(ss, data) {
  var sh = getOrCreateSheet_(ss, USER_STATUS_SHEET_NAME, USER_STATUS_HEADERS);
  var personnelCode = String(data.personnelCode || data.PersonnelCode || "").trim();
  var fullName = String(data.fullName || data.FullName || "").trim();
  var status = String(data.status || data.Status || "").trim();
  var now = new Date();

  if (!personnelCode) {
    return { ok: false, message: "PersonnelCode is required" };
  }

  var values = [
    personnelCode,
    fullName,
    status,
    "", // Placeholder for LastOnline
    "", // Placeholder for LastOffline
    now
  ];

  var row = findRowByPersonnelCode_(sh, personnelCode);
  if (row) {
    sh.getRange(row, 1, 1, values.length).setValues([values]);
  } else {
    sh.appendRow(values);
  }

  // Log online status
  if (status.toLowerCase() === "online") {
    writeOnlineLog(ss, personnelCode, fullName);
  }

  return { ok: true };
}

/**
 * Writes an entry to the OnlineLog sheet.
 */
function writeOnlineLog(ss, personnelCode, fullName) {
  try {
    var sh = getOrCreateSheet_(ss, ONLINE_LOG_SHEET_NAME, ONLINE_LOG_HEADERS);
    var now = new Date();
    var date = Utilities.formatDate(now, "Asia/Tehran", "yyyy-MM-dd");
    var time = Utilities.formatDate(now, "Asia/Tehran", "HH:mm:ss");

    sh.appendRow([
      now,
      date,
      time,
      String(personnelCode || "").trim(),
      String(fullName || "").trim(),
      "Online" // Explicitly set status to Online
    ]);
    Logger.log("Online log entry created for: " + personnelCode);
  } catch (err) {
    Logger.log("Error writing to OnlineLog: " + err.toString());
  }
}


/**
 * Main function to process attendance data.
 * This is the primary handler for incoming attendance records.
 */
function processAttendance(ss, data) {
  var recordsSheet = getOrCreateSheet_(ss, RECORDS_SHEET_NAME, RECORD_HEADERS);
  var recordIndexSheet = getOrCreateSheet_(ss, RECORD_INDEX_SHEET_NAME, RECORD_INDEX_HEADERS);

  var timestamp = new Date();
  var personnelCode = String(data.personnelCode || data.PersonnelCode || "").trim();
  var fullName = String(data.fullName || data.FullName || "").trim();
  var status = String(data.status || data.Status || "").trim().toLowerCase();
  var latitude = parseFloat(data.latitude || data.Latitude || 0);
  var longitude = parseFloat(data.longitude || data.Longitude || 0);
  var accuracy = parseFloat(data.accuracy || data.Accuracy || 0);
  var source = String(data.source || data.Source || "Unknown");

  // --- Basic Validations ---
  if (!personnelCode) {
    return { ok: false, message: "Personnel code is required." };
  }
  if (!status) {
    return { ok: false, message: "Status is required." };
  }
  if (accuracy > MIN_ACCURACY_METERS) {
    // Optionally log or handle inaccurate data
    Logger.log("Inaccurate GPS data for " + personnelCode + ": Accuracy " + accuracy + "m");
  }
  // --- End Validations ---

  var dateTimeStr = Utilities.formatDate(timestamp, "Asia/Tehran", "yyyy-MM-dd HH:mm:ss");

  // Append to Records sheet
  recordsSheet.appendRow([
    timestamp,
    personnelCode,
    fullName,
    status,
    latitude,
    longitude,
    accuracy,
    source,
    dateTimeStr
  ]);

  // Update RecordIndex sheet
  var rowIndex = findRowByPersonnelCode_(recordIndexSheet, personnelCode);
  var recordIndexValues = [
    personnelCode,
    timestamp,
    status,
    latitude,
    longitude
  ];

  if (rowIndex > 0) {
    recordIndexSheet.getRange(rowIndex, 1, 1, recordIndexValues.length).setValues([recordIndexValues]);
  } else {
    recordIndexSheet.appendRow(recordIndexValues);
  }
  
  // Update UserStatus sheet
  handleStatusSummary(ss, {
    personnelCode: personnelCode,
    fullName: fullName,
    status: status // Pass the raw status to handleStatusSummary for logging
  });

  return { ok: true, message: "Attendance recorded successfully." };
}
/* =============================================================
   ATTENDANCE SYSTEM - CORE ENGINE (PART 3)
   ============================================================= */

/**
 * Handles synchronization of offline attendance data.
 */
function handleOfflineSync(ss, data) {
  var recordsSheet = getOrCreateSheet_(ss, RECORDS_SHEET_NAME, RECORD_HEADERS);
  var recordIndexSheet = getOrCreateSheet_(ss, RECORD_INDEX_SHEET_NAME, RECORD_INDEX_HEADERS);

  var offlineEntries = data.entries;
  if (!offlineEntries || !Array.isArray(offlineEntries)) {
    return { ok: false, message: "Invalid offline entries data." };
  }

  var processedCount = 0;
  var timestamp = new Date(); // Use a single timestamp for the sync operation

  for (var i = 0; i < offlineEntries.length; i++) {
    var entry = offlineEntries[i];
    var personnelCode = String(entry.personnelCode || entry.PersonnelCode || "").trim();
    var fullName = String(entry.fullName || entry.FullName || "").trim();
    var status = String(entry.status || entry.Status || "").trim().toLowerCase();
    var latitude = parseFloat(entry.latitude || entry.Latitude || 0);
    var longitude = parseFloat(entry.longitude || entry.Longitude || 0);
    var accuracy = parseFloat(entry.accuracy || entry.Accuracy || 0);
    var source = String(entry.source || entry.Source || "Offline");
    var entryTimestamp = new Date(entry.timestamp || entry.Timestamp || timestamp); // Use entry timestamp if available, else sync timestamp
    var dateTimeStr = Utilities.formatDate(entryTimestamp, "Asia/Tehran", "yyyy-MM-dd HH:mm:ss");

    // --- Basic Validations ---
    if (!personnelCode) continue; // Skip if no personnel code
    if (!status) continue; // Skip if no status
    if (accuracy > MIN_ACCURACY_METERS) {
       Logger.log("Inaccurate GPS data during offline sync for " + personnelCode + ": Accuracy " + accuracy + "m");
    }
    // --- End Validations ---

    // Append to Records sheet
    recordsSheet.appendRow([
      entryTimestamp,
      personnelCode,
      fullName,
      status,
      latitude,
      longitude,
      accuracy,
      source,
      dateTimeStr
    ]);

    // Update RecordIndex sheet
    var rowIndex = findRowByPersonnelCode_(recordIndexSheet, personnelCode);
    var recordIndexValues = [
      personnelCode,
      entryTimestamp, // Use the entry's timestamp for the index
      status,
      latitude,
      longitude
    ];

    if (rowIndex > 0) {
      recordIndexSheet.getRange(rowIndex, 1, 1, recordIndexValues.length).setValues([recordIndexValues]);
    } else {
      recordIndexSheet.appendRow(recordIndexValues);
    }
    
    // Update UserStatus sheet for each entry
    handleStatusSummary(ss, {
      personnelCode: personnelCode,
      fullName: fullName,
      status: status
    });

    processedCount++;
  }

  return { ok: true, message: "Offline sync completed. Processed " + processedCount + " entries." };
}

/**
 * Gets or creates a sheet with the given name and headers.
 * If headers are provided and the sheet is new or empty, it sets them.
 */
function getOrCreateSheet_(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log("Sheet created: " + sheetName);
  }

  // Set headers if provided and the sheet is empty (last row is 0)
  if (headers && headers.length > 0 && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    Logger.log("Headers set for new sheet: " + sheetName);
  }
  
  // Ensure headers are present if they were missing (e.g., sheet existed but was empty)
  if (headers && headers.length > 0 && sheet.getLastRow() > 0 && sheet.getRange(1, 1).getValue() === "") {
     sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
     Logger.log("Headers were missing, now set for sheet: " + sheetName);
  }

  return sheet;
}

/**
 * Finds the row number for a given personnel code in a sheet.
 * Assumes personnel code is in the first column and data starts from row 2.
 */
function findRowByPersonnelCode_(sh, personnelCode) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0; // No data rows

  var personnelCodeStr = String(personnelCode).trim();
  var dataRange = sh.getRange(2, 1, lastRow - 1, 1); // Column A, starting from row 2
  var values = dataRange.getValues();

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === personnelCodeStr) {
      return i + 2; // Row number is index + 2 (because data starts from row 2)
    }
  }
  return 0; // Not found
}

/**
 * Retrieves user details from the Users sheet.
 */
function getUserDetails_(ss, personnelCode) {
  var usersSheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!usersSheet) return null;

  var lastRow = usersSheet.getLastRow();
  if (lastRow < 2) return null;

  var dataRange = usersSheet.getRange(2, 1, lastRow - 1, 5); // Assuming 5 columns: Code, Name, Dept, Role, Active
  var values = dataRange.getValues();
  var targetCode = String(personnelCode).trim();

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === targetCode) {
      return {
        personnelCode: values[i][0],
        fullName: values[i][1],
        department: values[i][2],
        role: values[i][3],
        active: String(values[i][4]).toLowerCase() === "true" || values[i][4] === true
      };
    }
  }
  return null; // User not found
}
/* =============================================================
   ATTENDANCE SYSTEM - ADMIN PANEL & UTILITIES (PART 4)
   ============================================================= */

/**
 * Creates custom menus in the Google Sheet UI.
 */
function onOpen(e) {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('سیستم تردد')
    .addItem('رفرش داده‌ها', 'refreshData')
    .addItem('مدیریت کاربران', 'openUserManagement')
    .addItem('گزارش تطبیق', 'openMatchingReport')
    .addToUi();

  // Check if sheets are set up, prompt if not
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(RECORDS_SHEET_NAME) === null) {
    ui.alert('نیاز به راه‌اندازی اولیه سیستم وجود دارد.', 'لطفاً برای ایجاد شیت‌های لازم، روی "OK" کلیک کنید.', ui.ButtonSet.OK);
    setupAttendanceSheets(); // Initial setup
  }
}

/**
 * Placeholder function to refresh data - needs implementation.
 */
function refreshData() {
  SpreadsheetApp.getUi().alert('تابع "رفرش داده‌ها" هنوز پیاده‌سازی نشده است.');
  // Example: Fetch latest data from sheets or external sources
}

/**
 * Opens the user management interface.
 */
function openUserManagement() {
  var html = HtmlService.createTemplateFromFile('UserManagement').evaluate()
    .setWidth(800)
    .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'مدیریت کاربران');
}

/**
 * Opens the matching report interface.
 */
function openMatchingReport() {
  var html = HtmlService.createTemplateFromFile('MatchingReport').evaluate()
    .setWidth(900)
    .setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, 'گزارش تطبیق تردد');
}

/**
 * Initiates the setup of attendance sheets.
 */
function setupAttendanceSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet_(ss, RECORDS_SHEET_NAME, RECORD_HEADERS);
  getOrCreateSheet_(ss, USERS_SHEET_NAME, USERS_HEADERS);
  getOrCreateSheet_(ss, RECORD_INDEX_SHEET_NAME, RECORD_INDEX_HEADERS);
  getOrCreateSheet_(ss, MATCHING_SHEET_NAME, MATCHING_HEADERS);
  getOrCreateSheet_(ss, USER_STATUS_SHEET_NAME, USER_STATUS_HEADERS);
  getOrCreateSheet_(ss, ONLINE_LOG_SHEET_NAME, ONLINE_LOG_HEADERS); // Ensure OnlineLog sheet is created

  SpreadsheetApp.getUi().alert('شیت‌های سیستم با موفقیت ایجاد یا تأیید شدند.');
  return { ok: true, message: "Attendance sheets setup complete." };
}

/**
 * Fetches all records from the Records sheet.
 */
function getAllRecords() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return data;
}

/**
 * Fetches all user statuses from the UserStatus sheet.
 */
function getAllUserStatuses() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USER_STATUS_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return data;
}

/**
 * Fetches all entries from the OnlineLog sheet.
 */
function getAllOnlineLogs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ONLINE_LOG_SHEET_NAME);
  if (!sheet) return [];
  // Adjust range if needed based on actual columns in OnlineLog
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return data;
}

/**
 * Fetches all user data from the Users sheet.
 */
function getAllUsers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return data;
}
/* =============================================================
   ATTENDANCE SYSTEM - UTILITIES & MATCHING LOGIC (PART 5)
   ============================================================= */

/**
 * Calculates the distance between two lat/lon points in meters.
 * Uses the Haversine formula.
 */
function calculateDistance_(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const d = R * c; // distance in metres
  return d;
}

/**
 * Checks if a given lat/lon is within a specified radius of a reference point.
 */
function isWithinRadius_(refLat, refLon, checkLat, checkLon, radiusMeters) {
  var distance = calculateDistance_(refLat, refLon, checkLat, checkLon);
  return distance <= radiusMeters;
}

/**
 * Finds potential matches for attendance records based on proximity and time.
 * This function is a placeholder and needs detailed implementation based on specific matching rules.
 */
function findPotentialMatches(ss, record) {
  var usersSheet = ss.getSheetByName(USERS_SHEET_NAME);
  var recordIndexSheet = ss.getSheetByName(RECORD_INDEX_SHEET_NAME);
  var matchingSheet = getOrCreateSheet_(ss, MATCHING_SHEET_NAME, MATCHING_HEADERS);

  if (!usersSheet || !recordIndexSheet) {
    Logger.log("Required sheets for matching not found.");
    return [];
  }

  var allUsers = usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, usersSheet.getLastColumn()).getValues();
  var allRecordIndexes = recordIndexSheet.getRange(2, 1, recordIndexSheet.getLastRow() - 1, recordIndexSheet.getLastColumn()).getValues();

  var recordTimestamp = new Date(record[0]); // Assuming record[0] is Timestamp
  var recordPersonnelCode = String(record[1]).trim();
  var recordFullName = String(record[2]).trim();
  var recordLatitude = parseFloat(record[4]);
  var recordLongitude = parseFloat(record[5]);

  var matches = [];

  // Iterate through other records (or users) to find matches
  // This is a simplified example - real matching logic would be more complex
  for (var i = 0; i < allRecordIndexes.length; i++) {
    var otherRecordIndex = allRecordIndexes[i];
    var otherPersonnelCode = String(otherRecordIndex[0]).trim();

    // Skip self-comparison
    if (recordPersonnelCode === otherPersonnelCode) continue;

    var otherRecordTime = new Date(otherRecordIndex[1]);
    var otherLatitude = parseFloat(otherRecordIndex[3]);
    var otherLongitude = parseFloat(otherRecordIndex[4]);

    // Check time proximity (e.g., within 5 minutes)
    var timeDiffMinutes = Math.abs(recordTimestamp.getTime() - otherRecordTime.getTime()) / (1000 * 60);
    if (timeDiffMinutes > 5) continue;

    // Check location proximity (e.g., within 50 meters)
    if (isWithinRadius_(recordLatitude, recordLongitude, otherLatitude, otherLongitude, 50)) {
      // Find user details for the matched record index
      var matchedUserDetails = getUserDetails_(ss, otherPersonnelCode); // Need ss here
      if (matchedUserDetails) {
        matches.push({
          timestamp: recordTimestamp,
          personnelCode: recordPersonnelCode,
          fullName: recordFullName,
          matchedCode: otherPersonnelCode,
          matchedName: matchedUserDetails.fullName,
          score: 100 // Placeholder score
        });
        // Optionally, log the match to the Matching sheet
        matchingSheet.appendRow([recordTimestamp, recordPersonnelCode, recordFullName, otherPersonnelCode, matchedUserDetails.fullName, 100]);
      }
    }
  }

  return matches;
}

/**
 * Helper to get user details, passing Spreadsheet object.
 */
function getUserDetails_(ss, personnelCode) {
  var usersSheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!usersSheet) return null;

  var lastRow = usersSheet.getLastRow();
  if (lastRow < 2) return null;

  var dataRange = usersSheet.getRange(2, 1, lastRow - 1, usersSheet.getLastColumn());
  var values = dataRange.getValues();
  var targetCode = String(personnelCode).trim();

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === targetCode) {
      return {
        personnelCode: values[i][0],
        fullName: values[i][1],
        department: values[i][2],
        role: values[i][3],
        active: String(values[i][4]).toLowerCase() === "true" || values[i][4] === true
      };
    }
  }
  return null;
}

/**
 * Final setup routine called during initial setup or when needed.
 */
function initializeSystem() {
  setupAttendanceSheets();
  // Add any other initialization tasks here
}
