import express from 'express';
import { asyncRoute } from '../util/asyncRoute.js';
import {
  settingsSummary, setSetting, extractFolderId, SETTING_KEYS,
} from '../services/settings.js';
import { testDriveAccess } from '../sync/driveClient.js';

export const router = express.Router();

/** Current configuration. Secrets report presence only. */
router.get('/', asyncRoute(async (_req, res) => {
  res.json(await settingsSummary());
}));

/**
 * Update Drive settings.
 *
 * The folder is accepted as a pasted browser URL or a bare id - people copy the
 * address bar, and rejecting that is a pointless round trip.
 */
router.put('/drive', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const problems = [];

  if (body.adex_folder !== undefined) {
    const id = body.adex_folder ? extractFolderId(body.adex_folder) : null;
    if (body.adex_folder && !id) {
      problems.push(
        'Could not read a folder id from that link. Paste the Drive folder URL '
        + '(https://drive.google.com/drive/folders/…) or the id itself.',
      );
    } else {
      await setSetting(SETTING_KEYS.DRIVE_FOLDER, id);
    }
  }

  if (body.archive_folder !== undefined) {
    const id = body.archive_folder ? extractFolderId(body.archive_folder) : null;
    if (body.archive_folder && !id) {
      problems.push('Could not read a folder id from the archive folder link.');
    } else {
      // Optional: when unset, a "Media Planner" folder is created in the
      // service account's own Drive root on first archive.
      await setSetting(SETTING_KEYS.DRIVE_ARCHIVE_FOLDER, id);
    }
  }

  if (body.service_account_json !== undefined) {
    const raw = String(body.service_account_json || '').trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        if (!parsed.client_email || !parsed.private_key) {
          problems.push('That JSON is missing client_email or private_key - it may be an OAuth '
            + 'client secret rather than a service-account key.');
        } else {
          await setSetting(SETTING_KEYS.DRIVE_CREDENTIALS, raw);
        }
      } catch (err) {
        problems.push(`Service account JSON could not be parsed: ${err.message}`);
      }
    } else {
      await setSetting(SETTING_KEYS.DRIVE_CREDENTIALS, null);
    }
  }

  // OAuth-as-a-user credentials, the free-tier alternative to a service account.
  // Client id is not secret and can be echoed back; secret and refresh token are
  // write-only. Empty string means "leave the stored value alone", so a user can
  // update the id without re-pasting the token; null clears it explicitly.
  if (body.oauth_client_id !== undefined) {
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID, body.oauth_client_id || null);
  }
  if (body.oauth_client_secret) {
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET, body.oauth_client_secret.trim());
  }
  if (body.oauth_refresh_token) {
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN, body.oauth_refresh_token.trim());
  }
  if (body.clear_oauth === true) {
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_ID, null);
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_CLIENT_SECRET, null);
    await setSetting(SETTING_KEYS.DRIVE_OAUTH_REFRESH_TOKEN, null);
  }

  if (body.archive_enabled !== undefined) {
    await setSetting(SETTING_KEYS.DRIVE_ARCHIVE_ENABLED, body.archive_enabled ? 'true' : 'false');
  }

  if (problems.length) return res.status(400).json({ error: problems[0], problems });
  res.json(await settingsSummary());
}));

/** Prove the credentials reach the folder, and say which step failed if not. */
router.post('/drive/test', asyncRoute(async (_req, res) => {
  const result = await testDriveAccess();
  res.status(result.ok ? 200 : 400).json(result);
}));
