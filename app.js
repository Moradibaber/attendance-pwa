/**
 * Google Apps Script - Attendance Admin Panel, Monthly Report & Personal Messages
 */

const RECORDS_SHEET_NAME = "Records";
const MESSAGES_SHEET_NAME = "Messages"; // نام تب پیام‌ها مطابق تصویر

const RECORD_HEADERS = [
  "Timestamp",
  "PersonnelCode",
  "FirstName",
  "LastName",
  "RecordType",
  "RecordDate",
  "RecordHour",
  "RecordTime",
  "Latitude",
  "Longitude",
  "Accuracy",
  "LocationStatus",
  "LocationError",
  "DeviceTime",
  "GeoTimestamp",
  "Photo",
  "CreatedAt",
  "Status"
];

function doGet(e) {
  return HtmlService.createTemplateFromFile("AdminPanel")
    .evaluate()
    .setTitle("پنل مدیریت تردد")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function doPost(e) {
  try {
    const payload = parsePayload(e);
    const sheet = getRecordsSheet();

    const finalRecordTime =
      payload.recordTime ||
      payload.recordHour ||
      extractTimeFromDeviceTime(payload.deviceTime) ||
      "";

    const geoTimestamp =
      payload.geoTimestamp ||
      payload.locationTimestamp ||
      payload.gpsTimestamp ||
      "";

    sheet.appendRow([
      new Date(),
      payload.personnelCode || "",
      payload.firstName || "",
      payload.lastName || "",
      payload.type || "تردد",
      payload.recordDate || "",
      finalRecordTime,
      finalRecordTime,
      payload.latitude || "",
      payload.longitude || "",
      payload.accuracy || "",
      payload.locationStatus || "",
      payload.locationError || "",
      payload.deviceTime || "",
      geoTimestamp,
      payload.photo || "",
      payload.createdAt || "",
      "sent"
    ]);

    return jsonResponse({
      ok: true,
      message: "تردد با موفقیت در Google Sheet ثبت شد ✅"
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: "خطا در ثبت تردد ❌",
      error: error.message || String(error)
    });
  }
}

function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("درخواست خالی است.");
  }

  return JSON.parse(e.postData.contents);
}

function getRecordsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(RECORDS_SHEET_NAME);
  }

  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), RECORD_HEADERS.length);
  const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

  let needsHeader = false;

  for (let i = 0; i < RECORD_HEADERS.length; i++) {
    if (currentHeaders[i] !== RECORD_HEADERS[i]) {
      needsHeader = true;
      break;
    }
  }

  if (needsHeader) {
    sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * دریافت سوابق پرسنل و چک کردن پیام‌های فعال
 */
function getPersonnelRecords(personnelCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!sheet) {
    return { error: "شیت Records یافت نشد." };
  }

  const personalMessage = getActiveMessageForPersonnel(personnelCode);

  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return {
      headers: ["PersonnelCode", "RecordDate", "RecordTime", "RecordType", "Status"],
      rows: [],
      message: personalMessage
    };
  }

  const headers = data[0];
  const pIdx = headers.indexOf("PersonnelCode");
  const dateIdx = headers.indexOf("RecordDate");
  const hourIdx = headers.indexOf("RecordHour");
  const timeIdx = headers.indexOf("RecordTime");
  const typeIdx = headers.indexOf("RecordType");
  const statusIdx = headers.indexOf("Status");

  if (pIdx === -1) {
    return { error: "ستون PersonnelCode یافت نشد." };
  }

  const filtered = data.slice(1).filter((row) => {
    return String(row[pIdx]) === String(personnelCode);
  });

  filtered.sort((a, b) => {
    const timeA = getRowTime(a, hourIdx, timeIdx);
    const timeB = getRowTime(b, hourIdx, timeIdx);
    const dateA = String(a[dateIdx] || "") + " " + String(timeA || "");
    const dateB = String(b[dateIdx] || "") + " " + String(timeB || "");
    return dateB.localeCompare(dateA);
  });

  return {
    headers: ["PersonnelCode", "RecordDate", "RecordTime", "RecordType", "Status"],
    rows: filtered.map((row) => {
      const finalTime = getRowTime(row, hourIdx, timeIdx);

      return [
        row[pIdx] || "",
        row[dateIdx] || "",
        finalTime || "",
        typeIdx !== -1 ? row[typeIdx] || "" : "",
        statusIdx !== -1 ? row[statusIdx] || "" : ""
      ];
    }),
    message: personalMessage
  };
}

