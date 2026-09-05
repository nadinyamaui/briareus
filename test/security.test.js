import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { securityHeaders, sameOriginWrites } from '../lib/security.js';

function run(middleware, req) {
  const out = { headers: {}, status: null, body: null, next: false };
  const res = {
    set(headers) {
      Object.assign(out.headers, headers);
      return this;
    },
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
  };
  middleware(
    {
      headers: {},
      get(name) {
        return this.headers[name.toLowerCase()];
      },
      ...req,
    },
    res,
    () => {
      out.next = true;
    },
  );
  return out;
}

describe('securityHeaders', () => {
  it('sets the four headers on every response and passes through', () => {
    const out = run(securityHeaders, { method: 'GET' });
    expect(out.next).toBe(true);
    expect(out.headers['X-Frame-Options']).toBe('DENY');
    expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(out.headers['Referrer-Policy']).toBe('same-origin');
    expect(out.headers['Content-Security-Policy']).toBeTruthy();
  });

  it('the CSP allows no scripts from anywhere but this origin', () => {
    const csp = run(securityHeaders, { method: 'GET' }).headers['Content-Security-Policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The recorded QA videos are served from this origin.
    expect(csp).toContain("media-src 'self'");
  });

  it('lets the page import map in by the hash of its exact contents', () => {
    const html = readFileSync(new URL('../public/developer.html', import.meta.url), 'utf8');
    const body = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
    expect(body).toBeTruthy();
    const hash = createHash('sha256').update(body).digest('base64');
    const csp = run(securityHeaders, { method: 'GET' }).headers['Content-Security-Policy'];
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
  });
});

describe('sameOriginWrites', () => {
  const host = 'reviewer.example.com';

  it('never judges a read', () => {
    const out = run(sameOriginWrites, {
      method: 'GET',
      headers: { origin: 'https://evil.example.com', host },
    });
    expect(out.next).toBe(true);
  });

  it('lets a same-origin write through', () => {
    const out = run(sameOriginWrites, {
      method: 'POST',
      headers: { origin: `https://${host}`, host },
    });
    expect(out.next).toBe(true);
  });

  it('refuses a write whose Origin names another site', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const out = run(sameOriginWrites, {
        method,
        headers: { origin: 'https://evil.example.com', host },
      });
      expect(out.next).toBe(false);
      expect(out.status).toBe(403);
    }
  });

  it('a mismatched port is another origin too', () => {
    const out = run(sameOriginWrites, {
      method: 'POST',
      headers: { origin: `https://${host}:8443`, host },
    });
    expect(out.status).toBe(403);
  });

  it('lets a write with no Origin through: curl and the webhook senders', () => {
    const out = run(sameOriginWrites, { method: 'POST', headers: { host } });
    expect(out.next).toBe(true);
  });

  it('refuses the "null" origin nobody can legitimately claim', () => {
    const out = run(sameOriginWrites, { method: 'POST', headers: { origin: 'null', host } });
    expect(out.status).toBe(403);
  });

  it('refuses an Origin that does not parse as a URL', () => {
    const out = run(sameOriginWrites, { method: 'POST', headers: { origin: 'not a url', host } });
    expect(out.status).toBe(403);
  });
});
