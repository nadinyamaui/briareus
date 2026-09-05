import { describe, it, expect, vi, beforeEach } from 'vitest';

// normalizeProject is not exported; createProject and updateProject are the
// doors to it, so the validation is tested through those, with the DB layer
// mocked to hand back whatever it was asked to save.
const state = vi.hoisted(() => ({ rows: [], saved: [], deleted: [], nextId: 1, loadError: null }));

vi.mock('../lib/db.js', () => ({
  loadProjectRows: async () => {
    if (state.loadError) throw state.loadError;
    return state.rows;
  },
  saveProject: async (p) => {
    const saved = { ...p, id: p.id ?? state.nextId++ };
    state.saved.push(saved);
    state.rows = [...state.rows.filter((r) => r.id !== saved.id), saved];
    return saved;
  },
  deleteProject: async (id) => {
    state.deleted.push(id);
    state.rows = state.rows.filter((r) => r.id !== Number(id));
    return true;
  },
  getProjectRow: async (id) => state.rows.find((r) => r.id === Number(id)) || null,
}));

vi.mock('../lib/templates.js', () => ({ normalize: (t) => t || {} }));

const {
  initProjects,
  listProjects,
  activeProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
  stepRuntime,
  render,
  selfProject,
  REVIEW_STEPS,
  PROJECT_DEFAULTS,
} = await import('../lib/projects.js');

const base = { repo: 'nadinyamaui/casos-ia', dbPoolDatabase: 'casos' };

// The table is read into memory at boot and refreshed on every write, so each
// test seeds the rows and re-reads them into that cache.
async function seed(rows = []) {
  state.rows = rows;
  state.saved = [];
  state.deleted = [];
  state.loadError = null;
  state.nextId = Math.max(0, ...rows.map((r) => r.id || 0)) + 1;
  await initProjects();
  state.saved = [];
}

const project = (over = {}) => ({ id: 1, ...PROJECT_DEFAULTS, ...over });

beforeEach(() => seed());

describe('the cache', () => {
  it('reads the table at boot', async () => {
    await seed([project({ repo: 'a/b' })]);

    expect(listProjects()).toHaveLength(1);
  });

  it('survives a table that will not load', async () => {
    await seed([project({ repo: 'a/b' })]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.loadError = new Error('server has gone away');

    await expect(initProjects()).resolves.toHaveLength(1);
    expect(err).toHaveBeenCalledWith('Could not load projects:', 'server has gone away');
    err.mockRestore();
  });

  it('offers only the enabled projects to start a session against', async () => {
    await seed([
      project({ id: 1, repo: 'a/b', enabled: true }),
      project({ id: 2, repo: 'c/d', enabled: false }),
    ]);

    expect(listProjects()).toHaveLength(2);
    expect(activeProjects().map((p) => p.repo)).toEqual(['a/b']);
  });

  it('finds a project whatever the casing of the repo', async () => {
    // GitHub repo names are case-insensitive, and a project typed into the
    // settings form will not always match how a session was created.
    await seed([project({ repo: 'NadinYamaui/Casos-IA' })]);

    expect(getProject('nadinyamaui/casos-ia').repo).toBe('NadinYamaui/Casos-IA');
  });

  it('answers null for a repo that is not set up', async () => {
    expect(getProject('nobody/nothing')).toBeNull();
    expect(getProject(null)).toBeNull();
  });
});

describe('the repository name', () => {
  it('must be owner/name', async () => {
    // Only the stable half of the message is pinned: the dash in it is
    // currently mojibake in the source, and this test must not enshrine that.
    await expect(createProject({ repo: 'casos-ia' })).rejects.toThrow(/"casos-ia" is not a valid repository/);
  });

  it.each(['', '   ', 'a/b/c', 'a b/c', 'owner/', '/name'])('refuses %o', async (repo) => {
    await expect(createProject({ repo })).rejects.toThrow(/is not a valid repository/);
  });

  it('refuses a null repo as firmly as a blank one', async () => {
    await expect(createProject({ repo: null })).rejects.toThrow(/is not a valid repository/);
  });

  it('accepts dots, dashes and underscores', async () => {
    await expect(createProject({ repo: 'own_er.x/na-me.js' })).resolves.toMatchObject({
      repo: 'own_er.x/na-me.js',
    });
  });

  it('refuses a second project for a repo already set up', async () => {
    await seed([project({ repo: 'nadinyamaui/casos-ia' })]);

    await expect(createProject({ repo: 'NadinYamaui/Casos-IA' })).rejects.toThrow(/is already set up/);
  });
});

describe('the label', () => {
  it('falls back to the repository name without its owner', async () => {
    expect((await createProject({ ...base })).label).toBe('casos-ia');
  });

  it('keeps a label that was given, trimmed', async () => {
    expect((await createProject({ ...base, label: '  Casos  ' })).label).toBe('Casos');
  });

  it('falls back when the label given is blank', async () => {
    expect((await createProject({ ...base, label: '   ' })).label).toBe('casos-ia');
  });
});

describe('the database settings', () => {
  it('refuses a pooled project with no database to point at', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolEnabled: true })).rejects.toThrow(
      /A pooled project needs the database its sessions should point at/,
    );
  });

  it('accepts a pooled project that names one', async () => {
    await expect(
      createProject({ repo: 'a/b', dbPoolEnabled: true, dbPoolDatabase: 'casos' }),
    ).resolves.toMatchObject({ dbPoolEnabled: true, dbPoolDatabase: 'casos' });
  });

  it('refuses a database name that is not an identifier', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolDatabase: 'casos; drop database x' })).rejects.toThrow(
      /is not a plain database identifier/,
    );
  });

  it('allows no database name at all', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolDatabase: '' })).resolves.toMatchObject({
      dbPoolDatabase: '',
    });
  });

  it('trims the restore dump path', async () => {
    expect((await createProject({ ...base, dbRestoreSql: '  /dumps/x.sql  ' })).dbRestoreSql).toBe(
      '/dumps/x.sql',
    );
  });
});

