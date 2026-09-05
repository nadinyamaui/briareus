// @ts-check
import crypto from 'crypto';
import { getConfig } from './config.js';

// The app's own login, a username and a password, in front of everything the
// server serves.
//
// This app starts shell commands, coding agents and database servers on the
// machine it runs on, with the machine's own git and GitHub credentials, so
// once it is reachable from anywhere (a Cloudflare tunnel, say), "who is
// asking" stops being a formality. Cloudflare Access gates at the edge; this
// gates in the app, so a tunnel pointed at the wrong hostname, an Access policy
// saved wrong, or anything else that reaches port 4300 still finds a locked
// door.
//
// It is off until `AUTH_PASSWORD_HASH` and `AUTH_SECRET` are both set (see
// `npm run set-password`), so a purely local install is unchanged.
//
// The username is `AUTH_USERNAME` (`admin` if unset), the password is stored as
// a scrypt hash and never in the clear. A signed-in
// browser carries one cookie: an expiry, signed with AUTH_SECRET. No server
// state, so a restart does not sign everybody out, and rotating the secret
// signs everybody out at once.

const COOKIE = 'reviewer_auth';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function authEnabled() {
  const { auth } = getConfig();
  return !!(auth.passwordHash && auth.secret);
}

// scrypt$<N>$<r>$<p>$<salt>$<key>, all hex and self-describing, so the cost
// parameters can change without invalidating what is already stored.
export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  let key;
  try {
    key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), Buffer.from(keyHex, 'hex').length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false; // unreadable hash: treat as no match rather than throwing
  }
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Hashed before comparing so two names of different lengths still compare in
// constant time; otherwise the reply time leaks how long the username is.
function sameString(a, b) {
  const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Both halves are always checked, even when the first one is already wrong:
// answering early on a bad username would turn the form into a way to find out
// which usernames exist.
export function verifyCredentials(username, password) {
  const { auth } = getConfig();
  const nameOk = sameString(username, auth.username);
  const passwordOk = verifyPassword(password, auth.passwordHash);
  return nameOk && passwordOk;
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// The cookie's whole payload is when it stops being valid: there is one user,
// so there is nothing else to carry.
function issueToken(secret, days) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + days * 86400_000 })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function tokenValid(token, secret) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac) return false;
  const expected = sign(payload, secret);
  // Same length either way (base64url of a sha256), so this is a real
  // constant-time compare rather than a length oracle.
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Secure only over HTTPS: the tunnel terminates TLS at Cloudflare and forwards
// the scheme, while a browser on this machine talks plain HTTP to localhost and
// would silently drop a Secure cookie.
function cookieOptions(req, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!req.secure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function signIn(req, res) {
  const { auth } = getConfig();
  res.cookie(
    COOKIE,
    issueToken(auth.secret, auth.sessionDays),
    cookieOptions(req, auth.sessionDays * 86400_000),
  );
}

export function signOut(req, res) {
  res.clearCookie(COOKIE, { ...cookieOptions(req, 0), maxAge: undefined });
}

export function signedIn(req) {
  if (!authEnabled()) return true;
  return tokenValid(readCookie(req, COOKIE), getConfig().auth.secret);
}

// Brute force, made pointless: five wrong passwords from one address and that
// address waits fifteen minutes. In memory on purpose: a restart clearing it
// costs an attacker more than it costs the one person who mistyped.
//
// The address alone is not enough, though: `req.ip` comes through the proxy's
// X-Forwarded-For, which an attacker who can vary that header would rotate to
// get a fresh counter per guess. So a second, address-blind budget backs it
// up: twenty failures from *anywhere* inside a window and every address waits
// out the lockout. There is one real user, so locking the whole door is the
// point, not collateral.
const attempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;
const GLOBAL_MAX_ATTEMPTS = 20;
const globalAttempts = { count: 0, last: 0, until: 0 };

export function loginBlocked(ip) {
  if (globalAttempts.until > Date.now()) return Math.ceil((globalAttempts.until - Date.now()) / 1000);
  const rec = attempts.get(ip);
  if (!rec) return 0;
  if (rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  if (rec.until) attempts.delete(ip); // lockout served
  return 0;
}

export function loginFailed(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
  // The global budget refills by going quiet: a lockout's worth of silence
  // since the last failure ends the current run of guesses.
  const now = Date.now();
  if (now - globalAttempts.last > LOCKOUT_MS) globalAttempts.count = 0;
  globalAttempts.last = now;
  globalAttempts.count += 1;
  if (globalAttempts.count >= GLOBAL_MAX_ATTEMPTS) {
    globalAttempts.until = now + LOCKOUT_MS;
    globalAttempts.count = 0;
  }
}

export function loginSucceeded(ip) {
  attempts.delete(ip);
}

// What every request goes through. The login page and the stylesheet it uses
// are the only things served to a stranger; everything else (pages, APIs, the
// event stream, the recorded videos) needs the cookie.
const PUBLIC_PATHS = new Set(['/login', '/login.js', '/api/login', '/app.css', '/healthz']);

// The agent-facing routes carry a bearer token of their own (the session's,
// handed to the memory tool through its environment) and check it themselves:
// a CLI child process has no browser cookie to show.
const AGENT_PREFIX = '/api/agent/';

export function requireAuth(req, res, next) {
  if (!authEnabled() || PUBLIC_PATHS.has(req.path) || req.path.startsWith(AGENT_PREFIX) || signedIn(req))
    return next();
  // An API or stream call gets an answer its caller can parse; a page gets sent
  // to the login form with somewhere to come back to.
  if (req.path.startsWith('/api/') || req.headers.accept === 'text/event-stream') {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const next_ = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${next_}`);
}
