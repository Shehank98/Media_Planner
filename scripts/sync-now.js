// One-off Drive sync from the command line: npm run sync -- [--force]
import { syncAdexFromDrive } from '../src/sync/adexSync.js';
import { close } from '../src/db.js';
import { migrate } from '../src/db.js';

const force = process.argv.includes('--force');

try {
  await migrate();
  const summary = await syncAdexFromDrive({ force, trigger: 'cli' });
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await close();
}
