import { it, expect, vi } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));
vi.mock('../lib/db.js', () => ({
  loadUserCredentialRows: vi.fn(),
  saveUserCredential: vi.fn(),
  deleteUserCredential: vi.fn(),
}));
const { createUserCredentials } = await import('../lib/user-credentials.js');

it('keeps each user’s credentials sealed, by kind, across a restart', async () => {
  let table = [];
  const options = {
    load: async () => table,
    save: async (userId, kind, value) => {
      table = [...table.filter((r) => !(r.userId === userId && r.kind === kind)), { userId, kind, value }];
    },
    remove: async (userId, kind) => {
      table = table.filter((r) => !(r.userId === userId && r.kind === kind));
    },
  };
  const credentials = createUserCredentials(options);
  await credentials.init();
  await credentials.set(2, 'github', { token: 'ghp_secret', login: 'ana' });
  expect(JSON.stringify(table)).not.toContain('ghp_secret');
  expect(credentials.get(2, 'github')).toEqual({ token: 'ghp_secret', login: 'ana' });
  expect(credentials.get(1, 'github')).toBeNull();
  expect(credentials.get(null, 'github')).toBeNull();
  const restarted = createUserCredentials(options);
  await restarted.init();
  expect(restarted.get(2, 'github').login).toBe('ana');
  await restarted.remove(2, 'github');
  expect(restarted.get(2, 'github')).toBeNull();
  expect(table).toEqual([]);
});

it('keeps the cache unchanged when the write fails', async () => {
  const credentials = createUserCredentials({
    load: async () => [],
    save: async () => {
      throw new Error('DB down');
    },
  });
  await credentials.init();
  await expect(credentials.set(2, 'github', { token: 't' })).rejects.toThrow('DB down');
  expect(credentials.get(2, 'github')).toBeNull();
});
