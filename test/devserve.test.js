import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ▶ Run's state machine in jobs.js: the per-session serve queue, a profile
// switch, the restart when a profile was edited, the keep-running branch when
// the settings no longer build a recipe, and the links it answers with. The
// app server is a fake child (spawn is mocked), the port probe always finds
// the port free (net is mocked), and a publish through the tunnel is whatever
// `state.publish` answers, so every race can be held open on purpose.
const state = vi.hoisted(() => ({
  projects: [],
  database: 'shop',
  // The first label of the hostnames serveHostname answers, before the port.
  label: 'preview',
  // (port, tenant) => Promise<url|null>; null means no tunnel.
  publish: null,
  // The fakes spawned, in order. `holdExit` delays a killed fake's exit.
  procs: [],
  holdExit: null,
  stored: [],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((command, opts) => {
      const proc = new EventEmitter();
      proc.pid = 990000 + state.procs.length;
      proc.exitCode = null;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.command = command;
      proc.env = opts.env;
      proc.kill = vi.fn();
      state.procs.push(proc);
      return proc;
    }),
  };
});

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal();
  const createServer = () => {
    const probe = new EventEmitter();
    probe.listen = (port, host, cb) => setImmediate(cb);
    probe.close = (cb) => setImmediate(cb);
    return probe;
  };
  return { ...actual, default: { ...actual, createServer }, createServer };
});

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({
    claudeBin: '/usr/bin/claude',
    claudeBinSource: 'test',
    codexBin: '',
    grokBin: '',
    opencodeBin: '',
    githubToken: 'tok',
    workspaceDir: path.join(os.tmpdir(), 'briareus-devserve-test'),
    dev: { maxSessions: 3, timeoutMin: 60 },
    reviewLoop: { maxRounds: 3, lowFindingsUntilRound: 1 },
  }),
  parseEnvFile: () => ({}),
}));

vi.mock('../lib/db.js', () => ({
  saveJob: vi.fn(async () => {}),
  saveJobEvents: vi.fn(async () => {}),
  loadJobs: vi.fn(async () => state.stored),
  loadJobEvents: vi.fn(async () => []),
  deleteJob: vi.fn(async () => true),
  jobEventMaxSeqs: vi.fn(async () => new Map()),
}));

vi.mock('../lib/github.js', () => ({
  githubRest: vi.fn(),
  githubGraphql: vi.fn(),
  upsertPrComment: vi.fn(),
  addPullRequestLabel: vi.fn(async () => []),
  removePullRequestLabel: vi.fn(async () => []),
  viewerLogin: vi.fn(async () => null),
}));

vi.mock('../lib/dbpool.js', () => ({
  acquireInstance: vi.fn(),
  releaseInstance: vi.fn(async () => {}),
  ensureSessionDatabase: vi.fn(),
  ensureProfileDatabase: vi.fn(async () => true),
  profileDbElsewhere: vi.fn(() => []),
  sessionDatabaseName: () => state.database,
  dropSessionDatabase: vi.fn(async () => false),
  instanceEnv: vi.fn(() => ({})),
  instanceAppPort: vi.fn(() => 8101),
  sessionCapacity: () => 3,
  projectClaimsServer: () => false,
}));

vi.mock('../lib/providerstore.js', () => ({
  getProvider: () => null,
  providerGroup: (p) => [p],
  providerGroupKey: () => 'claude|',
  providerGroups: () => [],
  getProviderForJob: vi.fn(() => null),
  providerModels: () => [],
  providerEfforts: () => [],
  providerDefaultModel: () => '',
  providerDefaultEffort: () => '',
  captureProviderAuth: vi.fn(),
  resolveRuntime: vi.fn(() => null),
}));

vi.mock('../lib/projects.js', async () => {
  const { render } = await vi.importActual('../lib/runprofiles.js');
  return {
    getProject: (repo) => state.projects.find((p) => p.repo === repo) || null,
    activeProjects: () => state.projects,
    selfProject: () => null,
    render,
    stepRuntime: vi.fn(() => null),
    reviewerRuntime: () => null,
  };
});

