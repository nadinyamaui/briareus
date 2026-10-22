import { it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
const { createWhatsAppOwners } = await import('../lib/whatsapp-owners.js');

function owners(initial = {}, deps = {}) {
  let stored = structuredClone(initial);
  const save = vi.fn(async (_key, value) => {
    stored = structuredClone(value);
  });
  const store = createWhatsAppOwners({
    load: async () => structuredClone(stored),
    save,
    legacyOwner: () => 1,
    ...deps,
  });
  return { store, save, stored: () => stored };
}

it('gives `default` to the first admin and any other account to whoever starts it first', async () => {
  const { store, save, stored } = owners();
  await store.init();
  expect(store.ownerOf('default')).toBe(1);
  expect(store.owns(1, 'default')).toBe(true);
  expect(store.owns(2, 'default')).toBe(false);
  await expect(store.claim(2, 'default')).rejects.toMatchObject({ status: 404 });
  expect(store.ownerOf('ana')).toBeNull();
  await store.claim(2, 'ana');
  expect(store.owns(2, 'ana')).toBe(true);
  await store.claim(2, 'ana');
  expect(save).toHaveBeenCalledTimes(1);
  await expect(store.claim(3, 'ana')).rejects.toMatchObject({ status: 404 });
  expect(stored()).toEqual({ ana: 2 });
  expect(store.owns(null, 'default')).toBe(false);
});

it('keeps a claim it could not save from counting', async () => {
  const { store, save } = owners();
  await store.init();
  save.mockRejectedValueOnce(new Error('DB down'));
  await expect(store.claim(2, 'ana')).rejects.toThrow('DB down');
  expect(store.ownerOf('ana')).toBeNull();
});

it('never watches a group bound to an account its session’s owner does not own', async () => {
  const { createWhatsAppWatcher } = await import('../lib/whatsapp-watch.js');
  const job = { id: 'j1', webhook: { armed: true, whatsappGroup: '1203@g.us', whatsappAccount: 'bob' } };
  let mine = false;
  const watcher = createWhatsAppWatcher({
    service: { messages: async () => ({ messages: [] }) },
    getJob: () => job,
    listJobs: () => [job],
    allowed: () => true,
    mayUse: (_job, account) => mine && account === 'bob',
    deliver: () => {},
    load: async (_key, fallback) => fallback,
    save: async () => {},
    log: () => {},
  });
  expect(watcher.watching('j1', 'bob', '1203@g.us')).toBe(false);
  mine = true;
  expect(watcher.watching('j1', 'bob', '1203@g.us')).toBe(true);
});

it.each(['constructor', 'toString', '__proto__'])('claims and reloads the valid name %s', async (account) => {
  const { store, stored } = owners();
  await store.init();
  expect(store.ownerOf(account)).toBeNull();
  await store.claim(2, account);
  expect(store.owns(2, account)).toBe(true);
  expect(Object.hasOwn(stored(), account)).toBe(true);
  await store.init();
  expect(store.owns(2, account)).toBe(true);
  await expect(store.claim(3, account)).rejects.toMatchObject({ status: 404 });
});

it('does not expose or reassign an existing account if its legacy assignment cannot be saved', async () => {
  const lookupAccount = vi.fn(async () => ({ account: { id: 'business', status: 'WORKING' } }));
  const { store, save, stored } = owners({}, { lookupAccount });
  await store.init();
  save.mockRejectedValueOnce(new Error('DB down'));
  await expect(store.claim(2, 'business')).rejects.toThrow('DB down');
  expect(store.ownerOf('business')).toBeNull();
  expect(stored()).toEqual({});
  await expect(store.claim(2, 'business')).rejects.toMatchObject({ status: 404 });
  expect(store.ownerOf('business')).toBe(1);
  await store.claim(1, 'business');
  expect(lookupAccount).toHaveBeenCalledTimes(2);
});

it('refuses to claim an existing account without a legacy owner', async () => {
  const { store, save } = owners(
    {},
    {
      legacyOwner: () => null,
      lookupAccount: async () => ({ account: { id: 'business' } }),
    },
  );
  await store.init();
  await expect(store.claim(2, 'business')).rejects.toMatchObject({ status: 503 });
  expect(save).not.toHaveBeenCalled();
  expect(store.ownerOf('business')).toBeNull();
});

it('serializes new claims and preserves a persisted owner without consulting WAHA', async () => {
  const lookupAccount = vi.fn(async () => {
    throw Object.assign(new Error('Missing'), { status: 404 });
  });
  const { store } = owners({}, { lookupAccount });
  await store.init();
  const claims = await Promise.allSettled([store.claim(2, 'ana'), store.claim(3, 'ana')]);
  expect(claims.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  await store.init();
  await store.claim(2, 'ana');
  expect(store.ownerOf('ana')).toBe(2);
  expect(lookupAccount).toHaveBeenCalledTimes(1);
});
