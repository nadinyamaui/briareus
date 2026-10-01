import { describe, it, expect } from 'vitest';
import { securityHeaders } from '../lib/security.js';

function run(req) {
  const out = { headers: {}, next: false };
  const res = {
    set(headers) {
      Object.assign(out.headers, headers);
      return this;
    },
  };
  securityHeaders(req, res, () => {
    out.next = true;
  });
  return out;
}

describe('securityHeaders', () => {
  it('sets the four headers on every response and passes through', () => {
    const out = run({ method: 'GET' });
    expect(out.next).toBe(true);
    expect(out.headers['X-Frame-Options']).toBe('DENY');
    expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(out.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('lets nothing a response names load or run, and nobody frame it', () => {
    const csp = run({ method: 'GET' }).headers['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
