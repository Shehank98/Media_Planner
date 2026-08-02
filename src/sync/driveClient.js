import fs from 'node:fs';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { config } from '../config.js';
import { getSetting, SETTING_KEYS, driveAuthMode } from '../services/settings.js';

// Drive access, either as a real user (OAuth) or as a service account.
//
// OAuth is the default when configured, because it authenticates as a person
// with their own Drive storage - the only option that works without a paid
// Workspace. A service account has no storage of its own: it can read files
// shared with it, but can only *write* into a Shared Drive, so archiving under
// a service account needs paid Workspace. Hence OAuth first.
//
// OAuth tokens minted by the Drive quickstart carry the drive.file scope, which
// grants access only to files the app itself created. That is exactly enough
// for archiving (the app creates every file it archives), but it means the app
// cannot read an adex folder a user filled by hand - those files must be
// uploaded through the app instead. listAdexFiles() explains this if it hits it.
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

/** Build an OAuth2 auth client from stored user credentials, or null if absent. */
async function oauthAuth() {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    getSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID),
    getSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET),
    getSetting(SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN),
  ]);
  if (!clientId || !clientSecret || !refreshToken) return null;

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  // The library refreshes the access token from this on demand, so nothing here
  // has to track expiry.
  auth.setCredentials({ refresh_token: refreshToken });
  return { auth, fingerprint: `oauth:${clientId}:${refreshToken.slice(-12)}` };
}

/** Build a service-account JWT auth client, or throw with a remedy. */
async function serviceAccountAuth() {
  const raw = await getSetting(SETTING_KEYS.DRIVE_CREDENTIALS);
  let creds = null;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    try {
      creds = JSON.parse(text);
    } catch (err) {
      throw new DriveNotConfigured(
        `The stored service-account key is not valid JSON: ${err.message}`,
        'Re-paste the whole key file, including the surrounding braces.',
      );
    }
  } else if (config.drive.credentialsPath && fs.existsSync(config.drive.credentialsPath)) {
    creds = JSON.parse(fs.readFileSync(config.drive.credentialsPath, 'utf8'));
  }
  if (!creds) {
    throw new DriveNotConfigured(
      'No Google Drive credentials are configured.',
      'Add OAuth credentials under Settings (recommended, works on the free tier), or paste a '
      + 'service-account JSON key.',
    );
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  return { auth, fingerprint: `sa:${creds.client_email}:${creds.private_key_id || ''}` };
}

// Cached per credential set, so changing auth in Settings takes effect without
// a restart.
let cached = null;
let cachedFor = null;
let cachedMode = null;

export async function driveClient() {
  // OAuth wins whenever it is fully configured - it is the auth that works on
  // the free tier.
  const built = (await oauthAuth()) || (await serviceAccountAuth());
  if (cached && cachedFor === built.fingerprint) return cached;

  cached = google.drive({ version: 'v3', auth: built.auth });
  cachedFor = built.fingerprint;
  cachedMode = built.fingerprint.startsWith('oauth') ? 'oauth' : 'service_account';
  return cached;
}

export async function currentAuthMode() {
  // driveAuthMode reads settings without building a client, which is what the
  // caller usually wants; cachedMode reflects the last client actually built.
  return (await driveAuthMode()) ?? cachedMode;
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
    for (const f of res.data.files || []) files.push(f);
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
 * parse but cannot reach Drive are indistinguishable from correct ones until a
 * sync or an archive silently fails.
 *
 * The test is auth-aware. For OAuth the thing that matters is write access -
 * archiving creates a folder and files - so the probe creates a folder and
 * deletes it, which proves exactly that. For a service account the folder has
 * to be shared, so the probe reads it.
 */
export async function testDriveAccess() {
  const mode = await currentAuthMode();
  if (!mode) {
    return {
      ok: false,
      stage: 'credentials',
      error: 'No Drive credentials are configured.',
      hint: 'Add OAuth credentials (recommended, free) or a service-account JSON key.',
    };
  }

  return mode === 'oauth' ? testOAuthAccess() : testServiceAccountAccess();
}

async function testOAuthAccess() {
  let drive;
  try {
    drive = await driveClient();
  } catch (err) {
    return { ok: false, stage: 'credentials', auth_mode: 'oauth', error: err.message, hint: err.hint };
  }

  // A round-trip create/delete proves the token refreshes and the app can write
  // - which is all archiving needs. It leaves nothing behind.
  let probeId = null;
  try {
    const probe = await drive.files.create({
      requestBody: { name: 'Media Planner — connection test', mimeType: FOLDER },
      fields: 'id',
    });
    probeId = probe.data.id;

    let email = null;
    try {
      const about = await drive.about.get({ fields: 'user(emailAddress)' });
      email = about.data.user?.emailAddress || null;
    } catch {
      // about.get needs a broader scope than drive.file; absence is not a
      // failure, so the account email is best-effort.
      email = null;
    }

    return {
      ok: true,
      auth_mode: 'oauth',
      account_email: email,
      write_verified: true,
      note: 'Signed in as a user; archiving will write to this Drive. Adex still needs to be '
        + 'uploaded through the app (OAuth cannot read folders it did not create).',
    };
  } catch (err) {
    return {
      ok: false,
      stage: 'access',
      auth_mode: 'oauth',
      error: err.message,
      hint: /invalid_grant/i.test(err.message || '')
        ? 'The refresh token was rejected - it may have been revoked or expired. Generate a new one.'
        : 'Check the OAuth client id, secret and refresh token.',
    };
  } finally {
    if (probeId) await drive.files.delete({ fileId: probeId }).catch(() => {});
  }
}

async function testServiceAccountAccess() {
  let built;
  try {
    built = await serviceAccountAuth();
  } catch (err) {
    return { ok: false, stage: 'credentials', auth_mode: 'service_account', error: err.message, hint: err.hint };
  }
  const email = built.fingerprint.split(':')[1];

  const folder = await getSetting(SETTING_KEYS.DRIVE_FOLDER);
  if (!folder) {
    return {
      ok: false,
      stage: 'folder',
      auth_mode: 'service_account',
      service_account_email: email,
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
      auth_mode: 'service_account',
      service_account_email: email,
      folder_name: meta.data.name,
      spreadsheets_found: files.length,
      newest: files[0]?.name || null,
    };
  } catch (err) {
    const notFound = err?.code === 404 || /not found/i.test(err?.message || '');
    return {
      ok: false,
      stage: 'access',
      auth_mode: 'service_account',
      service_account_email: email,
      error: notFound
        ? 'The folder was not found, or is not shared with the service account.'
        : err.message,
      hint: `Share the folder with ${email} (Editor) and check the link points at a folder.`,
    };
  }
}
