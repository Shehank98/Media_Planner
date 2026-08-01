// Express 4 doesn't forward rejected promises to the error handler, so every
// async handler is wrapped rather than relying on each one to try/catch.
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
