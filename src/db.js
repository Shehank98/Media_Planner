import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT } from './config.js';
import { log } from './util/logger.js';

// node-postgres hands NUMERIC back as a string to protect precision. Every
// numeric in this schema is money-in-thousands or a rating - both comfortably
// inside a float64 - and the LLM payload and charts need real numbers, so parse
// them once here rather than at forty call sites.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number.parseFloat(v)));
// DATE as a plain YYYY-MM-DD string, not a timezone-shifted Date object.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// int8 is also a string by default, which is how count(*), rank() and every
// window function come back. Left alone, the model payload and the charts fill
// up with "44" where they expect 44, and comparisons silently stop working.
// Values beyond Number's safe range keep the string, since that is the reason
// the driver is cautious here in the first place.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => log.error('idle postgres client errored', { err }));

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  log.info('schema applied');
}

export async function close() {
  await pool.end();
}
