// @ts-check
// The headers every response carries.
//
// Nothing this server answers is meant to render (JSON, event streams, downloads), so the
// policy says so: a response opened in a tab runs no script, loads nothing, and cannot be
// framed or sniffed.
const CSP = "default-src 'none'; frame-ancestors 'none'";

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}
