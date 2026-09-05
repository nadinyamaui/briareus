import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// normalizeProvider and adoptLogins are not exported; createProvider,
// updateProvider and initProviders are the doors to them. lib/providers.js is
// mocked down to the surface this module actually uses: the binary registry and
// the six config-dir/login helpers, all of which touch disk in the real thing.
const state = vi.hoisted(() => ({
  rows: [],
  saved: [],
  deleted: [],
  nextId: 1,
  loadError: null,
  saveError: null,
  claudeAuth: null,
  codexAuth: null,
  grokAuth: null,
  ensureThrows: null,
}));

vi.mock('../lib/db.js', () => ({
  loadProviderRows: async () => {
    if (state.loadError) throw state.loadError;
    return state.rows;
  },
  saveProviderRow: async (p) => {
    if (state.saveError) throw state.saveError;
    const saved = { ...p, id: p.id ?? state.nextId++ };
    state.saved.push(saved);
    state.rows = [...state.rows.filter((r) => r.id !== saved.id), saved];
    return saved;
  },
  deleteProviderRow: async (id) => {
    state.deleted.push(id);
    state.rows = state.rows.filter((r) => r.id !== Number(id));
    return true;
  },
  getProviderRow: async (id) => state.rows.find((r) => r.id === Number(id)) || null,
}));

vi.mock('../lib/providers.js', () => {
  const binary = (name, models, efforts, defaultModel, defaultEffort) => ({
    label: `${name} label`,
    models: () => models,
    efforts,
    defaultModel: () => defaultModel,
    defaultEffort: () => defaultEffort,
  });
  const BINARIES = {
    claude: binary('claude', ['opus', 'sonnet'], ['low', 'high'], 'opus', 'high'),
    codex: binary('codex', ['gpt-a', 'gpt-b'], ['med', 'max'], 'gpt-a', 'max'),
    grok: binary('grok', ['grok-1'], ['fast'], 'grok-1', 'fast'),
    opencode: binary('opencode', ['anthropic/x'], ['high'], 'anthropic/x', 'high'),
  };
  const ensure = (kind) => (p) => {
    if (state.ensureThrows) throw state.ensureThrows;
    return `/home/test/.${kind}-provider-${p.id}`;
  };
  return {
    BINARIES,
    getBinary: (name) => BINARIES[name],
    ensureClaudeHome: ensure('claude'),
    ensureCodexHome: ensure('codex'),
    ensureGrokHome: ensure('grok'),
    ensureOpencodeHome: ensure('opencode'),
    readClaudeAuth: () => state.claudeAuth,
    readCodexAuth: () => state.codexAuth,
    readGrokAuth: () => state.grokAuth,
    // The real one reads the entry's cached catalog; here one slug is sold at
    // two sizes and the rest are not, which is all this module branches on.
    codexWideVariants: (slugs) => slugs.flatMap((s) => (s === 'gpt-a' ? [s, 'gpt-a (872k)'] : [s])),
  };
});

const store = await import('../lib/providerstore.js');
const {
  initProviders,
  listProviders,
  getProvider,
  getProviderForJob,
  providerModels,
  providerEfforts,
  providerDefaultModel,
  providerDefaultEffort,
  resolveRuntime,
  createProvider,
  updateProvider,
  removeProvider,
  captureProviderAuth,
  PROVIDER_DEFAULTS,
} = store;

const cfg = {};

// A row as the database hands it back, with every field the module reads present.
function row(over = {}) {
  return { id: 1, ...PROVIDER_DEFAULTS, ...over };
}

async function seed(rows) {
  state.rows = rows;
  state.saved = [];
  state.deleted = [];
  state.loadError = null;
  state.saveError = null;
  state.nextId = Math.max(0, ...rows.map((r) => r.id || 0)) + 1;
  await initProviders();
  state.saved = [];
}

let logs;
beforeEach(() => {
  // The login fixtures are reset here rather than in seed(), because a test
  // sets them *before* seeding, and seed() is what feeds them to initProviders.
  state.claudeAuth = null;
  state.codexAuth = null;
  state.grokAuth = null;
  state.ensureThrows = null;
  logs = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});
afterEach(() => {
  logs.log.mockRestore();
  logs.error.mockRestore();
});

