import { it, expect } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';

// Two processes over one stored row: the server, and `npm run token` in a shell.
function sharedRow() {
  let saved = [];
  const load = async () => structuredClone(saved);
  const save = async (_name, value) => {
    saved = structuredClone(value);
  };
  return { load, save };
}

const admin = { label: 'Web', repos: [], permission: 'admin', days: 30 };

it('a write in one process does not erase a token another process issued', async () => {
  const row = sharedRow();
  const server = createMobileAuth(row);
  const cli = createMobileAuth(row);
  await server.init();
  await cli.init();
  const fromCli = await cli.create(admin, 'secret');
  // The server never reloaded, yet its own add starts from the stored row.
  await server.create({ ...admin, label: 'iPhone' }, 'secret');
  const restarted = createMobileAuth(row);
  await restarted.init();
  expect(restarted.list().map((d) => d.label)).toEqual(['Web', 'iPhone']);
  expect(restarted.authenticate(`Bearer ${fromCli.token}`, 'secret').id).toBe(fromCli.device.id);
});

it('refresh picks up tokens issued and revoked elsewhere', async () => {
  const row = sharedRow();
  const server = createMobileAuth(row);
  const cli = createMobileAuth(row);
  await server.init();
  await cli.init();
  const { device, token } = await cli.create(admin, 'secret');
  expect(() => server.authenticate(`Bearer ${token}`, 'secret')).toThrow('Invalid');
  await server.refresh();
  expect(server.authenticate(`Bearer ${token}`, 'secret').id).toBe(device.id);
  await cli.revoke(device.id);
  await server.refresh();
  expect(() => server.authenticate(`Bearer ${token}`, 'secret')).toThrow('Invalid');
});

it('a failed refresh keeps the last good list', async () => {
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
  const { token } = await server.create(admin, 'secret');
  down = true;
  await expect(server.refresh()).rejects.toThrow('DB down');
  expect(server.authenticate(`Bearer ${token}`, 'secret').label).toBe('Web');
});
