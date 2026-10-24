import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({
  loadShareRows: vi.fn(),
  loadUserRows: vi.fn(),
  replaceShares: vi.fn(),
  loadUserCredentialRows: vi.fn(),
  saveUserCredential: vi.fn(),
  deleteUserCredential: vi.fn(),
}));
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));
const { createUserCredentials } = await import('../lib/user-credentials.js');
const { seal } = await import('../lib/secretbox.js');
const { createShares } = await import('../lib/shares.js');
const { createUsers } = await import('../lib/users.js');

// Exercise the server's actual wiring without booting its workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const wiring = source.slice(source.indexOf('const sessionMayUse ='), source.indexOf('// On every response,'));

it('keeps legacy inbox access with the original operator through demotion and disable', () => {
  const owners = [
    { id: 1, role: 'admin', disabledAt: null },
    { id: 2, role: 'admin', disabledAt: null },
  ];
  const users = { list: () => owners, get: (id) => owners.find((u) => u.id === id) };
  const inboxWiring = source.slice(source.indexOf('const inboxOwner ='), source.indexOf('setInboxOwner('));
  const inboxOwner = new Function('users', inboxWiring + 'return inboxOwner;')(users);
  expect(inboxOwner({ ownerId: null })).toBe(1);
  owners[0].role = 'member';
  expect(inboxOwner({ ownerId: null })).toBe(1);
  owners[0].disabledAt = 1;
  expect(inboxOwner({ ownerId: null })).toBeNull();
  expect(inboxOwner({ ownerId: 1 })).toBeNull();
  expect(inboxOwner({ ownerId: 2 })).toBe(2);
  expect(inboxOwner({ ownerId: 99 })).toBeNull();
  owners.length = 0;
  expect(inboxOwner({ ownerId: null })).toBeNull();
});

it.each([null, 1])('reports unavailable inbox ownership until users recover (owner %s)', async (ownerId) => {
  const load = vi.fn(async () => [{ id: 1, disabledAt: null }]);
  load.mockRejectedValueOnce(new Error('DB down'));
  const users = createUsers({ load });
  await expect(users.init()).rejects.toThrow('DB down');
  const inboxWiring = source.slice(source.indexOf('const inboxOwner ='), source.indexOf('setInboxOwner('));
  const inboxOwner = new Function('users', inboxWiring + 'return inboxOwner;')(users);
  expect(() => inboxOwner({ ownerId })).toThrow(expect.objectContaining({ status: 503 }));
  await users.refresh();
  expect(inboxOwner({ ownerId })).toBe(1);
});

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
  new Function('users', 'shares', 'setDbServerFilter', 'setSessionProjectFilter', wiring)(
    users,
    shares,
    vi.fn(),
    (fn) => {
      allowed = fn;
    },
  );
  expect(allowed({ ownerId: 2 }, projects[0])).toBe(true);
  expect(allowed({ ownerId: 2 }, projects[1])).toBe(false);
  expect(allowed({ ownerId: 1 }, projects[1])).toBe(true);
  expect(allowed({ ownerId: null }, projects[1])).toBe(true);
  owners[1].disabledAt = 1;
  expect(allowed({ ownerId: 2 }, projects[0])).toBe(false);
  expect(allowed({ ownerId: 99 }, projects[0])).toBe(false);
});

it.each(['shares', 'credentials'])(
  'continues startup after a failed %s load and recovers without changing identity',
  async (failedStore) => {
    const loadShares = vi.fn(async () => [{ kind: 'project', id: '3', userId: 2 }]);
    const savedIdentity = { token: 'stored-token', login: 'ana' };
    let credentialRows = [{ userId: 2, kind: 'github', value: seal(JSON.stringify(savedIdentity)) }];
    const loadCredentials = vi.fn(async () => structuredClone(credentialRows));
    (failedStore === 'shares' ? loadShares : loadCredentials).mockRejectedValueOnce(new Error('DB down'));
    const shares = createShares({ load: loadShares });
    const credentials = createUserCredentials({
      load: loadCredentials,
      save: async (userId, kind, value) => {
        credentialRows = [{ userId, kind, value }];
      },
    });
    const users = {
      init: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      get: () => ({ id: 2, disabledAt: null }),
    };
    const mobileAuth = { init: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
    const slackService = { migrateLegacyOwnership: vi.fn(async () => {}) };
    const boot = source.slice(
      source.indexOf('    await shares.init().catch('),
      source.indexOf('    await initSavedPrompts();'),
    );
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('users', 'shares', 'credentials', 'mobileAuth', boot)(
      users,
      shares,
      credentials,
      mobileAuth,
    );
    const identityWiring = source.slice(
      source.indexOf('const githubOf ='),
      source.indexOf('setOwnerGithub('),
    );
    const githubOf = new Function('users', 'credentials', identityWiring + 'return githubOf;')(
      users,
      credentials,
    );
    if (failedStore === 'credentials')
      expect(() => githubOf(2)).toThrow(expect.objectContaining({ status: 503 }));
    else {
      expect(() => shares.allows({ id: 2, role: 'member' }, 'project', 3)).toThrow(
        expect.objectContaining({ status: 503 }),
      );
      expect(githubOf(2)).toEqual(savedIdentity);
    }
    let refresh;
    const timer = source.slice(
      source.indexOf('  setInterval(() => {\n    mobileAuth.refresh()'),
      source.indexOf('  // Every connected mailbox'),
    );
    new Function('setInterval', 'users', 'shares', 'credentials', 'mobileAuth', 'slackService', timer)(
      (fn) => {
        refresh = fn;
        return { unref() {} };
      },
      users,
      shares,
      credentials,
      mobileAuth,
      slackService,
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
    expect(loadShares).toHaveBeenCalledTimes(3);
    expect(loadCredentials).toHaveBeenCalledTimes(3);
    // A different server replaces, then disconnects the account in shared storage.
    const replacement = { token: 'bea-token', login: 'bea' };
    credentialRows = [{ userId: 2, kind: 'github', value: seal(JSON.stringify(replacement)) }];
    refresh();
    await vi.waitFor(() => expect(githubOf(2)).toEqual(replacement));
    credentialRows = [];
    refresh();
    await vi.waitFor(() => expect(githubOf(2)).toBeNull());
  },
);