describe('the cache', () => {
  it('reads the table at boot', async () => {
    await seed([row()]);

    expect(listProviders()).toHaveLength(1);
  });

  it('survives a table that will not load', async () => {
    await seed([row()]);
    state.loadError = new Error('server has gone away');

    await expect(initProviders()).resolves.toHaveLength(1);
    expect(logs.error).toHaveBeenCalledWith('Could not load providers:', 'server has gone away');
  });

  it('finds a provider by id, coercing the string an HTTP route hands it', async () => {
    await seed([row({ id: 4 })]);

    expect(getProvider('4').id).toBe(4);
    expect(getProvider(9)).toBeNull();
  });
});

describe('adopting a login at boot', () => {
  it('imports the machine codex login into a bare codex row', async () => {
    state.codexAuth = { token: 'from-disk' };
    await seed([row({ id: 1, binary: 'codex' })]);

    expect(state.rows[0].authData).toEqual({ token: 'from-disk' });
  });

  it('says so when it adopts one', async () => {
    state.codexAuth = { token: 'x' };
    state.rows = [row({ id: 1, binary: 'codex', label: 'work' })];
    state.nextId = 2;
    await initProviders();

    expect(logs.log).toHaveBeenCalledWith('Adopted codex login for "work" into the database');
  });

  it('leaves a codex row that already has a login alone', async () => {
    state.codexAuth = { token: 'from-disk' };
    await seed([row({ id: 1, binary: 'codex', authData: { token: 'kept' } })]);

    expect(state.rows[0].authData).toEqual({ token: 'kept' });
  });

  it('leaves a custom-endpoint codex row alone: it carries no login', async () => {
    state.codexAuth = { token: 'from-disk' };
    await seed([row({ id: 1, binary: 'codex', baseUrl: 'https://x.test' })]);

    expect(state.rows[0].authData).toBeNull();
  });

  it('leaves an api-key codex row alone', async () => {
    state.codexAuth = { token: 'from-disk' };
    await seed([row({ id: 1, binary: 'codex', apiKey: 'k' })]);

    expect(state.rows[0].authData).toBeNull();
  });

  it('imports the machine grok login into a bare grok row', async () => {
    state.grokAuth = { token: 'grok-disk' };
    await seed([row({ id: 1, binary: 'grok' })]);

    expect(state.rows[0].authData).toEqual({ token: 'grok-disk' });
  });

  it('adopts nothing when the machine has no login to give', async () => {
    await seed([row({ id: 1, binary: 'codex' })]);

    expect(state.rows[0].authData).toBeNull();
  });

  it('does not try to adopt for a claude row', async () => {
    state.claudeAuth = { token: 'x' };
    await seed([row({ id: 1, binary: 'claude' })]);

    expect(state.rows[0].authData).toBeNull();
  });

  it('reports a row it could not adopt and still comes up', async () => {
    state.codexAuth = { token: 'x' };
    state.rows = [row({ id: 1, binary: 'codex', label: 'broken' })];
    state.nextId = 2;
    state.saveError = new Error('table is read only');

    await initProviders();

    expect(logs.error).toHaveBeenCalledWith(
      'Could not adopt codex login for "broken":',
      'table is read only',
    );
    expect(listProviders()).toHaveLength(1);
    state.saveError = null;
  });

  it('makes sure each entry config dir exists', async () => {
    // An unwritable home must not stop the boot; it shows in the auth banner.
    state.ensureThrows = new Error('read-only filesystem');

    await expect(
      seed([
        row({ id: 1, binary: 'claude' }),
        row({ id: 2, binary: 'codex' }),
        row({ id: 3, binary: 'grok' }),
      ]),
    ).resolves.toBeUndefined();
  });

  it('leaves a row on a binary this build no longer has alone', async () => {
    // normalizeProvider cannot write one, but a row saved before a binary was
    // dropped is still in the table, so it gets no config dir rather than a crash
    // at boot.
    await seed([row({ id: 1, binary: 'retired' })]);

    expect(listProviders()).toHaveLength(1);
  });
});

