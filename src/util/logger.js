// Structured single-line JSON logs - Railway's log viewer groups them cleanly
// and they stay greppable.

function emit(level, msg, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line, replacer)}\n`);
}

// Errors don't serialise to JSON usefully by default.
function replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
