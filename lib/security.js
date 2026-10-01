// @ts-check
// The headers every response carries.
//
// Nothing this server answers is meant to render in a browser: it is JSON, an
// event stream, or a file a client downloads. So the policy says exactly that.
// A response opened in a tab anyway runs no script, loads nothing, and cannot
// be framed or sniffed into something it is not.
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