describe('capturing a login back into the row', () => {
  beforeEach(() => seed([row({ id: 1, binary: 'claude' })]));

  it('saves a claude login that is new', async () => {
    state.claudeAuth = { token: 'fresh' };

    const saved = await captureProviderAuth(row({ id: 1, binary: 'claude' }));

    expect(saved.authData).toEqual({ token: 'fresh' });
  });

  it('writes nothing when the login has not changed', async () => {
    state.claudeAuth = { token: 'same' };

    const p = row({ id: 1, binary: 'claude', authData: { token: 'same' } });
    const saved = await captureProviderAuth(p);

    expect(saved).toBe(p);
    expect(state.saved).toHaveLength(0);
  });

  it('writes nothing when the dir holds no login', async () => {
    const p = row({ id: 1, binary: 'claude' });

    expect(await captureProviderAuth(p)).toBe(p);
  });

  it('captures a codex login when the entry has no custom endpoint', async () => {
    state.codexAuth = { token: 'codex-fresh' };

    const saved = await captureProviderAuth(row({ id: 1, binary: 'codex' }));

    expect(saved.authData).toEqual({ token: 'codex-fresh' });
  });

  it('captures nothing for a custom-endpoint codex entry', async () => {
    state.codexAuth = { token: 'x' };
    const p = row({ id: 1, binary: 'codex', baseUrl: 'https://x.test' });

    expect(await captureProviderAuth(p)).toBe(p);
  });

  it('captures nothing for an api-key codex entry', async () => {
    state.codexAuth = { token: 'x' };
    const p = row({ id: 1, binary: 'codex', apiKey: 'k' });

    expect(await captureProviderAuth(p)).toBe(p);
  });

  it('captures a grok login', async () => {
    state.grokAuth = { token: 'grok-fresh' };

    const saved = await captureProviderAuth(row({ id: 1, binary: 'grok' }));

    expect(saved.authData).toEqual({ token: 'grok-fresh' });
  });
});

describe('mapping a stored session onto a provider row', () => {
  it('uses the row id when the session has one', async () => {
    await seed([row({ id: 3, binary: 'claude' })]);

    expect(getProviderForJob({ providerId: 3 }).id).toBe(3);
  });

  it('answers null for a slug it does not know', async () => {
    await seed([row()]);

    expect(getProviderForJob({ provider: 'gemini' })).toBeNull();
    expect(getProviderForJob({})).toBeNull();
  });

  it('maps the plain claude slug to the first row without an endpoint', async () => {
    await seed([
      row({ id: 1, binary: 'claude', baseUrl: 'https://x.test' }),
      row({ id: 2, binary: 'claude' }),
    ]);

    expect(getProviderForJob({ provider: 'claude' }).id).toBe(2);
  });

  it('falls back to the first claude row when every one has an endpoint', async () => {
    await seed([row({ id: 1, binary: 'claude', baseUrl: 'https://x.test' })]);

    expect(getProviderForJob({ provider: 'claude' }).id).toBe(1);
  });

  it('maps claude2 to the row that carries a login', async () => {
    await seed([row({ id: 1, binary: 'claude' }), row({ id: 2, binary: 'claude', authData: { t: 1 } })]);

    expect(getProviderForJob({ provider: 'claude2' }).id).toBe(2);
  });

  it('maps claude2 to the second row when none carries a login', async () => {
    await seed([row({ id: 1, binary: 'claude' }), row({ id: 2, binary: 'claude' })]);

    expect(getProviderForJob({ provider: 'claude2' }).id).toBe(2);
  });

  it('answers null for claude2 when there is only one claude row', async () => {
    await seed([row({ id: 1, binary: 'claude' })]);

    expect(getProviderForJob({ provider: 'claude2' })).toBeNull();
  });

  it('maps zai to the codex row with an endpoint', async () => {
    await seed([row({ id: 1, binary: 'codex' }), row({ id: 2, binary: 'codex', baseUrl: 'https://z.test' })]);

    expect(getProviderForJob({ provider: 'zai' }).id).toBe(2);
  });

  it('answers null for zai when no codex row has an endpoint', async () => {
    await seed([row({ id: 1, binary: 'codex' })]);

    expect(getProviderForJob({ provider: 'zai' })).toBeNull();
  });

  it('maps the grok slug onto a grok row', async () => {
    await seed([row({ id: 5, binary: 'grok' })]);

    expect(getProviderForJob({ provider: 'grok' }).id).toBe(5);
  });

  it('answers null when the binary has no rows at all', async () => {
    await seed([]);

    expect(getProviderForJob({ provider: 'claude' })).toBeNull();
  });
});

