const SHEET_NAME = 'Records';
const DRIVE_FOLDER_NAME = 'Attendance Photos';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Sheet not found: ' + SHEET_NAME);

    const photoUrl = savePhoto(data);
    sheet.appendRow([
      data.id,
      data.personnelCode,
      data.firstName,
      data.lastName,
      data.recordType,
      data.recordDate,
      data.recordTime,
      data.recordHour,
      data.latitude,
      data.longitude,
      data.accuracy,
      photoUrl,
      data.deviceTime,
      new Date(),
      'ارسال شده',
      data.note || '',
      data.duplicateKey
    ]);

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message || error) });
  }
}

function savePhoto(data) {
  if (!data.photo) return '';
  const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);
  const base64 = data.photo.split(',')[1];
  const bytes = Utilities.base64Decode(base64);
  const fileName = `${data.personnelCode}_${data.recordDate}_${data.recordTime}_${data.recordType}_${data.id}.jpg`;
  const blob = Utilities.newBlob(bytes, 'image/jpeg', fileName);
  const file = folder.createFile(blob);
  return file.getUrl();
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
