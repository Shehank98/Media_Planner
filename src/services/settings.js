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
};

const SECRET_KEYS = new Set([SETTING_KEYS.DRIVE_CREDENTIALS]);

// Env fallbacks, so an existing deployment keeps working untouched.
const ENV_FALLBACK = {
  [SETTING_KEYS.DRIVE_FOLDER]: () => config.drive.folderId,
  [SETTING_KEYS.DRIVE_CREDENTIALS]: () => config.drive.credentialsJson,
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

/** Settings for the API and UI. Secrets report presence only, never content. */
export async function settingsSummary() {
  const map = await load();
  const folder = await getSetting(SETTING_KEYS.DRIVE_FOLDER);
  const archive = await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_FOLDER);
  const credentials = await getSetting(SETTING_KEYS.DRIVE_CREDENTIALS);

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

  return {
    drive: {
      adex_folder_id: folder,
      adex_folder_url: folder ? `https://drive.google.com/drive/folders/${folder}` : null,
      adex_folder_source: map.get(SETTING_KEYS.DRIVE_FOLDER) ? 'settings' : (folder ? 'environment' : null),
      archive_folder_id: archive,
      archive_enabled: (await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_ENABLED)) !== 'false',
      credentials_configured: Boolean(credentials),
      credentials_source: map.get(SETTING_KEYS.DRIVE_CREDENTIALS) ? 'settings' : (credentials ? 'environment' : null),
      service_account_email: serviceAccountEmail,
      // Restating the one step people miss.
      share_note: serviceAccountEmail
        ? `Share the Drive folder with ${serviceAccountEmail} (Editor, so archived files can be written and removed).`
        : 'Paste a service-account JSON key to see which address the folder must be shared with.',
    },
    sync: {
      cron: config.drive.cron,
      enabled: config.drive.enabled,
    },
  };
}
