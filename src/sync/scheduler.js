import cron from 'node-cron';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { syncAdexFromDrive } from './adexSync.js';

let task = null;

/** Start the periodic Drive pull. No-op when disabled or unconfigured. */
export function startScheduler() {
  if (!config.drive.enabled) {
    log.info('drive sync scheduler disabled (SYNC_ENABLED=false)');
    return null;
  }
  if (!config.drive.folderId) {
    log.warn('drive sync scheduler not started: GDRIVE_FOLDER_ID is not set');
    return null;
  }
  if (!cron.validate(config.drive.cron)) {
    log.error('drive sync scheduler not started: invalid SYNC_CRON', { cron: config.drive.cron });
    return null;
  }

  task = cron.schedule(config.drive.cron, () => {
    syncAdexFromDrive({ trigger: 'cron' }).catch((err) => {
      // Already logged in detail by the sync itself; swallow so the scheduled
      // task survives to the next tick.
      log.error('scheduled adex sync failed', { err });
    });
  });

  log.info('drive sync scheduler started', { cron: config.drive.cron });
  return task;
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}
