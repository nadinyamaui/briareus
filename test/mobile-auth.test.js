import { beforeEach, it, expect, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';

const secret = 'owner-secret';
const input = { label: 'Desktop', repos: ['owner/project'], permission: 'manage', days: 90 };
let auth, saved, save, load, clock, issued;
beforeEach(async () => {
  saved = [];
  clock = Date.now();
  load = vi.fn(async () => structuredClone(saved));
  save = vi.fn(async (_name, value) => {
    saved = structuredClone(value);
  });
  auth = createMobileAuth({ load, save, now: () => clock });
  await auth.init();
  issued = await auth.create(input, secret);
});
const bearer = (credentials) => `Bearer ${credentials.token}`;

it('persists hashes only, survives restart, expires and is invalidated by owner secret rotation', async () => {
  expect(JSON.stringify(saved)).not.toContain(issued.token);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(auth.list()[0]).not.toHaveProperty('tokenHash');
  expect(auth.list()[0]).not.toHaveProperty('ownerHash');
  const restarted = createMobileAuth({ load, save, now: () => clock });
  await restarted.init();
  expect(restarted.authenticate(bearer(issued), secret).id).toBe(issued.device.id);
  expect(() => restarted.authenticate(bearer(issued), 'changed')).toThrow('Invalid');
  clock = issued.device.expiresAt;
  expect(() => restarted.authenticate(bearer(issued), secret)).toThrow('Invalid');
});

it('fails closed until its state loads', async () => {
  const unavailable = createMobileAuth({
    load: async () => {
      throw new Error('DB down');
    },
  });
  await expect(unavailable.init()).rejects.toThrow('DB down');
  expect(() => unavailable.authenticate(bearer(issued), secret)).toThrow('unavailable');
});

it('takes its own tokens and nothing shaped like one', () => {
  for (const header of [
    undefined,
    '',
    'Bearer internal-agent-token',
    `${bearer(issued)}x`,
    `Bearer brm_${'a'.repeat(43)}`,
    issued.token,
  ])
    expect(() => auth.authenticate(header, secret)).toThrow('Invalid');
  expect(() => auth.authenticate(bearer(issued), '')).toThrow('Invalid');
});

it('serializes concurrent changes and never reports a failed persistence as success', async () => {
  const [second, third] = await Promise.all([
    auth.create(input, secret),
    auth.create(input, secret),
    auth.revoke(issued.device.id),
  ]);
  expect(auth.list().map((d) => d.id)).toEqual([second.device.id, third.device.id]);
  save.mockRejectedValueOnce(new Error('DB offline'));
  await expect(auth.revoke(second.device.id)).rejects.toThrow('DB offline');
  expect(auth.authenticate(bearer(second), secret).id).toBe(second.device.id);
  await auth.revoke(second.device.id);
  expect(() => auth.authenticate(bearer(second), secret)).toThrow('Invalid');
});

// What `npm run create-token` does while the server is up: the same row,
// written by another process.
it('keeps a token another process issued when it next writes, and honours it from then on', async () => {
  const cli = createMobileAuth({ load, save, now: () => clock });
  await cli.init();
  const outside = await cli.create({ ...input, label: 'From the CLI', permission: 'admin' }, secret);
  expect(() => auth.authenticate(bearer(outside), secret)).toThrow('Invalid');
  await auth.revoke(issued.device.id);
  expect(saved.map((d) => d.label)).toEqual(['From the CLI']);
  expect(auth.authenticate(bearer(outside), secret).permission).toBe('admin');
});

it('gives an admin token no project list of its own', async () => {
  const admin = await auth.create({ ...input, permission: 'admin', repos: ['ignored/list'] }, secret);
  expect(admin.device.repos).toEqual([]);
  // No project has to exist yet for the operator's own token to be issued.
  await expect(auth.create({ ...input, permission: 'admin', repos: [] }, secret)).resolves.toBeTruthy();
});

it('validates the name, the permission, the projects and the expiry', () => {
  for (const overrides of [
    { days: 0 },
    { days: 366 },
    { days: 1.5 },
    { permission: 'owner' },
    { label: '' },
    { repos: [] },
    { repos: ['not a repo'] },
  ])
    expect(() => auth.create({ ...input, ...overrides }, secret)).toThrow();
  expect(() => auth.create(input, '')).toThrow('AUTH_SECRET');
});

// Two processes over one stored row: the server, and `npm run create-token`.
function sharedRow() {
  let row = [];
  return {
    load: async () => structuredClone(row),
    save: async (_name, value) => {
      row = structuredClone(value);
    },
  };
}

it('picks up tokens issued and revoked by another process when it refreshes', async () => {
  const row = sharedRow();
  const server = createMobileAuth(row);
  const cli = createMobileAuth(row);
  await server.init();
  await cli.init();
  const { device, token } = await cli.create(input, secret);
  expect(() => server.authenticate(`Bearer ${token}`, secret)).toThrow('Invalid');
  await server.refresh();
  expect(server.authenticate(`Bearer ${token}`, secret).id).toBe(device.id);
  await cli.revoke(device.id);
  await server.refresh();
  expect(() => server.authenticate(`Bearer ${token}`, secret)).toThrow('Invalid');
});

it('keeps the last good list when a refresh fails', async () => {
  const row = sharedRow();
  let down = false;
  const server = createMobileAuth({
    ...row,
    load: async (...args) => {
      if (down) throw new Error('DB down');
      return row.load(...args);
    },
  });
  await server.init();
  const { token } = await server.create(input, secret);
  down = true;
  await expect(server.refresh()).rejects.toThrow('DB down');
  expect(server.authenticate(`Bearer ${token}`, secret).label).toBe('Desktop');
});