describe('resolving a row against its binary', () => {
  it('takes the binary lists when the row names none', () => {
    const p = row({ binary: 'claude' });

    expect(providerModels(p, cfg)).toEqual(['opus', 'sonnet']);
    expect(providerEfforts(p)).toEqual(['low', 'high']);
  });

  it('prefers the row own lists', () => {
    const p = row({ binary: 'claude', models: ['custom'], efforts: ['custom-effort'] });

    expect(providerModels(p, cfg)).toEqual(['custom']);
    expect(providerEfforts(p)).toEqual(['custom-effort']);
  });

  it('widens a curated codex list, so a login row need not name the twin itself', () => {
    const p = row({ binary: 'codex', models: ['gpt-a', 'gpt-b'] });

    expect(providerModels(p, cfg)).toEqual(['gpt-a', 'gpt-a (872k)', 'gpt-b']);
  });

  it('leaves a custom-endpoint codex list alone: its catalog is written from it', () => {
    const p = row({ binary: 'codex', models: ['gpt-a'], baseUrl: 'https://example.test', apiKey: 'k' });

    expect(providerModels(p, cfg)).toEqual(['gpt-a']);
  });

  it('uses the row default model when it is one of the offered ones', () => {
    expect(providerDefaultModel(row({ binary: 'claude', defaultModel: 'sonnet' }), cfg)).toBe('sonnet');
  });

  it('ignores a row default model that is not offered', () => {
    expect(providerDefaultModel(row({ binary: 'claude', defaultModel: 'gone' }), cfg)).toBe('opus');
  });

  it('falls back to the first model when the binary default is not offered', () => {
    const p = row({ binary: 'claude', models: ['only-this'] });

    expect(providerDefaultModel(p, cfg)).toBe('only-this');
  });

  it('uses the row default effort when it is one of the offered ones', () => {
    expect(providerDefaultEffort(row({ binary: 'claude', defaultEffort: 'low' }), cfg)).toBe('low');
  });

  it('ignores a row default effort that is not offered', () => {
    expect(providerDefaultEffort(row({ binary: 'claude', defaultEffort: 'gone' }), cfg)).toBe('high');
  });

  it('falls back to the last effort, the strongest, when the binary default is not offered', () => {
    const p = row({ binary: 'claude', efforts: ['a', 'b'] });

    expect(providerDefaultEffort(p, cfg)).toBe('b');
  });
});

