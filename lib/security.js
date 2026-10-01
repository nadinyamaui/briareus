// @ts-check
// The two browser-facing hardenings the login itself cannot provide.
//
// This app is reachable through a tunnel, so the browser side deserves the
// same care the API side gets: headers that keep the dashboard from being
// framed, sniffed or scripted from anywhere else, and a same-origin check on
// every write so a page somebody else controls cannot ride a signed-in
// browser into the API. Both are middleware here rather than inline in
// server.js so they can be tested without booting the app.

// What every response carries. The policy is as tight as the frontend allows:
// scripts only from this origin (nothing inline: login.js exists so the
// login page needs no exception), styles may
// be inline because the vanilla-JS pages set style attributes when they draw,
// media covers the recorded QA videos.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
}

// Reject a state-changing request whose Origin says it was sent by a page on
// some other site. The sameSite=lax cookie already refuses to ride along on
// cross-site POSTs in current browsers, and this is the same rule enforced
// server-side, so an old browser (or a header-stripping proxy misconfig) is
// not the one thing the login depends on.
//
// Only requests that carry an Origin are judged: browsers always send it on
// cross-site writes, while curl, the webhook senders and same-origin GETs may
// not send one at all, and "no Origin" from a browser is a same-origin or
// non-browser request, not an attack.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function sameOriginWrites(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  const origin = req.get('Origin');
  if (!origin || origin === 'null') {
    // `null` is what browsers say for sandboxed iframes and some redirects:
    // an origin nobody can claim, so nothing to match it against. Let the
    // cookie's own sameSite rule decide, exactly as with no header at all.
    if (origin === 'null') return res.status(403).json({ error: 'Cross-origin request refused' });
    return next();
  }
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  if (host !== req.get('Host')) {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  return next();
}
