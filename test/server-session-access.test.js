import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({
  loadShareRows: vi.fn(),
  replaceShares: vi.fn(),
  loadUserCredentialRows: vi.fn(),
  saveUserCredential: vi.fn(),
  deleteUserCredential: vi.fn(),
}));
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));
const { createUserCredentials } = await import('../lib/user-credentials.js');
const { seal } = await import('../lib/secretbox.js');
const { createShares } = await import('../lib/shares.js');

// Exercise the server's actual wiring without booting its workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const wiring = source.slice(source.indexOf('const sessionMayUse ='), source.indexOf('// On every response,'));

it('checks session project access against the shared project ID', async () => {
  const shares = createShares({
    load: async () => [{ kind: 'project', id: '3', userId: 2 }],
  });
  await shares.init();
  const owners = [
    { id: 1, role: 'admin', disabledAt: null },
    { id: 2, role: 'member', disabledAt: null },
  ];
  const users = { get: (id) => owners.find((u) => u.id === id) };
  const projects = [
    { id: 3, repo: 'acme/shared' },
    { id: 4, repo: 'acme/private' },
  ];
  let allowed;
  new Function('users', 'shares', 'getProject', 'setDbServerFilter', 'setSessionProjectAccess', wiring)(
    users,
    shares,
    (repo) => projects.find((p) => p.repo === repo),
    vi.fn(),
    (fn) => {
      allowed = fn;
    },
  );
  expect(allowed({ ownerId: 2 }, 'acme/shared')).toBe(true);
  expect(allowed({ ownerId: 2 }, 'acme/private')).toBe(false);
  expect(allowed({ ownerId: 1 }, 'acme/private')).toBe(true);
  expect(allowed({ ownerId: null }, 'acme/private')).toBe(true);
  owners[1].disabledAt = 1;
  expect(allowed({ ownerId: 2 }, 'acme/shared')).toBe(false);
  expect(allowed({ ownerId: 99 }, 'acme/shared')).toBe(false);
});

it.each(['shares', 'credentials'])(
  'recovers a failed %s startup load without using the server identity',
  async (failedStore) => {
    const loadShares = vi.fn(async () => [{ kind: 'project', id: '3', userId: 2 }]);
    const savedIdentity = { token: 'stored-token', login: 'ana' };
    const loadCredentials = vi.fn(async () => [
      { userId: 2, kind: 'github', value: seal(JSON.stringify(savedIdentity)) },
    ]);
    (failedStore === 'shares' ? loadShares : loadCredentials).mockRejectedValueOnce(new Error('DB down'));
    const shares = createShares({ load: loadShares });
    const credentials = createUserCredentials({ load: loadCredentials, save: async () => {} });
    const users = { init: vi.fn(), refresh: vi.fn(async () => {}), get: () => ({ id: 2, disabledAt: null }) };
    const mobileAuth = { init: vi.fn(), refresh: vi.fn(async () => {}) };
    const boot = source.slice(
      source.indexOf('    await users.init();'),
      source.indexOf('    await initSavedPrompts();'),
    );
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await expect(
      new AsyncFunction('users', 'shares', 'credentials', 'mobileAuth', boot)(
        users,
        shares,
        credentials,
        mobileAuth,
      ),
    ).rejects.toThrow('DB down');
    const identityWiring = source.slice(
      source.indexOf('const githubOf ='),
      source.indexOf('setOwnerGithub('),
    );
    const githubOf = new Function('users', 'credentials', identityWiring + 'return githubOf;')(
      users,
      credentials,
    );
    expect(() => githubOf(2)).toThrow(expect.objectContaining({ status: 503 }));
    let refresh;
    const timer = source.slice(
      source.indexOf('  setInterval(() => {\n    mobileAuth.refresh()'),
      source.indexOf('  // Every connected mailbox'),
    );
    new Function('setInterval', 'users', 'shares', 'credentials', 'mobileAuth', timer)(
      (fn) => {
        refresh = fn;
        return { unref() {} };
      },
      users,
      shares,
      credentials,
      mobileAuth,
    );
    refresh();
    await vi.waitFor(() => {
      expect(shares.allows({ id: 2, role: 'member' }, 'project', 3)).toBe(true);
      expect(githubOf(2)).toEqual(savedIdentity);
    });
    await credentials.set(2, 'github', { token: 'ana-token', login: 'ana' });
    refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(githubOf(2)).toEqual({ token: 'ana-token', login: 'ana' });
    expect(loadShares).toHaveBeenCalledTimes(failedStore === 'shares' ? 2 : 1);
    expect(loadCredentials).toHaveBeenCalledTimes(failedStore === 'credentials' ? 2 : 1);
  },
);