describe('resolveRuntime', () => {
  beforeEach(() => seed([row({ id: 1, binary: 'claude' })]));

  it('keeps a model and effort that still exist', () => {
    expect(resolveRuntime({ providerId: 1, model: 'sonnet', effort: 'low' }, cfg)).toMatchObject({
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('falls back to the defaults when the model was renamed away', () => {
    // Better than failing every run until somebody notices.
    expect(resolveRuntime({ providerId: 1, model: 'retired', effort: 'gone' }, cfg)).toMatchObject({
      model: 'opus',
      effort: 'high',
    });
  });

  it('answers null when the provider row is gone', () => {
    expect(resolveRuntime({ providerId: 99, model: 'opus' }, cfg)).toBeNull();
  });

  it('answers null when there is no runtime at all', () => {
    expect(resolveRuntime(null, cfg)).toBeNull();
  });
});

describe('creating a provider', () => {
  beforeEach(() => seed([]));

  it('fills the defaults for everything not given', async () => {
    const saved = await createProvider({ binary: 'claude' });

    expect(saved).toMatchObject({ binary: 'claude', baseUrl: '', apiKey: '', models: [], efforts: [] });
  });

  it('labels an unlabelled entry with its binary label', async () => {
    expect((await createProvider({ binary: 'codex' })).label).toBe('codex label');
  });

  it('keeps a label that was given, trimmed', async () => {
    expect((await createProvider({ binary: 'claude', label: '  work  ' })).label).toBe('work');
  });

  it('defaults the binary to claude', async () => {
    expect((await createProvider({})).binary).toBe('claude');
  });

  it('refuses a binary this machine cannot run', async () => {
    await expect(createProvider({ binary: 'gemini' })).rejects.toThrow(
      /"gemini" is not one of the binaries this machine can run \(claude, codex, grok, opencode\)/,
    );
  });

  it('refuses a blank binary', async () => {
    await expect(createProvider({ binary: '  ' })).rejects.toThrow(/is not one of the binaries/);
  });

  it('refuses a null binary', async () => {
    await expect(createProvider({ binary: null })).rejects.toThrow(/is not one of the binaries/);
  });

  it('falls back to the binary label when the label given is null', async () => {
    expect((await createProvider({ binary: 'claude', label: null })).label).toBe('claude label');
  });

  it('takes a list one entry per line', async () => {
    const saved = await createProvider({
      binary: 'claude',
      models: 'opus\n  sonnet  \n\n',
      efforts: 'low\nhigh',
    });

    expect(saved.models).toEqual(['opus', 'sonnet']);
    expect(saved.efforts).toEqual(['low', 'high']);
  });

  it('takes a list as an array too, trimmed and compacted', async () => {
    const saved = await createProvider({ binary: 'claude', models: [' opus ', '', 'sonnet'] });

    expect(saved.models).toEqual(['opus', 'sonnet']);
  });

  it('reads anything else as an empty list', async () => {
    expect((await createProvider({ binary: 'claude', models: 42 })).models).toEqual([]);
  });

  it('trims the endpoint and the key', async () => {
    const saved = await createProvider({ binary: 'claude', baseUrl: ' https://x.test ', apiKey: ' k ' });

    expect(saved).toMatchObject({ baseUrl: 'https://x.test', apiKey: 'k' });
  });

  it('reads a null endpoint as none', async () => {
    expect((await createProvider({ binary: 'claude', baseUrl: null })).baseUrl).toBe('');
  });

  it('refuses an endpoint on the grok binary', async () => {
    await expect(createProvider({ binary: 'grok', baseUrl: 'https://x.test' })).rejects.toThrow(
      /grok has no endpoint override/,
    );
  });

  it('accepts an endpoint on the opencode binary', async () => {
    await expect(
      createProvider({ binary: 'opencode', baseUrl: 'https://x.test/v1', apiKey: 'k' }),
    ).resolves.toMatchObject({ baseUrl: 'https://x.test/v1', apiKey: 'k' });
  });

  it('refuses an endpoint that is not an http url', async () => {
    await expect(createProvider({ binary: 'claude', baseUrl: 'ftp://x.test' })).rejects.toThrow(
      /"ftp:\/\/x.test" is not an http\(s\) URL/,
    );
  });

  it('accepts an https endpoint whatever its case', async () => {
    await expect(createProvider({ binary: 'claude', baseUrl: 'HTTPS://x.test' })).resolves.toMatchObject({
      baseUrl: 'HTTPS://x.test',
    });
  });

  it('appends to the end of the order when no position is given', async () => {
    await seed([row({ id: 1, sortOrder: 4 })]);

    expect((await createProvider({ binary: 'claude' })).sortOrder).toBe(5);
  });

  it('keeps an explicit position', async () => {
    expect((await createProvider({ binary: 'claude', sortOrder: 9 })).sortOrder).toBe(9);
  });

  it('reads an unparseable position as the front of the order', async () => {
    expect((await createProvider({ binary: 'claude', sortOrder: 'x' })).sortOrder).toBe(0);
  });
});

describe('updating a provider', () => {
  beforeEach(() => seed([row({ id: 1, binary: 'claude', label: 'one', models: ['opus'] })]));

  it('keeps the fields the edit did not mention', async () => {
    const saved = await updateProvider(1, { label: 'renamed' });

    expect(saved).toMatchObject({ id: 1, binary: 'claude', label: 'renamed', models: ['opus'] });
  });

  it('refuses an id that is not there', async () => {
    await expect(updateProvider(99, { label: 'x' })).rejects.toThrow(/Provider not found/);
  });

  it('validates the edit against the same rules as a create', async () => {
    await expect(updateProvider(1, { binary: 'gemini' })).rejects.toThrow(/is not one of the binaries/);
  });
});

describe('removing a provider', () => {
  it('drops it from the table and the cache', async () => {
    await seed([row({ id: 1 })]);

    expect(await removeProvider(1)).toBe(true);
    expect(state.deleted).toEqual([1]);
    expect(listProviders()).toEqual([]);
  });
});
