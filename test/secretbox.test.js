import { describe, it, expect, vi } from 'vitest';

const config = vi.hoisted(() => ({ credentialsKey: 'k'.repeat(32) }));
vi.mock('../lib/config.js', () => ({ getConfig: () => config }));

const { seal, open } = await import('../lib/secretbox.js');

describe('secretbox', () => {
  it('opens what it sealed, and never seals the same text the same way', () => {
    const a = seal('hunter2');
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('hunter2');
    expect(seal('hunter2')).not.toBe(a);
    expect(open(a)).toBe('hunter2');
  });
  it('refuses a tampered value', () => {
    const [v, iv, tag, body] = seal('hunter2').split(':');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] ^= 1;
    expect(() => open([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow(/decrypted/);
  });
  it('cannot open with another key', () => {
    const sealed = seal('hunter2');
    config.credentialsKey = 'other'.repeat(8);
    try {
      expect(() => open(sealed)).toThrow(/CREDENTIALS_KEY/);
    } finally {
      config.credentialsKey = 'k'.repeat(32);
    }
  });
  it('names the missing or short key', () => {
    for (const k of ['', 'short']) {
      config.credentialsKey = k;
      try {
        expect(() => seal('x')).toThrow(/CREDENTIALS_KEY/);
      } finally {
        config.credentialsKey = 'k'.repeat(32);
      }
    }
  });
});