vi.mock('../lib/tunnel.js', () => ({
  publicAppUrl: vi.fn((port, tenant) => state.publish(port, tenant)),
  serveHostname: (port, tenant) =>
    tenant ? `${tenant}--${state.label}-${port}.example.com` : `${state.label}-${port}.example.com`,
  localHostname: (port, tenant) => (tenant ? `${tenant}--preview-${port}.localhost` : '127.0.0.1'),
}));

vi.mock('../lib/uploads.js', () => ({ initUploads: vi.fn(), getUpload: vi.fn(() => null) }));

vi.mock('../lib/usage.js', () => ({
  jobUsageEstimates: vi.fn(async () => new Map()),
  recordTurnUsage: vi.fn(),
}));

import { spawn } from 'child_process';
import { ensureProfileDatabase, profileDbElsewhere, dropSessionDatabase } from '../lib/dbpool.js';
import { publicAppUrl } from '../lib/tunnel.js';
import { bus, initJobs, getJob, startDevServe, closeDevSession } from '../lib/jobs.js';

const PROFILES = [
  'profile: projects',
  'env:',
  '  VERTICAL=projects',
  'profile: crm',
  'env:',
  '  VERTICAL=crm',
  '  DB_DATABASE={database}_crm',
].join('\n');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

let dir;
let seq = 0;

// A fresh open session per test: the registry is module-level, so each test
// gets a session id of its own.
function session() {
  const job = getJob(`serve-${seq}`);
  job.status = 'idle';
  job.workDir = dir;
  return job;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-devserve-'));
  state.stored = Array.from({ length: 30 }, (_, i) => ({
    id: `serve-${i}`,
    kind: 'devchat',
    status: 'idle',
    repo: 'acme/shop',
    turns: 1,
  }));
  await initJobs();
});

let kill;

beforeEach(() => {
  seq++;
  state.projects = [
    {
      repo: 'acme/shop',
      label: 'Shop',
      localDir: '',
      runCommands: ['php -S 127.0.0.1:{port}'],
      runProfiles: PROFILES,
    },
  ];
  state.database = 'shop';
  state.label = 'preview';
  state.publish = async () => null;
  state.procs = [];
  state.holdExit = null;
  spawn.mockClear();
  ensureProfileDatabase.mockClear();
  publicAppUrl.mockClear();
  // killTree signals the process group; a fake's is intercepted here and
  // answered with the fake's exit, never sent to a real process.
  kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    const proc = state.procs.find((p) => p.pid === Math.abs(pid));
    if (!proc) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    (state.holdExit || Promise.resolve()).then(() => {
      proc.exitCode = 137;
      proc.emit('exit', 137);
    });
    return true;
  });
});

afterEach(() => {
  kill.mockRestore();
});

