import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ cfg: null }));

vi.mock('../lib/config.js', () => ({
  getConfig: () => state.cfg,
}));

import {
  hashPassword,
  verifyPassword,
  verifyCredentials,
  authEnabled,
  signIn,
  signOut,
  signedIn,
  requireAuth,
  loginBlocked,
  loginFailed,
  loginSucceeded,
} from '../lib/auth.js';

function configure({
  username = 'nadin',
  password = 'hunter2!',
  secret = 'top-secret',
  sessionDays = 1,
} = {}) {
  state.cfg = {
    auth: {
      username,
      passwordHash: password ? hashPassword(password) : '',
      secret,
      sessionDays,
    },
  };
}

beforeEach(() => configure());

describe('hashPassword / verifyPassword', () => {
  it('produces a self-describing scrypt hash and verifies it back', () => {
    const hash = hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(verifyPassword('correct horse', hash)).toBe(true);
  });

  it('rejects the wrong password', () => {
    expect(verifyPassword('wrong', hashPassword('right'))).toBe(false);
  });

  it('hashes the same password differently each time (random salt)', () => {
    expect(hashPassword('pw')).not.toBe(hashPassword('pw'));
  });

  it('treats an unreadable stored hash as no match rather than throwing', () => {
    expect(verifyPassword('pw', '')).toBe(false);
    expect(verifyPassword('pw', 'not-a-hash')).toBe(false);
    expect(verifyPassword('pw', 'bcrypt$a$b$c$d$e')).toBe(false);
    expect(verifyPassword('pw', 'scrypt$x$y$z$nothex$nothex')).toBe(false);
  });

  it('honors the cost parameters stored in the hash itself', () => {
    const hash = hashPassword('pw');
    // A tampered N must not verify: the key it derives is a different one.
    const tampered = hash.replace('$16384$', '$4096$');
    expect(verifyPassword('pw', tampered)).toBe(false);
  });
});

describe('verifyCredentials / authEnabled', () => {
  it('requires both halves to match', () => {
    expect(verifyCredentials('nadin', 'hunter2!')).toBe(true);
    expect(verifyCredentials('nadin', 'nope')).toBe(false);
    expect(verifyCredentials('admin', 'hunter2!')).toBe(false);
  });

  it('is enabled only when both the hash and the secret are set', () => {
    expect(authEnabled()).toBe(true);
    configure({ password: '' });
    expect(authEnabled()).toBe(false);
    configure({ secret: '' });
    expect(authEnabled()).toBe(false);
  });
});

// A minimal express-shaped req/res pair: signIn writes one cookie, signedIn
// reads it back off the Cookie header.
function fakeRes() {
  const res = { cookies: {}, cleared: [] };
  res.cookie = (name, value, opts) => {
    res.cookies[name] = { value, opts };
  };
  res.clearCookie = (name) => {
    res.cleared.push(name);
  };
  return res;
}

function reqWithCookie(res, { secure = false } = {}) {
  const pairs = Object.entries(res.cookies).map(([n, c]) => `${n}=${encodeURIComponent(c.value)}`);
  return { headers: { cookie: pairs.join('; ') }, secure };
}

describe('the signed cookie', () => {
  afterEach(() => vi.useRealTimers());

  it('signs a browser in and recognizes it', () => {
    const res = fakeRes();
    signIn({ secure: true }, res);
    const cookie = res.cookies.reviewer_auth;
    expect(cookie.opts.httpOnly).toBe(true);
    expect(cookie.opts.secure).toBe(true);
    expect(signedIn(reqWithCookie(res))).toBe(true);
  });

  it('drops the Secure flag for a plain-HTTP localhost browser', () => {
    const res = fakeRes();
    signIn({ secure: false }, res);
    expect(res.cookies.reviewer_auth.opts.secure).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const res = fakeRes();
    signIn({ secure: false }, res);
    configure({ secret: 'rotated' });
    expect(signedIn(reqWithCookie(res))).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const res = fakeRes();
    signIn({ secure: false }, res);
    const [payload, mac] = res.cookies.reviewer_auth.value.split('.');
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 86400_000 })).toString('base64url');
    expect(signedIn({ headers: { cookie: `reviewer_auth=${forged}.${mac}` } })).toBe(false);
    expect(signedIn({ headers: { cookie: `reviewer_auth=${payload}` } })).toBe(false);
    expect(signedIn({ headers: {} })).toBe(false);
  });

  it('expires with the session', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    signIn({ secure: false }, res); // sessionDays: 1
    const req = reqWithCookie(res);
    expect(signedIn(req)).toBe(true);
    vi.advanceTimersByTime(2 * 86400_000);
    expect(signedIn(req)).toBe(false);
  });

  it('treats everyone as signed in while auth is off', () => {
    configure({ password: '', secret: '' });
    expect(signedIn({ headers: {} })).toBe(true);
  });

  it('signOut clears the cookie', () => {
    const res = fakeRes();
    signOut({ secure: false }, res);
    expect(res.cleared).toContain('reviewer_auth');
  });
});

