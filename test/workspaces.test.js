import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Nothing here touches a real clone: fs, git/du and the session registry are
// all stand-ins, so the tests are about how the module reads them, and about
// what the two delete actions refuse to do.
const state = vi.hoisted(() => ({
  root: '/pool',
  /** @type {Record<string, { dir?: boolean, content?: string, mtimeMs?: number }>} */
  files: {},
  /** @type {Record<string, string | Error>} */
  git: {},
  duOut: '2048\t/pool/x\n',
  sessions: [],
  removed: [],
}));

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ workspaceDir: state.root }) }));
vi.mock('../lib/jobs.js', () => ({
  DEV_OPEN: ['queued', 'preparing', 'running', 'idle'],
  listDevSessions: () => state.sessions,
}));

vi.mock('fs', () => {
  const norm = (p) => String(p);
  const fs = {
    readdirSync: (dir) =>
      Object.entries(state.files)
        .filter(([p]) => path.dirname(p) === norm(dir))
        .map(([p, f]) => ({ name: path.basename(p), isDirectory: () => !!f.dir })),
    existsSync: (p) => norm(p) in state.files,
    statSync: (p) => {
      const f = state.files[norm(p)];
      if (!f) throw new Error('ENOENT');
      return { mtimeMs: f.mtimeMs || 0 };
    },
    readFileSync: (p) => {
      const f = state.files[norm(p)];
      if (!f) throw new Error('ENOENT');
      return f.content;
    },
    rmSync: (p) => {
      state.removed.push(norm(p));
      delete state.files[norm(p)];
    },
  };
  return { default: fs, ...fs };
});

vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const execFile = (bin, args, opts, cb) => {
    if (bin === 'du') return cb(null, state.duOut, '');
    const dir = args[1];
    const key = `${dir} ${args.slice(2).join(' ')}`;
    const r = state.git[key];
    if (r instanceof Error) return cb(Object.assign(r, { stderr: r.message }), '', r.message);
    if (r === undefined) return cb(new Error(`unexpected git ${key}`), '', '');
    cb(null, r, '');
  };
  // The real execFile resolves to { stdout, stderr } under promisify; the
  // module relies on that shape.
  execFile[promisify.custom] = (bin, args, opts) =>
    new Promise((resolve, reject) =>
      execFile(bin, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))),
    );
  return { execFile };
});

const { listWorkspaces, resetSetup, cleanWorkspace, parseSlotName, slotDir } =
  await import('../lib/workspaces.js');

function slot(name, { branch = 'main', head = 'abc1234', status = '' } = {}) {
  const dir = path.join(state.root, name);
  state.files[dir] = { dir: true };
  state.git[`${dir} rev-parse --abbrev-ref HEAD`] = `${branch}\n`;
  state.git[`${dir} rev-parse --short HEAD`] = `${head}\n`;
  state.git[`${dir} status --porcelain`] = status;
  return dir;
}

beforeEach(() => {
  // A fresh pool per test, and a different root so the du cache never
  // answers for a previous test's directory.
  state.root = `/pool-${Math.random().toString(16).slice(2)}`;
  state.files = {};
  state.git = {};
  state.sessions = [];
  state.removed = [];
});

describe('parseSlotName / slotDir', () => {
  it('reads owner, repo and slot index', () => {
    expect(parseSlotName('acme__app')).toEqual({ repo: 'acme/app', index: 1 });
    expect(parseSlotName('acme__app__3')).toEqual({ repo: 'acme/app', index: 3 });
    expect(parseSlotName('acme__my-app__12')).toEqual({ repo: 'acme/my-app', index: 12 });
  });

  it('ignores what is not a slot', () => {
    expect(parseSlotName('README.md')).toBeNull();
    expect(parseSlotName('__x')).toBeNull();
    expect(parseSlotName('.git')).toBeNull();
  });

  it('never resolves outside the pool', () => {
    expect(slotDir('acme__app')).toBe(path.join(state.root, 'acme__app'));
    expect(slotDir('../etc__passwd')).toBeNull();
    expect(slotDir('a__b/../../x')).toBeNull();
    expect(slotDir('')).toBeNull();
  });
});

