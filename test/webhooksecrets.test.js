import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  publicBaseUrl: 'https://reviewer.example.com',
  stored: null,
  saves: [],
}));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ publicBaseUrl: state.publicBaseUrl }),
}));

vi.mock('../lib/db.js', () => ({
  loadAppSetting: vi.fn(async () => state.stored),
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
    expect(state.saves).toEqual([{ key: 'webhooks', value: secrets }]);
  });

  it('reuses what is already stored instead of rotating on every boot', async () => {
    state.stored = { github: 'g'.repeat(64) };
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
