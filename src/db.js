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
