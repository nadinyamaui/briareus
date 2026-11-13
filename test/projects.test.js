import { describe, it, expect, vi, beforeEach } from 'vitest';
import { oweProjectOutcomes } from '../lib/review-enforcement.js';

// normalizeProject is not exported, so validation is tested through createProject and
// updateProject, with the DB layer mocked to hand back whatever it was asked to save.
const state = vi.hoisted(() => ({
  rows: [],
  saved: [],
  deleted: [],
  ordered: [],
  outcomesMarked: [],
  nextId: 1,
  loadError: null,
  // Runs inside a save, standing in for another request that lands meanwhile.
  during: null,
}));

vi.mock('../lib/db.js', () => ({
  markRepoCodeReviewOutcomesStale: async (repo) => {
    state.outcomesMarked.push(repo);
    return 1;
  },
  loadProjectRows: async () => {
    if (state.loadError) throw state.loadError;
    return state.rows;
  },
  saveProject: async (p) => {
    await state.during?.();
    // An update that names no position keeps the row's, as the real one does.
    const saved = { ...state.rows.find((r) => r.id === p.id), ...p, id: p.id ?? state.nextId++ };
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
  saveProjectOrder: async (ids) => {
    await state.during?.();
    state.ordered.push(ids);
    state.rows = state.rows
      .map((r) => ({ ...r, sortOrder: ids.indexOf(r.id) + 1 }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },
}));

vi.mock('../lib/templates.js', () => ({ normalize: (t) => t || {} }));

const {
  initProjects,
  listProjects,
  activeProjects,
  getProject,
  createProject,
  updateProject,
  editProject,
  removeProject,
  reorderProjects,
  stepRuntime,
  actionRuntime,
  render,
  selfProject,
  QA_STEPS,
  PROJECT_DEFAULTS,
  OUTCOME_SETTINGS,
  onOutcomeSettingsChange,
} = await import('../lib/projects.js');

const base = { repo: 'exampleco/sample-app', dbPoolDatabase: 'sample' };

// The table is read into memory at boot and refreshed on every write, so each
// test seeds the rows and re-reads them into that cache.
async function seed(rows = []) {
  state.rows = rows;
  state.saved = [];
  state.deleted = [];
  state.ordered = [];
  state.outcomesMarked = [];
  state.loadError = null;
  state.during = null;
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
    await seed([project({ repo: 'Exampleco/sample-app' })]);

    expect(getProject('exampleco/sample-app').repo).toBe('Exampleco/sample-app');
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
    await expect(createProject({ repo: 'sample-app' })).rejects.toThrow(
      /"sample-app" is not a valid repository/,
    );
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
    await seed([project({ repo: 'exampleco/sample-app' })]);

    await expect(createProject({ repo: 'Exampleco/sample-app' })).rejects.toThrow(/is already set up/);
  });
});

describe('the label', () => {
  it('falls back to the repository name without its owner', async () => {
    expect((await createProject({ ...base })).label).toBe('sample-app');
  });

  it('keeps a label that was given, trimmed', async () => {
    expect((await createProject({ ...base, label: '  Sample  ' })).label).toBe('Sample');
  });

  it('falls back when the label given is blank', async () => {
    expect((await createProject({ ...base, label: '   ' })).label).toBe('sample-app');
  });
});

