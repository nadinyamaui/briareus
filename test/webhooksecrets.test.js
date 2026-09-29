import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  publicBaseUrl: 'https://reviewer.example.com',
  stored: null,
  saves: [],
  // How many reads fail before the database answers.
  down: 0,
}));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ publicBaseUrl: state.publicBaseUrl }),
}));

vi.mock('../lib/db.js', () => ({
  loadAppSetting: vi.fn(async () => {
    if (state.down > 0) {
      state.down--;
      throw new Error('Database down');
    }
    return state.stored;
  }),
  saveAppSetting: vi.fn(async (key, value) => {
    state.saves.push({ key, value });
  }),
}));

// The module caches the secrets after the first read, so every test imports a
// fresh copy.
async function freshModule() {
  vi.resetModules();
  return import('../lib/webhooksecrets.js');
}

beforeEach(() => {
  state.publicBaseUrl = 'https://reviewer.example.com';
  state.stored = null;
  state.saves = [];
  state.down = 0;
});

describe('webhookBase', () => {
  it('answers the configured origin when a sender can reach it', async () => {
    const { webhookBase } = await freshModule();
    expect(webhookBase()).toBe('https://reviewer.example.com');
  });

  it.each([
    ['plain http', 'http://reviewer.example.com'],
    ['localhost', 'https://localhost:4300'],
    ['a loopback address', 'https://127.0.0.1'],
    ['a .test hostname', 'https://reviewer.test'],
    ['a .local hostname', 'https://reviewer.local'],
    ['a .localhost hostname', 'https://app.localhost'],
  ])('installs no hook for %s', async (_label, url) => {
    state.publicBaseUrl = url;
    const { webhookBase } = await freshModule();
    expect(webhookBase()).toBe('');
  });

  it('the delivery URL hangs off the base, or goes empty with it', async () => {
    const mod = await freshModule();
    expect(mod.githubWebhookUrl()).toBe('https://reviewer.example.com/webhooks/github');
    state.publicBaseUrl = 'http://nope';
    expect(mod.githubWebhookUrl()).toBe('');
  });
});

describe('webhookSecrets', () => {
  it('generates the secret on first use and persists it', async () => {
    const { webhookSecrets } = await freshModule();
    const secrets = await webhookSecrets();
    expect(secrets.github).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.sessions).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.sessions).not.toBe(secrets.github);
    expect(state.saves).toEqual([{ key: 'webhooks', value: secrets }]);
  });

  it('reuses what is already stored instead of rotating on every boot', async () => {
    state.stored = { github: 'g'.repeat(64), sessions: 's'.repeat(64) };
    const { webhookSecrets } = await freshModule();
    expect(await webhookSecrets()).toEqual(state.stored);
    expect(state.saves).toEqual([]);
  });

  it('answers from the cache after the first read', async () => {
    const { webhookSecrets } = await freshModule();
    const first = await webhookSecrets();
    state.stored = { github: 'other' };
    expect(await webhookSecrets()).toBe(first);
    expect(state.saves).toHaveLength(1);
  });
});

describe('session webhooks', () => {
  it('a row from before them gains the sessions secret, the GitHub one unchanged', async () => {
    state.stored = { github: 'g'.repeat(64) };
    const { webhookSecrets } = await freshModule();
    const secrets = await webhookSecrets();
    expect(secrets.github).toBe('g'.repeat(64));
    expect(secrets.sessions).toMatch(/^[0-9a-f]{64}$/);
    expect(state.saves).toEqual([{ key: 'webhooks', value: secrets }]);
  });

  it('derives one stable key per session, different for every session', async () => {
    state.stored = { github: 'g'.repeat(64), sessions: 's'.repeat(64) };
    const { sessionWebhookKey } = await freshModule();
    const a = await sessionWebhookKey('abc123');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sessionWebhookKey('abc123')).toBe(a);
    expect(await sessionWebhookKey('abc124')).not.toBe(a);
    // Rotating the master secret changes every key.
    state.stored = { github: 'g'.repeat(64), sessions: 't'.repeat(64) };
    const rotated = await freshModule();
    expect(await rotated.sessionWebhookKey('abc123')).not.toBe(a);
  });

  it('two first reads at once mint one secret between them, and write it once', async () => {
    state.stored = { github: 'g'.repeat(64) };
    const { webhookSecrets, sessionWebhookKey } = await freshModule();
    const [a, b, key] = await Promise.all([webhookSecrets(), webhookSecrets(), sessionWebhookKey('abc123')]);
    expect(b).toBe(a);
    expect(state.saves).toEqual([{ key: 'webhooks', value: a }]);
    // What the dashboard showed is what a restart computes from the row.
    state.stored = state.saves[0].value;
    const restarted = await freshModule();
    expect(await restarted.sessionWebhookKey('abc123')).toBe(key);
  });

  it('a read that failed is not held on to: the next caller reads again', async () => {
    state.stored = { github: 'g'.repeat(64), sessions: 's'.repeat(64) };
    state.down = 1;
    const { webhookSecrets } = await freshModule();
    await expect(webhookSecrets()).rejects.toThrow('Database down');
    expect(await webhookSecrets()).toEqual(state.stored);
  });

  it('rotating one session raises its epoch: a new key for it, and the same one for the rest', async () => {
    state.stored = { github: 'g'.repeat(64), sessions: 's'.repeat(64) };
    const { sessionWebhookKey } = await freshModule();
    const first = await sessionWebhookKey('abc123');
    expect(await sessionWebhookKey('abc123', 0)).toBe(first);
    const rotated = await sessionWebhookKey('abc123', 1);
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(first);
    expect(await sessionWebhookKey('abc123', 2)).not.toBe(rotated);
    expect(await sessionWebhookKey('abc124', 1)).not.toBe(rotated);
    expect(await sessionWebhookKey('abc124')).not.toBe(first);
  });

  it('gives the instructions webhook a key of its own, which no messages key can be', async () => {
    state.stored = { github: 'g'.repeat(64), sessions: 's'.repeat(64) };
    const { sessionWebhookKey } = await freshModule();
    const messages = await sessionWebhookKey('abc123', 0);
    const instructions = await sessionWebhookKey('abc123', 0, 'instructions');
    expect(instructions).toMatch(/^[0-9a-f]{64}$/);
    expect(instructions).not.toBe(messages);
    expect(await sessionWebhookKey('abc123', 0, 'messages')).toBe(messages);
    expect(await sessionWebhookKey('abc123', 1, 'instructions')).not.toBe(instructions);
    expect(await sessionWebhookKey('abc123', 1, 'instructions')).not.toBe(
      await sessionWebhookKey('abc123', 1),
    );
  });

  it('hangs the URL off the configured origin, reachable from the internet or not', async () => {
    const mod = await freshModule();
    expect(mod.sessionWebhookUrl('abc123')).toBe('https://reviewer.example.com/webhooks/session/abc123');
    expect(mod.sessionWebhookUrl('abc123', 'instructions')).toBe(
      'https://reviewer.example.com/webhooks/session/abc123/instructions',
    );
    state.publicBaseUrl = 'http://127.0.0.1:4301';
    expect(mod.sessionWebhookUrl('abc123')).toBe('http://127.0.0.1:4301/webhooks/session/abc123');
  });
});