describe('project database extensions', () => {
  it('takes one extension per line and lowercases them', async () => {
    await createProject({ ...base, dbExtensions: 'vector\n  PG_TRGM  \n\n' });

    expect(state.saved[0].dbExtensions).toEqual(['vector', 'pg_trgm']);
  });

  it('refuses a name that is not a plain identifier', async () => {
    // It reaches psql inside CREATE EXTENSION "…", where a quote would end the
    // identifier and the rest would run as SQL.
    await expect(createProject({ ...base, dbExtensions: 'vector"; drop database x; --' })).rejects.toThrow(
      /not a plain extension name/,
    );
  });

  it('defaults to none', async () => {
    await createProject({ ...base });

    expect(state.saved[0].dbExtensions).toEqual([]);
  });

  it('takes an array as readily as lines', async () => {
    await createProject({ ...base, dbExtensions: [' Vector ', '', 'pg_trgm'] });

    expect(state.saved[0].dbExtensions).toEqual(['vector', 'pg_trgm']);
  });

  it('reads anything else as none', async () => {
    await createProject({ ...base, dbExtensions: 42 });

    expect(state.saved[0].dbExtensions).toEqual([]);
  });
});

describe('the command lists', () => {
  it('takes setup and run commands one per line', async () => {
    const saved = await createProject({
      ...base,
      setupCommands: 'composer install\n  npm ci  \n\n',
      runCommands: 'php artisan serve',
    });

    expect(saved.setupCommands).toEqual(['composer install', 'npm ci']);
    expect(saved.runCommands).toEqual(['php artisan serve']);
  });

  it('trims the binary directories', async () => {
    const saved = await createProject({ ...base, phpBinDir: '  /usr/bin  ', localDir: '  /srv/app  ' });

    expect(saved).toMatchObject({ phpBinDir: '/usr/bin', localDir: '/srv/app' });
  });
});