describe('listWorkspaces', () => {
  it('returns nothing when the pool directory does not exist yet', async () => {
    expect(await listWorkspaces()).toEqual([]);
  });

  it('describes each slot, sorted by repo then index, skipping non-slots', async () => {
    const a2 = slot('acme__app__2', { branch: 'dev-1', head: 'beef', status: ' M x.js\n' });
    const a1 = slot('acme__app');
    state.files[path.join(a1, 'vendor')] = { dir: true };
    state.files[path.join(a1, '.git', 'reviewer-setup.json')] = {
      content: JSON.stringify({ 'composer install': 'x', 'yarn install': 'y' }),
      mtimeMs: 1700000000000.4,
    };
    state.files[path.join(state.root, 'notes.txt')] = {};
    state.files[path.join(state.root, 'lost+found')] = { dir: true };
    state.sessions = [
      { id: 's1', title: 'Fix login', status: 'running', workDir: a2 },
      { id: 's0', title: 'old', status: 'closed', workDir: a1 },
    ];

    const rows = await listWorkspaces();
    expect(rows.map((r) => r.slot)).toEqual(['acme__app', 'acme__app__2']);
    expect(rows[0]).toMatchObject({
      repo: 'acme/app',
      index: 1,
      branch: 'main',
      head: 'abc1234',
      dirty: false,
      sizeKb: 2048,
      vendor: true,
      nodeModules: false,
      setup: { at: 1700000000000, steps: 2 },
      claimedBy: null,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      index: 2,
      branch: 'dev-1',
      dirty: true,
      setup: null,
      claimedBy: { id: 's1', title: 'Fix login' },
    });
  });

  it('reports a broken slot as an error field instead of failing the listing', async () => {
    slot('acme__app');
    const bad = path.join(state.root, 'acme__app__2');
    state.files[bad] = { dir: true };
    state.git[`${bad} rev-parse --abbrev-ref HEAD`] = new Error('fatal: not a git repository');
    state.git[`${bad} rev-parse --short HEAD`] = new Error('fatal: not a git repository');
    state.git[`${bad} status --porcelain`] = new Error('fatal: not a git repository');

    const rows = await listWorkspaces();
    expect(rows).toHaveLength(2);
    expect(rows[1].error).toMatch(/not a git repository/);
    expect(rows[1].branch).toBeNull();
    expect(rows[1].sizeKb).toBe(2048);
  });
});

describe('actions', () => {
  it('reset-setup removes only the fingerprint file', () => {
    const dir = slot('acme__app');
    const fp = path.join(dir, '.git', 'reviewer-setup.json');
    state.files[fp] = { content: '{}' };
    state.files[path.join(dir, 'vendor')] = { dir: true };
    expect(resetSetup('acme__app')).toEqual({ slot: 'acme__app' });
    expect(state.removed).toEqual([fp]);
  });

  it('clean removes vendor, node_modules and the fingerprint, nothing else', () => {
    const dir = slot('acme__app');
    cleanWorkspace('acme__app');
    expect(state.removed.sort()).toEqual(
      [
        path.join(dir, 'vendor'),
        path.join(dir, 'node_modules'),
        path.join(dir, '.git', 'reviewer-setup.json'),
      ].sort(),
    );
  });

  it('refuses with 409 while an open session holds the slot', () => {
    const dir = slot('acme__app');
    state.sessions = [{ id: 's9', status: 'idle', workDir: dir }];
    expect(() => resetSetup('acme__app')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => cleanWorkspace('acme__app')).toThrow(expect.objectContaining({ status: 409 }));
    expect(state.removed).toEqual([]);
  });

  it('answers 404 for a name that is not a slot on disk', () => {
    expect(() => resetSetup('acme__missing')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => cleanWorkspace('../etc')).toThrow(expect.objectContaining({ status: 404 }));
    expect(state.removed).toEqual([]);
  });
});