/**
 * پیدا کردن پیام فعال در شیت Messages
 */
function getActiveMessageForPersonnel(personnelCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mSheet = ss.getSheetByName(MESSAGES_SHEET_NAME);

  if (!mSheet) return null;

  const data = mSheet.getDataRange().getValues();

  if (data.length < 2) return null;

  const headers = data[0];
  const pIdx = headers.indexOf("PersonnelCode");
  const msgIdx = headers.indexOf("Message");
  const activeIdx = headers.indexOf("IsActive");

  if (pIdx === -1 || msgIdx === -1 || activeIdx === -1) return null;

  const searchCode = String(personnelCode).trim();

  for (let i = 1; i < data.length; i++) {
    const rowPCode = String(data[i][pIdx]).trim();
    const isActive = data[i][activeIdx];

    if (
      rowPCode === searchCode &&
      (isActive === true || String(isActive).toUpperCase() === "TRUE")
    ) {
      return data[i][msgIdx];
    }
  }

  return null;
}

function buildMonthlyReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const recordsSheet = ss.getSheetByName(RECORDS_SHEET_NAME);

  if (!recordsSheet) {
    ui.alert("شیت Records یافت نشد.");
    return;
  }

  const prompt = ui.prompt(
    "گزارش ماهیانه",
    "ماه مورد نظر را وارد کنید. مثال: ۱۴۰۵/۰۴ یا تیر ۱۴۰۵",
    ui.ButtonSet.OK_CANCEL
  );

  if (prompt.getSelectedButton() !== ui.Button.OK) return;

  const selectedMonthRaw = String(prompt.getResponseText() || "").trim();
  const selectedMonth = normalizeMonthInput(selectedMonthRaw);

  if (!selectedMonth) {
    ui.alert("ماه وارد شده معتبر نیست. مثال درست: ۱۴۰۵/۰۴ یا تیر ۱۴۰۵");
    return;
  }

  let reportSheet = ss.getSheetByName("MonthlyReport");

  if (!reportSheet) {
    reportSheet = ss.insertSheet("MonthlyReport");
  }

  reportSheet.clear();

  const data = recordsSheet.getDataRange().getValues();

  const reportHeaders = [
    "شماره پرسنلی",
    "نام",
    "نام خانوادگی",
    "ماه",
    "تاریخ",
    "اولین ورود",
    "آخرین خروج",
    "مدت حضور (دقیقه)",
    "تعداد ثبت"
  ];

  reportSheet.getRange(1, 1, 1, reportHeaders.length).setValues([reportHeaders]);

  if (data.length < 2) {
    ui.alert("داده‌ای برای گزارش وجود ندارد.");
    return;
  }

  const headers = data[0];
  const pIdx = headers.indexOf("PersonnelCode");
  const fNameIdx = headers.indexOf("FirstName");
  const lNameIdx = headers.indexOf("LastName");
  const dateIdx = headers.indexOf("RecordDate");
  const hourIdx = headers.indexOf("RecordHour");
  const timeIdx = headers.indexOf("RecordTime");

  const grouped = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const pCode = row[pIdx];
    const date = String(row[dateIdx] || "").trim();
    const time = getRowTime(row, hourIdx, timeIdx);

    if (!pCode || !date || !time) continue;

    if (normalizeRecordDateToMonth(date) !== selectedMonth) continue;

    const key = String(pCode) + "_" + date;

    if (!grouped[key]) {
      grouped[key] = {
        pCode,
        fName: fNameIdx !== -1 ? row[fNameIdx] : "",
        lName: lNameIdx !== -1 ? row[lNameIdx] : "",
        date,
        times: []
      };
    }

    grouped[key].times.push(time);
  }

  const reportData = [reportHeaders];

  Object.keys(grouped).forEach((key) => {
    const group = grouped[key];

    group.times.sort((a, b) => timeToMinutes(a) - timeToMinutes(b));

    const firstIn = group.times[0];
    const lastOut = group.times[group.times.length - 1];

    const duration =
      firstIn && lastOut && firstIn !== lastOut
        ? calculateMinutes(firstIn, lastOut)
        : 0;

    reportData.push([
      group.pCode,
      group.fName,
      group.lName,
      selectedMonthRaw,
      group.date,
      firstIn,
      lastOut,
      duration,
      group.times.length
    ]);
  });

  if (reportData.length > 1) {
    reportSheet.getRange(1, 1, reportData.length, reportData[0].length).setValues(reportData);
    reportSheet.getRange(1, 1, 1, reportHeaders.length).setFontWeight("bold");
    reportSheet.autoResizeColumns(1, reportHeaders.length);
    ui.alert("گزارش با موفقیت ساخته شد ✅");
  } else {
    ui.alert("داده‌ای یافت نشد.");
  }
}