describe('the text fields', () => {
  it.each([
    'envTemplate',
    'reviewPublishInstructions',
    'qaNotes',
    'feedbackInstructions',
    'testSheetInstructions',
  ])('stores %s with LF endings whatever arrives', async (key) => {
    // A textarea posts LF and a seeded file may be CRLF; the two must not read
    // as a change every time the project is opened and saved.
    const saved = await createProject({ ...base, [key]: 'one\r\ntwo\r\n' });

    expect(saved[key]).toBe('one\ntwo\n');
  });

  it('reads a null text field as the empty one', async () => {
    expect((await createProject({ ...base, qaNotes: null })).qaNotes).toBe('');
  });

  it('reads null as blank for every optional field a form can leave unset', async () => {
    const saved = await createProject({
      ...base,
      label: null,
      phpBinDir: null,
      localDir: null,
      dbRestoreSql: null,
      reviewModel: null,
      reviewEffort: null,
      promptTemplates: null,
    });

    expect(saved).toMatchObject({
      label: 'casos-ia', // falls back rather than staying blank
      phpBinDir: '',
      localDir: '',
      dbRestoreSql: '',
      reviewModel: '',
      reviewEffort: '',
      promptTemplates: {},
    });
  });
});

describe('the QA chain', () => {
  it('switches the test sheet on with the test run: the run reads the sheet', async () => {
    const saved = await createProject({ ...base, reviewTestRun: true, reviewTestSheet: false });

    expect(saved).toMatchObject({ reviewTestRun: true, reviewTestSheet: true });
  });

  it('leaves the sheet on its own when the run is off', async () => {
    const saved = await createProject({ ...base, reviewTestSheet: true, reviewTestRun: false });

    expect(saved).toMatchObject({ reviewTestSheet: true, reviewTestRun: false });
  });

  it('is off by default', async () => {
    expect(await createProject({ ...base })).toMatchObject({
      reviewTestSheet: false,
      reviewTestRun: false,
    });
  });
});

describe('the review author', () => {
  it('drops a leading @', async () => {
    expect((await createProject({ ...base, reviewAuthor: ' @nadinyamaui ' })).reviewAuthor).toBe(
      'nadinyamaui',
    );
  });

  it('allows no author at all', async () => {
    expect((await createProject({ ...base, reviewAuthor: '' })).reviewAuthor).toBe('');
  });

  it.each(['-leading', 'trailing-', 'has space', 'double--dash', 'a'.repeat(40)])(
    'refuses %o as a GitHub username',
    async (reviewAuthor) => {
      await expect(createProject({ ...base, reviewAuthor })).rejects.toThrow(/is not a GitHub username/);
    },
  );

  it('accepts a plain login', async () => {
    await expect(createProject({ ...base, reviewAuthor: 'nadin-yamaui1' })).resolves.toMatchObject({
      reviewAuthor: 'nadin-yamaui1',
    });
  });
});

describe('the reviewer runtime', () => {
  it('keeps a provider id that is a positive integer', async () => {
    expect((await createProject({ ...base, reviewProviderId: '4' })).reviewProviderId).toBe(4);
  });

  it.each([0, -1, 'abc', 1.5, null])('reads %o as no provider', async (reviewProviderId) => {
    expect((await createProject({ ...base, reviewProviderId })).reviewProviderId).toBeNull();
  });

  it('trims the model and effort', async () => {
    const saved = await createProject({ ...base, reviewModel: ' opus ', reviewEffort: ' high ' });

    expect(saved).toMatchObject({ reviewModel: 'opus', reviewEffort: 'high' });
  });
});

describe('the worker runtime and budget', () => {
  it('keeps a worker provider id that is a positive integer', async () => {
    expect((await createProject({ ...base, workerProviderId: '4' })).workerProviderId).toBe(4);
  });

  it.each([0, -1, 'abc', 1.5, null])('reads %o as no worker provider', async (workerProviderId) => {
    expect((await createProject({ ...base, workerProviderId })).workerProviderId).toBeNull();
  });

  it('trims the worker model and effort', async () => {
    const saved = await createProject({ ...base, workerModel: ' haiku ', workerEffort: ' low ' });

    expect(saved).toMatchObject({ workerModel: 'haiku', workerEffort: 'low' });
  });

  it('keeps a positive budget in dollars', async () => {
    expect((await createProject({ ...base, workerBudgetUsd: '12.5' })).workerBudgetUsd).toBe(12.5);
  });

  it.each([0, -3, 'abc', null, ''])('reads %o as no spending cap', async (workerBudgetUsd) => {
    expect((await createProject({ ...base, workerBudgetUsd })).workerBudgetUsd).toBeNull();
  });
});

