import { afterEach, describe, expect, it, vi } from 'vitest';

import { childEnv } from '../lib/childenv.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('childEnv', () => {
  it("drops the server's own credentials and keeps the rest", () => {
    vi.stubEnv('OPENAI_TRANSCRIBE_API_KEY', 'sk-secret');
    vi.stubEnv('OPENAI_TRANSCRIBE_MODEL', 'gpt-4o-transcribe');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'r2-secret');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-secret');
    vi.stubEnv('OPENAI_API_KEY', 'a-session-own-key');

    const env = childEnv();

    expect(env).not.toHaveProperty('OPENAI_TRANSCRIBE_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_TRANSCRIBE_MODEL');
    expect(env).not.toHaveProperty('R2_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(env.OPENAI_API_KEY).toBe('a-session-own-key');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('adds the overrides, but never lets one bring a credential back', () => {
    const env = childEnv({ GIT_TERMINAL_PROMPT: '0', OPENAI_TRANSCRIBE_API_KEY: 'sk-secret' });

    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env).not.toHaveProperty('OPENAI_TRANSCRIBE_API_KEY');
  });
});
