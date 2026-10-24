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
  const save = vi.fn().mockRejectedValueOnce(new Error('DB down')).mockResolvedValue(undefined);
  const credentials = createUserCredentials({
    load: async () => [],
    save,
  });
  await credentials.init();
  await expect(credentials.set(2, 'github', { token: 't' })).rejects.toThrow('DB down');
  expect(credentials.get(2, 'github')).toBeNull();
  await credentials.set(2, 'github', { token: 'new' });
  expect(credentials.get(2, 'github')).toEqual({ token: 'new' });
});

it('refreshes connections, replacements and disconnects made through another server', async () => {
  let table = [];
  const options = {
    load: async () => structuredClone(table),
    save: async (userId, kind, value) => {
      table = [{ userId, kind, value }];
    },
    remove: async () => {
      table = [];
    },
  };
  const a = createUserCredentials(options);
  const b = createUserCredentials(options);
  await Promise.all([a.init(), b.init()]);
  for (const login of ['ana', 'bea']) {
    const identity = { token: `${login}-token`, login };
    await a.set(2, 'github', identity);
    await b.refresh();
    expect(b.get(2, 'github')).toEqual(identity);
  }
  await a.remove(2, 'github');
  await b.refresh();
  expect(b.get(2, 'github')).toBeNull();
});

it('recovers initialization on refresh and keeps the queue usable after a failed refresh', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('DB down')).mockResolvedValue([]);
  const credentials = createUserCredentials({ load, save: async () => {} });
  await expect(credentials.init()).rejects.toThrow('DB down');
  await credentials.refresh();
  expect(credentials.get(2, 'github')).toBeNull();
  load.mockRejectedValueOnce(new Error('DB down'));
  await expect(credentials.refresh()).rejects.toThrow('DB down');
  await credentials.set(2, 'github', { token: 'new' });
  expect(credentials.get(2, 'github')).toEqual({ token: 'new' });
});

it('orders refreshes and mutations so a delayed snapshot cannot restore a disconnected PAT', async () => {
  let table = [];
  const load = vi.fn(async () => structuredClone(table));
  const disconnect = Promise.withResolvers();
  const disconnectStarted = Promise.withResolvers();
  const remove = vi.fn(async () => {
    disconnectStarted.resolve();
    await disconnect.promise;
    table = [];
  });
  const credentials = createUserCredentials({
    load,
    save: async (userId, kind, value) => {
      table = [{ userId, kind, value }];
    },
    remove,
  });
  await credentials.init();
  await credentials.set(2, 'github', { token: 'old' });
  const snapshot = Promise.withResolvers();
  const loadStarted = Promise.withResolvers();
  load.mockImplementationOnce(() => {
    loadStarted.resolve();
    return snapshot.promise;
  });
  const firstRefresh = credentials.refresh();
  await loadStarted.promise;
  const removing = credentials.remove(2, 'github');
  const nextRefresh = credentials.refresh();
  await Promise.resolve();
  expect(remove).not.toHaveBeenCalled();
  snapshot.resolve(structuredClone(table));
  await disconnectStarted.promise;
  expect(load).toHaveBeenCalledTimes(2);
  disconnect.resolve();
  await Promise.all([firstRefresh, removing, nextRefresh]);
  expect(credentials.get(2, 'github')).toBeNull();
  expect(table).toEqual([]);
});

it('finishes saving and publishing a credential before a queued disconnect', async () => {
  let row = null;
  let acknowledgeSave;
  const acknowledgement = new Promise((resolve) => {
    acknowledgeSave = resolve;
  });
  const remove = vi.fn(async () => {
    row = null;
  });
  const options = {
    load: async () => (row ? [{ userId: 2, kind: 'github', value: row }] : []),
    save: vi.fn(async (_userId, _kind, sealed) => {
      row = sealed;
      await acknowledgement;
    }),
    remove,
  };
  const credentials = createUserCredentials(options);
  await credentials.init();
  const saving = credentials.set(2, 'github', { token: 'old' });
  await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
  const disconnecting = credentials.remove(2, 'github');
  await new Promise((resolve) => setImmediate(resolve));
  expect(remove).not.toHaveBeenCalled();
  acknowledgeSave();
  await Promise.all([saving, disconnecting]);
  expect(row).toBeNull();
  expect(credentials.get(2, 'github')).toBeNull();
  const restarted = createUserCredentials(options);
  await restarted.init();
  expect(restarted.get(2, 'github')).toBeNull();
});

it('keeps unavailable credentials distinct from disconnected accounts and retries initialization once', async () => {
  let finishLoad;
  const loading = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const load = vi.fn().mockRejectedValueOnce(new Error('DB down')).mockReturnValueOnce(loading);
  const save = vi.fn(async () => {});
  const credentials = createUserCredentials({ load, save });
  await expect(credentials.init()).rejects.toThrow('DB down');
  expect(() => credentials.get(2, 'github')).toThrow(expect.objectContaining({ status: 503 }));
  await expect(credentials.set(2, 'github', { token: 'too-early' })).rejects.toMatchObject({ status: 503 });
  expect(save).not.toHaveBeenCalled();
  await expect(credentials.remove(2, 'github')).rejects.toMatchObject({ status: 503 });
  const first = credentials.init();
  const second = credentials.init();
  finishLoad([]);
  await Promise.all([first, second]);
  expect(load).toHaveBeenCalledTimes(2);
  expect(credentials.get(2, 'github')).toBeNull();
  await credentials.set(2, 'github', { token: 'connected' });
  await credentials.init();
  expect(load).toHaveBeenCalledTimes(2);
  expect(credentials.get(2, 'github')).toEqual({ token: 'connected' });
});