describe('login lockout', () => {
  afterEach(() => vi.useRealTimers());

  it('blocks an address after five failures and serves out the lockout', () => {
    vi.useFakeTimers();
    const ip = '10.0.0.1';
    for (let i = 0; i < 4; i++) loginFailed(ip);
    expect(loginBlocked(ip)).toBe(0);
    loginFailed(ip); // fifth
    expect(loginBlocked(ip)).toBeGreaterThan(0);
    vi.advanceTimersByTime(15 * 60_000 + 1000);
    expect(loginBlocked(ip)).toBe(0);
  });

  it('a successful login clears the counter', () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 4; i++) loginFailed(ip);
    loginSucceeded(ip);
    loginFailed(ip); // would have been the fifth
    expect(loginBlocked(ip)).toBe(0);
  });

  it('addresses do not share a counter', () => {
    for (let i = 0; i < 5; i++) loginFailed('10.0.0.3');
    expect(loginBlocked('10.0.0.3')).toBeGreaterThan(0);
    expect(loginBlocked('10.0.0.4')).toBe(0);
  });

  // The per-address counter is bypassable by whoever controls X-Forwarded-For;
  // the address-blind budget behind it is not.
  it('twenty failures across rotating addresses lock every address out', () => {
    vi.useFakeTimers();
    // A lockout's worth of silence first, so failures from earlier tests do
    // not count toward this run of guesses.
    vi.advanceTimersByTime(16 * 60_000);
    for (let i = 0; i < 19; i++) loginFailed(`172.16.0.${i}`);
    expect(loginBlocked('192.168.1.99')).toBe(0);
    loginFailed('172.16.0.19'); // twentieth, from yet another address
    expect(loginBlocked('192.168.1.99')).toBeGreaterThan(0);
    vi.advanceTimersByTime(15 * 60_000 + 1000);
    expect(loginBlocked('192.168.1.99')).toBe(0);
  });
});

describe('requireAuth', () => {
  function run(req) {
    const out = { status: null, body: null, redirect: null, next: false };
    const res = {
      status(code) {
        out.status = code;
        return this;
      },
      json(body) {
        out.body = body;
        return this;
      },
      redirect(to) {
        out.redirect = to;
        return this;
      },
    };
    requireAuth(req, res, () => {
      out.next = true;
    });
    return out;
  }

  it('lets everything through while auth is off', () => {
    configure({ password: '', secret: '' });
    expect(run({ path: '/api/sessions', headers: {} }).next).toBe(true);
  });

  it('serves the login page and the stylesheet to a stranger', () => {
    expect(run({ path: '/login', headers: {} }).next).toBe(true);
    expect(run({ path: '/app.css', headers: {} }).next).toBe(true);
    expect(run({ path: '/login.js', headers: {} }).next).toBe(true);
    expect(run({ path: '/healthz', headers: {} }).next).toBe(true);
  });

  it('lets the agent routes through: they check their own bearer token', () => {
    expect(run({ path: '/api/agent/memories', headers: {} }).next).toBe(true);
    expect(run({ path: '/api/agent/memories/some-name', headers: {} }).next).toBe(true);
    expect(run({ path: '/api/agentless', headers: {} }).next).toBe(false);
  });

  it('answers an unauthenticated API call with 401 JSON', () => {
    const out = run({ path: '/api/sessions', headers: {} });
    expect(out.status).toBe(401);
    expect(out.body).toEqual({ error: 'Not signed in' });
  });

  it('answers an unauthenticated event stream with 401 too', () => {
    const out = run({ path: '/stream', headers: { accept: 'text/event-stream' } });
    expect(out.status).toBe(401);
  });

  it('redirects an unauthenticated page to the login with a way back', () => {
    const out = run({ path: '/settings', originalUrl: '/settings?tab=projects', headers: {} });
    expect(out.redirect).toBe(`/login?next=${encodeURIComponent('/settings?tab=projects')}`);
  });

  it('lets a signed-in browser through', () => {
    const res = fakeRes();
    signIn({ secure: false }, res);
    const req = { ...reqWithCookie(res), path: '/api/sessions' };
    expect(run(req).next).toBe(true);
  });
});
