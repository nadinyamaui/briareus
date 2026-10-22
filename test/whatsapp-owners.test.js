import { it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
const { createWhatsAppOwners } = await import('../lib/whatsapp-owners.js');

function owners(initial = {}) {
  let stored = structuredClone(initial);
  const save = vi.fn(async (_key, value) => {
    stored = structuredClone(value);
  });
  const store = createWhatsAppOwners({
    load: async () => structuredClone(stored),
    save,
    legacyOwner: () => 1,
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
