// ---------------------------------------------------------------------------
// Turn a Postgres driver error into something a person can act on.
//
// "connect ECONNREFUSED 10.0.0.3:5432" is accurate and useless. Every failure
// below has one or two likely causes and a specific thing to check, and the
// deploy-time ones (missing URL, TLS, un-run migration) account for nearly all
// of them. Surfacing the cause here means it reaches /health and the UI banner
// instead of only the server log.
// ---------------------------------------------------------------------------

export function describeDbError(err) {
  const code = err?.code;
  const message = String(err?.message || err || 'unknown database error');

  if (!process.env.DATABASE_URL) {
    return {
      message: 'DATABASE_URL is not set.',
      hint: 'On Railway, attach a Postgres plugin and reference it as ${{Postgres.DATABASE_URL}} '
        + 'in the service variables. Locally, set it in .env.',
      fatal: true,
    };
  }

  if (code === 'ECONNREFUSED') {
    return {
      message: `Nothing is listening at the address in DATABASE_URL (${message}).`,
      hint: 'Check the host and port. On Railway use the internal host '
        + '(postgres.railway.internal), not localhost — localhost inside a container is the '
        + 'container itself, not the database.',
      fatal: true,
    };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      message: `The database hostname in DATABASE_URL could not be resolved (${message}).`,
      hint: 'Check the hostname. Railway internal hostnames only resolve from inside the '
        + 'project network — from outside, use the public proxy URL instead.',
      fatal: true,
    };
  }

  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) {
    return {
      message: `The database did not answer in time (${message}).`,
      hint: 'Usually a firewall or a database that is asleep or restarting. Check the Postgres '
        + 'service is running.',
      fatal: true,
    };
  }

  // TLS. Railway's managed Postgres presents a self-signed certificate.
  if (/self.signed certificate|SELF_SIGNED_CERT|certificate/i.test(message) || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return {
      message: `TLS negotiation with the database failed (${message}).`,
      hint: 'Set PGSSL=true. Railway\'s Postgres uses a self-signed certificate, which the '
        + 'driver rejects unless SSL is enabled.',
      fatal: true,
    };
  }
  if (/does not support SSL|server does not support SSL/i.test(message)) {
    return {
      message: 'The database refused a TLS connection.',
      hint: 'Set PGSSL=false — this server is not configured for TLS.',
      fatal: true,
    };
  }

  // 28P01 invalid_password, 28000 invalid_authorization_specification
  if (code === '28P01' || code === '28000') {
    return {
      message: 'The database rejected the credentials in DATABASE_URL.',
      hint: 'Re-copy the connection string; a rotated password leaves the old one in the '
        + 'service variables.',
      fatal: true,
    };
  }

  // 3D000 invalid_catalog_name
  if (code === '3D000') {
    return {
      message: `The database named in DATABASE_URL does not exist (${message}).`,
      hint: 'Create it, or correct the database name at the end of the connection string.',
      fatal: true,
    };
  }

  // 42P01 undefined_table - connected fine, but the schema was never applied.
  if (code === '42P01') {
    return {
      message: `The schema has not been applied (${message}).`,
      hint: 'Run `npm run migrate`. The server also applies the schema on boot, so check the '
        + 'boot logs for why that failed — usually the database was unreachable at the time.',
      fatal: false,
    };
  }

  // 53300 too_many_connections
  if (code === '53300') {
    return {
      message: 'The database is refusing new connections (too many clients).',
      hint: 'Another process is holding connections open, or the plan\'s connection limit is '
        + 'lower than the pool size (10).',
      fatal: true,
    };
  }

  return { message, hint: null, fatal: true };
}

/** True for errors that mean the database is unreachable or unusable. */
export function isDbError(err) {
  if (!err) return false;
  const code = err.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return true; // SQLSTATE
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET',
    'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code);
}