describe('the project that is the dashboard itself', () => {
  it('is off unless ticked, and stored as a plain boolean', async () => {
    expect((await createProject(base)).isSelf).toBe(false);
    expect((await createProject({ repo: 'acme/dashboard', isSelf: 'on' })).isSelf).toBe(true);
  });

  it('refuses a second project claiming to be the dashboard, naming the first', async () => {
    await seed([project({ id: 1, repo: 'acme/dashboard', isSelf: true })]);

    await expect(createProject({ repo: 'acme/fork', isSelf: true })).rejects.toThrow(
      /acme\/dashboard is already flagged as the dashboard itself/,
    );
    await seed([
      project({ id: 1, repo: 'acme/dashboard', isSelf: true }),
      project({ id: 2, repo: 'acme/shop' }),
    ]);
    await expect(updateProject(2, { isSelf: true })).rejects.toThrow(/already flagged/);
  });

  it('lets the flagged project be saved again, flag and all', async () => {
    await seed([project({ id: 1, repo: 'acme/dashboard', isSelf: true })]);

    expect((await updateProject(1, { label: 'Dash', isSelf: true })).isSelf).toBe(true);
    expect((await updateProject(1, { isSelf: false })).isSelf).toBe(false);
  });

  it('selfProject answers the enabled flagged project, or nothing', async () => {
    expect(selfProject()).toBeNull();
    await seed([project({ id: 1, repo: 'acme/dashboard', isSelf: true, enabled: false })]);
    expect(selfProject()).toBeNull();
    await seed([project({ id: 1, repo: 'acme/dashboard', isSelf: true, enabled: true })]);
    expect(selfProject().repo).toBe('acme/dashboard');
  });
});

describe('the SQL seam', () => {
  // lib/db.js is mocked in this suite, so nothing here exercises the real
  // column mapping — which is exactly how the worker fields once shipped
  // normalized but never persisted. The crude guard: every project field must
  // at least be NAMED in db.js (rowToProject maps each as `key:`), so a field
  // added to PROJECT_DEFAULTS without touching the persistence layer fails
  // loudly here instead of silently dropping what the form saved.
  it('names every project field in lib/db.js', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8');
    for (const key of Object.keys(PROJECT_DEFAULTS)) {
      expect(src, `lib/db.js never maps "${key}"`).toContain(`${key}:`);
    }
  });
});

describe('the per-step runtimes', () => {
  it('keeps an entry that names a provider', async () => {
    const saved = await createProject({
      ...base,
      stepRuntimes: { testSheet: { providerId: '3', model: ' opus ', effort: ' high ' } },
    });

    expect(saved.stepRuntimes).toEqual({ testSheet: { providerId: 3, model: 'opus', effort: 'high' } });
  });

  it('stores "same as the session" as nothing at all', async () => {
    // Rather than an entry full of empty strings.
    const saved = await createProject({ ...base, stepRuntimes: { testSheet: { providerId: '' } } });

    expect(saved.stepRuntimes).toEqual({});
  });

  it('drops a step this build does not have', async () => {
    const saved = await createProject({
      ...base,
      stepRuntimes: { retired: { providerId: 3 }, testRun: { providerId: 4 } },
    });

    expect(Object.keys(saved.stepRuntimes)).toEqual(['testRun']);
  });

  it.each([null, 'a string', 42])('reads %o as no overrides at all', async (stepRuntimes) => {
    expect((await createProject({ ...base, stepRuntimes })).stepRuntimes).toEqual({});
  });

  it('drops an entry that is not an object', async () => {
    expect((await createProject({ ...base, stepRuntimes: { testSheet: 'nope' } })).stepRuntimes).toEqual({});
  });

  it('names the two steps a QA session runs, in order', () => {
    expect(REVIEW_STEPS.map((s) => s.key)).toEqual(['testSheet', 'testRun']);
  });
});

