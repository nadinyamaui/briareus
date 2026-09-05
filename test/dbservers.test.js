import { describe, it, expect, vi, beforeEach } from 'vitest';

// normalizeServer and findClash are not exported; createDbServer/updateDbServer
// are the doors to them, so the validation and the clash check are tested
// through those, with the DB layer handing back whatever it was asked to save.
const state = vi.hoisted(() => ({ rows: [], saved: [], deleted: [], nextId: 1, loadError: null }));

vi.mock('../lib/db.js', () => ({
  loadDbServerRows: async () => {
    if (state.loadError) throw state.loadError;
    return state.rows;
  },
  saveDbServer: async (s) => {
    const saved = { ...s, id: s.id ?? state.nextId++ };
    state.saved.push(saved);
    // A write is followed by reload(), so the cache must see the new row.
    state.rows = [...state.rows.filter((r) => r.id !== saved.id), saved];
    return saved;
  },
  deleteDbServer: async (id) => {
    state.deleted.push(id);
    state.rows = state.rows.filter((r) => r.id !== Number(id));
    return true;
  },
  getDbServerRow: async (id) => state.rows.find((r) => r.id === Number(id)) || null,
}));

const {
  initDbServers,
  listDbServers,
  activeDbServers,
  getDbServer,
  createDbServer,
  updateDbServer,
  removeDbServer,
  DB_SERVER_DEFAULTS,
} = await import('../lib/dbservers.js');

// The module caches the rows at boot and refreshes on every write, so each test
// starts by seeding the table and re-reading it into that cache.
async function seed(rows) {
  state.rows = rows;
  state.saved = [];
  state.deleted = [];
  state.loadError = null;
  state.nextId = Math.max(0, ...rows.map((r) => r.id || 0)) + 1;
  await initDbServers();
}

