// Standalone migration entry point: `npm run migrate`.
// The server also calls migrate() on boot, so this is mainly for CI and for
// running against a fresh Railway database before the first deploy.
import { migrate, close } from '../src/db.js';
import { log } from '../src/util/logger.js';

try {
  await migrate();
  log.info('migration complete');
} catch (err) {
  log.error('migration failed', { err });
  process.exitCode = 1;
} finally {
  await close();
}
