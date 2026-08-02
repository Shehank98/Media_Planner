import { pool } from '../db.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Runtime settings, with environment variables as the fallback.
//
// Drive configuration changes more often than the code does - a different
// folder for a different client, a rotated service account - and requiring a
// redeploy for that is friction with no upside. Stored values win over env so
// the Settings tab is authoritative once used.
//
// Secrets are write-only through the API: the UI can set the service-account
// key and see that one is configured, but never read it back.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  DRIVE_FOLDER: 'drive.adex_folder',
  DRIVE_ARCHIVE_FOLDER: 'drive.archive_folder',
  DRIVE_CREDENTIALS: 'drive.service_account_json',
  DRIVE_ARCHIVE_ENABLED: 'drive.archive_enabled',
  // OAuth-as-a-user credentials, the free-tier alternative to a service account.
  DRIVE_OAUTH_CLIENT_ID: 'drive.oauth_client_id',
  DRIVE_OAUTH_CLIENT_SECRET: 'drive.oauth_client_secret',
  DRIVE_OAUTH_REFRESH_TOKEN: 'drive.oauth_refresh_token',
};

const SECRET_KEYS = new Set([
  SETTING_KEYS.DRIVE_CREDENTIALS,
  SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET,
  SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN,
]);

// Env fallbacks, so an existing deployment keeps working untouched.
const ENV_FALLBACK = {
  [SETTING_KEYS.DRIVE_FOLDER]: () => config.drive.folderId,
  [SETTING_KEYS.DRIVE_CREDENTIALS]: () => config.drive.credentialsJson,
  [SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID]: () => config.drive.oauth.clientId,
  [SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET]: () => config.drive.oauth.clientSecret,
  [SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN]: () => config.drive.oauth.refreshToken,
};

let cache = null;

async function load() {
  if (cache) return cache;
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  cache = new Map(rows.map((r) => [r.key, r.value]));
  return cache;
}

/** Invalidate after a write. Cheap, and settings change rarely. */
export function invalidateSettings() {
  cache = null;
}

export async function getSetting(key) {
  const stored = (await load()).get(key);
  if (stored !== undefined && stored !== null && stored !== '') return stored;
  const fallback = ENV_FALLBACK[key];
  return fallback ? (fallback() || null) : null;
}

export async function setSetting(key, value) {
  const isSecret = SECRET_KEYS.has(key);
  if (value === null || value === '') {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  } else {
    await pool.query(
      `INSERT INTO app_settings (key, value, is_secret, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, String(value), isSecret],
    );
  }
  invalidateSettings();
}

/**
 * Pull a Drive folder id out of whatever the user pasted.
 *
 * People paste the browser URL, not the id. Accepting only the bare id means
 * everyone gets it wrong once and has to be told; accepting both costs one
 * regex.
 */
export function extractFolderId(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (!text) return null;

  // https://drive.google.com/drive/folders/<id>?usp=sharing
  const folder = text.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (folder) return folder[1];
  // https://drive.google.com/drive/u/0/folders/<id>
  const open = text.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (open) return open[1];
  // A bare id.
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  return null;
}

/**
 * Which Drive auth is active.
 *
 * OAuth wins when a refresh token is configured: it authenticates as a real
 * user with their own Drive storage, which is the option that works without a
 * paid Workspace. A service account has no storage of its own and can only
 * write into a Shared Drive, so it is the fallback, not the default.
 */
export async function driveAuthMode() {
  const oauthReady = Boolean(
    (await getSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID))
    && (await getSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET))
    && (await getSetting(SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN)),
  );
  if (oauthReady) return 'oauth';
  if (await getSetting(SETTING_KEYS.DRIVE_CREDENTIALS)) return 'service_account';
  return null;
}

/** Settings for the API and UI. Secrets report presence only, never content. */
export async function settingsSummary() {
  const map = await load();
  const folder = await getSetting(SETTING_KEYS.DRIVE_FOLDER);
  const archive = await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_FOLDER);
  const credentials = await getSetting(SETTING_KEYS.DRIVE_CREDENTIALS);
  const authMode = await driveAuthMode();

  let serviceAccountEmail = null;
  if (credentials) {
    try {
      const parsed = JSON.parse(
        credentials.trim().startsWith('{')
          ? credentials
          : Buffer.from(credentials, 'base64').toString('utf8'),
      );
      // The one part of the key that is safe to show, and the one people need:
      // the folder has to be shared with this address.
      serviceAccountEmail = parsed.client_email || null;
    } catch {
      serviceAccountEmail = null;
    }
  }

  const oauthConfigured = authMode === 'oauth';

  return {
    drive: {
      auth_mode: authMode,
      adex_folder_id: folder,
      adex_folder_url: folder ? `https://drive.google.com/drive/folders/${folder}` : null,
      adex_folder_source: map.get(SETTING_KEYS.DRIVE_FOLDER) ? 'settings' : (folder ? 'environment' : null),
      archive_folder_id: archive,
      archive_enabled: (await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_ENABLED)) !== 'false',

      // OAuth (user) auth.
      oauth_configured: oauthConfigured,
      oauth_client_id: (await getSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID)) || null,

      // Service-account auth.
      credentials_configured: Boolean(credentials),
      credentials_source: map.get(SETTING_KEYS.DRIVE_CREDENTIALS) ? 'settings' : (credentials ? 'environment' : null),
      service_account_email: serviceAccountEmail,

      // The one instruction people need, phrased for whichever auth is active.
      share_note: driveShareNote(authMode, serviceAccountEmail),
    },
    sync: {
      cron: config.drive.cron,
      enabled: config.drive.enabled,
    },
  };
}

function driveShareNote(authMode, serviceAccountEmail) {
  if (authMode === 'oauth') {
    return 'Signed in as a user via OAuth. Archived files go to your own Drive; nothing needs '
      + 'to be shared. Note: OAuth (drive.file scope) can only see files this app created, so '
      + 'adex must be uploaded through the app rather than dropped in a Drive folder for syncing.';
  }
  if (serviceAccountEmail) {
    return `Share the Drive folder with ${serviceAccountEmail} (Editor). A service account has no `
      + 'storage of its own, so archiving needs a Shared Drive (paid Workspace) - OAuth is the '
      + 'free-tier option.';
  }
  return 'Add OAuth credentials (recommended, free) or a service-account JSON key.';
}
