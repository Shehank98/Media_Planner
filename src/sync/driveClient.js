import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from '../config.js';

// Read-only Drive access via a service account. Share the target folder with
// the service account's client_email - the account has no Drive of its own.
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Spreadsheet MIME types worth downloading. Native Google Sheets are exported
// to xlsx; real .xlsx files are downloaded as-is.
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS = 'application/vnd.ms-excel';
const INGESTIBLE = new Set([GOOGLE_SHEET, XLSX, XLS]);

function loadCredentials() {
  const raw = config.drive.credentialsJson;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  if (config.drive.credentialsPath && fs.existsSync(config.drive.credentialsPath)) {
    return JSON.parse(fs.readFileSync(config.drive.credentialsPath, 'utf8'));
  }
  throw new Error(
    'No Drive credentials: set GDRIVE_SERVICE_ACCOUNT_JSON (raw or base64) or GOOGLE_APPLICATION_CREDENTIALS',
  );
}

let cached = null;

export function driveClient() {
  if (cached) return cached;
  const creds = loadCredentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  cached = google.drive({ version: 'v3', auth });
  return cached;
}

/** List every ingestible spreadsheet in the configured folder, newest first. */
export async function listAdexFiles({ folderId = config.drive.folderId } = {}) {
  if (!folderId) throw new Error('GDRIVE_FOLDER_ID is not set');
  const drive = driveClient();
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum)',
      pageSize: 200,
      pageToken,
      // Required for files living in a Shared Drive.
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'modifiedTime desc',
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files.filter((f) => INGESTIBLE.has(f.mimeType));
}

/** Download a Drive file into a Buffer, exporting native Sheets to xlsx. */
export async function downloadFile(file) {
  const drive = driveClient();
  const opts = { responseType: 'arraybuffer' };

  const res = file.mimeType === GOOGLE_SHEET
    ? await drive.files.export({ fileId: file.id, mimeType: XLSX }, opts)
    : await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        opts,
      );

  return Buffer.from(res.data);
}
