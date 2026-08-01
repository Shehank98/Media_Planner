import fs from 'node:fs';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { config } from '../config.js';
import { getSetting, SETTING_KEYS } from '../services/settings.js';

// Drive access via a service account. The folder must be shared with the
// account's client_email - it has no Drive of its own.
//
// Read-only would be enough for the adex sync, but archiving uploads needs
// write and delete as well, so the scope covers both. The account can only
// touch what has been shared with it.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS = 'application/vnd.ms-excel';
const INGESTIBLE = new Set([GOOGLE_SHEET, XLSX, XLS]);

/** The folder every archive run writes into, created on first use. */
export const ARCHIVE_ROOT_NAME = 'Media Planner';

export class DriveNotConfigured extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'DriveNotConfigured';
    this.hint = hint;
    this.status = 400;
  }
}

async function loadCredentials() {
  const raw = await getSetting(SETTING_KEYS.DRIVE_CREDENTIALS);
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new DriveNotConfigured(
        `The stored service-account key is not valid JSON: ${err.message}`,
        'Re-paste the whole key file, including the surrounding braces.',
      );
    }
  }
  if (config.drive.credentialsPath && fs.existsSync(config.drive.credentialsPath)) {
    return JSON.parse(fs.readFileSync(config.drive.credentialsPath, 'utf8'));
  }
  throw new DriveNotConfigured(
    'No Google Drive service account is configured.',
    'Paste a service-account JSON key under Settings, or set GDRIVE_SERVICE_ACCOUNT_JSON.',
  );
}

// Cached per credential set, so changing the key in Settings takes effect
// without a restart.
let cached = null;
let cachedFor = null;

export async function driveClient() {
  const creds = await loadCredentials();
  const fingerprint = `${creds.client_email}:${creds.private_key_id || ''}`;
  if (cached && cachedFor === fingerprint) return cached;

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  cached = google.drive({ version: 'v3', auth });
  cachedFor = fingerprint;
  return cached;
}

export async function adexFolderId() {
  const folder = await getSetting(SETTING_KEYS.DRIVE_FOLDER);
  if (!folder) {
    throw new DriveNotConfigured(
      'No Drive folder is configured for adex data.',
      'Paste the folder link under Settings.',
    );
  }
  return folder;
}

/** List every ingestible spreadsheet in the adex folder, newest first. */
export async function listAdexFiles({ folderId = null } = {}) {
  const target = folderId || await adexFolderId();
  const drive = await driveClient();
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${target}' in parents and trashed = false`,
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
  const drive = await driveClient();
  const opts = { responseType: 'arraybuffer' };

  const res = file.mimeType === GOOGLE_SHEET
    ? await drive.files.export({ fileId: file.id, mimeType: XLSX }, opts)
    : await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        opts,
      );

  return Buffer.from(res.data);
}

/** Find a folder by name under a parent, or create it. */
export async function ensureFolder(name, parentId = null) {
  const drive = await driveClient();
  const clauses = [
    `mimeType = '${FOLDER}'`,
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    'trashed = false',
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);

  const found = await drive.files.list({
    q: clauses.join(' and '),
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER,
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

export async function uploadBuffer({ name, buffer, folderId, mimeType = XLSX }) {
  const drive = await driveClient();
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, size',
    supportsAllDrives: true,
  });
  return res.data;
}

export async function deleteFile(fileId) {
  const drive = await driveClient();
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

/**
 * Confirm the configuration actually works, and say which part failed.
 *
 * "Test connection" is the whole point of the Settings tab: credentials that
 * parse but address a folder nobody shared are indistinguishable from correct
 * ones until a sync silently returns nothing.
 */
export async function testDriveAccess() {
  let creds;
  try {
    creds = await loadCredentials();
  } catch (err) {
    return { ok: false, stage: 'credentials', error: err.message, hint: err.hint };
  }

  const folder = await getSetting(SETTING_KEYS.DRIVE_FOLDER);
  if (!folder) {
    return {
      ok: false,
      stage: 'folder',
      service_account_email: creds.client_email,
      error: 'No adex folder is configured.',
      hint: 'Paste the Drive folder link above.',
    };
  }

  try {
    const drive = await driveClient();
    const meta = await drive.files.get({
      fileId: folder,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
    const files = await listAdexFiles({ folderId: folder });
    return {
      ok: true,
      service_account_email: creds.client_email,
      folder_name: meta.data.name,
      spreadsheets_found: files.length,
      newest: files[0]?.name || null,
    };
  } catch (err) {
    const notFound = err?.code === 404 || /not found/i.test(err?.message || '');
    return {
      ok: false,
      stage: 'access',
      service_account_email: creds.client_email,
      error: notFound
        ? 'The folder was not found, or is not shared with the service account.'
        : err.message,
      hint: `Share the folder with ${creds.client_email} (Editor) and check the link points at a folder.`,
    };
  }
}