describe('the database settings', () => {
  it('takes the database name its sessions build theirs from', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolDatabase: ' sample ' })).resolves.toMatchObject({
      dbPoolDatabase: 'sample',
    });
  });

  it('refuses a database name that is not an identifier', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolDatabase: 'sample; drop database x' })).rejects.toThrow(
      /is not a plain database identifier/,
    );
  });

  it('allows no database name at all', async () => {
    await expect(createProject({ repo: 'a/b', dbPoolDatabase: '' })).resolves.toMatchObject({
      dbPoolDatabase: '',
    });
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

describe('the run profiles', () => {
  it('stores them as typed, once they read', async () => {
    const text = 'profile: projects\r\nenv:\r\n  VERTICAL=projects\r\n';
    const saved = await createProject({ ...base, runProfiles: text });

    expect(saved.runProfiles).toBe('profile: projects\nenv:\n  VERTICAL=projects');
  });

  it('keeps leading blank lines, so an error names the line the textarea shows', async () => {
    await expect(createProject({ ...base, runProfiles: '\n\nprofile: a\nenv:\n  1A=x\n\n' })).rejects.toThrow(
      /Run profiles, line 5/,
    );
    const saved = await createProject({ ...base, runProfiles: '\n\nprofile: a\nenv:\n  A=1\n\n' });
    expect(saved.runProfiles).toBe('\n\nprofile: a\nenv:\n  A=1');
  });

  it('refuses a save whose profiles do not read, naming the line', async () => {
    await expect(createProject({ ...base, runProfiles: 'env:\n  A=1' })).rejects.toThrow(
      /Run profiles, line 1/,
    );
  });
});

describe('the text fields', () => {
  it('reads a null text field as the empty one', async () => {
    expect((await createProject({ ...base, qaNotes: null })).qaNotes).toBe('');
  });

  it('reads null as blank for every optional field a form can leave unset', async () => {
    const saved = await createProject({
      ...base,
      label: null,
      phpBinDir: null,
      localDir: null,
      actionModel: null,
      actionEffort: null,
      promptTemplates: null,
    });

    expect(saved).toMatchObject({
      label: 'sample-app', // falls back rather than staying blank
      phpBinDir: '',
      localDir: '',
      actionModel: '',
      actionEffort: '',
      promptTemplates: {},
    });
  });
});

describe('the review author', () => {
  it('drops a leading @', async () => {
    expect((await createProject({ ...base, prAuthor: ' @sampleuser ' })).prAuthor).toBe('sampleuser');
  });

  it('allows no author at all', async () => {
    expect((await createProject({ ...base, prAuthor: '' })).prAuthor).toBe('');
  });

  it.each(['-leading', 'trailing-', 'has space', 'double--dash', 'a'.repeat(40)])(
    'refuses %o as a GitHub username',
    async (prAuthor) => {
      await expect(createProject({ ...base, prAuthor })).rejects.toThrow(/is not a GitHub username/);
    },
  );

  it('accepts a plain login', async () => {
    await expect(createProject({ ...base, prAuthor: 'sample-user1' })).resolves.toMatchObject({
      prAuthor: 'sample-user1',
    });
  });
});

describe('the reviewer runtime', () => {
  it('keeps a provider id that is a positive integer', async () => {
    expect((await createProject({ ...base, actionProviderId: '4' })).actionProviderId).toBe(4);
  });

  it.each([0, -1, 'abc', 1.5, null])('reads %o as no provider', async (actionProviderId) => {
    expect((await createProject({ ...base, actionProviderId })).actionProviderId).toBeNull();
  });

  it('trims the model and effort', async () => {
    const saved = await createProject({ ...base, actionModel: ' opus ', actionEffort: ' high ' });

    expect(saved).toMatchObject({ actionModel: 'opus', actionEffort: 'high' });
  });
});

describe('the worker runtime', () => {
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
});

describe('the local session limit', () => {
  it('defaults to one and takes a whole number up to 10, or 0 for no limit', async () => {
    expect((await createProject({ ...base })).localSessionLimit).toBe(1);
    expect((await createProject({ repo: 'acme/two', localSessionLimit: '3' })).localSessionLimit).toBe(3);
    expect((await createProject({ repo: 'acme/any', localSessionLimit: 0 })).localSessionLimit).toBe(0);
    for (const bad of [-1, 11, 2.5, 'many', null])
      await expect(createProject({ repo: 'acme/bad', localSessionLimit: bad })).rejects.toThrow(
        /localSessionLimit must be a whole number from 0 \(no limit\) to 10/,
      );
  });
});

describe('the code review round limit', () => {
  it('defaults to three and takes a whole number up to 20, or 0 for no limit', async () => {
    const saved = await createProject({ ...base });
    expect(saved.reviewRoundLimit).toBe(3);
    expect((await updateProject(saved.id, { reviewRoundLimit: '5' })).reviewRoundLimit).toBe(5);
    // An update that names nothing about it leaves it alone.
    expect((await updateProject(saved.id, { label: 'Renamed' })).reviewRoundLimit).toBe(5);
    expect((await updateProject(saved.id, { reviewRoundLimit: 0 })).reviewRoundLimit).toBe(0);
    expect((await updateProject(saved.id, { reviewRoundLimit: 20 })).reviewRoundLimit).toBe(20);
    for (const bad of [-1, 21, 2.5, 'many', true])
      await expect(updateProject(saved.id, { reviewRoundLimit: bad })).rejects.toThrow(
        /reviewRoundLimit must be a whole number from 0 \(no limit\) to 20/,
      );
    expect((await updateProject(saved.id, { label: 'Still' })).reviewRoundLimit).toBe(20);
  });

  it('reads a cleared limit as the default, never as no limit', async () => {
    const saved = await createProject({ ...base, reviewRoundLimit: 0 });
    expect(saved.reviewRoundLimit).toBe(0);
    expect((await updateProject(saved.id, { reviewRoundLimit: null })).reviewRoundLimit).toBe(3);
    expect((await updateProject(saved.id, { reviewRoundLimit: 7 })).reviewRoundLimit).toBe(7);
    expect((await updateProject(saved.id, { reviewRoundLimit: '' })).reviewRoundLimit).toBe(3);
  });
});

describe('enforcing the code review outcome', () => {
  it('is off until it is switched on, and stays as set', async () => {
    const saved = await createProject({ ...base });
    expect(saved.enforceReviewOutcome).toBe(false);
    expect((await updateProject(saved.id, { enforceReviewOutcome: true })).enforceReviewOutcome).toBe(true);
    // An update that names nothing about it leaves it alone.
    expect((await updateProject(saved.id, { label: 'Renamed' })).enforceReviewOutcome).toBe(true);
    expect((await updateProject(saved.id, { enforceReviewOutcome: false })).enforceReviewOutcome).toBe(false);
    expect(await createProject({ ...base, repo: 'acme/enforced', enforceReviewOutcome: true })).toMatchObject(
      { enforceReviewOutcome: true },
    );
  });

  it('takes only true or false: it makes GitHub block merges, so nothing loose switches it', async () => {
    const saved = await createProject({ ...base });
    for (const bad of ['true', 'false', 1, 0, null, ''])
      await expect(updateProject(saved.id, { enforceReviewOutcome: bad })).rejects.toThrow(
        'enforceReviewOutcome must be true or false',
      );
    expect((await updateProject(saved.id, { label: 'Still off' })).enforceReviewOutcome).toBe(false);
  });
});

describe('setting a project aside for the review benchmark', () => {
  it('is off until switched on with a real boolean, and stays as set', async () => {
    const saved = await createProject({ ...base });
    expect(saved.reviewBenchmark).toBe(false);
    expect((await updateProject(saved.id, { reviewBenchmark: true })).reviewBenchmark).toBe(true);
    expect((await updateProject(saved.id, { label: 'Renamed' })).reviewBenchmark).toBe(true);
    for (const bad of ['true', 1, null])
      await expect(updateProject(saved.id, { reviewBenchmark: bad })).rejects.toThrow(
        'reviewBenchmark must be true or false',
      );
    expect((await updateProject(saved.id, { reviewBenchmark: false })).reviewBenchmark).toBe(false);
  });
});

describe('the local checkout auto-update', () => {
  it('keeps the update commands one per line and needs a checkout to be on', async () => {
    const saved = await createProject({
      ...base,
      localDir: '/src/shop',
      autoUpdate: 'on',
      updateCommands: 'composer install\n\n  php artisan horizon:terminate  ',
    });
    expect(saved.autoUpdate).toBe(true);
    expect(saved.updateCommands).toEqual(['composer install', 'php artisan horizon:terminate']);
    await expect(createProject({ repo: 'acme/other', autoUpdate: true })).rejects.toThrow(
      /needs a local checkout/,
    );
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
  // lib/db.js is mocked here, so the real column mapping is untested; that is how the worker
  // fields once shipped normalized but never persisted. Crude guard: every project field must
  // be named in db.js (rowToProject maps each as `key:`).
  it('names every project field in lib/db.js', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8');
    for (const key of Object.keys(PROJECT_DEFAULTS)) {
      expect(src, `lib/db.js never maps "${key}"`).toContain(`${key}:`);
    }
  });
});

describe('the project board', () => {
  it('has none by default', async () => {
    expect((await createProject(base)).projectBoard).toBe(null);
  });

  it('keeps an organization board with a view, numbers from a form taken as numbers', async () => {
    const saved = await createProject({
      ...base,
      projectBoard: { owner: ' @exampleco ', ownerType: 'Organization', number: '1', view: '42' },
    });
    expect(saved.projectBoard).toEqual({
      owner: 'exampleco',
      ownerType: 'organization',
      number: 1,
      view: 42,
    });
  });

  it('takes an organization when no owner type is given, and no view as null', async () => {
    const saved = await createProject({ ...base, projectBoard: { owner: 'ada', number: 3, view: '' } });
    expect(saved.projectBoard).toEqual({ owner: 'ada', ownerType: 'organization', number: 3, view: null });
  });

  it('keeps a user board', async () => {
    const saved = await createProject({
      ...base,
      projectBoard: { owner: 'ada', ownerType: 'user', number: 2 },
    });
    expect(saved.projectBoard.ownerType).toBe('user');
  });

  it.each([null, '', { owner: '', number: '' }, { owner: ' ', number: null, view: 4 }])(
    'reads %o as no board',
    async (projectBoard) => {
      expect((await createProject({ ...base, projectBoard })).projectBoard).toBe(null);
    },
  );

  it.each([
    [{ owner: 'not a login', number: 1 }, /is not a GitHub organization or user/],
    [{ owner: '', number: 1 }, /is not a GitHub organization or user/],
    [{ owner: 'acme', ownerType: 'team', number: 1 }, /owner type must be organization or user/],
    [{ owner: 'acme' }, /needs its project number/],
    [{ owner: 'acme', number: 0 }, /needs its project number/],
    [{ owner: 'acme', number: '1.5' }, /needs its project number/],
    [{ owner: 'acme', number: 1, view: -2 }, /view must be a whole number/],
    [{ owner: 'acme', number: 1, view: 'all' }, /view must be a whole number/],
    ['acme/1', /must be an object/],
    [[1], /must be an object/],
  ])('refuses %o', async (projectBoard, message) => {
    await expect(createProject({ ...base, projectBoard })).rejects.toThrow(message);
  });

  it('is cleared by an edit that sends null, and kept by one that leaves it out', async () => {
    const saved = await createProject({ ...base, projectBoard: { owner: 'acme', number: 1 } });
    expect((await updateProject(saved.id, { label: 'Renamed' })).projectBoard).toMatchObject({ number: 1 });
    expect((await updateProject(saved.id, { projectBoard: null })).projectBoard).toBe(null);
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
    expect(QA_STEPS.map((s) => s.key)).toEqual(['testSheet', 'testRun']);
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

describe('reading the project reviewer runtime back', () => {
  it('answers what ⌕ Code review was configured to run on', () => {
    const p = { actionProviderId: 3, actionModel: 'opus', actionEffort: 'high' };

    expect(actionRuntime(p)).toEqual({ providerId: 3, model: 'opus', effort: 'high' });
  });

  it('fills the model and effort in as blank when the project omits them', () => {
    expect(actionRuntime({ actionProviderId: 3 })).toEqual({ providerId: 3, model: '', effort: '' });
  });

  it('answers null for a project that named no reviewer, and for no project', () => {
    expect(actionRuntime({ actionProviderId: null, actionModel: 'opus' })).toBeNull();
    expect(actionRuntime({})).toBeNull();
    expect(actionRuntime(null)).toBeNull();
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

describe('reordering', () => {
  beforeEach(() =>
    seed([
      project({ id: 1, repo: 'a/one', sortOrder: 1 }),
      project({ id: 2, repo: 'a/two', sortOrder: 2 }),
      project({ id: 3, repo: 'a/three', sortOrder: 3 }),
    ]),
  );

  it('stores the order it is given and hands back the reloaded list', async () => {
    const list = await reorderProjects([3, 1, 2]);

    expect(state.ordered).toEqual([[3, 1, 2]]);
    expect(list.map((p) => p.repo)).toEqual(['a/three', 'a/one', 'a/two']);
    expect(listProjects().map((p) => p.id)).toEqual([3, 1, 2]);
  });

  it('takes ids as strings too, the way a form might send them', async () => {
    await reorderProjects(['2', '3', '1']);

    expect(state.ordered).toEqual([[2, 3, 1]]);
  });

  it('keeps the new order in the cache when reading it back fails', async () => {
    state.loadError = new Error('gone away');

    const list = await reorderProjects([2, 3, 1]);

    expect(list.map((p) => [p.id, p.sortOrder])).toEqual([
      [2, 1],
      [3, 2],
      [1, 3],
    ]);
    expect(listProjects().map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('skips a project removed during the save, rather than caching a bare entry', async () => {
    state.during = async () => {
      state.during = null;
      await removeProject(3);
      state.loadError = new Error('gone away');
    };

    await reorderProjects([3, 2, 1]);

    expect(listProjects().map((p) => [p.id, p.sortOrder])).toEqual([
      [2, 1],
      [1, 2],
    ]);
    expect(getProject('a/one').id).toBe(1);
  });

  it('keeps a project created during the save, after the listed ones', async () => {
    state.during = async () => {
      state.during = null;
      await createProject({ repo: 'a/four' });
      state.loadError = new Error('gone away');
    };

    await reorderProjects([3, 2, 1]);

    expect(listProjects().map((p) => p.id)).toEqual([3, 2, 1, 4]);
  });

  it.each([
    ['leaves a project out', [3, 1]],
    ['names one twice', [1, 1, 2, 3]],
    ['repeats one in place of another', [1, 1, 2]],
    ['names a project that is not there', [1, 2, 4]],
    ['is not a list', 'nope'],
    ['names projects by values that are not ids', [true, ' 2 ', 3]],
    ['names a project by a fraction', [1, 2, 3.5]],
    ['is missing', undefined],
  ])('refuses a list that %s, with 409, and saves nothing', async (_, ids) => {
    await expect(reorderProjects(ids)).rejects.toMatchObject({ status: 409 });

    expect(state.ordered).toEqual([]);
  });
});

describe('updating a project', () => {
  beforeEach(() => seed([project({ id: 1, repo: 'a/b', label: 'one', setupCommands: ['npm ci'] })]));

  it('keeps the fields the edit did not mention', async () => {
    const saved = await updateProject(1, { label: 'renamed' });

    expect(saved).toMatchObject({ id: 1, repo: 'a/b', label: 'renamed', setupCommands: ['npm ci'] });
  });

  it('keeps a position a reorder wrote while the edit was in flight', async () => {
    await seed([
      project({ id: 1, repo: 'a/b', sortOrder: 1 }),
      project({ id: 2, repo: 'c/d', sortOrder: 2 }),
    ]);
    state.during = async () => {
      state.during = null;
      await reorderProjects([2, 1]);
    };

    await updateProject(1, { label: 'renamed' });

    expect(listProjects().map((p) => [p.id, p.sortOrder])).toEqual([
      [2, 1],
      [1, 2],
    ]);
  });

  it('saves a position the edit names', async () => {
    expect((await updateProject(1, { sortOrder: 7 })).sortOrder).toBe(7);
  });

  it('refuses an id that is not there', async () => {
    await expect(updateProject(99, { label: 'x' })).rejects.toThrow(/Project not found/);
  });

  it('runs one update at a time, so a concurrent one does not save back the row it read', async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    state.during = async () => {
      state.during = null;
      await held;
    };
    const first = editProject(1, (stored) => ({ envTemplate: `${stored.envTemplate}A=1\n` }));
    const second = updateProject(1, { label: 'renamed' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);

    expect(getProject('a/b')).toMatchObject({ label: 'renamed', envTemplate: 'A=1\n' });
  });

  it('hands an edit the stored row even when the reload after a save failed', async () => {
    state.loadError = new Error('gone away');
    await editProject(1, (stored) => ({ envTemplate: `${stored.envTemplate}A=1\n` }));
    expect(getProject('a/b').envTemplate).toBe('A=1\n');

    await editProject(1, (stored) => ({ envTemplate: `${stored.envTemplate}B=2\n` }));
    expect(state.rows.find((r) => r.id === 1).envTemplate).toBe('A=1\nB=2\n');
    expect(getProject('a/b').envTemplate).toBe('A=1\nB=2\n');
  });

  it('saves nothing when an edit refuses', async () => {
    await expect(
      editProject(1, () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(state.saved).toEqual([]);
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

describe('email tool project opt-in', () => {
  it('defaults new projects to no email access', async () => {
    expect(PROJECT_DEFAULTS.mailToolsEnabled).toBe(false);
    expect((await createProject(base)).mailToolsEnabled).toBe(false);
  });
  it('persists explicit opt-in, preserves it on unrelated edits, and can revoke it', async () => {
    const p = await createProject({ ...base, mailToolsEnabled: true });
    expect(p.mailToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { label: 'Renamed' })).mailToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { mailToolsEnabled: false })).mailToolsEnabled).toBe(false);
  });
  it.each(['true', 'false', 1, 0, null])(
    'rejects non-boolean permission values: %j',
    async (mailToolsEnabled) => {
      await expect(createProject({ ...base, mailToolsEnabled })).rejects.toThrow(/must be true or false/);
      expect(state.saved).toHaveLength(0);
    },
  );
});

describe('WhatsApp tool project opt-in', () => {
  it('defaults new projects to no WhatsApp access, independently of email', async () => {
    expect(PROJECT_DEFAULTS.whatsappToolsEnabled).toBe(false);
    const p = await createProject({ ...base, mailToolsEnabled: true });
    expect(p).toMatchObject({ mailToolsEnabled: true, whatsappToolsEnabled: false });
  });
  it('persists explicit opt-in, preserves it on unrelated edits, and can revoke it', async () => {
    const p = await createProject({ ...base, whatsappToolsEnabled: true });
    expect(p.whatsappToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { label: 'Renamed' })).whatsappToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { whatsappToolsEnabled: false })).whatsappToolsEnabled).toBe(false);
  });
  it.each(['true', 1, null])('rejects non-boolean permission values: %j', async (whatsappToolsEnabled) => {
    await expect(createProject({ ...base, whatsappToolsEnabled })).rejects.toThrow(/must be true or false/);
    expect(state.saved).toHaveLength(0);
  });
});

describe('Home Assistant tool project opt-in', () => {
  it('defaults new projects to no Home Assistant access, independently of the other tools', async () => {
    expect(PROJECT_DEFAULTS.homeAssistantToolsEnabled).toBe(false);
    const p = await createProject({ ...base, whatsappToolsEnabled: true, printToolsEnabled: true });
    expect(p.homeAssistantToolsEnabled).toBe(false);
  });
  it('persists explicit opt-in, preserves it on unrelated edits, and can revoke it', async () => {
    const p = await createProject({ ...base, homeAssistantToolsEnabled: true });
    expect(p.homeAssistantToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { label: 'Renamed' })).homeAssistantToolsEnabled).toBe(true);
    expect((await updateProject(p.id, { homeAssistantToolsEnabled: false })).homeAssistantToolsEnabled).toBe(
      false,
    );
  });
  it.each(['true', 1, null])(
    'rejects non-boolean permission values: %j',
    async (homeAssistantToolsEnabled) => {
      await expect(createProject({ ...base, homeAssistantToolsEnabled })).rejects.toThrow(
        /must be true or false/,
      );
      expect(state.saved).toHaveLength(0);
    },
  );
});

describe('main database backup settings', () => {
  it('defaults off and preserves explicit choices through unrelated edits', async () => {
    const saved = await createProject(base);
    expect(saved.databaseBackupEnabled).toBe(false);
    expect((await updateProject(saved.id, { databaseBackupEnabled: true })).databaseBackupEnabled).toBe(true);
    expect((await updateProject(saved.id, { label: 'Backed up' })).databaseBackupEnabled).toBe(true);
    expect((await updateProject(saved.id, { databaseBackupEnabled: false })).databaseBackupEnabled).toBe(
      false,
    );
  });

  it.each(['false', 1, null])('rejects a non-boolean backup choice: %s', async (value) => {
    await expect(createProject({ ...base, databaseBackupEnabled: value })).rejects.toThrow(
      'must be true or false',
    );
  });
});

describe('the security review policy', () => {
  it('is off until it is set, and stays as set', async () => {
    const saved = await createProject({ ...base });
    expect(saved.securityReview).toBe('off');
    expect((await updateProject(saved.id, { securityReview: 'advisory' })).securityReview).toBe('advisory');
    // An update that names nothing about it leaves it alone.
    expect((await updateProject(saved.id, { label: 'Renamed' })).securityReview).toBe('advisory');
    expect((await updateProject(saved.id, { securityReview: 'required' })).securityReview).toBe('required');
    expect((await updateProject(saved.id, { securityReview: 'off' })).securityReview).toBe('off');
    expect(await createProject({ ...base, repo: 'acme/required', securityReview: 'required' })).toMatchObject(
      {
        securityReview: 'required',
      },
    );
  });

  it('takes one of its three states by name: nothing loose turns a pass on, off or into a requirement', async () => {
    const saved = await createProject({ ...base, securityReview: 'advisory' });
    for (const bad of [true, false, 1, 0, null, '', 'on', 'Required', 'REQUIRED', ' required', ['required']])
      await expect(updateProject(saved.id, { securityReview: bad })).rejects.toThrow(
        'securityReview must be one of off, advisory, required',
      );
    await expect(createProject({ ...base, repo: 'acme/loose', securityReview: 'yes' })).rejects.toThrow(
      'securityReview must be one of off, advisory, required',
    );
    expect((await updateProject(saved.id, { label: 'Still advisory' })).securityReview).toBe('advisory');
  });
});

describe('the approval policy', () => {
  const policy = {
    enabled: true,
    tiers: { high: { approvals: 2, requireSecurity: true } },
    rules: [{ pattern: '/migrations/', tier: 'high', label: 'Schema' }],
  };

  it('is none unless set, and is stored checked and filled in', async () => {
    const saved = await createProject({ ...base });
    expect(saved.approvalPolicy).toBeNull();
    const updated = await updateProject(saved.id, { approvalPolicy: policy });
    expect(updated.approvalPolicy).toEqual({
      enabled: true,
      tiers: {
        low: { approvals: 0, requireSecurity: false },
        medium: { approvals: 1, requireSecurity: false },
        high: { approvals: 2, requireSecurity: true },
      },
      rules: [{ pattern: '/migrations/', tier: 'high', label: 'Schema', approvals: null }],
      thresholds: {},
      acceptGithubApprovals: false,
      allowSelfApproval: false,
      securitySignalTier: null,
    });
    // An edit that names other things leaves it alone; null removes it.
    expect((await updateProject(saved.id, { label: 'Renamed' })).approvalPolicy).toEqual(
      updated.approvalPolicy,
    );
    expect((await updateProject(saved.id, { approvalPolicy: null })).approvalPolicy).toBeNull();
  });

  it('refuses a policy it does not understand, and keeps the one it had', async () => {
    const saved = await createProject({ ...base, approvalPolicy: policy });
    for (const [bad, why] of [
      [{ ...policy, enabled: 'yes' }, /enabled must be true or false/],
      [{ ...policy, rules: [{ pattern: '!/docs/', tier: 'low' }] }, /negation/],
      [{ ...policy, rules: [{ pattern: '/src/[a-z].js', tier: 'high' }] }, /character classes/],
      [{ ...policy, tiers: { medium: { approvals: 3 } } }, /cannot ask for fewer/],
      [{ ...policy, runtime: { model: 'other' } }, /unknown fields: runtime/],
      ['strict', /must be an object/],
    ])
      await expect(updateProject(saved.id, { approvalPolicy: bad })).rejects.toThrow(why);
    expect(getProject(base.repo).approvalPolicy.rules).toHaveLength(1);
    await expect(
      createProject({ ...base, repo: 'acme/loose', approvalPolicy: { rules: [] } }),
    ).rejects.toThrow(/enabled must be true or false/);
  });

  it('never carries a provider, a model or an effort', async () => {
    const saved = await createProject({ ...base, actionModel: 'configured-model', approvalPolicy: policy });
    for (const field of ['provider', 'providerId', 'model', 'effort'])
      await expect(
        updateProject(saved.id, {
          approvalPolicy: { ...policy, tiers: { high: { approvals: 2, [field]: 'x' } } },
        }),
      ).rejects.toThrow(/unknown fields/);
    // Saving the policy changes nothing about what a review runs on.
    const before = getProject(base.repo);
    const after = await updateProject(saved.id, { approvalPolicy: { ...policy, allowSelfApproval: true } });
    for (const key of ['actionProviderId', 'actionModel', 'actionEffort', 'stepRuntimes', 'securityReview'])
      expect(after[key]).toEqual(before[key]);
  });
});

describe('settings the review outcome is computed from', () => {
  let changes;
  beforeEach(() => {
    changes = [];
    onOutcomeSettingsChange(async (project, changed) => {
      changes.push([project.repo, changed, project.securityReview]);
    });
  });

  it('tell whoever keeps the outcomes when a save changes one, and only then', async () => {
    const saved = await createProject({ ...base });
    expect(changes).toEqual([]);
    await updateProject(saved.id, { label: 'Renamed', qaTestRun: true });
    // Saved again as it is: nothing changed.
    await updateProject(saved.id, {
      securityReview: 'off',
      enforceReviewOutcome: false,
      reviewRoundLimit: 3,
    });
    expect(changes).toEqual([]);
    await updateProject(saved.id, { securityReview: 'required' });
    expect(changes).toEqual([[base.repo, ['securityReview'], 'required']]);
    await updateProject(saved.id, { enforceReviewOutcome: true, reviewRoundLimit: 5 });
    expect(changes.at(-1)).toEqual([base.repo, ['enforceReviewOutcome', 'reviewRoundLimit'], 'required']);
    await updateProject(saved.id, { securityReview: 'advisory', label: 'Again' });
    expect(changes.at(-1)).toEqual([base.repo, ['securityReview'], 'advisory']);
    // By the time it is told, the project reads as saved.
    onOutcomeSettingsChange(async (project) => {
      changes.push(getProject(project.repo).securityReview);
    });
    await updateProject(saved.id, { securityReview: 'off' });
    expect(changes.at(-1)).toBe('off');
    // The approval policy is one of them, compared by what it says.
    changes = [];
    onOutcomeSettingsChange(async (project, changed) => {
      changes.push(changed);
    });
    const policy = { enabled: true, rules: [{ pattern: '/db/', tier: 'high' }] };
    await updateProject(saved.id, { approvalPolicy: policy });
    await updateProject(saved.id, { approvalPolicy: policy });
    await updateProject(saved.id, { approvalPolicy: { ...policy, allowSelfApproval: true } });
    await updateProject(saved.id, { approvalPolicy: null });
    await updateProject(saved.id, { approvalPolicy: null });
    expect(changes).toEqual([['approvalPolicy'], ['approvalPolicy'], ['approvalPolicy']]);
    expect(OUTCOME_SETTINGS).toEqual([
      'securityReview',
      'enforceReviewOutcome',
      'reviewRoundLimit',
      'approvalPolicy',
    ]);
  });

  it('marks stored outcomes without a cold GitHub board fetch delaying subsequent edits', async () => {
    const first = await createProject({ ...base });
    const second = await createProject({ ...base, repo: 'acme/other' });
    onOutcomeSettingsChange(oweProjectOutcomes);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      const changed = updateProject(first.id, { securityReview: 'required' });
      const renamed = updateProject(second.id, { label: 'Saved without waiting for GitHub' });
      await expect(changed).resolves.toMatchObject({ securityReview: 'required' });
      await expect(renamed).resolves.toMatchObject({ label: 'Saved without waiting for GitHub' });
      expect(state.outcomesMarked).toEqual([base.repo]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('keep a save that landed even when the outcomes could not be marked', async () => {
    const saved = await createProject({ ...base });
    onOutcomeSettingsChange(async () => {
      throw new Error('database is down');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await updateProject(saved.id, { securityReview: 'required' })).securityReview).toBe('required');
      expect(logged).toHaveBeenCalledWith(
        `Code review outcomes of ${base.repo} not marked for recomputation: database is down`,
      );
    } finally {
      logged.mockRestore();
    }
    expect(getProject(base.repo).securityReview).toBe('required');
  });
});