describe('the cache', () => {
  beforeEach(() => seed([]));

  it('reads the table at boot', async () => {
    await seed([{ id: 1, host: 'a', port: 3306, enabled: true }]);

    expect(listDbServers()).toHaveLength(1);
  });

  it('survives a table that will not load, keeping the last cache it had', async () => {
    // A pool that cannot be read must not stop the boot: the app still comes
    // up, it just has whatever it last knew about to hand out.
    await seed([{ id: 1, host: 'a', port: 3306, enabled: true }]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.loadError = new Error('server has gone away');

    await expect(initDbServers()).resolves.toHaveLength(1);
    expect(err).toHaveBeenCalledWith('Could not load database servers:', 'server has gone away');

    err.mockRestore();
    state.loadError = null;
  });

  it('lists every server but only hands out the enabled ones to claim', async () => {
    await seed([
      { id: 1, host: 'a', port: 3306, enabled: true },
      { id: 2, host: 'b', port: 3306, enabled: false },
    ]);

    expect(listDbServers()).toHaveLength(2);
    expect(activeDbServers().map((s) => s.id)).toEqual([1]);
  });

  it('finds a server by id, coercing the string an HTTP route hands it', async () => {
    await seed([{ id: 7, host: 'a', port: 3306, enabled: true }]);

    expect(getDbServer('7').host).toBe('a');
    expect(getDbServer(7).host).toBe('a');
  });

  it('answers null for an id that is not in the pool', async () => {
    await seed([{ id: 7, host: 'a', port: 3306, enabled: true }]);

    expect(getDbServer(8)).toBeNull();
  });
});

describe('creating a server', () => {
  beforeEach(() => seed([]));

  it('fills the defaults for everything not given', async () => {
    const saved = await createDbServer({ host: 'db.internal' });

    expect(saved).toMatchObject({
      host: 'db.internal',
      port: DB_SERVER_DEFAULTS.port,
      username: DB_SERVER_DEFAULTS.username,
      password: '',
      enabled: true,
    });
  });

  it('labels an unlabelled server with its address', async () => {
    const saved = await createDbServer({ host: 'db.internal', port: 3307 });

    expect(saved.label).toBe('db.internal:3307');
  });

  it('keeps a label that was given, trimmed', async () => {
    const saved = await createDbServer({ host: 'a', label: '  staging  ' });

    expect(saved.label).toBe('staging');
  });

  it('appends to the end of the order when no position is given', async () => {
    await seed([{ id: 1, host: 'a', port: 3306, enabled: true, sortOrder: 4 }]);

    const saved = await createDbServer({ host: 'b' });

    expect(saved.sortOrder).toBe(5);
  });

  it('keeps an explicit position', async () => {
    const saved = await createDbServer({ host: 'a', sortOrder: 9 });

    expect(saved.sortOrder).toBe(9);
  });

  it('refuses a server with no host', async () => {
    await expect(createDbServer({ host: '   ' })).rejects.toThrow(/needs a host/);
  });

  it('refuses a null host as firmly as a blank one', async () => {
    await expect(createDbServer({ host: null })).rejects.toThrow(/needs a host/);
  });

  it('refuses a server with no username', async () => {
    await expect(createDbServer({ host: 'a', username: '  ' })).rejects.toThrow(/needs a username/);
  });

  it('refuses a null username as firmly as a blank one', async () => {
    await expect(createDbServer({ host: 'a', username: null })).rejects.toThrow(/needs a username/);
  });

  it('reads a null password as the empty one', async () => {
    const saved = await createDbServer({ host: 'a', password: null });

    expect(saved.password).toBe('');
  });

  it('falls back to the address when the label given is null', async () => {
    const saved = await createDbServer({ host: 'a', port: 3306, label: null });

    expect(saved.label).toBe('a:3306');
  });

  it('reads an unparseable position as the front of the order', async () => {
    const saved = await createDbServer({ host: 'a', sortOrder: 'not a number' });

    expect(saved.sortOrder).toBe(0);
  });

  it.each([
    ['0', 0],
    ['65536', 65536],
    ['not a number', 'abc'],
    ['a fraction', 3306.5],
  ])('refuses %s as a port', async (_label, port) => {
    await expect(createDbServer({ host: 'a', port })).rejects.toThrow(/is not a valid port/);
  });

  it('keeps a password that is deliberately empty', async () => {
    // A MySQL user without a password is a real answer, not a missing one.
    const saved = await createDbServer({ host: 'a', password: '' });

    expect(saved.password).toBe('');
  });

  it('refuses a second entry for the same host and port', async () => {
    await seed([{ id: 1, host: 'db.internal', port: 3306, enabled: true, sortOrder: 1 }]);

    await expect(createDbServer({ host: 'db.internal', port: 3306 })).rejects.toThrow(/already in the pool/);
  });

  it('compares hosts case-insensitively when looking for a clash', async () => {
    // Two entries for one server would hand two sessions the same database,
    // which is the whole thing the pool exists to prevent.
    await seed([{ id: 1, host: 'DB.Internal', port: 3306, enabled: true, sortOrder: 1 }]);

    await expect(createDbServer({ host: 'db.internal', port: 3306 })).rejects.toThrow(/already in the pool/);
  });

  it('allows the same host on a different port', async () => {
    await seed([{ id: 1, host: 'db.internal', port: 3306, enabled: true, sortOrder: 1 }]);

    await expect(createDbServer({ host: 'db.internal', port: 3307 })).resolves.toMatchObject({
      port: 3307,
    });
  });
});

describe('updating a server', () => {
  const existing = {
    id: 1,
    host: 'a',
    port: 3306,
    username: 'root',
    password: 'p',
    enabled: true,
    label: 'one',
    sortOrder: 1,
  };

  beforeEach(() => seed([{ ...existing }]));

  it('keeps the fields the edit did not mention', async () => {
    const saved = await updateDbServer(1, { label: 'renamed' });

    expect(saved).toMatchObject({
      id: 1,
      host: 'a',
      port: 3306,
      username: 'root',
      password: 'p',
      label: 'renamed',
    });
  });

  it('can switch a server off without touching anything else', async () => {
    const saved = await updateDbServer(1, { enabled: false });

    expect(saved.enabled).toBe(false);
    expect(activeDbServers()).toEqual([]);
  });

  it('refuses an id that is not in the pool', async () => {
    await expect(updateDbServer(99, { host: 'b' })).rejects.toThrow(/not found/);
  });

  it('does not count the server against itself when checking for a clash', async () => {
    await expect(updateDbServer(1, { label: 'still one' })).resolves.toMatchObject({ id: 1 });
  });

  it('refuses a move onto another entry address', async () => {
    await seed([
      { ...existing },
      { id: 2, host: 'b', port: 3306, username: 'root', enabled: true, sortOrder: 2 },
    ]);

    await expect(updateDbServer(2, { host: 'a' })).rejects.toThrow(/already in the pool/);
  });
});

describe('removing a server', () => {
  beforeEach(() => seed([{ id: 1, host: 'a', port: 3306, enabled: true, sortOrder: 1 }]));

  it('drops it from the table and the cache', async () => {
    const removed = await removeDbServer(1);

    expect(removed).toBe(true);
    expect(state.deleted).toEqual([1]);
    expect(listDbServers()).toEqual([]);
  });
});