describe('reading one step runtime back', () => {
  it('answers what the step was configured to run on', () => {
    const p = { stepRuntimes: { testSheet: { providerId: 3, model: 'opus', effort: 'high' } } };

    expect(stepRuntime(p, 'testSheet')).toEqual({ providerId: 3, model: 'opus', effort: 'high' });
  });

  it('fills the model and effort in as blank when the entry omits them', () => {
    const p = { stepRuntimes: { testSheet: { providerId: 3 } } };

    expect(stepRuntime(p, 'testSheet')).toEqual({ providerId: 3, model: '', effort: '' });
  });

  it('answers null for a step that runs on the session own provider', () => {
    expect(stepRuntime({ stepRuntimes: {} }, 'testSheet')).toBeNull();
    expect(stepRuntime({ stepRuntimes: { testSheet: { providerId: 0 } } }, 'testSheet')).toBeNull();
  });

  it('answers null for a project with no overrides and for no project', () => {
    expect(stepRuntime({}, 'testSheet')).toBeNull();
    expect(stepRuntime(null, 'testSheet')).toBeNull();
  });
});

describe('the order', () => {
  it('appends to the end when no position is given', async () => {
    await seed([project({ id: 1, repo: 'a/b', sortOrder: 4 })]);

    expect((await createProject({ ...base })).sortOrder).toBe(5);
  });

  it('keeps an explicit position', async () => {
    expect((await createProject({ ...base, sortOrder: 9 })).sortOrder).toBe(9);
  });

  it('reads an unparseable position as the front', async () => {
    expect((await createProject({ ...base, sortOrder: 'x' })).sortOrder).toBe(0);
  });
});

describe('updating a project', () => {
  beforeEach(() => seed([project({ id: 1, repo: 'a/b', label: 'one', setupCommands: ['npm ci'] })]));

  it('keeps the fields the edit did not mention', async () => {
    const saved = await updateProject(1, { label: 'renamed' });

    expect(saved).toMatchObject({ id: 1, repo: 'a/b', label: 'renamed', setupCommands: ['npm ci'] });
  });

  it('refuses an id that is not there', async () => {
    await expect(updateProject(99, { label: 'x' })).rejects.toThrow(/Project not found/);
  });

  it('lets a project keep its own repo', async () => {
    await expect(updateProject(1, { repo: 'a/b' })).resolves.toMatchObject({ id: 1 });
  });

  it('refuses a move onto a repo another project already has', async () => {
    await seed([project({ id: 1, repo: 'a/b' }), project({ id: 2, repo: 'c/d' })]);

    await expect(updateProject(2, { repo: 'a/b' })).rejects.toThrow(/is already set up/);
  });

  it('can switch a project off', async () => {
    const saved = await updateProject(1, { enabled: false });

    expect(saved.enabled).toBe(false);
    expect(activeProjects()).toEqual([]);
  });

  it('validates the edit against the same rules as a create', async () => {
    await expect(updateProject(1, { repo: 'nope' })).rejects.toThrow(/is not a valid repository/);
  });
});

describe('removing a project', () => {
  it('drops it from the table and the cache', async () => {
    await seed([project({ id: 1, repo: 'a/b' })]);

    expect(await removeProject(1)).toBe(true);
    expect(state.deleted).toEqual([1]);
    expect(listProjects()).toEqual([]);
  });
});

describe('token substitution', () => {
  it('replaces a token it knows', () => {
    expect(render('serve --port {port}', { port: 8101 })).toBe('serve --port 8101');
  });

  it('replaces every occurrence', () => {
    expect(render('{a}-{a}', { a: 'x' })).toBe('x-x');
  });

  it('leaves an unknown token alone so a typo shows up', () => {
    // Rather than blanking it and disappearing silently.
    expect(render('serve --port {prot}', { port: 8101 })).toBe('serve --port {prot}');
  });

  it('reads a missing template as the empty string', () => {
    expect(render(null, {})).toBe('');
    expect(render(undefined, {})).toBe('');
  });

  it('substitutes a value that is not a string', () => {
    expect(render('{n}', { n: 0 })).toBe('0');
  });
});