function getRowTime(row, hourIdx, timeIdx) {
  const val =
    hourIdx !== -1 && row[hourIdx]
      ? row[hourIdx]
      : timeIdx !== -1
        ? row[timeIdx]
        : "";

  return normalizeTimeValue(val);
}

function normalizeTimeValue(value) {
  if (!value) return "";

  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return (
      pad2(value.getHours()) +
      ":" +
      pad2(value.getMinutes()) +
      ":" +
      pad2(value.getSeconds())
    );
  }

  const text = normalizeDigits(value).trim().replace(/[.：]/g, ":");
  const match = text.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);

  return match
    ? pad2(match[1]) + ":" + pad2(match[2]) + ":" + (match[3] ? pad2(match[3]) : "00")
    : text;
}

function extractTimeFromDeviceTime(value) {
  const match = normalizeDigits(value).match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);

  return match
    ? pad2(match[1]) + ":" + pad2(match[2]) + ":" + (match[3] ? pad2(match[3]) : "00")
    : "";
}

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

function pad2(v) {
  return String(v).padStart(2, "0");
}

function normalizeMonthInput(v) {
  const t = normalizeDigits(v).trim();

  const pMonths = {
    "فروردین": "01",
    "اردیبهشت": "02",
    "خرداد": "03",
    "تیر": "04",
    "مرداد": "05",
    "شهریور": "06",
    "مهر": "07",
    "آبان": "08",
    "آذر": "09",
    "دی": "10",
    "بهمن": "11",
    "اسفند": "12"
  };

  for (const m in pMonths) {
    if (t.includes(m)) {
      const yr = t.match(/\d{4}/);
      return yr ? yr[0] + "/" + pMonths[m] : "";
    }
  }

  const parts = t.replace(/[-.\\\s]/g, "/").split("/");

  return parts.length >= 2 ? parts[0] + "/" + pad2(parts[1]) : "";
}

function normalizeRecordDateToMonth(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return v.getFullYear() + "/" + pad2(v.getMonth() + 1);
  }

  const parts = normalizeDigits(v).replace(/[-.\\\s]/g, "/").split("/");

  return parts.length >= 2 ? parts[0] + "/" + pad2(parts[1]) : "";
}

function timeToMinutes(v) {
  const p = normalizeTimeValue(v).split(":");

  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function calculateMinutes(s, e) {
  return Math.max(0, timeToMinutes(e) - timeToMinutes(s));
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("پنل تردد")
    .addItem("ساخت گزارش ماهیانه", "buildMonthlyReport")
    .addToUi();
}