describe('▶ Run: the serial queue', () => {
  it('gives two concurrent plain presses one server, and both the same tab', async () => {
    const job = session();

    const [a, b] = await Promise.all([startDevServe(job.id), startDevServe(job.id)]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ url: 'http://127.0.0.1:8101', profile: 'projects' });
    expect(b).toEqual(a);
    expect(job.serveProc).toBe(state.procs[0]);
  });

  it('serves the profile a switch moved to when a plain press queues behind it', async () => {
    const job = session();
    await startDevServe(job.id);

    const [switched, plain] = await Promise.all([
      startDevServe(job.id, { profile: 'crm' }),
      startDevServe(job.id),
    ]);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(switched.profile).toBe('crm');
    expect(plain.profile).toBe('crm');
    expect(job.serveProfile).toBe('crm');
    expect(state.procs[1].env.VERTICAL).toBe('crm');
  });

  it('lets a switch go ahead while the press before it is still publishing its tab', async () => {
    const held = deferred();
    let publishes = 0;
    state.publish = () => (publishes++ === 0 ? held.promise : Promise.resolve(null));
    const job = session();

    const plain = startDevServe(job.id);
    const switched = await startDevServe(job.id, { profile: 'crm' });

    expect(switched).toEqual({ url: 'http://127.0.0.1:8101', profile: 'crm' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(state.procs[0].exitCode).not.toBeNull();
    held.resolve(null);
    expect(await plain).toEqual({ url: 'http://127.0.0.1:8101', profile: 'projects' });
    // The stopped server's late links do not land on the session.
    await tick();
    expect(job.serveLinks).toEqual([{ tenant: null, url: 'http://127.0.0.1:8101' }]);
  });
});

describe('▶ Run: switching profile', () => {
  it('stops the old server, then starts the new one on the same port with its database made', async () => {
    const job = session();
    await startDevServe(job.id);
    const [old] = state.procs;

    const res = await startDevServe(job.id, { profile: 'crm' });

    expect(res).toEqual({ url: 'http://127.0.0.1:8101', profile: 'crm' });
    expect(old.exitCode).not.toBeNull();
    expect(job.serveProc).toBe(state.procs[1]);
    expect(state.procs[1].command).toBe('php -S 127.0.0.1:8101');
    expect(state.procs[1].env.DB_DATABASE).toBe('shop_crm');
    expect(ensureProfileDatabase).toHaveBeenCalledWith(job, 'shop_crm', expect.any(Function));
  });

  it('creates no database for a profile that points the app at another server', async () => {
    state.projects[0].runProfiles = 'profile: reports\nenv:\n  DB_HOST=reports-db\n  DB_DATABASE=reports';
    profileDbElsewhere.mockReturnValueOnce(['DB_HOST']);
    const job = session();

    await startDevServe(job.id);

    expect(profileDbElsewhere).toHaveBeenCalledWith(job, { DB_HOST: 'reports-db', DB_DATABASE: 'reports' });
    expect(ensureProfileDatabase).not.toHaveBeenCalled();
    expect(state.procs[0].env.DB_HOST).toBe('reports-db');
    expect(
      job.events.some((e) => /sets DB_HOST, so its database reports is not created/.test(e.text || '')),
    ).toBe(true);
  });

  it("still creates the database of a profile that restates the session's own server", async () => {
    state.projects[0].runProfiles = 'profile: restated\nenv:\n  DB_PORT=3306\n  DB_DATABASE={database}_x';
    const job = session();

    await startDevServe(job.id);

    expect(ensureProfileDatabase).toHaveBeenCalledWith(job, 'shop_x', expect.any(Function));
  });

  it('refuses a tenant whose hostname label would pass the 63 characters DNS allows', async () => {
    state.projects[0].runProfiles = `profile: long\ntenants: ${'a'.repeat(30)}`;
    state.label = 'p'.repeat(27);
    const job = session();

    await expect(startDevServe(job.id)).rejects.toThrow(
      /tenant a{30} makes the hostname a{30}--p{27}-8101\.example\.com, whose first label is longer than the 63 characters/,
    );
    expect(spawn).not.toHaveBeenCalled();

    // One character less fits exactly.
    state.label = 'p'.repeat(26);
    await startDevServe(job.id);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves the old server running when the new profile is refused', async () => {
    const job = session();
    state.database = '';
    await startDevServe(job.id);
    const [old] = state.procs;

    await expect(startDevServe(job.id, { profile: 'crm' })).rejects.toThrow(/uses \{database\}/);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(old.exitCode).toBeNull();
    expect(job.serveProc).toBe(old);
    expect(job.serveProfile).toBe('projects');
  });

  it('spawns nothing when the session closes while the old server is stopping', async () => {
    const job = session();
    await startDevServe(job.id);
    const stopping = deferred();
    state.holdExit = stopping.promise;

    // The close's database drop is still awaiting when the stop ends, so the
    // status is not closed yet: the start has to see the close all the same.
    const dropping = deferred();
    dropSessionDatabase.mockImplementationOnce(() => dropping.promise);

    const switching = startDevServe(job.id, { profile: 'crm' });
    const settled = switching.catch((e) => e);
    await tick();
    await tick();
    const closing = closeDevSession(job.id);
    stopping.resolve();
    const outcome = await settled;
    dropping.resolve(false);
    await closing;

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toMatch(/let go of its workspace/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('closed');
  });
});

describe('▶ Run: a running app whose settings changed', () => {
  it('restarts the same profile when it was edited since the app started', async () => {
    const job = session();
    await startDevServe(job.id);
    state.projects[0].runProfiles = PROFILES.replace('VERTICAL=projects', 'VERTICAL=projects2');

    await startDevServe(job.id);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(state.procs[0].exitCode).not.toBeNull();
    expect(state.procs[1].env.VERTICAL).toBe('projects2');
  });

  it('keeps an unedited app running and answers with its tab', async () => {
    const job = session();
    await startDevServe(job.id);

    const res = await startDevServe(job.id);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ url: 'http://127.0.0.1:8101', profile: 'projects' });
  });

  it('keeps the app running when no recipe builds, and answers with the tenants it started with', async () => {
    state.projects[0].runProfiles = 'profile: tenants\ntenants: central, demo';
    const job = session();
    await startDevServe(job.id);
    // One Settings save blanks the run commands and edits the tenants.
    state.projects[0].runCommands = [];
    state.projects[0].runProfiles = 'profile: tenants\ntenants: other';
    publicAppUrl.mockClear();

    const res = await startDevServe(job.id);
    await tick();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ url: 'http://central--preview-8101.localhost:8101', profile: 'tenants' });
    expect(publicAppUrl.mock.calls.map(([, tenant]) => tenant)).toEqual(['central', 'demo']);
    expect(job.serveLinks.map((l) => l.tenant)).toEqual(['central', 'demo']);
    expect(job.events.some((e) => /Keeping the running app: No run command/.test(e.text || ''))).toBe(true);
  });
});

describe('▶ Run: the links it answers with', () => {
  it('opens the first tenant as soon as it is published, ahead of the port hostname {host} needs', async () => {
    state.projects[0].runCommands = ['php -S 127.0.0.1:{port} # {host}'];
    state.projects[0].runProfiles = 'profile: tenants\ntenants: central, demo';
    const held = deferred();
    state.publish = (port, tenant) =>
      tenant === 'central' ? Promise.resolve(`https://central.example.com`) : held.promise;
    const job = session();

    const res = await startDevServe(job.id);

    expect(res).toEqual({ url: 'https://central.example.com', profile: 'tenants' });
    // The first tenant is at the head of the tunnel's publish chain.
    expect(publicAppUrl.mock.calls.map(([, tenant]) => tenant)).toEqual(['central', 'demo', null]);
    expect(job.serveLinks).toBeNull();
    held.resolve('https://other.example.com');
    await tick();
    await tick();
    expect(job.serveLinks).toEqual([
      { tenant: 'central', url: 'https://central.example.com' },
      { tenant: 'demo', url: 'https://other.example.com' },
    ]);
  });

  it('refuses run commands naming a tenant the served profile does not list', async () => {
    state.projects[0].runCommands = ['php artisan register {host:central}', 'php -S 127.0.0.1:{port}'];
    const job = session();

    await expect(startDevServe(job.id)).rejects.toThrow(
      /run commands use \{host:central\}, but run profile projects does not list central/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('leaves no unhandled rejection when the run commands exit at once', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const held = deferred();
    state.publish = () => held.promise;
    spawn.mockImplementationOnce((command, opts) => {
      const proc = new EventEmitter();
      proc.pid = 990000 + state.procs.length;
      proc.exitCode = 1;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.env = opts.env;
      state.procs.push(proc);
      return proc;
    });
    const job = session();

    await expect(startDevServe(job.id)).rejects.toThrow(/exited immediately/);
    // Whatever the links chain runs into once its publish lands (here a page
    // listener that throws) must not escape: nobody awaits it any more.
    job.serveProc = state.procs[0];
    state.procs[0].exitCode = null;
    const boom = () => {
      throw new Error('boom');
    };
    bus.on('job', boom);
    held.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.off('job', boom);
    job.serveProc = null;

    expect(error).toHaveBeenCalledWith('serve links error:', 'boom');
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    error.mockRestore();
  });
});
