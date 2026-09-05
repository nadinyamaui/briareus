import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import { spawn } from 'child_process';
import { BINARIES } from '../lib/providers.js';

// jobs.js orchestrates processes, clones and MySQL; none of that runs here.
// These tests cover what is pure: the event windowing, the public projection
// of a job, and every validation createDevSession refuses on before it
// creates anything. The success path (spawning a session) stays untested on
// purpose; it is the integration surface.
const state = vi.hoisted(() => ({
  provider: { id: 1, label: 'Claude entry', binary: 'claude' },
  projects: [],
  claimsServer: false,
  capacity: 3,
  // What the database hands back to initJobs: the only way to get a session
  // into the registry here without spawning one.
  stored: [],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({
    claudeBin: '/usr/bin/claude',
    claudeBinSource: 'test',
    codexBin: '',
    grokBin: '',
    opencodeBin: '',
    githubToken: 'tok',
    workspaceDir: '/tmp/nowhere',
    dev: { maxSessions: 3, timeoutMin: 60 },
    reviewLoop: { maxRounds: 3, lowFindingsUntilRound: 1 },
  }),
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
}));

vi.mock('../lib/dbpool.js', () => ({
  acquireInstance: vi.fn(),
  releaseInstance: vi.fn(),
  ensureSessionDatabase: vi.fn(),
  dropSessionDatabase: vi.fn(),
  instanceEnv: vi.fn(() => ({})),
  instanceAppPort: vi.fn(() => 8101),
  sessionCapacity: () => state.capacity,
  projectClaimsServer: () => state.claimsServer,
}));

vi.mock('../lib/providerstore.js', () => ({
  getProvider: (id) => (id === state.provider.id ? state.provider : null),
  getProviderForJob: vi.fn(),
  providerModels: () => ['claude-fable-5-1'],
  providerEfforts: () => ['low', 'high'],
  providerDefaultModel: () => 'claude-fable-5-1',
  providerDefaultEffort: () => 'high',
  captureProviderAuth: vi.fn(),
  // The real one resolves a runtime against the provider rows; here the one
  // row there is answers as stored, and any other id is a deleted row.
  resolveRuntime: vi.fn((runtime) =>
    runtime && runtime.providerId === state.provider.id
      ? { provider: state.provider, model: runtime.model, effort: runtime.effort }
      : null,
  ),
}));

vi.mock('../lib/projects.js', () => ({
  getProject: (repo) => state.projects.find((p) => p.repo === repo) || null,
  activeProjects: () => state.projects,
  selfProject: () => state.projects.find((p) => p.isSelf) || null,
  render: vi.fn((s) => s),
  stepRuntime: vi.fn(() => null),
}));

vi.mock('../lib/prtasks.js', () => ({
  testSheetPrompt: vi.fn(() => 'SHEET'),
  testRunPrompt: vi.fn(() => 'RUN'),
  implementFeedbackPrompt: vi.fn(() => 'FEEDBACK'),
}));

vi.mock('../lib/findings.js', () => ({
  latestReviewFindings: vi.fn(async () => []),
  latestTestFailures: vi.fn(async () => []),
  queueFindingsForFix: vi.fn(async (repo, prNumber, findings) => ({
    kept: findings,
    parked: [],
    error: null,
  })),
  sortFindingsForFix: vi.fn(async (repo, prNumber, findings) => ({ kept: findings, parked: [] })),
  recordTriage: vi.fn(async () => ({ error: null })),
  findingKey: vi.fn((title) => `key:${title}`),
  PARK_REASONS: { severity: 'below the floor', 'out-of-diff': 'outside the diff' },
}));

vi.mock('../lib/uploads.js', () => ({
  initUploads: vi.fn(),
  getUpload: vi.fn(() => null),
}));

vi.mock('../lib/usage.js', () => ({
  recordTurnUsage: vi.fn(),
}));

import { deleteJob, saveJob } from '../lib/db.js';
import { dropSessionDatabase } from '../lib/dbpool.js';
import {
  latestReviewFindings,
  latestTestFailures,
  queueFindingsForFix,
  recordTriage,
} from '../lib/findings.js';
import { implementFeedbackPrompt } from '../lib/prtasks.js';
import { githubGraphql, githubRest } from '../lib/github.js';
import { resolveRuntime, getProviderForJob, captureProviderAuth } from '../lib/providerstore.js';
import {
  initJobs,
  closeDevSession,
  deleteJobById,
  jobEventsSince,
  publicJob,
  getJob,
  createDevSession,
  devSessionSlots,
  dropQueuedMessage,
  cancelDevTurn,
  closeDevSessionWithReason,
  syncSessionsOn,
  spottedPrIsThisSession,
  setReviewLoop,
  setQaLoop,
  renameDevSession,
  linkPrToSession,
  attachPrForBranch,
  spawnWorkerSession,
  workerSessionsFor,
  workerSummary,
  deliverWorkerNotices,
  sendDevMessage,
  orchestratorSpend,
  sessionUsage,
  childSessionsOf,
  triageLoopFindings,
  retryLoopRound,
  workspaceStartBranch,
  workspaceBranchPlan,
  workspaceCheckoutPlan,
  workspaceGitProbeOptions,
} from '../lib/jobs.js';

beforeEach(() => {
  state.projects = [{ repo: 'acme/shop', label: 'Shop', localDir: '' }];
  state.claimsServer = false;
  state.capacity = 3;
});

describe('jobEventsSince', () => {
  const job = { events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] };

  it('answers only the events past the cursor', () => {
    expect(jobEventsSince(job, 1)).toEqual([{ seq: 2 }, { seq: 3 }]);
    expect(jobEventsSince(job, 0)).toHaveLength(3);
  });

  it('a cursor past the end answers nothing', () => {
    expect(jobEventsSince(job, 99)).toEqual([]);
  });
});

describe('restart reconciliation for loop jobs', () => {
  beforeAll(async () => {
    state.stored = [
      {
        id: 'restart-review-parent',
        kind: 'devchat',
        status: 'idle',
        repo: 'acme/shop',
        turns: 1,
        reviewLoop: { rounds: 1, reviewing: true, reviewSessionId: 'restart-review' },
      },
      {
        id: 'restart-review',
        kind: 'devchat',
        status: 'running',
        repo: 'acme/shop',
        loopParentId: 'restart-review-parent',
      },
      {
        id: 'restart-fix-parent',
        kind: 'devchat',
        status: 'idle',
        repo: 'acme/shop',
        turns: 1,
        reviewLoop: { rounds: 2, fixing: true, fixSessionId: 'restart-fix' },
      },
      {
        id: 'restart-fix',
        kind: 'devchat',
        status: 'running',
        repo: 'acme/shop',
        loopFixParentId: 'restart-fix-parent',
      },
      {
        id: 'restart-qa-parent',
        kind: 'devchat',
        status: 'idle',
        repo: 'acme/shop',
        turns: 1,
        reviewLoop: { rounds: 1, done: true },
        qaLoop: { running: true, sessionId: 'restart-qa', done: false },
      },
      {
        id: 'restart-qa',
        kind: 'devchat',
        status: 'running',
        repo: 'acme/shop',
        qaParentId: 'restart-qa-parent',
      },
    ];
    await initJobs();
  });

  it('turns a restarted review into a failed, retryable round', () => {
    const parent = getJob('restart-review-parent');

    expect(parent.status).toBe('interrupted');
    expect(parent.reviewLoop).toMatchObject({ reviewing: false });
    expect(parent.reviewLoop.failure).toMatchObject({
      round: 1,
      reason: 'Server restarted while the job was active',
    });
    expect(workerSummary(parent).reviewLoop).toMatchObject({
      reviewing: false,
      failure: { round: 1, reason: 'Server restarted while the job was active' },
    });
  });

  it('releases interrupted fix and QA sessions instead of leaving them in flight', () => {
    const fixParent = getJob('restart-fix-parent');
    const qaParent = getJob('restart-qa-parent');

    expect(fixParent.reviewLoop).toMatchObject({ fixing: false, fixSessionId: null });
    expect(fixParent.reviewLoop.failure).toMatchObject({
      round: 2,
      reason: 'Server restarted while the job was active',
    });
    expect(qaParent.qaLoop).toMatchObject({ running: false, done: false });
    expect(qaParent.qaLoop.failure).toMatchObject({
      kind: 'interrupted',
      reason: 'Server restarted while the job was active',
    });
    expect(workerSummary(qaParent).qaLoop.failure).toEqual({
      kind: 'interrupted',
      reason: 'Server restarted while the job was active',
    });
  });
});

describe('workspaceGitProbeOptions', () => {
  it('gives synchronous probes the authenticated git environment without exposing the token', () => {
    const options = workspaceGitProbeOptions({ repo: 'acme/shop' });

    expect(options).toMatchObject({
      encoding: 'utf8',
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    expect(options.env).toHaveProperty('REVIEWER_GIT_TOKEN');
    expect(options.env).toHaveProperty('GIT_CONFIG_KEY_0', 'credential.https://github.com.helper');
  });
});

describe('workspaceStartBranch', () => {
  it('restores a resumed worker branch instead of treating it as a fresh branch', () => {
    const job = { id: '43e67d04', branch: 'dev-43e67d04', startBranch: null, reviewBranch: null };

    expect(workspaceStartBranch(job)).toBe('dev-43e67d04');
    expect(workspaceBranchPlan(job, 'main')).toEqual({
      branch: 'dev-43e67d04',
      startPoint: 'dev-43e67d04',
    });
  });

  it('refreshes a resumed branch from its remote ref when it exists', () => {
    const job = { id: 'j1', branch: 'worker', startBranch: null, reviewBranch: null };

    expect(workspaceCheckoutPlan(job, 'main', { remoteWorkerRef: true, localBranch: true })).toEqual({
      branch: 'worker',
      startPoint: 'worker',
      source: 'remote',
      checkoutRef: 'refs/remotes/origin/worker',
    });
  });

  it('keeps an existing local-only resumed branch when the remote ref is absent', () => {
    const job = { id: 'j1', branch: 'worker', startBranch: null, reviewBranch: null };

    expect(workspaceCheckoutPlan(job, 'main', { remoteWorkerRef: false, localBranch: true })).toEqual({
      branch: 'worker',
      startPoint: 'worker',
      source: 'local',
      checkoutRef: 'worker',
    });
  });

  it('leaves a new session without a branch so it can start from the default branch', () => {
    expect(
      workspaceStartBranch({ id: 'new', branch: null, startBranch: null, reviewBranch: null }),
    ).toBeNull();
  });
});

describe('publicJob', () => {
  it('strips the process handles and the event buffer off the wire format', () => {
    const job = {
      id: 'j1',
      kind: 'devchat',
      status: 'idle',
      events: [{ seq: 1 }],
      seq: 1,
      proc: { pid: 123 },
      timeout: 42,
      turnCanceled: true,
      serveProc: { pid: 456 },
      meta: {},
    };
    const projected = publicJob(job);
    expect(projected).toMatchObject({ id: 'j1', kind: 'devchat', status: 'idle' });
    for (const secret of ['events', 'seq', 'proc', 'timeout', 'turnCanceled', 'serveProc']) {
      expect(projected).not.toHaveProperty(secret);
    }
  });
});

describe('getJob', () => {
  it('answers null for an id nothing created', () => {
    expect(getJob('never-created')).toBeNull();
  });
});

describe('devSessionSlots', () => {
  it('a project that claims no database server is never capped', () => {
    expect(devSessionSlots('acme/shop')).toBe(Infinity);
  });

  it('a claiming project gets the pool capacity (no sessions are open here)', () => {
    state.claimsServer = true;
    state.capacity = 2;
    expect(devSessionSlots('acme/shop')).toBe(2);
  });
});

describe('createDevSession: the validation gauntlet', () => {
  const base = {
    provider: 1,
    model: 'claude-fable-5-1',
    effort: 'high',
    prompt: 'do things',
    repo: 'acme/shop',
  };

  it('refuses a provider nobody configured', () => {
    expect(() => createDevSession({ ...base, provider: 99 })).toThrow(/Unknown provider: 99/);
  });

  it('refuses when no projects exist, and an unknown repo', () => {
    state.projects = [];
    expect(() => createDevSession(base)).toThrow(/No projects are set up yet/);
    state.projects = [{ repo: 'acme/shop', label: 'Shop', localDir: '' }];
    expect(() => createDevSession({ ...base, repo: 'acme/other' })).toThrow(/Unknown project: acme\/other/);
  });

  it('refuses branch names git would refuse', () => {
    for (const branch of ['-leading-dash', 'a..b', 'ends/', 'x.lock', '@', 'a b']) {
      expect(() => createDevSession({ ...base, branch })).toThrow(/is not a valid branch name/);
    }
  });

  it('a session is a review or a QA run, never both, and neither runs local', () => {
    expect(() => createDevSession({ ...base, review: true, qa: true, branch: 'f' })).toThrow(
      /either a code review or a QA run/,
    );
    expect(() => createDevSession({ ...base, qa: true, local: true, branch: 'f' })).toThrow(
      /workspace clone of its own/,
    );
    expect(() => createDevSession({ ...base, review: true, local: true, branch: 'f' })).toThrow(
      /workspace clone of its own/,
    );
  });

  it('review and QA both need the branch they act on', () => {
    expect(() => createDevSession({ ...base, review: true })).toThrow(/needs the branch to review/);
    expect(() => createDevSession({ ...base, qa: true })).toThrow(/needs the pull request branch/);
  });

  it('a chat session with nothing to say does not start', () => {
    expect(() => createDevSession({ ...base, prompt: '   ' })).toThrow(/first message cannot be empty/);
  });

  it('local mode needs a configured checkout that is actually a git tree', () => {
    expect(() => createDevSession({ ...base, local: true })).toThrow(/no local checkout configured/);
    state.projects = [{ repo: 'acme/shop', label: 'Shop', localDir: '/tmp/definitely-not-a-checkout' }];
    expect(() => createDevSession({ ...base, local: true })).toThrow(/is not a git checkout/);
  });

  it('a full database pool refuses the session before creating anything', () => {
    state.claimsServer = true;
    state.capacity = 0;
    expect(() => createDevSession(base)).toThrow(/holding a database server; close one first/);
  });

  it('the review loop only arms a durable task session, never a review, QA run, auto-closing errand or local one', () => {
    for (const extra of [
      { review: true, branch: 'f' },
      { qa: true, branch: 'f' },
      { local: true },
      { autoClose: true },
    ]) {
      expect(() => createDevSession({ ...base, reviewLoop: true, ...extra })).toThrow(
        /review loop only applies/,
      );
      expect(() => createDevSession({ ...base, reviewLoop: true, qaLoop: true, ...extra })).toThrow(
        /loop only applies/,
      );
    }
  });

  it('the QA loop queues behind the review loop, never on its own', () => {
    expect(() => createDevSession({ ...base, qaLoop: true })).toThrow(/arm the review loop too/);
  });

  it('an orchestrator only chats: no review, QA, local mode, loops, autoClose or branch', () => {
    for (const extra of [
      { review: true },
      { qa: true },
      { local: true },
      { autoClose: true },
      { reviewLoop: true },
      { qaLoop: true },
      { branch: 'feature' },
    ]) {
      expect(() => createDevSession({ ...base, orchestrator: true, ...extra })).toThrow(
        /only chats and manages workers/,
      );
    }
  });

  it('a Zeus session is an orchestrator with the same refusals, filed under its own activity', () => {
    for (const extra of [{ review: true }, { local: true }, { reviewLoop: true }, { branch: 'feature' }]) {
      expect(() => createDevSession({ ...base, zeus: true, ...extra })).toThrow(
        /only chats and manages workers/,
      );
    }
    const zeusRoles = { product: { providerId: 1 }, architecture: { providerId: 1 } };
    const zeus = createDevSession({ ...base, zeus: true, zeusRoles });
    expect(zeus.orchestrator).toBe(true);
    expect(zeus.zeus).toBe(true);
    expect(zeus.activity).toBe('zeus');
    expect(zeus.readOnly).toBe(false);
    // Its workers' runtime is the orchestrator's, so the epic dialog's pick
    // shape works for Zeus too.
    expect(
      createDevSession({ ...base, zeus: true, zeusRoles, workerRuntime: { providerId: 1 } }).workerRuntime,
    ).toEqual({
      providerId: 1,
      model: 'claude-fable-5-1',
      effort: 'high',
    });
    expect(createDevSession({ ...base, orchestrator: true }).zeus).toBe(false);
  });

  it('a Zeus session stores a runtime per analyst role, and only Zeus does', () => {
    expect(() =>
      createDevSession({ ...base, orchestrator: true, zeusRoles: { qa: { providerId: 1 } } }),
    ).toThrow(/Only a Zeus session carries runtimes for analyst roles/);
    expect(() =>
      createDevSession({ ...base, zeus: true, zeusRoles: { designer: { providerId: 1 } } }),
    ).toThrow(/Unknown Zeus analyst role: designer/);
    expect(() => createDevSession({ ...base, zeus: true, zeusRoles: { qa: { providerId: 99 } } })).toThrow(
      /Unknown worker provider: 99/,
    );
    const picked = createDevSession({
      ...base,
      zeus: true,
      zeusRoles: {
        product: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
        architecture: { providerId: 1, model: 'gone-model', effort: 'extreme' },
      },
    });
    expect(picked.zeusRoles).toEqual({
      product: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
      architecture: { providerId: 1, model: 'claude-fable-5-1', effort: 'high' },
    });
    // A session started before the fusion dropped to two proposals still reads
    // back its third pick; it is simply no longer asked for.
    expect(
      createDevSession({
        ...base,
        zeus: true,
        zeusRoles: {
          product: { providerId: 1 },
          architecture: { providerId: 1 },
          qa: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
        },
      }).zeusRoles.qa,
    ).toEqual({ providerId: 1, model: 'claude-fable-5-1', effort: 'low' });
    for (const zeusRoles of [undefined, {}, { product: { providerId: 1 } }, { qa: { providerId: 1 } }]) {
      expect(() => createDevSession({ ...base, zeus: true, zeusRoles })).toThrow(
        /Choose a model for both proposal slots/,
      );
    }
  });

  it('a read-only analyst is always somebody’s worker and takes nothing that pushes', () => {
    expect(() => createDevSession({ ...base, readOnly: true })).toThrow(/worker session of some Zeus/);
    for (const extra of [{ orchestrator: true }, { zeus: true }, { reviewLoop: true }, { autoClose: true }]) {
      expect(() => createDevSession({ ...base, readOnly: true, parentId: 'x', ...extra })).toThrow(
        /only reads and reports/,
      );
    }
  });

  it('a worker must file under a live orchestrator session', () => {
    expect(() => createDevSession({ ...base, parentId: 'nothing-here' })).toThrow(
      /No orchestrator session nothing-here/,
    );
  });

  it('only an orchestrator carries a runtime for its workers, on a provider row that exists', () => {
    expect(() => createDevSession({ ...base, workerRuntime: { providerId: 1 } })).toThrow(
      /Only an orchestrator session carries a runtime/,
    );
    expect(() =>
      createDevSession({ ...base, orchestrator: true, workerRuntime: { providerId: 99 } }),
    ).toThrow(/Unknown worker provider: 99/);
  });

  it('stores the workers’ runtime by row id, falling to the provider’s defaults for what it does not offer', () => {
    const picked = createDevSession({
      ...base,
      orchestrator: true,
      workerRuntime: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
    });
    expect(picked.workerRuntime).toEqual({ providerId: 1, model: 'claude-fable-5-1', effort: 'low' });
    const loose = createDevSession({
      ...base,
      orchestrator: true,
      workerRuntime: { providerId: 1, model: 'gone-model', effort: 'extreme' },
    });
    expect(loose.workerRuntime).toEqual({ providerId: 1, model: 'claude-fable-5-1', effort: 'high' });
    expect(createDevSession({ ...base, orchestrator: true }).workerRuntime).toBeNull();
    expect(createDevSession({ ...base }).workerRuntime).toBeNull();
  });
});

describe('spawnWorkerSession', () => {
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed', // restored as-is; flipped to idle below where a test needs it open
    repo: 'acme/shop',
    providerId: 1,
    turns: 1,
    createdAt: `2026-08-2${extra?.day || 1}T00:00:00.000Z`,
    meta: {},
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('orch-a', { orchestrator: true }),
      row('orch-b', { orchestrator: true }),
      // Started with a worker runtime of its own (the epic dialog's pick); its
      // own effort is the provider's default, so a worker on 'low' proves the
      // pick was used. orch-gone's pick names a provider row deleted since.
      row('orch-c', {
        orchestrator: true,
        effort: 'high',
        workerRuntime: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
      }),
      row('orch-gone', {
        orchestrator: true,
        effort: 'high',
        workerRuntime: { providerId: 99, model: 'claude-fable-5-1', effort: 'low' },
      }),
      row('plain-a', {}),
      row('w-a1', { parentId: 'orch-a', day: 2 }),
      row('w-a2', { parentId: 'orch-a', day: 3 }),
      row('zeus-a', { orchestrator: true, zeus: true }),
      row('zeus-resume', { orchestrator: true, zeus: true }),
      // Started from the composer's dialog with a pick for two roles; its own
      // effort is the provider's default, so an analyst on 'low' proves the
      // role's pick was used, and one on 'high' that the fallback was.
      row('zeus-roles', {
        orchestrator: true,
        zeus: true,
        effort: 'high',
        zeusRoles: {
          product: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
          validator: { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
        },
      }),
    ];
    await initJobs();
    getJob('orch-a').status = 'idle';
    getJob('orch-c').status = 'idle';
    getJob('orch-gone').status = 'idle';
    getJob('zeus-a').status = 'idle';
    getJob('zeus-roles').status = 'idle';
  });

  it('a resumed Zeus saves complete model choices before queuing its brief', () => {
    const job = getJob('zeus-resume');
    job.status = 'running';
    const pick = { providerId: 1, model: 'claude-fable-5-1', effort: 'low' };
    const roles = { product: pick, architecture: pick };
    expect(() => sendDevMessage(job.id, 'Brief', [], { product: pick })).toThrow(/both proposal slots/);
    expect(job.zeusRoles).toBeUndefined();
    expect(() => sendDevMessage('orch-a', 'Brief', [], roles)).toThrow(/Only a Zeus/);
    const session = sendDevMessage(job.id, 'Same complete brief', [], roles);
    expect(session.zeusRoles).toEqual(roles);
    expect(session.queued[0].text).toBe('Same complete brief');
    const analyst = spawnWorkerSession(job, {
      title: 'Model 2',
      prompt: 'Full proposal',
      role: 'architecture',
    });
    expect(analyst.effort).toBe('low');
    expect(job.zeusProposalPrompt).toBe('Full proposal');
    expect(() => spawnWorkerSession(job, { title: 'Model 3', prompt: 'Only QA', role: 'qa' })).toThrow(
      /exactly the same prompt/,
    );
    const other = spawnWorkerSession(job, { title: 'Model 3', prompt: 'Full proposal', role: 'qa' });
    expect(getJob(other.id).events.find((event) => event.kind === 'user').text).toBe('Full proposal');
    expect(getJob(analyst.id).events.find((event) => event.kind === 'user').text).toBe('Full proposal');
    sendDevMessage(job.id, 'A new brief');
    expect(job.zeusProposalPrompt).toBe('Full proposal'); // queued: the old round still owns the prompt
    dropQueuedMessage(job.id, 1);
    dropQueuedMessage(job.id, 0);
    job.status = 'idle';
    sendDevMessage(job.id, 'A new brief');
    expect(job.zeusProposalPrompt).toBeNull();
  });

  it.each(['codex', 'grok', 'opencode'])(
    '%s receives updated Zeus choices on immediate and queued resumed turns',
    async (binary) => {
      const job = getJob('zeus-resume');
      dropQueuedMessage(job.id, 0);
      job.status = 'idle';
      job.chats = { 1: { sessionId: binary === 'opencode' ? 'ses_resume' : 'resume-id', started: true } };
      const provider = { ...state.provider, binary };
      getProviderForJob.mockReturnValue(provider);
      captureProviderAuth.mockResolvedValue(undefined);
      const bin = vi.spyOn(BINARIES[binary], 'bin').mockReturnValue({ bin: '/mock/agent', source: 'test' });
      const children = [];
      const prompts = [];
      spawn.mockImplementation(() => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        if (binary === 'grok') {
          prompts.push(fs.readFileSync(`/tmp/reviewer-prompts/${job.id}-prompt.txt`, 'utf8'));
        } else {
          child.stdin.on('data', (chunk) => prompts.push(chunk.toString()));
        }
        children.push(child);
        return child;
      });
      try {
        const pick = { providerId: 1, model: 'claude-fable-5-1', effort: 'low' };
        const roles = { product: pick, architecture: pick };
        sendDevMessage(job.id, 'Immediate brief', [], roles);
        expect(prompts).toHaveLength(1);
        const queued = sendDevMessage(job.id, 'Queued brief', [], roles);
        expect(queued.queued[0].text).toBe('Queued brief');
        expect(prompts).toHaveLength(1);
        children[0].emit('close', 0);
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        for (const [index, prompt] of prompts.entries()) {
          expect(prompt).toContain(index === 0 ? 'Immediate brief' : 'Queued brief');
          expect(prompt).toContain('supersede any earlier missing or partial picks');
          expect(prompt).toContain('Omit provider_id and model');
          expect(prompt).toContain('same complete proposal prompt to both');
          for (const role of Object.keys(roles)) {
            expect(prompt).toContain(`- ${role}: Claude entry (provider_id 1), claude-fable-5-1, effort low`);
          }
          // Resumed providers do not receive the full initial system briefing.
          expect(prompt).not.toContain('# Fusion');
          expect(prompt).toContain('ZEUS itself consolidates both complete outputs');
        }
        children[1].emit('close', 0);
        await vi.waitFor(() => expect(job.status).toBe('idle'));
      } finally {
        bin.mockRestore();
        spawn.mockReset();
        getProviderForJob.mockReset();
        captureProviderAuth.mockReset();
      }
    },
  );

  it('a role is a Zeus analyst’s and one of the four', () => {
    expect(() => spawnWorkerSession(getJob('orch-a'), { title: 'R', prompt: 'x', role: 'qa' })).toThrow(
      /Only a Zeus session starts analysts by role/,
    );
    expect(() => spawnWorkerSession(getJob('zeus-a'), { title: 'R', prompt: 'x', role: 'designer' })).toThrow(
      /Unknown analyst role "designer"/,
    );
  });

  it('an analyst spawned by role runs on the runtime the user picked for that role', () => {
    const product = spawnWorkerSession(getJob('zeus-roles'), {
      title: 'Product',
      prompt: 'x',
      role: 'product',
    });
    expect(product.effort).toBe('low');
    expect(product.analystRole).toBe('product');
    // A role with no pick falls through to the usual worker runtime chain,
    // which here ends at the Zeus session's own entry.
    const qa = spawnWorkerSession(getJob('zeus-roles'), { title: 'QA', prompt: 'x', role: 'qa' });
    expect(qa.effort).toBe('high');
    expect(qa.analystRole).toBe('qa');
    // A spawn that names its own runtime is taken at its word over the pick:
    // naming the model alone skips the role's pick (and its 'low').
    const named = spawnWorkerSession(getJob('zeus-roles'), {
      title: 'Named',
      prompt: 'x',
      role: 'validator',
      model: 'claude-fable-5-1',
    });
    expect(named.effort).toBe('high');
    expect(named.analystRole).toBe('validator');
    // No role at all: still a read-only analyst, unlabelled.
    const plain = spawnWorkerSession(getJob('zeus-roles'), { title: 'Plain', prompt: 'x' });
    expect(plain.readOnly).toBe(true);
    expect(plain.analystRole).toBeNull();
  });

  it('a Zeus session starts read-only analysts and refuses loops and branches for them', () => {
    expect(() =>
      spawnWorkerSession(getJob('zeus-a'), { title: 'Looped', prompt: 'x', reviewLoop: true }),
    ).toThrow(/read-only: it pushes nothing/);
    expect(() => spawnWorkerSession(getJob('zeus-a'), { title: 'QA', prompt: 'x', qaLoop: true })).toThrow(
      /read-only: it pushes nothing/,
    );
    expect(() =>
      spawnWorkerSession(getJob('zeus-a'), { title: 'Branch', prompt: 'x', branch: 'feature' }),
    ).toThrow(/takes no branch/);
    // A plain worker under Zeus cannot be made by hand either.
    expect(() =>
      createDevSession({
        provider: 1,
        model: 'claude-fable-5-1',
        effort: 'high',
        prompt: 'x',
        repo: 'acme/shop',
        parentId: 'zeus-a',
      }),
    ).toThrow(/only starts read-only analysts/);
  });

  it('an analyst files under Zeus as a read-only worker on the analyst activity', () => {
    const analyst = spawnWorkerSession(getJob('zeus-a'), { title: 'Product', prompt: 'x' });
    expect(analyst.readOnly).toBe(true);
    expect(analyst.parentId).toBe('zeus-a');
    expect(analyst.activity).toBe('analyst');
    expect(analyst.reviewLoop).toBeNull();
    expect(analyst.qaLoop).toBeNull();
    expect(workerSessionsFor(getJob('zeus-a')).map((j) => j.id)).toEqual([analyst.id]);
  });

  it('refuses a parent that is not an orchestrator', () => {
    expect(() => spawnWorkerSession(getJob('plain-a'), { prompt: 'x' })).toThrow(
      /Only an orchestrator session/,
    );
  });

  it('refuses a parent that let go of everything', () => {
    expect(() => spawnWorkerSession(getJob('orch-b'), { prompt: 'x' })).toThrow(/is not open/);
  });

  it('refuses an empty task brief', () => {
    expect(() => spawnWorkerSession(getJob('orch-a'), { prompt: '   ' })).toThrow(/task brief/);
  });

  it('workerSessionsFor answers only this orchestrator’s workers, newest first', () => {
    expect(workerSessionsFor(getJob('orch-a')).map((j) => j.id)).toEqual(['w-a2', 'w-a1']);
    expect(workerSessionsFor(getJob('orch-b'))).toEqual([]);
  });

  // Last in this block: these two actually create sessions, so they would show
  // up in the listing test above.
  it('arms the loops on the worker only when the spawn asked for them', () => {
    const looped = spawnWorkerSession(getJob('orch-a'), {
      title: 'Loop',
      prompt: 'x',
      reviewLoop: true,
      qaLoop: true,
    });
    expect(looped.reviewLoop).not.toBeNull();
    expect(looped.qaLoop).not.toBeNull();
    const plain = spawnWorkerSession(getJob('orch-a'), { title: 'No loop', prompt: 'x' });
    expect(plain.reviewLoop).toBeNull();
    expect(plain.qaLoop).toBeNull();
  });

  it('refuses a QA loop with no review loop to queue behind', () => {
    expect(() =>
      spawnWorkerSession(getJob('orch-a'), { title: 'QA only', prompt: 'x', qaLoop: true }),
    ).toThrow(/arm the review loop too/);
  });

  it('a spawn that names nothing runs on the runtime the orchestration was started with', () => {
    // No project worker runtime here (beforeEach), so 'low' can only be the pick.
    const picked = spawnWorkerSession(getJob('orch-c'), { title: 'Picked', prompt: 'x' });
    expect(picked.effort).toBe('low');
    // A spawn that names its own runtime is taken at its word.
    const named = spawnWorkerSession(getJob('orch-c'), { title: 'Named', prompt: 'x', effort: 'high' });
    expect(named.effort).toBe('high');
    // A pick whose provider row is gone falls through to the project's runtime
    // rather than to the orchestrator's own entry.
    state.projects = [
      { repo: 'acme/shop', label: 'Shop', localDir: '', workerProviderId: 1, workerEffort: 'low' },
    ];
    const gone = spawnWorkerSession(getJob('orch-gone'), { title: 'Gone', prompt: 'x' });
    expect(gone.effort).toBe('low');
  });
});

describe('spawnWorkerSession: tooling fixes', () => {
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/shop',
    providerId: 1,
    turns: 1,
    createdAt: '2026-09-02T00:00:00.000Z',
    meta: {},
    ...extra,
  });
  const dashboard = {
    repo: 'acme/dashboard',
    label: 'Dashboard',
    localDir: '',
    isSelf: true,
    workerProviderId: 1,
    workerModel: 'claude-fable-5-1',
    workerEffort: 'low',
  };

  beforeAll(async () => {
    state.stored = [row('tool-orch', { orchestrator: true })];
    await initJobs();
    getJob('tool-orch').status = 'idle';
  });

  beforeEach(() => {
    state.projects = [
      { repo: 'acme/shop', label: 'Shop', localDir: '', workerProviderId: 1, workerEffort: 'high' },
      dashboard,
    ];
    resolveRuntime.mockClear();
    getJob('tool-orch').workerRuntime = null;
  });

  it('refuses when no project is flagged as the dashboard itself', () => {
    state.projects = [state.projects[0]];
    expect(() => spawnWorkerSession(getJob('tool-orch'), { title: 'x', prompt: 'x', tooling: true })).toThrow(
      /flagged as the dashboard itself/,
    );
  });

  it('createDevSession refuses a tooling fix that is not a worker', () => {
    expect(() =>
      createDevSession({ provider: 1, prompt: 'x', repo: 'acme/shop', toolingFor: 'acme/shop' }),
    ).toThrow(/worker session of some orchestrator/);
  });

  it('runs on the dashboard project’s worker runtime, ahead of the orchestration’s own pick', () => {
    // The shop's runtime says effort high, and so does the pick the
    // orchestration was started with; the dashboard's says low, and that is
    // the one a tooling fix resolves.
    getJob('tool-orch').workerRuntime = { providerId: 1, model: 'claude-fable-5-1', effort: 'high' };
    const w = spawnWorkerSession(getJob('tool-orch'), { title: 'Runtime', prompt: 'x', tooling: true });
    expect(resolveRuntime).toHaveBeenCalledWith(
      { providerId: 1, model: 'claude-fable-5-1', effort: 'low' },
      expect.anything(),
    );
    expect(w.effort).toBe('low');
  });

  it('falls back to the orchestration’s own pick when the dashboard project names no runtime', () => {
    state.projects[1] = { ...dashboard, workerProviderId: null };
    getJob('tool-orch').workerRuntime = { providerId: 1, model: 'claude-fable-5-1', effort: 'high' };
    const w = spawnWorkerSession(getJob('tool-orch'), { title: 'Runtime', prompt: 'x', tooling: true });
    expect(resolveRuntime).toHaveBeenCalledWith(
      { providerId: 1, model: 'claude-fable-5-1', effort: 'high' },
      expect.anything(),
    );
    expect(w.effort).toBe('high');
  });

  it('sends the worker to the dashboard project, review loop armed, briefed as a tooling fix', () => {
    const orch = getJob('tool-orch');
    const w = spawnWorkerSession(orch, {
      title: 'read_worker truncates',
      prompt: 'read_worker cut the tail at 40 entries even when asked for 200.',
      tooling: true,
    });

    expect(w.repo).toBe('acme/dashboard');
    expect(w.parentId).toBe('tool-orch');
    expect(w.toolingFor).toBe('acme/shop');
    expect(w.reviewLoop).not.toBeNull();
    expect(w.qaLoop).toBeNull();
    const first = getJob(w.id).events.find((e) => e.kind === 'user').text;
    expect(first).toMatch(/^This is a tooling fix/);
    expect(first).toContain('orchestrator on acme/shop');
    expect(first).toContain('# What the orchestrator reported\n\nread_worker cut the tail');
    // The supervisor's tools and chat both say which repository it went to.
    expect(workerSummary(w)).toMatchObject({ repo: 'acme/dashboard', toolingFor: 'acme/shop' });
    const info = orch.events.filter((e) => e.kind === 'info').map((e) => e.text);
    expect(info.at(-1)).toMatch(/^Started tooling-fix worker .* on acme\/dashboard, .*review loop armed\.$/);
  });

  it('a plain spawn is untouched: the orchestration’s own repository, nothing framed', () => {
    const w = spawnWorkerSession(getJob('tool-orch'), { title: 'Plain', prompt: 'Do the thing.' });
    expect(w.repo).toBe('acme/shop');
    expect(w.toolingFor).toBeNull();
    expect(w.reviewLoop).toBeNull();
    expect(getJob(w.id).events.find((e) => e.kind === 'user').text).toBe('Do the thing.');
    expect(workerSummary(w).toolingFor).toBeNull();
  });
});

describe('deliverWorkerNotices', () => {
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed', // restored as-is; flipped to idle below where a test needs it open
    repo: 'acme/notices',
    providerId: 1,
    turns: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    meta: {},
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('not-orch', {
        orchestrator: true,
        pendingWorkerNotices: [{ workerId: 'not-w1', kind: 'settled', text: 'Worker not-w1 finished.' }],
      }),
      row('not-held', {
        orchestrator: true,
        awaitingAnswer: true,
        pendingWorkerNotices: [{ workerId: 'not-w1', kind: 'settled', text: 'held' }],
      }),
      row('not-stale', {
        orchestrator: true,
        pendingWorkerNotices: [{ workerId: 'not-w1', kind: 'ask', text: 'answered already' }],
      }),
      row('not-w1', { parentId: 'not-orch', awaitingAnswer: false }),
      row('not-plain', {}),
    ];
    await initJobs();
    for (const id of ['not-orch', 'not-held', 'not-stale', 'not-w1']) getJob(id).status = 'idle';
  });

  it('a plain session is not delivered to, whatever rides on its record', () => {
    const plain = getJob('not-plain');
    plain.pendingWorkerNotices = [{ workerId: 'x', kind: 'settled', text: 'nope' }];
    deliverWorkerNotices(plain);
    expect(plain.pendingWorkerNotices).toHaveLength(1);
  });

  it('a free orchestrator takes the buffered updates as one injected turn', () => {
    const orch = getJob('not-orch');
    deliverWorkerNotices(orch);
    expect(orch.pendingWorkerNotices).toHaveLength(0);
    const user = orch.events.filter((e) => e.kind === 'user');
    expect(user).toHaveLength(1);
    expect(user[0].text).toContain('Worker not-w1 finished.');
  });

  it('an orchestrator standing on its own question holds the buffer', () => {
    const orch = getJob('not-held');
    deliverWorkerNotices(orch);
    expect(orch.pendingWorkerNotices).toHaveLength(1);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });

  it('a question notice whose worker no longer waits is dropped at delivery', () => {
    const orch = getJob('not-stale');
    deliverWorkerNotices(orch); // not-w1 has awaitingAnswer: false
    expect(orch.pendingWorkerNotices).toHaveLength(0);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });
});

describe('the unattended-turn breaker and the delivery holds', () => {
  const notice = (workerId, kind = 'settled', text = `update from ${workerId}`) => ({ workerId, kind, text });
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/breaker',
    providerId: 1,
    turns: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    meta: {},
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('brk-orch', {
        orchestrator: true,
        unattendedTurns: 10,
        pendingWorkerNotices: [notice('brk-w1')],
      }),
      row('brk-reset', { orchestrator: true, unattendedTurns: 7, unattendedSaid: true }),
      row('brk-stop', {
        orchestrator: true,
        turnCanceled: true,
        pendingWorkerNotices: [notice('brk-w1')],
      }),
      row('brk-gone', {
        orchestrator: true,
        pendingWorkerNotices: [notice('brk-closed'), notice('brk-deleted')],
      }),
      row('brk-w1', { parentId: 'brk-orch' }),
      row('brk-closed', { parentId: 'brk-gone' }), // stays closed
    ];
    await initJobs();
    for (const id of ['brk-orch', 'brk-reset', 'brk-stop', 'brk-gone', 'brk-w1']) getJob(id).status = 'idle';
  });

  it('past the cap, updates arrive as lines the user reads, not injected turns', () => {
    const orch = getJob('brk-orch');
    deliverWorkerNotices(orch);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
    const info = orch.events.filter((e) => e.kind === 'info').map((e) => e.text);
    expect(info.some((t) => t.includes('paused'))).toBe(true);
    expect(info.some((t) => t.includes('update from brk-w1'))).toBe(true);
    expect(orch.pendingWorkerNotices).toHaveLength(0);
    expect(orch.unattendedSaid).toBe(true);
  });

  it('a genuine user message re-arms the breaker; an injected one would not', () => {
    sendDevMessage('brk-reset', 'sigue');
    const orch = getJob('brk-reset');
    expect(orch.unattendedTurns).toBe(0);
    expect(orch.unattendedSaid).toBe(false);
  });

  it('■ Stop holds delivery: the next turn is the user’s, not an injected one', () => {
    const orch = getJob('brk-stop');
    deliverWorkerNotices(orch);
    expect(orch.pendingWorkerNotices).toHaveLength(1);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });

  it('updates for closed or deleted workers are dropped at delivery', () => {
    const orch = getJob('brk-gone');
    deliverWorkerNotices(orch); // brk-closed is closed, brk-deleted never existed
    expect(orch.pendingWorkerNotices).toHaveLength(0);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });
});

describe('the worker budget', () => {
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/shop',
    providerId: 1,
    turns: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    meta: {},
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('bud-orch', {
        orchestrator: true,
        costUsd: 5,
        inputTokens: 1000,
        outputTokens: 100,
        durationMs: 60_000,
      }),
      row('bud-w1', {
        parentId: 'bud-orch',
        costUsd: 2,
        inputTokens: 500,
        outputTokens: 50,
        durationMs: 30_000,
      }),
      row('bud-poor', {
        orchestrator: true,
        costUsd: 0.5,
        pendingWorkerNotices: [{ workerId: 'bud-w2', kind: 'settled', text: 'update from bud-w2' }],
      }),
      row('bud-w2', { parentId: 'bud-poor' }),
      // What a worker's review loop spends on its behalf: the review of its
      // push and the fix session that implements the findings.
      row('bud-rev', {
        loopParentId: 'bud-w1',
        costUsd: 1,
        inputTokens: 200,
        outputTokens: 20,
        durationMs: 10_000,
      }),
      row('bud-fix', { loopFixParentId: 'bud-w1', costUsd: 0.5, inputTokens: 100, durationMs: 5_000 }),
      // What the worker's QA loop spent; a session that never reported a
      // cost (a codex run, say) must not turn the total into a zero.
      row('bud-qa', { qaParentId: 'bud-w1', costUsd: null, inputTokens: 50, outputTokens: 5 }),
    ];
    await initJobs();
    for (const id of ['bud-orch', 'bud-w1', 'bud-poor', 'bud-w2']) getJob(id).status = 'idle';
  });

  it('orchestratorSpend sums the supervisor, every worker and its loops, unpriced turns as zero', () => {
    expect(orchestratorSpend(getJob('bud-orch'))).toBe(8.5);
    expect(orchestratorSpend(getJob('bud-poor'))).toBe(0.5);
  });

  it('the children index files each session under the one it ran for', () => {
    expect(childSessionsOf(getJob('bud-orch')).map((j) => j.id)).toEqual(['bud-w1']);
    expect(
      childSessionsOf(getJob('bud-w1'))
        .map((j) => j.id)
        .sort(),
    ).toEqual(['bud-fix', 'bud-qa', 'bud-rev']);
    expect(childSessionsOf(getJob('bud-rev'))).toEqual([]);
  });

  it('sessionUsage rolls tokens, time and cost up the whole tree, counting the sessions folded in', () => {
    expect(sessionUsage(getJob('bud-orch'))).toEqual({
      sessions: 4,
      costUsd: 8.5,
      inputTokens: 1850,
      outputTokens: 175,
      durationMs: 105_000,
    });
    // A worker's own rollup is its reviews, fix and QA run: what the task cost.
    expect(sessionUsage(getJob('bud-w1'))).toEqual({
      sessions: 3,
      costUsd: 3.5,
      inputTokens: 850,
      outputTokens: 75,
      durationMs: 45_000,
    });
    // Nothing under it and nothing reported: every measure stays null rather
    // than reading as a free session.
    expect(sessionUsage(getJob('bud-w2'))).toEqual({
      sessions: 0,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
    });
  });

  it('the wire record carries the rollup beside the session’s own figures', () => {
    const orch = publicJob(getJob('bud-orch'));
    expect(orch.costUsd).toBe(5); // its own turns
    expect(orch.usage).toEqual({
      sessions: 4,
      costUsd: 8.5,
      inputTokens: 1850,
      outputTokens: 175,
      durationMs: 105_000,
    });
    // The tool's worker line and its cost are the task's, loops included.
    expect(workerSummary(getJob('bud-w1')).costUsd).toBe(3.5);
  });

  it('spawn refuses once the orchestration spent its budget', () => {
    state.projects = [{ repo: 'acme/shop', label: 'Shop', localDir: '', workerBudgetUsd: 6 }];
    expect(() => spawnWorkerSession(getJob('bud-orch'), { title: 'x', prompt: 'x' })).toThrow(
      /spent \$8\.50 of its \$6\.00 budget/,
    );
  });

  it('past the budget, updates arrive as lines rather than injected turns', () => {
    state.projects = [{ repo: 'acme/shop', label: 'Shop', localDir: '', workerBudgetUsd: 0.25 }];
    const orch = getJob('bud-poor');
    deliverWorkerNotices(orch);
    expect(orch.events.filter((e) => e.kind === 'user')).toHaveLength(0);
    const info = orch.events.filter((e) => e.kind === 'info').map((e) => e.text);
    expect(info.some((t) => t.includes('$0.50 of its $0.25 budget'))).toBe(true);
    expect(info.some((t) => t.includes('update from bud-w2'))).toBe(true);
    expect(orch.pendingWorkerNotices).toHaveLength(0);
    expect(orch.budgetSaid).toBe(true);
  });
});

describe('workerSummary', () => {
  it('projects the fields a supervisor decides on, checks folded into one string', () => {
    const summary = workerSummary({
      id: 'w1',
      title: 'Fix the login',
      status: 'idle',
      awaitingAnswer: true,
      branch: 'dev-w1',
      provider: 'Cheap',
      model: 'claude-haiku-4-5',
      effort: 'low',
      turns: 2,
      costUsd: 0.5,
      lastText: 'Done.',
      createdAt: 't',
      error: null,
      prStatus: {
        number: 7,
        state: 'open',
        url: 'https://github.com/acme/shop/pull/7',
        checks: { passed: 2, failed: 0, pending: 1 },
      },
    });
    expect(summary).toMatchObject({
      id: 'w1',
      awaitingAnswer: true,
      branch: 'dev-w1',
      pr: { number: 7, state: 'open', checks: '✓2 ✗0 ●1' },
    });
    // The raw prStatus (commit lists, check runs) stays out: it is panel data,
    // not something a supervisor reads.
    expect(summary).not.toHaveProperty('prStatus');
  });

  it('a worker with no pull request answers pr: null', () => {
    expect(workerSummary({ id: 'w2', turns: 0 }).pr).toBeNull();
  });

  it('projects transient PR discovery failures and retry state', () => {
    const summary = workerSummary({
      id: 'w2',
      turns: 0,
      reviewLoop: {
        discoveryError: 'GitHub returned 503',
        discoveryRetries: 1,
      },
    });

    expect(summary.reviewLoop).toMatchObject({
      discoveryError: 'GitHub returned 503',
      discoveryRetries: 1,
      discoveryRetryPending: false,
    });
  });
});

describe('the by-id operations on ids nothing created', () => {
  it('dropQueuedMessage throws for an unknown session', () => {
    expect(() => dropQueuedMessage('nope', 0)).toThrow(/Session not found/);
  });

  it('cancelDevTurn answers null', () => {
    expect(cancelDevTurn('nope')).toBeNull();
  });

  it('closeDevSessionWithReason answers false: nothing was open', async () => {
    expect(await closeDevSessionWithReason('nope', 'because')).toBe(false);
  });
});

describe('closeDevSession on an unattended session', () => {
  const stored = (id, autoClose) => ({
    id,
    kind: 'devchat',
    status: 'closed', // restored as-is; holdsResources() would rewrite an open one
    repo: 'acme/shop',
    autoClose,
    turns: 1,
    meta: {},
  });

  beforeAll(async () => {
    // Both start closed so the close below has something to do, flipped after
    // the restore, which would otherwise mark an open session interrupted.
    state.stored = [stored('auto-1', true), stored('hand-1', false)];
    await initJobs();
    for (const id of ['auto-1', 'hand-1']) getJob(id).status = 'idle';
  });

  it('closing an auto-close session trashes its record too', async () => {
    await closeDevSession('auto-1');
    expect(deleteJob).toHaveBeenCalledWith('auto-1', null);
    expect(getJob('auto-1')).toBeNull();
  });

  it('a session somebody started by hand keeps its conversation', async () => {
    const closed = await closeDevSession('hand-1');
    expect(closed.status).toBe('closed');
    expect(deleteJob).not.toHaveBeenCalledWith('hand-1');
    expect(getJob('hand-1')).not.toBeNull();
  });

  it('hands the session database back along with the server and the clone', async () => {
    expect(dropSessionDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hand-1' }),
      expect.any(Function),
    );
  });
});

describe('deleting a session that was never closed', () => {
  beforeAll(async () => {
    state.stored = [
      {
        id: 'undropped-1',
        kind: 'devchat',
        status: 'failed',
        repo: 'acme/shop',
        turns: 1,
        sessionDb: 'shop_undropped_1',
        meta: {},
      },
    ];
    await initJobs();
  });

  // A session that died during setup never reaches closeDevSession, and its
  // record is the only thing that knows the database's name.
  it('drops its database before the record goes', async () => {
    await deleteJobById('undropped-1');

    expect(dropSessionDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'undropped-1', sessionDb: 'shop_undropped_1' }),
    );
    expect(deleteJob).toHaveBeenCalledWith('undropped-1', null);
  });
});

describe('closeDevSession folding a deleted loop session’s cost into its parent', () => {
  // Its own repo, so these restored rows never match the registry sweeps other
  // describes make. The parents carry no reviewLoop/qaLoop on purpose: the
  // close-report paths return early, leaving only the cost fold to observe.
  const row = (id, extra) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/cost',
    turns: 1,
    meta: {},
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('cost-par-1', { costUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 20_000 }),
      row('cost-rev-1', {
        autoClose: true,
        loopParentId: 'cost-par-1',
        costUsd: 0.5,
        inputTokens: 300,
        outputTokens: 30,
        durationMs: 5_000,
      }),
      row('cost-par-2', {}),
      row('cost-qa-2', { autoClose: true, qaParentId: 'cost-par-2', costUsd: 0.75 }),
      row('cost-par-3', { costUsd: 2 }),
      row('cost-rev-3', { autoClose: true, loopParentId: 'cost-par-3', costUsd: null }),
      row('cost-par-4', { costUsd: 1 }),
      row('cost-rev-4', { autoClose: true, loopParentId: 'cost-par-4', costUsd: 0.5 }),
      row('cost-par-5', { costUsd: 3 }),
      row('cost-rev-5', { autoClose: true, loopParentId: 'cost-par-5', costUsd: 0.5 }),
      row('cost-par-6', { costUsd: 1 }),
      row('cost-fix-6', { autoClose: true, loopFixParentId: 'cost-par-6', costUsd: 0.5 }),
    ];
    await initJobs();
    for (const j of state.stored) getJob(j.id).status = 'idle';
  });

  it("a deleted loop review's spend lands on the session it reviewed for", async () => {
    // Live, the review is already in the parent's rollup; deleting it must
    // leave that number where it stood.
    const before = sessionUsage(getJob('cost-par-1'));
    expect(before).toEqual({
      sessions: 1,
      costUsd: 1.75,
      inputTokens: 1300,
      outputTokens: 130,
      durationMs: 25_000,
    });
    await closeDevSession('cost-rev-1');
    expect(getJob('cost-rev-1')).toBeNull();
    const parent = getJob('cost-par-1');
    expect(sessionUsage(parent)).toEqual(before);
    expect(childSessionsOf(parent)).toEqual([]);
    // Into the absorbed fields, beside the parent's own figures, which stay
    // what its own turns consumed (codex rewrites them from its thread's
    // accounting after every turn, so a fold added into them would not last).
    expect(parent.costUsd).toBe(1.25);
    expect(parent.inputTokens).toBe(1000);
    expect(parent).toMatchObject({
      absorbedSessions: 1,
      absorbedCostUsd: 0.5,
      absorbedInputTokens: 300,
      absorbedOutputTokens: 30,
      absorbedDurationMs: 5_000,
    });
    // The durable copy rides the delete itself: one transaction, so a crash
    // cannot commit the delete and lose the transfer, and a parent loaded out
    // of the restore window is still paid.
    expect(deleteJob).toHaveBeenCalledWith('cost-rev-1', {
      intoJobId: 'cost-par-1',
      sessions: 1,
      costUsd: 0.5,
      inputTokens: 300,
      outputTokens: 30,
      durationMs: 5_000,
    });
  });

  it('a deleted QA run pays into a parent that had no cost of its own yet', async () => {
    await closeDevSession('cost-qa-2');
    expect(getJob('cost-qa-2')).toBeNull();
    expect(sessionUsage(getJob('cost-par-2')).costUsd).toBe(0.75);
    expect(publicJob(getJob('cost-par-2')).usage.costUsd).toBe(0.75);
  });

  it("a deleted fix session's cost lands on the session whose loop it fixed for", async () => {
    await closeDevSession('cost-fix-6');
    expect(getJob('cost-fix-6')).toBeNull();
    expect(sessionUsage(getJob('cost-par-6')).costUsd).toBe(1.5);
  });

  it("a session that reported nothing leaves the parent's number alone", async () => {
    await closeDevSession('cost-rev-3');
    expect(getJob('cost-rev-3')).toBeNull();
    expect(sessionUsage(getJob('cost-par-3'))).toMatchObject({ sessions: 0, costUsd: 2 });
    expect(deleteJob).toHaveBeenCalledWith('cost-rev-3', null);
  });

  it('a delete the database refused does not count the same dollars twice', async () => {
    deleteJob.mockRejectedValueOnce(new Error('nope'));
    await closeDevSession('cost-rev-4');
    expect(getJob('cost-rev-4')).not.toBeNull(); // the record survived, cost and all
    expect(getJob('cost-par-4').absorbedCostUsd).toBeUndefined();
    expect(sessionUsage(getJob('cost-par-4')).costUsd).toBe(1.5); // still live under it
  });

  it('the hand-delete retry after a refused auto-delete still folds the cost', async () => {
    // The DELETE route calls deleteJobById directly on the already-closed row;
    // the fold lives there, so this path pays the parent like the first meant to.
    await deleteJobById('cost-rev-4');
    expect(getJob('cost-rev-4')).toBeNull();
    expect(getJob('cost-par-4').absorbedCostUsd).toBe(0.5);
    expect(sessionUsage(getJob('cost-par-4')).costUsd).toBe(1.5);
  });

  it('a delete whose row a racing close already removed does not fold again', async () => {
    deleteJob.mockResolvedValueOnce(0); // zero affected rows: the other close won
    await closeDevSession('cost-rev-5');
    expect(getJob('cost-rev-5')).toBeNull();
    expect(getJob('cost-par-5').absorbedCostUsd).toBeUndefined();
    expect(sessionUsage(getJob('cost-par-5')).costUsd).toBe(3);
  });

  it('a deleted worker hands its orchestrator everything it had absorbed and still had under it', async () => {
    // bud-w1 (from the budget suite above) already carries a live review, fix
    // and QA run; deleting the worker moves that whole subtree's spend up in
    // one fold, so the orchestrator's number does not move.
    const orch = getJob('bud-orch');
    const before = sessionUsage(orch);
    getJob('bud-w1').status = 'closed'; // the budget suite flipped it to idle
    await deleteJobById('bud-w1');
    expect(getJob('bud-w1')).toBeNull();
    expect(orch.absorbedSessions).toBe(4);
    expect(sessionUsage(orch)).toEqual(before);
    expect(orchestratorSpend(orch)).toBe(8.5);
  });
});

describe('the review loop: what a closing loop review reports back', () => {
  // Its own repo and PR number, so these restored rows never match the
  // registry sweeps other describes make over acme/shop.
  const parentRow = (id, reviewId, loop = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/loop',
    turns: 1,
    // What startLoopFixSession spawns with. acme/loop is deliberately not in
    // state.projects, so every spawn attempt fails on "Unknown project" and
    // leaves its trace as an info event: the attempt is what these tests
    // observe, the success path stays untested like every other spawn.
    providerId: 1,
    branch: 'task/loop',
    startedOnPr: 77,
    prStatus: { number: 77, state: 'open' },
    reviewLoop: { rounds: 1, reviewing: true, reviewSessionId: reviewId, lastSha: 'abc', ...loop },
  });
  const reviewRow = (id, parentId, done) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/loop',
    turns: 1,
    createdAt: '2026-08-25T13:00:00.000Z',
    loopParentId: parentId,
    loopReviewDone: done,
  });

  beforeAll(async () => {
    state.stored = [
      parentRow('par-1', 'rev-1'),
      reviewRow('rev-1', 'par-1', false),
      parentRow('par-2', 'rev-2'),
      reviewRow('rev-2', 'par-2', true),
      parentRow('par-3', 'rev-3'),
      reviewRow('rev-3', 'par-3', true),
      parentRow('par-4', 'rev-4'),
      reviewRow('rev-4', 'par-4', true),
      parentRow('par-5', 'rev-5'),
      reviewRow('rev-5', 'par-5', true),
      parentRow('par-6', 'rev-6'),
      reviewRow('rev-6', 'par-6', true),
      parentRow('par-7', 'rev-7'),
      reviewRow('rev-7', 'par-7', true),
      // Two rounds deep, each with the round before it on record: par-8 is
      // handed the same findings again, par-9 different ones.
      parentRow('par-8', 'rev-8', { rounds: 2, lastFindings: 'k1' }),
      reviewRow('rev-8', 'par-8', true),
      parentRow('par-9', 'rev-9', { rounds: 2, lastFindings: 'k1' }),
      reviewRow('rev-9', 'par-9', true),
      // On the last round the cap allows, with a round before it that found
      // something else, so nothing but the cap can stop it.
      parentRow('par-10', 'rev-10', { rounds: 3, lastFindings: 'k0' }),
      reviewRow('rev-10', 'par-10', true),
      // Past round one, which is where lows stop re-opening the loop.
      parentRow('par-11', 'rev-11', { rounds: 2, lastFindings: 'k0' }),
      reviewRow('rev-11', 'par-11', true),
      // Two rounds whose findings GitHub does not hand over on the first ask:
      // par-15's read comes back on a retry, par-16's never does.
      parentRow('par-15', 'rev-15'),
      reviewRow('rev-15', 'par-15', true),
      {
        ...parentRow('par-16', 'rev-16'),
        parentId: 'loop-orch',
        title: 'Delete the custom field',
        createdAt: '2026-08-25T12:33:00.000Z',
      },
      reviewRow('rev-16', 'par-16', true),
      // A third: its read fails the same way, and then its session is closed.
      parentRow('par-17', 'rev-17'),
      reviewRow('rev-17', 'par-17', true),
      // Two workers of an orchestrator: their loops' verdicts are its to act
      // on. It stands on a question of its own, so the updates are held in
      // its buffer where the tests can read them instead of being spent on
      // an injected turn.
      {
        id: 'loop-orch',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/loop',
        providerId: 1,
        turns: 1,
        createdAt: '2026-08-25T12:00:00.000Z',
        orchestrator: true,
        awaitingAnswer: true,
      },
      {
        ...parentRow('par-12', 'rev-12'),
        parentId: 'loop-orch',
        title: 'Add the export',
        createdAt: '2026-08-25T12:30:00.000Z',
      },
      reviewRow('rev-12', 'par-12', true),
      {
        ...parentRow('par-13', 'rev-13', { rounds: 2, lastFindings: 'k1' }),
        parentId: 'loop-orch',
        title: 'Fix the filter',
        createdAt: '2026-08-25T12:31:00.000Z',
      },
      reviewRow('rev-13', 'par-13', true),
      // A third on its last allowed round: the cap stands ahead of the triage.
      {
        ...parentRow('par-14', 'rev-14', { rounds: 3, lastFindings: 'k0' }),
        parentId: 'loop-orch',
        title: 'Add the import',
        createdAt: '2026-08-25T12:32:00.000Z',
      },
      reviewRow('rev-14', 'par-14', true),
    ];
    await initJobs();
    for (const id of [
      'loop-orch',
      'par-12',
      'rev-12',
      'par-13',
      'rev-13',
      'par-14',
      'rev-14',
      'par-1',
      'rev-1',
      'par-2',
      'rev-2',
      'par-3',
      'rev-3',
      'par-4',
      'rev-4',
      'par-5',
      'rev-5',
      'par-6',
      'rev-6',
      'par-7',
      'rev-7',
      'par-8',
      'rev-8',
      'par-9',
      'rev-9',
      'par-10',
      'rev-10',
      'par-11',
      'rev-11',
      'par-15',
      'rev-15',
      'par-16',
      'rev-16',
      'par-17',
      'rev-17',
    ]) {
      getJob(id).status = 'idle';
    }
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);
  // The report a closing review files is fire-and-forget, and a round whose
  // findings read failed retries inside it, so these wait on the state rather
  // than on a fixed number of ticks.
  const waitFor = async (cond) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the loop never reached the expected state');
  };

  it('a review stopped mid-way releases the loop without a fix turn', async () => {
    await closeDevSession('rev-1');
    await new Promise((r) => setTimeout(r, 0)); // the report is fire-and-forget
    const parent = getJob('par-1');
    expect(parent.reviewLoop.reviewing).toBe(false);
    expect(infoTexts(parent).join('\n')).toMatch(/stopped before it finished/);
    // A round that published nothing approved nothing: recorded as a round
    // that could not run, which is what a retry (and list_workers) reads.
    expect(parent.reviewLoop.failure).toMatchObject({
      round: 1,
      reason: 'the code review closed before it published anything',
    });
    expect(workerSummary(parent).reviewLoop).toMatchObject({
      done: false,
      failure: { round: 1, reason: 'the code review closed before it published anything' },
    });
  });

  it('a finished review that declared no findings ends the round cleanly', async () => {
    await closeDevSession('rev-2');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('par-2');
    expect(parent.reviewLoop.reviewing).toBe(false);
    expect(infoTexts(parent).join('\n')).toMatch(/declared no findings/);
    // Scoped to what this review itself could have posted, so a round that
    // published nothing does not hand back the previous round's findings.
    expect(latestReviewFindings).toHaveBeenCalledWith('acme/loop', 77, {
      since: '2026-08-25T13:00:00.000Z',
    });
  });

  it('findings go to a fix session even while the session stands on a question', async () => {
    const parent = getJob('par-3');
    parent.awaitingAnswer = true;
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k1', severity: 'high', title: 'A thing' }]);
    await closeDevSession('rev-3');
    await new Promise((r) => setTimeout(r, 0));
    // The fix runs in a session of its own, so nothing is held back and no
    // turn is fired at the question card.
    expect(parent.reviewLoop.pendingFix).toBeFalsy();
    expect(parent.awaitingAnswer).toBe(true); // the question card is still the user's to answer
    expect(parent.status).toBe('idle'); // no turn was started behind it
    expect(infoTexts(parent).join('\n')).toMatch(/could not start the fix session/);
  });

  it("lists the round's findings as required fixes so the fix session can mark them solved", async () => {
    const found = [{ key: 'k1', severity: 'high', title: 'A thing' }];
    latestReviewFindings.mockResolvedValueOnce(found);
    await closeDevSession('rev-4');
    await new Promise((r) => setTimeout(r, 0));
    // Round one takes everything a review found; the floor only tightens later.
    expect(queueFindingsForFix).toHaveBeenCalledWith('acme/loop', 77, found, { severityFloor: 'low' });
  });

  it('sends nothing back when every finding was already dismissed by hand', async () => {
    const parent = getJob('par-5');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k1', severity: 'high', title: 'A thing' }]);
    queueFindingsForFix.mockResolvedValueOnce({ kept: [], parked: [], error: null });
    await closeDevSession('rev-5');
    await new Promise((r) => setTimeout(r, 0));
    expect(parent.status).toBe('idle');
    expect(infoTexts(parent).join('\n')).toMatch(/none of them for this loop to implement/);
  });

  it('implements the whole round when even the stored verdicts cannot be read', async () => {
    const parent = getJob('par-6');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k1', severity: 'high', title: 'A thing' }]);
    queueFindingsForFix.mockRejectedValueOnce(new Error('database is away'));
    await closeDevSession('rev-6');
    await new Promise((r) => setTimeout(r, 0));
    const text = infoTexts(parent).join('\n');
    expect(text).toMatch(/could not read this pull request's finding verdicts/);
    expect(text).toMatch(/could not start the fix session/); // the round is not dropped
  });

  it('starts no fix session for a pull request that closed during the checklist write', async () => {
    const parent = getJob('par-7');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k1', severity: 'high', title: 'A thing' }]);
    queueFindingsForFix.mockImplementationOnce(async (repo, prNumber, findings) => {
      parent.prStatus = { number: 77, state: 'closed' }; // merged while the write was out
      return { kept: findings, parked: [], error: null };
    });
    await closeDevSession('rev-7');
    await new Promise((r) => setTimeout(r, 0));
    expect(parent.status).toBe('idle');
    expect(parent.reviewLoop.fixing).toBeFalsy();
    expect(infoTexts(parent).join('\n')).not.toMatch(/fix session/);
  });

  it('stops the loop when a round repeats the findings of the round before it', async () => {
    const parent = getJob('par-8');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k1', severity: 'high', title: 'A thing' }]);
    await closeDevSession('rev-8');
    await new Promise((r) => setTimeout(r, 0));
    expect(parent.reviewLoop.stalled).toBe(true);
    expect(parent.reviewLoop.fixing).toBeFalsy(); // no fix session to push another commit with
    expect(parent.status).toBe('idle');
    expect(infoTexts(parent).join('\n')).toMatch(/same 1 finding\(s\) as the round before it/);
  });

  it('a round that found something new goes to a fix session and becomes the next comparison', async () => {
    const parent = getJob('par-9');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k2', severity: 'high', title: 'Another' }]);
    await closeDevSession('rev-9');
    await new Promise((r) => setTimeout(r, 0));
    expect(parent.reviewLoop.stalled).toBeFalsy(); // restored rows carry no flag until one is set
    expect(parent.reviewLoop.lastFindings).toBe('k2');
    expect(infoTexts(parent).join('\n')).toMatch(/could not start the fix session/); // the spawn was attempted
  });

  // The gate the stall check cannot make: a loop reviewing the code its own
  // fixes introduced finds something different every round, so it never runs
  // dry and never repeats itself.
  it('stops at the round cap even when the round found something new', async () => {
    const parent = getJob('par-10');
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k9', severity: 'high', title: 'Yet another' }]);
    await closeDevSession('rev-10');
    await new Promise((r) => setTimeout(r, 0));
    expect(parent.reviewLoop.stalled).toBe(true);
    expect(parent.reviewLoop.fixing).toBeFalsy(); // no fix session, so no round 4
    expect(infoTexts(parent).join('\n')).toMatch(/REVIEW_LOOP_MAX_ROUNDS=3/);
  });

  it('stops asking for lows once the loop is past its first round', async () => {
    const parent = getJob('par-11');
    const found = [{ key: 'k1', severity: 'low', title: 'A nit' }];
    latestReviewFindings.mockResolvedValueOnce(found);
    queueFindingsForFix.mockResolvedValueOnce({
      kept: [],
      parked: [{ ...found[0], reason: 'severity' }],
      error: null,
    });
    await closeDevSession('rev-11');
    await new Promise((r) => setTimeout(r, 0));
    expect(queueFindingsForFix).toHaveBeenCalledWith('acme/loop', 77, found, {
      severityFloor: 'medium',
    });
    // Recorded on the pull request and said out loud, but not implemented.
    expect(parent.reviewLoop.fixing).toBeFalsy();
    expect(infoTexts(parent).join('\n')).toMatch(/A nit \(below the floor\)/);
  });

  // The failure the loop used to swallow: the review had finished and
  // published, and one failing GitHub call afterwards dropped the round on the
  // floor, leaving the loop reading as "waiting for a push" with nobody told.
  it('a round whose findings GitHub refuses once still converges', async () => {
    const parent = getJob('par-15');
    latestReviewFindings.mockRejectedValueOnce(new Error('GitHub answered 403 listing PR #77 comments'));
    await closeDevSession('rev-15');
    await waitFor(() => parent.reviewLoop.done);
    expect(parent.reviewLoop.pendingResult).toBeNull(); // the round is settled, nothing left to retry
    expect(infoTexts(parent).join('\n')).toMatch(/review round 1 declared no findings/);
  });

  it('a round GitHub keeps refusing stays the loop’s next step, and says so to the orchestrator', async () => {
    const parent = getJob('par-16');
    // Every attempt inside one resolve, so the round is left pending.
    for (let i = 0; i < 3; i++) {
      latestReviewFindings.mockRejectedValueOnce(new Error('GitHub answered 502 listing PR #77 comments'));
    }
    await closeDevSession('rev-16');
    await waitFor(() => !!parent.reviewLoop.pendingResult && parent.reviewLoop.pendingResult.said);
    // The review's own outcome is on record: the round did happen, it is not
    // reopened by a new review, and it is not a loop waiting for a push.
    expect(parent.reviewLoop.pendingResult).toMatchObject({ prNumber: 77, round: 1 });
    expect(parent.reviewLoop.done).toBeFalsy(); // restored rows carry no flag until one is set
    expect(parent.reviewLoop.reviewing).toBe(false);
    expect(parent.reviewLoop.rounds).toBe(1);
    expect(infoTexts(parent).join('\n')).toMatch(/round 1's findings.*The round is not lost/s);
    expect(workerSummary(parent).reviewLoop).toMatchObject({
      rounds: 1,
      awaitingResult: true,
      done: false,
    });
    // And the next resolve waits: the sync tick fires every 20s, and without
    // this the retry would be three GitHub requests per tick per session.
    expect(parent.reviewLoop.pendingResult.attempts).toBe(1);
    expect(Date.parse(parent.reviewLoop.pendingResult.nextRetryAt)).toBeGreaterThan(Date.now());
    expect(parent.reviewLoop.pendingResult.failingSince).toBeTruthy();
  });

  it('closing the session drops the round nobody could read', async () => {
    const parent = getJob('par-17');
    for (let i = 0; i < 3; i++) {
      latestReviewFindings.mockRejectedValueOnce(new Error('GitHub answered 502 listing PR #77 comments'));
    }
    await closeDevSession('rev-17');
    await waitFor(() => !!parent.reviewLoop.pendingResult && parent.reviewLoop.pendingResult.said);
    await closeDevSession('par-17');
    // Nothing is owed to a closed session, and a reopen days later must not
    // fire a fix session for a review that ran before the close.
    expect(parent.reviewLoop.pendingResult).toBeNull();
    expect(infoTexts(parent).join('\n')).toMatch(/dropped with this close/);
  });

  it('a plain session’s converged loop is nobody else’s business', async () => {
    // par-2 converged above and files under no orchestrator: nothing was
    // queued anywhere (the buffer only ever exists on a parent).
    expect(getJob('par-2').pendingWorkerNotices).toBeUndefined();
  });

  it('a worker’s converged loop reaches its orchestrator as a merge cue', async () => {
    await closeDevSession('rev-12');
    await new Promise((r) => setTimeout(r, 0));
    const orch = getJob('loop-orch');
    const notice = orch.pendingWorkerNotices.find((n) => n.workerId === 'par-12');
    expect(notice.kind).toBe('loop');
    expect(notice.text).toMatch(/^Worker par-12 \(Add the export\): the review loop converged on PR #77/);
    expect(notice.text).toMatch(/declared no findings/);
    expect(notice.text).toMatch(/ready to merge/);
  });

  it('a worker’s review goes directly to the fix step without orchestrator triage', async () => {
    const findings = [{ key: 'new-key', severity: 'high', title: 'A new issue' }];
    latestReviewFindings.mockResolvedValueOnce(findings);
    queueFindingsForFix.mockResolvedValueOnce({ kept: findings, parked: [] });
    const recorded = recordTriage.mock.calls.length;
    await closeDevSession('rev-13');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('par-13');
    expect(parent.reviewLoop.triage).toBeFalsy();
    expect(parent.reviewLoop.lastFindings).toBe('new-key');
    expect(queueFindingsForFix).toHaveBeenLastCalledWith('acme/loop', 77, findings, {
      severityFloor: 'medium',
    });
    expect(recordTriage.mock.calls.length).toBe(recorded);
    expect(
      getJob('loop-orch').pendingWorkerNotices.some((n) => n.workerId === 'par-13' && n.kind === 'triage'),
    ).toBe(false);
  });

  it('the round cap still stops a worker’s loop without orchestrator triage', async () => {
    latestReviewFindings.mockResolvedValueOnce([{ key: 'k9', severity: 'high', title: 'Yet another' }]);
    await closeDevSession('rev-14');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('par-14');
    expect(parent.reviewLoop.stalled).toBe(true);
    expect(parent.reviewLoop.triage).toBeFalsy(); // restored rows carry no field until one is set
    const orch = getJob('loop-orch');
    const notice = orch.pendingWorkerNotices.find((n) => n.workerId === 'par-14');
    expect(notice.text).toMatch(/^Worker par-14 \(Add the import\): the review loop stalled on PR #77/);
    expect(notice.text).toMatch(/REVIEW_LOOP_MAX_ROUNDS=3/);
    expect(notice.text).toMatch(/1 finding\(s\) listed on the pull request: Yet another\./);
    expect(notice.text).toMatch(/do not waive findings or restart the loop automatically/);
  });
});

// The way out of a pending round: a read that fails for a rate limit comes
// back within the minute, but a rotated token, a lost scope or a deleted pull
// request never does, and the round must not hold the loop for good.
describe('the review loop: a pending round that is past giving up on', () => {
  // A worker restored mid-outage: the round finished, published, and its
  // findings have not been readable since. `pending` says how long that has
  // been going on and which pull request it is on.
  const workerRow = (id, prNumber, pending) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/stuck',
    providerId: 1,
    turns: 1,
    branch: `task/stuck-${prNumber}`,
    startedOnPr: prNumber,
    parentId: 'stuck-orch',
    title: 'Wire the export',
    createdAt: '2026-08-25T12:30:00.000Z',
    reviewLoop: {
      rounds: 1,
      reviewing: false,
      lastSha: `sha${prNumber}`,
      pendingResult: {
        prNumber,
        round: 1,
        since: null,
        said: true,
        attempts: 9,
        error: 'GitHub answered 401 listing PR comments',
        nextRetryAt: '2026-08-25T12:35:00.000Z',
        ...pending,
      },
    },
  });
  // Failing since long before the deadline, and failing for less than it.
  const ancient = '2026-08-25T12:31:00.000Z';
  let recent;

  beforeAll(async () => {
    recent = new Date(Date.now() - 29 * 60_000).toISOString();
    state.stored = [
      {
        id: 'stuck-orch',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/stuck',
        providerId: 1,
        turns: 1,
        createdAt: '2026-08-25T12:00:00.000Z',
        orchestrator: true,
        awaitingAnswer: true, // so the update lands in the buffer the test reads
      },
      workerRow('stuck-1', 79, { failingSince: ancient }),
      workerRow('stuck-2', 80, { failingSince: ancient }),
      workerRow('stuck-3', 81, { failingSince: ancient }),
      workerRow('stuck-4', 82, { failingSince: recent }),
    ];
    await initJobs();
    for (const id of ['stuck-orch', 'stuck-1', 'stuck-2', 'stuck-3', 'stuck-4']) getJob(id).status = 'idle';
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      const m = /^\/repos\/acme\/stuck\/pulls\/(\d+)$/.exec(url);
      if (m) {
        const number = Number(m[1]);
        return {
          ok: true,
          json: async () => ({
            number,
            html_url: `https://github.com/acme/stuck/pull/${number}`,
            // PR #81 was closed while nobody could read the round off it.
            state: number === 81 ? 'closed' : 'open',
            head: { ref: `task/stuck-${number}`, sha: `sha${number}` },
            base: { ref: 'main' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });

  const waitFor = async (cond) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the loop never reached the expected state');
  };

  // The sync tick's own path into the round: the branch event mirrors the pull
  // request, and the settle behind it drains the pending round.
  const nudge = (prNumber) => syncSessionsOn('acme/stuck', `task/stuck-${prNumber}`);
  const refuse = (n, message = 'GitHub answered 401 listing PR comments') => {
    for (let i = 0; i < n; i++) latestReviewFindings.mockRejectedValueOnce(new Error(message));
  };

  it('stalls the loop instead of holding the round for ever', async () => {
    const parent = getJob('stuck-1');
    refuse(3); // every attempt inside the one resolve
    nudge(79);
    await waitFor(() => parent.reviewLoop.stalled);
    // The round is no longer the loop's next step, so a later push starts a
    // fresh one instead of finding the loop wedged here.
    expect(parent.reviewLoop.pendingResult).toBeNull();
    const text = infoTexts(parent).join('\n');
    expect(text).toMatch(/could not be read off PR #79 for 30 minutes/);
    expect(text).toMatch(/GitHub answered 401/); // what the last attempt said
    // And the orchestrator is told, the way every other stall tells it.
    const notice = getJob('stuck-orch').pendingWorkerNotices.find((n) => n.workerId === 'stuck-1');
    expect(notice.kind).toBe('loop');
    expect(notice.text).toMatch(/the review loop stalled on PR #79/);
    expect(notice.text).toMatch(/judge it by hand/);
  });

  // The deadline is judged on a read that just failed, never on the clock
  // alone: a round pending across a restart (markInterrupted) or a failed turn
  // has nothing retrying it in the meantime, and the read GitHub would now
  // answer must be made before the round is given up on.
  it('asks GitHub once more before it gives up on a round', async () => {
    const parent = getJob('stuck-2');
    nudge(80); // the default mock answers: no findings
    await waitFor(() => parent.reviewLoop.done);
    expect(latestReviewFindings).toHaveBeenCalledWith('acme/stuck', 80, { since: null });
    expect(parent.reviewLoop.pendingResult).toBeNull();
    expect(parent.reviewLoop.stalled).toBeFalsy();
    expect(infoTexts(parent).join('\n')).toMatch(/review round 1 declared no findings/);
    expect(
      getJob('stuck-orch').pendingWorkerNotices.some(
        (n) => n.workerId === 'stuck-2' && /stalled/.test(n.text),
      ),
    ).toBe(false);
  });

  // Nothing is owed to a pull request that was merged or closed during the
  // outage: no round to judge, so no stall and no orchestrator turn.
  it('drops the round quietly when the pull request is no longer open', async () => {
    const parent = getJob('stuck-3');
    refuse(3);
    nudge(81);
    await waitFor(() => parent.reviewLoop.pendingResult === null);
    expect(parent.reviewLoop.stalled).toBeFalsy();
    expect(infoTexts(parent).join('\n')).not.toMatch(/could not be read off PR #81 for 30 minutes/);
    expect(getJob('stuck-orch').pendingWorkerNotices.some((n) => n.workerId === 'stuck-3')).toBe(false);
  });

  // The failure this whole pending state exists for: GitHub's core budget
  // resets on a fixed hourly window, so its cooldown routinely outlasts the
  // 30-minute deadline. Those attempts never reach the network, so they cost
  // the round neither an attempt nor a minute of its deadline.
  it('parks on the rate limit’s own reset without spending the deadline', async () => {
    const parent = getJob('stuck-4');
    const retryAt = Date.now() + 50 * 60_000; // past the deadline, as a core reset can be
    const limited = new Error('GitHub core rate limit exhausted, backing off until 3:00:00 PM');
    limited.rateLimited = true;
    limited.retryAt = retryAt;
    latestReviewFindings.mockRejectedValueOnce(limited);
    const before = latestReviewFindings.mock.calls.length;
    nudge(82);
    await waitFor(() => parent.reviewLoop.pendingResult.nextRetryAt !== '2026-08-25T12:35:00.000Z');
    const pending = parent.reviewLoop.pendingResult;
    // The round is still the loop's next step, retried when the limit lifts.
    expect(pending).toMatchObject({ prNumber: 82, round: 1 });
    expect(parent.reviewLoop.stalled).toBeFalsy();
    expect(pending.nextRetryAt).toBe(new Date(retryAt).toISOString());
    // Not counted: no attempt spent on the backoff, and the deadline's clock
    // pushed forward by the wait, so the round survives the whole cooldown.
    expect(pending.attempts).toBe(9);
    expect(Date.parse(pending.failingSince) - Date.parse(recent)).toBeGreaterThan(45 * 60_000);
    // And a local cooldown is not retried twice more inside the same resolve.
    expect(latestReviewFindings.mock.calls.length - before).toBe(1);
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);
});

// The failure a rate-limit backoff used to not survive: the process that owns
// the retry (the sync tick) restarts mid-backoff, and restoreFromDb marks the
// session `interrupted` rather than leaving it `idle`. The read needs none of
// the session's own resources, only the persisted round on the pull request,
// so the retry must not depend on the session looking like a live one.
describe('the review loop: a pending round outlives the process that started its backoff', () => {
  it('resumes a pending round on an interrupted (restarted) session, not just an idle one', async () => {
    vi.useFakeTimers();
    latestReviewFindings.mockClear();
    state.stored = [
      {
        id: 'restart-par-1',
        kind: 'devchat',
        // idle, not closed: restoreFromDb only marks a session interrupted
        // (holdsResources) when it was still holding its clone/database claim,
        // exactly the restart this loop must survive.
        status: 'idle',
        repo: 'acme/restart',
        turns: 1,
        branch: 'task/restart-1',
        startedOnPr: 90,
        prStatus: { number: 90, state: 'open' },
        dbServerId: 9,
        dbHost: 'db-host',
        dbPort: 3306,
        reviewLoop: {
          rounds: 1,
          reviewing: false,
          pendingResult: {
            prNumber: 90,
            round: 1,
            since: null,
            said: true,
            attempts: 1,
            failingSince: '2026-08-25T12:31:00.000Z',
            nextRetryAt: new Date(0).toISOString(),
          },
        },
      },
    ];
    latestReviewFindings.mockResolvedValueOnce([]);
    await initJobs();
    const parent = getJob('restart-par-1');
    // The real restart transition (restoreFromDb -> markInterrupted), not a
    // hand-set status: it is what actually clears the database claim and
    // leaves the session `interrupted`.
    expect(parent.status).toBe('interrupted');
    expect(parent.dbServerId).toBeNull();
    expect(parent.error).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestReviewFindings).toHaveBeenCalledWith('acme/restart', 90, { since: null });
    expect(parent.reviewLoop.pendingResult).toBeNull();
    expect(parent.reviewLoop.done).toBe(true);
    vi.useRealTimers();
  });

  it('still drops the round once the session is actually closed, not merely interrupted', async () => {
    vi.useFakeTimers();
    latestReviewFindings.mockClear();
    state.stored = [
      {
        id: 'restart-par-2',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/restart',
        turns: 1,
        branch: 'task/restart-2',
        startedOnPr: 91,
        prStatus: { number: 91, state: 'open' },
        reviewLoop: {
          rounds: 1,
          reviewing: false,
          pendingResult: {
            prNumber: 91,
            round: 1,
            since: null,
            said: true,
            attempts: 1,
            failingSince: '2026-08-25T12:31:00.000Z',
            nextRetryAt: new Date(0).toISOString(),
          },
        },
      },
    ];
    await initJobs();
    const parent = getJob('restart-par-2');
    // Left as the restore found it: genuinely closed, so nobody is owed this
    // round and the tick must not spend a GitHub call retrying it.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestReviewFindings).not.toHaveBeenCalled();
    expect(parent.reviewLoop.pendingResult).not.toBeNull();
    vi.useRealTimers();
  });
});

// Retrying a round/verdict read across interrupted/failed (rather than
// dropping it the moment DEV_OPEN no longer covers the session) opens a
// window: the read can still be in flight when the session is deleted out
// from under it. deleteJobById must be the one thing a resurrecting save()
// cannot outrun.
describe('deleting a session with a round read in flight', () => {
  it('does not let a pending round’s save resurrect a job deleted while the read was in flight', async () => {
    vi.useFakeTimers();
    try {
      latestReviewFindings.mockClear();
      saveJob.mockClear();
      state.stored = [
        {
          id: 'race-par-1',
          kind: 'devchat',
          status: 'interrupted',
          repo: 'acme/race',
          turns: 1,
          branch: 'task/race-1',
          startedOnPr: 95,
          prStatus: { number: 95, state: 'open' },
          reviewLoop: {
            rounds: 1,
            reviewing: false,
            pendingResult: {
              prNumber: 95,
              round: 1,
              since: null,
              said: true,
              attempts: 1,
              failingSince: '2026-08-25T12:31:00.000Z',
              nextRetryAt: new Date(0).toISOString(),
            },
          },
        },
      ];
      let resolveFindings;
      latestReviewFindings.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFindings = resolve;
          }),
      );
      let resolveDrop;
      dropSessionDatabase.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDrop = resolve;
          }),
      );
      await initJobs();

      // The sync tick starts the round's read; it is left in flight (the
      // findings promise above is not resolved yet).
      await vi.advanceTimersByTimeAsync(20_000);
      expect(latestReviewFindings).toHaveBeenCalledWith('acme/race', 95, { since: null });

      // The session is deleted while that read is still outstanding. This runs
      // synchronously up to its own first await (dropSessionDatabase, held open
      // above), so the job is still in the registry and the delete is
      // mid-flight when the read resolves below.
      const deleted = deleteJobById('race-par-1');

      // The read resolves with no findings, which drives resolveLoopRound
      // straight through to `save(parent)` with no further await in between.
      resolveFindings([]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // A flush tick fires while deleteJobById is still paused on
      // dropSessionDatabase: the row must not be written back now that the
      // session is being deleted.
      await vi.advanceTimersByTimeAsync(600);
      expect(saveJob).not.toHaveBeenCalled();

      // Let the delete finish.
      resolveDrop();
      await deleted;
      expect(deleteJob).toHaveBeenCalledWith('race-par-1', null);
      expect(getJob('race-par-1')).toBeNull();

      // Nothing queued by the read's completion survives the delete either.
      await vi.advanceTimersByTimeAsync(600);
      expect(saveJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the review loop: the orchestrator’s triage of a held round', () => {
  const held = () => ({
    prNumber: 79,
    round: 2,
    findings: [
      { key: 'k1', severity: 'high', title: 'A thing', parked: null },
      { key: 'k2', severity: 'low', title: 'A nit', file: 'lib/x.js', line: 4, parked: 'severity' },
    ],
  });
  const workerRow = (id, orch, loop = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/triage', // not in state.projects: a fix session spawn fails and leaves its trace
    providerId: 1,
    turns: 1,
    title: 'Add the export',
    createdAt: '2026-08-26T12:30:00.000Z',
    parentId: orch,
    branch: 'task/triage',
    startedOnPr: 79,
    prStatus: { number: 79, state: 'open' },
    reviewLoop: { rounds: 2, lastSha: 'abc', lastFindings: 'k0', triage: held(), ...loop },
  });
  const orchRow = (id, extra = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/triage',
    providerId: 1,
    turns: 1,
    createdAt: '2026-08-26T12:00:00.000Z',
    orchestrator: true,
    awaitingAnswer: true, // so the updates stay in the buffer where the tests read them
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      orchRow('tri-orch'),
      workerRow('tri-1', 'tri-orch'),
      workerRow('tri-2', 'tri-orch'),
      workerRow('tri-3', 'tri-orch', { lastFindings: 'k1' }),
      workerRow('tri-4', 'tri-orch', { triage: null }),
      // An orchestrator that was closed with a round on hold, and the fix
      // session whose close is the worker's next settle.
      orchRow('tri-gone'),
      workerRow('tri-5', 'tri-gone', { fixing: true, fixSessionId: 'tri-5-fix' }),
      {
        id: 'tri-5-fix',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/triage',
        turns: 1,
        loopFixParentId: 'tri-5',
        loopFixDone: true,
      },
      // A free orchestrator with a triage update for a worker no longer holding one.
      orchRow('tri-free', {
        awaitingAnswer: false,
        pendingWorkerNotices: [{ workerId: 'tri-4', kind: 'triage', text: 'stale' }],
      }),
    ];
    await initJobs();
    for (const id of ['tri-orch', 'tri-1', 'tri-2', 'tri-3', 'tri-4', 'tri-5', 'tri-5-fix', 'tri-free']) {
      getJob(id).status = 'idle';
    }
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);

  it('refuses a worker with no round on hold', async () => {
    await expect(triageLoopFindings('tri-4', { verdicts: [{ key: 'k1', decision: 'fix' }] })).rejects.toThrow(
      /no review round waiting/,
    );
    await expect(triageLoopFindings('nobody', { verdicts: [] })).rejects.toThrow(/Session not found/);
  });

  it('wants a verdict on every finding, by key, in one of the three words', async () => {
    const before = recordTriage.mock.calls.length;
    await expect(triageLoopFindings('tri-1', { verdicts: [] })).rejects.toThrow(/one verdict per finding/);
    await expect(triageLoopFindings('tri-1', { verdicts: [{ key: 'k1', decision: 'fix' }] })).rejects.toThrow(
      /still unruled: k2/,
    );
    await expect(
      triageLoopFindings('tri-1', {
        verdicts: [
          { key: 'k1', decision: 'fix' },
          { key: 'k7', decision: 'fix' },
        ],
      }),
    ).rejects.toThrow(/No finding k7/);
    await expect(
      triageLoopFindings('tri-1', {
        verdicts: [
          { key: 'k1', decision: 'maybe' },
          { key: 'k2', decision: 'fix' },
        ],
      }),
    ).rejects.toThrow(/"maybe" is not a verdict for k1/);
    // Nothing was recorded and the round is still on hold.
    expect(recordTriage.mock.calls.length).toBe(before);
    expect(getJob('tri-1').reviewLoop.triage).not.toBeNull();
  });

  it('records the verdicts, then sends what was kept to a fix session with the note', async () => {
    const result = await triageLoopFindings('tri-1', {
      verdicts: [
        { key: 'k1', decision: 'fix' },
        { key: 'k2', decision: 'dismiss', reason: 'the memo is keyed on purpose' },
      ],
      note: 'Keep the public signature.',
    });
    const worker = getJob('tri-1');
    expect(worker.reviewLoop.triage).toBeNull();
    // Every verdict goes on record, "dismiss" spelled the way the panel spells it.
    expect(recordTriage).toHaveBeenLastCalledWith(
      'acme/triage',
      79,
      [
        { key: 'k1', severity: 'high', title: 'A thing', decision: 'fix', reason: null },
        {
          key: 'k2',
          severity: 'low',
          title: 'A nit',
          file: 'lib/x.js',
          line: 4,
          decision: 'dismissed',
          reason: 'the memo is keyed on purpose',
        },
      ],
      { round: 2 },
    );
    // What was kept is the next round's comparison, and is what the fix
    // session is briefed with, as a decided list plus the note.
    expect(worker.reviewLoop.lastFindings).toBe('k1');
    expect(implementFeedbackPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prNumber: 79,
        findings: [{ key: 'k1', severity: 'high', title: 'A thing' }],
        triaged: true,
        note: 'Keep the public signature.',
      }),
    );
    const text = infoTexts(worker).join('\n');
    expect(text).toMatch(
      /triaged round 2: 1 finding\(s\) to fix, 1 left out \(A nit: dismissed, the memo is keyed on purpose\)/,
    );
    expect(text).toMatch(/could not start the fix session/); // the spawn was attempted
    expect(result).toEqual({ fixing: false, converged: false });
  });

  it('a round with nothing kept converges, and says so to the orchestrator', async () => {
    const result = await triageLoopFindings('tri-2', {
      verdicts: [
        { key: 'k1', decision: 'optional', reason: 'later' },
        { key: 'k2', decision: 'dismissed' },
      ],
    });
    const worker = getJob('tri-2');
    expect(result).toEqual({ fixing: false, converged: true });
    expect(worker.reviewLoop.done).toBe(true);
    expect(worker.reviewLoop.triage).toBeNull();
    expect(infoTexts(worker).join('\n')).toMatch(/leaves nothing to implement after triage/);
    const notice = getJob('tri-orch').pendingWorkerNotices.find((n) => n.workerId === 'tri-2');
    expect(notice.kind).toBe('loop');
    expect(notice.text).toMatch(/converged on PR #79: round 2 left nothing to implement after your triage/);
  });

  it('the stall gate runs on what the triage kept', async () => {
    // tri-3's previous round already sent k1 alone to a fix session.
    const result = await triageLoopFindings('tri-3', {
      verdicts: [
        { key: 'k1', decision: 'fix' },
        { key: 'k2', decision: 'dismissed', reason: 'nit' },
      ],
    });
    const worker = getJob('tri-3');
    expect(result).toEqual({ fixing: false, converged: false });
    expect(worker.reviewLoop.stalled).toBe(true);
    expect(worker.reviewLoop.fixing).toBeFalsy();
    const notice = getJob('tri-orch').pendingWorkerNotices.find((n) => n.workerId === 'tri-3');
    expect(notice.text).toMatch(/stalled on PR #79.*same findings as the round before it/);
  });

  it('a persisted held round resumes directly even with a live orchestrator', async () => {
    getJob('tri-5').parentId = 'tri-orch';
    const before = queueFindingsForFix.mock.calls.length;
    await closeDevSession('tri-5-fix'); // the worker's next settle
    await new Promise((r) => setTimeout(r, 0));
    const worker = getJob('tri-5');
    expect(worker.reviewLoop.triage).toBeNull();
    expect(queueFindingsForFix.mock.calls.length).toBe(before + 1);
    expect(queueFindingsForFix).toHaveBeenLastCalledWith('acme/triage', 79, held().findings, {
      severityFloor: 'medium',
    });
    const text = infoTexts(worker).join('\n');
    expect(text).toMatch(/round 2's previously held findings now go directly to the fix session/);
    expect(text).toMatch(/could not start the fix session/);
  });

  it('a triage update for a round no longer on hold is dropped at delivery', () => {
    const orch = getJob('tri-free');
    deliverWorkerNotices(orch);
    expect(orch.pendingWorkerNotices).toEqual([]);
    expect(orch.events.filter((e) => e.kind === 'user')).toEqual([]); // no turn was spent on it
  });

  it('workerSummary carries the held round, park advice spelled out', () => {
    const summary = workerSummary(getJob('tri-4'));
    expect(summary.reviewLoop.triage).toBeNull();
    const holding = workerSummary({ ...getJob('tri-4'), reviewLoop: { rounds: 2, triage: held() } });
    expect(holding.reviewLoop.triage).toEqual({
      prNumber: 79,
      round: 2,
      findings: [
        { key: 'k1', severity: 'high', title: 'A thing', file: null, line: null, parked: null },
        { key: 'k2', severity: 'low', title: 'A nit', file: 'lib/x.js', line: 4, parked: 'below the floor' },
      ],
    });
  });

  it('turning the loop off drops the held round and says where its findings are', () => {
    const worker = getJob('tri-4');
    worker.reviewLoop.triage = held();
    setReviewLoop('tri-4', false);
    expect(worker.reviewLoop).toBeNull();
    expect(infoTexts(worker).join('\n')).toMatch(/findings awaiting triage stay on the pull request/);
  });
});

describe('the review loop: what a closing fix session reports back', () => {
  const parentRow = (id, fixId) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/loopfix',
    turns: 1,
    branch: 'task/loopfix',
    startedOnPr: 78,
    prStatus: { number: 78, state: 'open' },
    reviewLoop: { rounds: 1, reviewing: false, fixing: true, fixSessionId: fixId, lastSha: 'abc' },
  });
  const fixRow = (id, parentId, done) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/loopfix',
    turns: 1,
    loopFixParentId: parentId,
    loopFixDone: done,
  });

  beforeAll(async () => {
    state.stored = [
      parentRow('fixpar-1', 'fix-1'),
      fixRow('fix-1', 'fixpar-1', true),
      parentRow('fixpar-2', 'fix-2'),
      fixRow('fix-2', 'fixpar-2', false),
    ];
    await initJobs();
    for (const id of ['fixpar-1', 'fix-1', 'fixpar-2', 'fix-2']) getJob(id).status = 'idle';
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);

  it('a finished fix session releases the loop and offers the next round', async () => {
    await closeDevSession('fix-1');
    await new Promise((r) => setTimeout(r, 0)); // the report is fire-and-forget
    const parent = getJob('fixpar-1');
    expect(parent.reviewLoop.fixing).toBe(false);
    expect(parent.reviewLoop.fixSessionId).toBeNull();
    expect(infoTexts(parent).join('\n')).toMatch(/fix session finished/);
  });

  it('a fix session stopped mid-way releases the loop without a next round', async () => {
    await closeDevSession('fix-2');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('fixpar-2');
    expect(parent.reviewLoop.fixing).toBe(false);
    expect(infoTexts(parent).join('\n')).toMatch(/stopped before it finished/);
  });
});

describe('the review loop: arming and disarming a session already underway', () => {
  const row = (id, extra = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped after the restore, like the rows above
    repo: 'acme/arm',
    turns: 1,
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('arm-1'),
      row('arm-2', { reviewLoop: { rounds: 2, reviewing: true, pendingFix: 'FEEDBACK' } }),
      row('arm-3', { reviewBranch: 'feature/x' }),
      row('arm-4', { qaBranch: 'feature/x' }),
      row('arm-5', { autoClose: true }),
      row('arm-6', { loopParentId: 'arm-other' }),
      row('arm-7', { local: true }),
      row('arm-closed'),
      // A session whose loop review is still running, and that review.
      row('arm-8', { reviewLoop: { rounds: 2, reviewing: true, reviewSessionId: 'arm-8-rev' } }),
      row('arm-8-rev', { loopParentId: 'arm-8' }),
    ];
    await initJobs();
    for (const id of ['arm-1', 'arm-2', 'arm-3', 'arm-4', 'arm-5', 'arm-6', 'arm-7', 'arm-8', 'arm-8-rev']) {
      getJob(id).status = 'idle';
    }
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);

  it('arms a session that was started without the loop', async () => {
    const session = setReviewLoop('arm-1', true);
    expect(session.reviewLoop).toMatchObject({
      rounds: 0,
      done: false,
      reviewing: false,
      lastSha: null,
    });
    await new Promise((r) => setTimeout(r, 0)); // the first round is offered off the call
    expect(infoTexts(getJob('arm-1')).join('\n')).toMatch(/Review loop armed/);
    // Nothing to review against yet, so the loop says what it is waiting for
    // rather than starting a round.
    expect(infoTexts(getJob('arm-1')).join('\n')).toMatch(/once this session has an open pull request/);
  });

  it('arming an already armed session changes nothing', () => {
    getJob('arm-1').reviewLoop.rounds = 1;
    expect(setReviewLoop('arm-1', true).reviewLoop.rounds).toBe(1);
  });

  it('disarming drops the loop, the review out and the findings it was holding', () => {
    const session = setReviewLoop('arm-2', false);
    expect(session.reviewLoop).toBeNull();
    const text = infoTexts(getJob('arm-2')).join('\n');
    expect(text).toMatch(/No further reviews start on their own/);
    expect(text).toMatch(/reports nothing back/); // a review was out
    expect(text).toMatch(/holding are on the pull request/); // and a fix turn was held
  });

  it('re-arming starts the round count over: a person asked for them', () => {
    expect(setReviewLoop('arm-2', true).reviewLoop).toMatchObject({ rounds: 0, pendingFix: null });
  });

  it('re-arming adopts a review the disarmed loop left running instead of starting a second one', async () => {
    setReviewLoop('arm-8', false);
    const session = setReviewLoop('arm-8', true);
    // Counted as the round it is, and pointed at again, so its close reports
    // back here and no second review of the same pull request starts.
    expect(session.reviewLoop).toMatchObject({ rounds: 1, reviewing: true, reviewSessionId: 'arm-8-rev' });
    expect(infoTexts(getJob('arm-8')).join('\n')).toMatch(/already running is its first round/);
    await new Promise((r) => setTimeout(r, 0));
    expect(getJob('arm-8').reviewLoop.reviewSessionId).toBe('arm-8-rev');
  });

  it('refuses the sessions the loop never applies to', () => {
    for (const id of ['arm-3', 'arm-4', 'arm-5', 'arm-6', 'arm-7']) {
      expect(() => setReviewLoop(id, true)).toThrow(/only applies to a session started from scratch/);
    }
  });

  it('refuses a session that is not open, and one that never existed', () => {
    expect(() => setReviewLoop('arm-closed', true)).toThrow(/needs an open session/);
    expect(() => setReviewLoop('nope', true)).toThrow(/Session not found/);
  });
});

describe('the QA loop: reporting a finished QA run', () => {
  const parentRow = (id, qaId) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/qa-loop',
    turns: 1,
    branch: 'feature/x',
    startedOnPr: 88,
    prStatus: { number: 88, state: 'open' },
    reviewLoop: { rounds: 1, done: true, reviewing: false },
    qaLoop: { running: true, sessionId: qaId, done: false, failedScenarios: null },
  });
  const qaRow = (id, parentId, done) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/qa-loop',
    turns: 2,
    qaBranch: 'feature/x',
    autoClose: true,
    startedOnPr: 88,
    qaParentId: parentId,
    qaLoopDone: done,
  });

  beforeAll(async () => {
    state.stored = [
      parentRow('qa-par-1', 'qa-run-1'),
      qaRow('qa-run-1', 'qa-par-1', true),
      parentRow('qa-par-2', 'qa-run-2'),
      qaRow('qa-run-2', 'qa-par-2', true),
      parentRow('qa-par-3', 'qa-run-3'),
      qaRow('qa-run-3', 'qa-par-3', false),
      // A later push staled this QA run before it closed; its verdict must not
      // mark the new branch QA'd.
      {
        ...parentRow('qa-par-4', 'qa-run-4'),
        reviewLoop: { rounds: 2, done: false, reviewing: true },
        qaLoop: { running: true, sessionId: null, staleSessionId: 'qa-run-4', done: false },
      },
      qaRow('qa-run-4', 'qa-par-4', true),
      // A worker's QA verdict goes to its orchestrator too; held in the buffer
      // by the orchestrator's own open question, so the test can read it.
      {
        id: 'qa-orch',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/qa-loop',
        providerId: 1,
        turns: 1,
        createdAt: '2026-08-25T12:00:00.000Z',
        orchestrator: true,
        awaitingAnswer: true,
      },
      { ...parentRow('qa-par-5', 'qa-run-5'), parentId: 'qa-orch', createdAt: '2026-08-25T12:30:00.000Z' },
      qaRow('qa-run-5', 'qa-par-5', true),
      parentRow('qa-par-6', 'qa-run-6'),
      qaRow('qa-run-6', 'qa-par-6', true),
      {
        ...parentRow('qa-par-7', 'qa-run-7'),
        qaLoop: {
          running: false,
          sessionId: 'qa-run-7',
          done: false,
          failure: { kind: 'failed', reason: 'Claude HQ exited with code 1' },
        },
      },
      qaRow('qa-run-7', 'qa-par-7', false),
      { ...parentRow('qa-par-8', 'qa-run-8'), parentId: 'qa-orch' },
      qaRow('qa-run-8', 'qa-par-8', false),
    ];
    await initJobs();
    for (const id of [
      'qa-orch',
      'qa-par-5',
      'qa-run-5',
      'qa-par-6',
      'qa-run-6',
      'qa-par-1',
      'qa-run-1',
      'qa-par-2',
      'qa-run-2',
      'qa-par-3',
      'qa-run-3',
      'qa-par-4',
      'qa-run-4',
      'qa-par-7',
      'qa-run-7',
      'qa-par-8',
      'qa-run-8',
    ]) {
      getJob(id).status = 'idle';
    }
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);

  it('a clean sheet stops the loop: no QA action is required', async () => {
    latestTestFailures.mockResolvedValueOnce([]);
    await closeDevSession('qa-run-1');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('qa-par-1');
    expect(parent.qaLoop).toMatchObject({ running: false, done: true, failedScenarios: 0 });
    expect(infoTexts(parent).join('\n')).toMatch(/no QA actions are required/);
    expect(latestTestFailures).toHaveBeenCalledWith('acme/qa-loop', 88);
  });

  it('failed scenarios are reported as feedback, and the loop stops there', async () => {
    latestTestFailures.mockResolvedValueOnce([{ number: '2', scenario: 'Filters invoices' }]);
    await closeDevSession('qa-run-2');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('qa-par-2');
    expect(parent.qaLoop).toMatchObject({ running: false, done: true, failedScenarios: 1 });
    expect(infoTexts(parent).join('\n')).toMatch(/1 scenario\(s\) failed/);
    expect(infoTexts(parent).join('\n')).toMatch(/stops here for now/);
  });

  it('a QA run stopped before finishing stays retryable rather than reading as a verdict', async () => {
    latestTestFailures.mockClear();
    await closeDevSession('qa-run-3');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('qa-par-3');
    expect(parent.qaLoop).toMatchObject({ running: false, done: false });
    expect(parent.qaLoop.failure).toMatchObject({
      kind: 'interrupted',
      reason: 'the QA session was stopped before it finished',
    });
    expect(infoTexts(parent).join('\n')).toMatch(/stopped before it finished/);
    expect(latestTestFailures).not.toHaveBeenCalledWith('acme/qa-loop', 88);
  });

  it('does not overwrite a provider failure when the failed QA session is subsequently closed', async () => {
    await closeDevSession('qa-run-7');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('qa-par-7');

    expect(parent.qaLoop).toMatchObject({
      running: false,
      done: false,
      failure: { kind: 'failed', reason: 'Claude HQ exited with code 1' },
    });
    expect(infoTexts(parent).join('\n')).not.toMatch(/stopped before it finished/);
  });

  it('wakes the orchestrator when QA is interrupted and names the retry action', async () => {
    await closeDevSession('qa-run-8');
    await new Promise((r) => setTimeout(r, 0));
    const notice = getJob('qa-orch').pendingWorkerNotices.find((n) => n.workerId === 'qa-par-8');

    expect(notice.kind).toBe('loop');
    expect(notice.text).toMatch(/QA was interrupted before it finished/);
    expect(notice.text).toMatch(/No QA is running and nothing was approved/);
    expect(notice.text).toMatch(/use send_to_worker/);
  });

  it('a QA run staled by a later push closes without recording its verdict', async () => {
    latestTestFailures.mockClear();
    await closeDevSession('qa-run-4');
    await new Promise((r) => setTimeout(r, 0));
    const parent = getJob('qa-par-4');
    expect(parent.qaLoop).toMatchObject({
      running: false,
      sessionId: null,
      staleSessionId: null,
      done: false,
    });
    expect(latestTestFailures).not.toHaveBeenCalledWith('acme/qa-loop', 88);
  });

  it('a worker’s QA verdict reaches its orchestrator', async () => {
    latestTestFailures.mockResolvedValueOnce([]);
    await closeDevSession('qa-run-5');
    await new Promise((r) => setTimeout(r, 0));
    const notice = getJob('qa-orch').pendingWorkerNotices.find((n) => n.workerId === 'qa-par-5');
    expect(notice.kind).toBe('loop');
    expect(notice.text).toMatch(/QA on PR #88 passed/);
    expect(notice.text).toMatch(/ready to merge/);
  });

  it('retries a rate-limited verdict at the primary reset without rerunning QA', async () => {
    vi.useFakeTimers();
    latestTestFailures.mockClear();
    const retryAt = Date.now() + 100;
    latestTestFailures
      .mockRejectedValueOnce(Object.assign(new Error('core exhausted'), { rateLimited: true, retryAt }))
      .mockResolvedValueOnce([{ number: '2', scenario: 'Filters invoices' }]);
    await closeDevSession('qa-run-6');
    const parent = getJob('qa-par-6');
    expect(parent.qaLoop).toMatchObject({ running: false, done: false });
    expect(parent.qaLoop.pendingVerdict).toMatchObject({ prNumber: 88 });
    await vi.advanceTimersByTimeAsync(100);
    expect(parent.qaLoop).toMatchObject({ running: false, done: true, failedScenarios: 1 });
    expect(latestTestFailures.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('resumes a pending verdict from an idle restored session', async () => {
    vi.useFakeTimers();
    state.stored = [
      {
        ...parentRow('qa-restart-1', 'qa-restart-run'),
        qaLoop: {
          running: false,
          sessionId: null,
          done: false,
          failedScenarios: null,
          pendingVerdict: { prNumber: 88, nextRetryAt: new Date(0).toISOString() },
        },
      },
    ];
    latestTestFailures.mockResolvedValueOnce([]);
    await initJobs();
    const parent = getJob('qa-restart-1');
    parent.status = 'idle';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(parent.qaLoop).toMatchObject({ done: true, failedScenarios: 0 });
    expect(parent.qaLoop.pendingVerdict).toBeNull();
    vi.useRealTimers();
  });

  // The same restart that used to strand a review loop's pending round strands
  // a QA verdict read the same way: `interrupted`, not `idle`, is what a
  // restored session actually is, and the tick must retry it there too.
  it('resumes a pending verdict from an interrupted (restarted) session, not just an idle one', async () => {
    vi.useFakeTimers();
    latestTestFailures.mockClear();
    state.stored = [
      {
        ...parentRow('qa-restart-2', 'qa-restart-run-2'),
        // idle, not closed: restoreFromDb only marks a session interrupted
        // (holdsResources) when it was still holding its clone/database claim,
        // exactly the restart this loop must survive.
        status: 'idle',
        dbServerId: 9,
        dbHost: 'db-host',
        dbPort: 3306,
        qaLoop: {
          running: false,
          sessionId: null,
          done: false,
          failedScenarios: null,
          pendingVerdict: { prNumber: 88, nextRetryAt: new Date(0).toISOString() },
        },
      },
    ];
    latestTestFailures.mockResolvedValueOnce([]);
    await initJobs();
    const parent = getJob('qa-restart-2');
    // The real restart transition (restoreFromDb -> markInterrupted), not a
    // hand-set status.
    expect(parent.status).toBe('interrupted');
    expect(parent.dbServerId).toBeNull();
    expect(parent.error).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(parent.qaLoop).toMatchObject({ done: true, failedScenarios: 0 });
    expect(parent.qaLoop.pendingVerdict).toBeNull();
    vi.useRealTimers();
  });
});

describe('the QA loop: arming and disarming', () => {
  beforeAll(async () => {
    state.stored = [
      {
        id: 'qa-arm-1',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/shop',
        turns: 1,
        reviewLoop: { rounds: 1, done: false, reviewing: false },
      },
    ];
    await initJobs();
    getJob('qa-arm-1').status = 'idle';
  });

  it('arms behind a review loop', () => {
    expect(setQaLoop('qa-arm-1', true).qaLoop).toMatchObject({
      running: false,
      done: false,
      sessionId: null,
    });
  });

  it('turning the review loop off cancels the QA run queued behind it', () => {
    setReviewLoop('qa-arm-1', false);
    expect(getJob('qa-arm-1').reviewLoop).toBeNull();
    expect(getJob('qa-arm-1').qaLoop).toBeNull();
  });

  it('cannot be armed without the review loop', () => {
    expect(() => setQaLoop('qa-arm-1', true)).toThrow(/turn the review loop on first/);
  });
});

describe('spottedPrIsThisSession', () => {
  it('attaches a PR opened from the session own branch', () => {
    expect(spottedPrIsThisSession({ branch: 'dev-0e70ae5d' }, 'dev-0e70ae5d')).toBe(true);
  });

  it('refuses a PR the agent merely quoted from another branch', () => {
    expect(spottedPrIsThisSession({ branch: 'dev-0e70ae5d' }, 'patch/11777-add-single-invoice')).toBe(false);
  });

  it('refuses when either side has no branch to compare', () => {
    expect(spottedPrIsThisSession({ branch: null }, 'feature/x')).toBe(false);
    expect(spottedPrIsThisSession({ branch: 'feature/x' }, null)).toBe(false);
  });

  it('attaches the PR a gh-only errand is about, whatever the borrowed checkout is on', () => {
    const job = { branch: 'patch/11777-add-single-invoice', prBranch: 'patch/11734-fleet-locations' };
    expect(spottedPrIsThisSession(job, 'patch/11734-fleet-locations')).toBe(true);
    expect(spottedPrIsThisSession(job, 'patch/11999-something-else')).toBe(false);
  });
});

describe('attachPrForBranch', () => {
  // Only the two calls this describe cares about answer; everything else the
  // sync reaches for (reviews, commits, checks) reports "not ok" and is skipped.
  const github = (prs, pr) => {
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url.startsWith('/repos/acme/shop/pulls?')) return { ok: true, json: async () => prs, url };
      if (/\/pulls\/\d+$/.test(url)) return { ok: true, json: async () => pr };
      return { ok: false, status: 404, json: async () => ({}) };
    });
  };
  // A fresh id per session: the cooldown that keeps the sync tick off GitHub is
  // keyed by session id and lives at module level, so a reused id would carry
  // one test's "nothing open on that branch" into the next.
  let n = 0;
  const session = (over = {}) => ({
    id: `att-${++n}`,
    kind: 'devchat',
    repo: 'acme/shop',
    branch: 'dev-95c1bae2',
    baseBranch: 'main',
    startedOnPr: null,
    prStatus: null,
    events: [],
    seq: 0,
    ...over,
  });

  // A block body on purpose: mockReset() answers the mock itself, and a
  // beforeEach that returns something callable hands vitest a teardown hook.
  beforeEach(() => {
    githubRest.mockReset();
    githubGraphql.mockReset();
  });

  it('attaches the open pull request the session branch is open from', async () => {
    github([{ number: 51, base: { ref: 'main' } }], {
      number: 51,
      html_url: 'https://github.com/acme/shop/pull/51',
      state: 'open',
      head: { ref: 'dev-95c1bae2', sha: 'sha51' },
      base: { ref: 'main' },
    });
    const job = session();
    expect(await attachPrForBranch(job)).toBe(51);
    expect(job.prStatus.number).toBe(51);
    // Nobody pointed this session at #51, which is what keeps a merge of it
    // from closing the session out from under its user.
    expect(job.prAttachedByBranch).toBe(true);
    // Asked by exact head ref: the one lookup that cannot latch onto a pull
    // request this session has nothing to do with.
    expect(githubRest.mock.calls[0][2]).toContain('head=acme:dev-95c1bae2');
    expect(githubRest.mock.calls[0][2]).toContain('state=open');
  });

  it('an errand that found its pull request this way is still an errand on it', async () => {
    github([{ number: 51, base: { ref: 'main' } }], {
      number: 51,
      state: 'open',
      head: { ref: 'dev-95c1bae2', sha: 'sha51' },
      base: { ref: 'main' },
    });
    // A review holds a clone and a database server for work the merge makes
    // pointless, so the merge must still end it.
    const job = session({ reviewBranch: 'dev-95c1bae2', prAttachedByBranch: false });
    expect(await attachPrForBranch(job)).toBe(51);
    expect(job.prAttachedByBranch).toBe(false);
  });

  it('between two pull requests on one branch it takes the one on the session base', async () => {
    github(
      [
        { number: 80, base: { ref: 'release/1.0' } },
        { number: 51, base: { ref: 'main' } },
      ],
      {
        number: 51,
        html_url: 'https://github.com/acme/shop/pull/51',
        state: 'open',
        head: { ref: 'dev-95c1bae2', sha: 'sha51' },
        base: { ref: 'main' },
      },
    );
    const job = session();
    expect(await attachPrForBranch(job)).toBe(51);
    expect(job.prStatus.number).toBe(51);
  });

  it('attaches nothing, and says so once, when the branch is genuinely ambiguous', async () => {
    github(
      [
        { number: 80, base: { ref: 'release/1.0' } },
        { number: 81, base: { ref: 'release/2.0' } },
      ],
      null,
    );
    const job = session();
    expect(await attachPrForBranch(job)).toBeNull();
    expect(job.prStatus).toBeNull();
    const said = job.events.filter((e) => e.kind === 'info').map((e) => e.text);
    expect(said.join('\n')).toMatch(/#80, #81 are all open from dev-95c1bae2/);
    // Asked again past the cooldown, it does not repeat itself.
    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    expect(job.events.filter((e) => e.kind === 'info')).toHaveLength(said.length);
  });

  it('a branch with nothing open is not re-asked about until the cooldown is up', async () => {
    github([], null);
    const job = session();
    expect(await attachPrForBranch(job)).toBeNull();
    expect(await attachPrForBranch(job)).toBeNull();
    expect(githubRest).toHaveBeenCalledTimes(1); // the tick asks all day; GitHub hears it once
    // A turn that just ended is the moment a pull request appears, so that one
    // asks anyway.
    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    expect(githubRest).toHaveBeenCalledTimes(2);
  });

  it('answers null when the branch has no pull request open', async () => {
    github([], null);
    const job = session();
    expect(await attachPrForBranch(job)).toBeNull();
    expect(job.prStatus).toBeNull();
  });

  it('asks nothing for a session that already knows its pull request', async () => {
    github([{ number: 99 }], null);
    expect(await attachPrForBranch(session({ startedOnPr: 77 }))).toBe(77);
    expect(githubRest).not.toHaveBeenCalled();
  });

  it('never guesses on the default branch or in a shared local checkout', async () => {
    github([{ number: 12 }], null);
    expect(await attachPrForBranch(session({ branch: 'main' }))).toBeNull();
    expect(await attachPrForBranch(session({ local: true }))).toBeNull();
    expect(await attachPrForBranch(session({ branch: null }))).toBeNull();
    expect(githubRest).not.toHaveBeenCalled();
  });

  it('a GitHub outage leaves the session as it was', async () => {
    githubRest.mockRejectedValue(new Error('502'));
    const job = session();
    expect(await attachPrForBranch(job)).toBeNull();
    expect(job.prStatus).toBeNull();
  });

  it('discards fork heads before selecting a GraphQL fallback', async () => {
    const pr = {
      number: 52,
      state: 'open',
      head: { ref: 'dev-95c1bae2', sha: 'sha52' },
      base: { ref: 'release/1.0' },
    };
    githubRest.mockRejectedValueOnce(
      Object.assign(new Error('GitHub core rate limit exhausted'), {
        rateLimited: true,
        retryAt: Date.now() + 60_000,
      }),
    );
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (/\/pulls\/52$/.test(url)) return { ok: true, json: async () => pr };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    githubGraphql.mockResolvedValue({
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 80,
              baseRefName: 'main',
              headRepository: { nameWithOwner: 'fork/shop' },
            },
            {
              number: 52,
              baseRefName: 'release/1.0',
              headRepository: { nameWithOwner: 'acme/shop' },
            },
          ],
        },
      },
    });

    const job = session();
    expect(await attachPrForBranch(job, { fresh: true })).toBe(52);
    expect(job.prStatus).toMatchObject({ number: 52, headRef: 'dev-95c1bae2', baseRef: 'release/1.0' });
    expect(githubGraphql).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('headRepository { nameWithOwner }'),
      { owner: 'acme', name: 'shop', head: 'dev-95c1bae2' },
    );
    // GraphQL rejects the whole query over one field its schema does not have,
    // so the fallback must ask for `baseRefName` and never REST's `base { ref }`.
    const [, query] = githubGraphql.mock.calls.find(([, q]) => q.includes('headRefName: $head'));
    expect(query).toContain('baseRefName');
    expect(query).not.toContain('base { ref }');
  });

  it('keeps its short backoff when the GraphQL fallback also fails', async () => {
    vi.useFakeTimers();
    try {
      githubRest.mockRejectedValue(
        Object.assign(new Error('GitHub core rate limit exhausted'), { rateLimited: true }),
      );
      githubGraphql.mockRejectedValue(new Error('GitHub GraphQL answered 503'));
      const job = session({
        status: 'idle',
        reviewLoop: { discoveryError: null, discoveryErrorSaid: false, discoveryRetries: 0 },
      });

      expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
      expect(job.reviewLoop.discoveryError).toBe('GitHub GraphQL answered 503');
      expect(job.reviewLoop.discoveryRetries).toBe(1);
      expect(githubGraphql).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(githubGraphql).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate an in-flight fallback attachment or an already-running review', async () => {
    state.stored = [
      { id: 'fallback-live-review', kind: 'devchat', status: 'closed', repo: 'acme/shop', turns: 1 },
    ];
    await initJobs();
    getJob('fallback-live-review').status = 'idle';
    let resolveGraphql;
    const waiting = new Promise((resolve) => {
      resolveGraphql = resolve;
    });
    const job = session({
      status: 'idle',
      reviewLoop: {
        rounds: 1,
        reviewing: true,
        reviewSessionId: 'fallback-live-review',
        discoveryError: null,
        discoveryErrorSaid: false,
      },
    });
    const pr = {
      number: 53,
      state: 'open',
      head: { ref: 'dev-95c1bae2', sha: 'sha53' },
      base: { ref: 'main' },
    };
    githubRest.mockRejectedValueOnce(
      Object.assign(new Error('GitHub core rate limit exhausted'), { rateLimited: true }),
    );
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (/\/pulls\/53$/.test(url)) return { ok: true, json: async () => pr };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    githubGraphql.mockReturnValueOnce(waiting);

    const first = attachPrForBranch(job, { fresh: true });
    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    resolveGraphql({
      repository: {
        pullRequests: {
          nodes: [{ number: 53, baseRefName: 'main', headRepository: { nameWithOwner: 'acme/shop' } }],
        },
      },
    });

    expect(await first).toBe(53);
    expect(githubGraphql.mock.calls.filter(([, query]) => query.includes('headRefName: $head'))).toHaveLength(
      1,
    );
    expect(job.reviewLoop).toMatchObject({ rounds: 1, reviewing: true });
  });

  it('starts legacy loop rows with no discovery retry counter at zero', async () => {
    githubRest.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    githubGraphql.mockRejectedValue(new Error('GitHub GraphQL answered 503'));
    const job = session({ reviewLoop: { discoveryError: null, discoveryErrorSaid: false } });
    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    expect(job.reviewLoop.discoveryRetries).toBe(1);
  });

  it('clears discovery state when a successful lookup finds no pull request', async () => {
    github([]);
    const job = session({
      reviewLoop: { discoveryError: 'GitHub returned 403', discoveryErrorSaid: true, discoveryRetries: 3 },
    });
    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    expect(job.reviewLoop).toMatchObject({
      discoveryError: null,
      discoveryErrorSaid: false,
      discoveryRetries: 0,
    });
  });

  it('retries a transient discovery failure on a later idle transition and clears its status', async () => {
    const pr = {
      number: 52,
      state: 'open',
      head: { ref: 'dev-95c1bae2', sha: 'sha52' },
      base: { ref: 'main' },
    };
    const job = session({
      reviewLoop: { discoveryError: null, discoveryErrorSaid: false },
    });
    githubRest.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url.startsWith('/repos/acme/shop/pulls?')) return { ok: true, json: async () => [pr] };
      if (/\/pulls\/\d+$/.test(url)) return { ok: true, json: async () => pr };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
    expect(job.reviewLoop.discoveryError).toBe('GitHub returned 403');
    expect(await attachPrForBranch(job, { fresh: true })).toBe(52);
    expect(job.reviewLoop.discoveryError).toBeNull();
    // A successful second idle check attaches the existing PR; it does not
    // create another association or require another branch push.
    expect(await attachPrForBranch(job, { fresh: true })).toBe(52);
    expect(
      githubRest.mock.calls.filter((call) => call[2].startsWith('/repos/acme/shop/pulls?')),
    ).toHaveLength(2);
  });

  it("keeps an armed worker's PR discovery retry armed when GraphQL cannot use the spare budget", async () => {
    vi.useFakeTimers();
    try {
      const pr = {
        number: 1598,
        html_url: 'https://github.com/acme/shop/pull/1598',
        state: 'open',
        head: { ref: 'dev-95c1bae2', sha: 'sha1598' },
        base: { ref: 'main' },
      };
      const retryAt = Date.now() + 60_000;
      const rateLimit = Object.assign(new Error('GitHub core rate limit exhausted'), {
        rateLimited: true,
        retryAt,
      });
      const job = session({
        status: 'idle',
        reviewLoop: {
          discoveryError: null,
          discoveryErrorSaid: false,
          discoveryRetries: 0,
          lastSha: 'sha1598',
        },
      });
      githubRest.mockRejectedValueOnce(rateLimit);
      githubGraphql.mockRejectedValueOnce(new Error('GitHub GraphQL answered 503'));
      githubRest.mockImplementation(async (_cfg, _method, url) => {
        if (url.startsWith('/repos/acme/shop/pulls?')) return { ok: true, json: async () => [pr] };
        if (/\/pulls\/\d+$/.test(url)) return { ok: true, json: async () => pr };
        return { ok: false, status: 404, json: async () => ({}) };
      });

      expect(await attachPrForBranch(job, { fresh: true })).toBeNull();
      expect(job.reviewLoop.discoveryRetries).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(job.prStatus).toMatchObject({ number: 1598, state: 'open', headSha: 'sha1598' });
      expect(job.reviewLoop.discoveryError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('manual session metadata', () => {
  const row = (id, extra = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed',
    repo: 'acme/manual',
    title: 'Original title',
    turns: 1,
    branch: `dev-${id}`,
    baseBranch: 'main',
    prStatus: null,
    startedOnPr: null,
    ...extra,
  });

  beforeAll(async () => {
    state.stored = [
      row('manual-ok'),
      row('manual-url'),
      row('manual-wrong'),
      row('manual-linked', { startedOnPr: 9 }),
    ];
    await initJobs();
  });

  beforeEach(() => {
    githubRest.mockReset();
    githubGraphql.mockReset();
  });

  it('renames a session without changing its conversation', () => {
    const session = renameDevSession('manual-ok', '  A clearer title  ');
    expect(session.title).toBe('A clearer title');
    expect(getJob('manual-ok').title).toBe('A clearer title');
    expect(getJob('manual-ok').events).toEqual([]);
  });

  it('refuses an empty or excessively long title', () => {
    expect(() => renameDevSession('manual-ok', '   ')).toThrow(/cannot be empty/);
    expect(() => renameDevSession('manual-ok', 'x'.repeat(161))).toThrow(/160 characters/);
  });

  it('links a PR number after verifying its exact head branch', async () => {
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url === '/repos/acme/manual/pulls/71') {
        return {
          ok: true,
          json: async () => ({
            number: 71,
            html_url: 'https://github.com/acme/manual/pull/71',
            title: 'Manual link',
            state: 'open',
            head: { ref: 'dev-manual-ok', sha: 'sha71' },
            base: { ref: 'main' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    githubGraphql.mockRejectedValue(new Error('not available'));

    const session = await linkPrToSession('manual-ok', '#71');

    expect(session.startedOnPr).toBe(71);
    expect(session.prAttachedByBranch).toBe(false);
    expect(session.prStatus).toMatchObject({ number: 71, headRef: 'dev-manual-ok' });
  });

  it('accepts a full same-repository URL', async () => {
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url === '/repos/acme/manual/pulls/73') {
        return {
          ok: true,
          json: async () => ({
            number: 73,
            html_url: 'https://github.com/acme/manual/pull/73',
            title: 'URL link',
            state: 'open',
            head: { ref: 'dev-manual-url', sha: 'sha73' },
            base: { ref: 'main' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    githubGraphql.mockRejectedValue(new Error('not available'));

    const session = await linkPrToSession('manual-url', 'https://github.com/acme/manual/pull/73');
    expect(session.prStatus.number).toBe(73);
  });

  it('rejects a URL from another repository', async () => {
    await expect(
      linkPrToSession('manual-wrong', 'https://github.com/elsewhere/project/pull/72'),
    ).rejects.toThrow(/belongs to elsewhere\/project/);
    expect(githubRest).not.toHaveBeenCalled();
  });

  it('leaves the session unlinked when the PR uses another branch', async () => {
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url === '/repos/acme/manual/pulls/72') {
        return {
          ok: true,
          json: async () => ({
            number: 72,
            state: 'open',
            head: { ref: 'somebody-elses-branch', sha: 'sha72' },
            base: { ref: 'main' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await expect(linkPrToSession('manual-wrong', 72)).rejects.toThrow(/not this session's dev-manual-wrong/);
    expect(getJob('manual-wrong').startedOnPr).toBeNull();
    expect(getJob('manual-wrong').prStatus).toBeNull();
  });

  it('does not replace a session existing PR link', async () => {
    await expect(linkPrToSession('manual-linked', 10)).rejects.toThrow(/already linked to PR #9/);
    expect(githubRest).not.toHaveBeenCalled();
  });
});

describe('a merge closing the sessions on a pull request', () => {
  // Its own repo and PR number, so the registry sweep here touches nothing the
  // other describes restored.
  const row = (id, attachedByBranch) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/merge',
    turns: 1,
    branch: 'dev-merge',
    prAttachedByBranch: attachedByBranch,
    prStatus: { number: 90, state: 'open', syncedAt: '2026-08-25T13:00:00.000Z' },
  });

  beforeAll(async () => {
    state.stored = [row('handed-1', false), row('branch-1', true)];
    await initJobs();
    for (const id of ['handed-1', 'branch-1']) getJob(id).status = 'idle';
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      if (url === '/repos/acme/merge/pulls/90') {
        return {
          ok: true,
          json: async () => ({
            number: 90,
            html_url: 'https://github.com/acme/merge/pull/90',
            state: 'closed',
            merged_at: '2026-08-25T15:00:00.000Z',
            head: { ref: 'dev-merge', sha: 'sha90' },
            base: { ref: 'main' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    syncSessionsOn('acme/merge', null, 90);
  });

  it('closes the session that was pointed at the pull request', async () => {
    await vi.waitFor(() => expect(getJob('handed-1').status).toBe('closed'));
  });

  it('leaves the session that only found the pull request from its branch open', async () => {
    await vi.waitFor(() => expect(getJob('branch-1').prStatus.state).toBe('merged'));
    const job = getJob('branch-1');
    expect(job.status).toBe('idle');
    expect(
      job.events
        .filter((e) => e.kind === 'info')
        .map((e) => e.text)
        .join('\n'),
    ).toMatch(/stays open: its pull request was found from its branch/);
  });
});

describe('the CI verdict a worker hands its orchestrator', () => {
  // Its own repo and PR numbers, like the describes above, so the sync here
  // matches none of the sessions they restored. The orchestrator stands on a
  // question, which parks every update in its buffer where a test can read it
  // instead of spending an injected turn on it.
  const run = (name, conclusion) => ({
    name,
    status: 'completed',
    conclusion,
    html_url: `https://github.com/acme/ci/runs/${name}`,
  });
  const worker = (id, number, over = {}) => ({
    id,
    kind: 'devchat',
    status: 'closed', // flipped to idle after the restore, like the rows above
    repo: 'acme/ci',
    turns: 1,
    title: `Worker ${id}`,
    parentId: 'ci-orch',
    branch: `dev-${id}`,
    startedOnPr: number,
    prStatus: {
      number,
      state: 'open',
      headSha: 'sha-old',
      checks: { total: 2, passed: 0, failed: 0, pending: 2, runs: [] },
      syncedAt: '2026-08-25T13:00:00.000Z',
    },
    ...over,
  });
  // The updates this worker put in the orchestrator's buffer, joined.
  const notices = (workerId) =>
    (getJob('ci-orch').pendingWorkerNotices || [])
      .filter((n) => n.workerId === workerId)
      .map((n) => n.text)
      .join('\n');

  beforeAll(async () => {
    state.stored = [
      {
        id: 'ci-orch',
        kind: 'devchat',
        status: 'closed',
        repo: 'acme/ci',
        providerId: 1,
        turns: 1,
        orchestrator: true,
        awaitingAnswer: true,
      },
      worker('ci-green', 201),
      worker('ci-red', 202),
      worker('ci-loop', 203, { reviewLoop: { rounds: 2, done: false } }),
      // Nothing mirrored yet: this sync is the pull request's first, the one
      // that must stay quiet.
      worker('ci-first', 204, { prStatus: null }),
      // Already green on the sha GitHub is about to report again.
      worker('ci-again', 205, {
        prStatus: {
          number: 205,
          state: 'open',
          headSha: 'sha205',
          checks: { total: 2, passed: 2, failed: 0, pending: 0, runs: [] },
          syncedAt: '2026-08-25T13:00:00.000Z',
        },
      }),
    ];
    await initJobs();
    for (const j of state.stored) getJob(j.id).status = 'idle';
    getJob('ci-orch').status = 'idle';
    getJob('ci-orch').awaitingAnswer = true;
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      const pr = url.match(/^\/repos\/acme\/ci\/pulls\/(\d+)$/);
      if (pr) {
        const number = Number(pr[1]);
        return {
          ok: true,
          json: async () => ({
            number,
            html_url: `https://github.com/acme/ci/pull/${number}`,
            state: 'open',
            head: { ref: `dev-ci-${number}`, sha: `sha${number}` },
            base: { ref: 'main' },
          }),
        };
      }
      const checks = url.match(/^\/repos\/acme\/ci\/commits\/sha(\d+)\/check-runs/);
      if (checks) {
        const runs =
          checks[1] === '202'
            ? [run('Fast checks', 'success'), run('Tests', 'failure')]
            : [run('Fast checks', 'success'), run('Tests', 'success')];
        return { ok: true, json: async () => ({ check_runs: runs }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });

  it('hands a green run to the orchestrator as the cue to merge', async () => {
    syncSessionsOn('acme/ci', null, 201);
    await vi.waitFor(() => expect(notices('ci-green')).toContain('PR #201'));
    expect(notices('ci-green')).toContain('every check on PR #201 passed (2/2)');
    expect(notices('ci-green')).toContain('ready to merge');
  });

  it('names the failing checks and says not to merge', async () => {
    syncSessionsOn('acme/ci', null, 202);
    await vi.waitFor(() => expect(notices('ci-red')).toContain('PR #202'));
    expect(notices('ci-red')).toContain('1 of 2 failing (Tests)');
    expect(notices('ci-red')).toContain('Do not merge');
  });

  it('green with the review loop still out is not a merge yet', async () => {
    syncSessionsOn('acme/ci', null, 203);
    await vi.waitFor(() => expect(notices('ci-loop')).toContain('PR #203'));
    expect(notices('ci-loop')).toContain('Its review loop is still running (round 2)');
  });

  it('says nothing about a run that was already over when the session first looked', async () => {
    syncSessionsOn('acme/ci', 'dev-ci-first', null);
    await vi.waitFor(() => expect(getJob('ci-first').prStatus.checks.passed).toBe(2));
    expect(notices('ci-first')).toBe('');
  });

  it('says nothing again on the next sync of the same finished run', async () => {
    syncSessionsOn('acme/ci', null, 205);
    await vi.waitFor(() => expect(getJob('ci-again').prStatus.syncedAt).not.toBe('2026-08-25T13:00:00.000Z'));
    expect(notices('ci-again')).toBe('');
  });
});

describe('syncSessionsOn', () => {
  const rows = [
    {
      id: 'reconcile-open',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/reconcile',
      providerId: 1,
      branch: 'dev-reconcile-open',
      baseBranch: 'main',
      prStatus: null,
      reviewLoop: null,
    },
    {
      id: 'reconcile-later',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/reconcile',
      providerId: 1,
      branch: 'dev-reconcile-later',
      baseBranch: 'main',
      prStatus: null,
      reviewLoop: null,
    },
  ];

  let openPrs = new Map();
  let details = new Map();

  beforeAll(async () => {
    state.stored = rows;
    await initJobs();
    for (const row of rows) getJob(row.id).status = 'idle';
  });

  beforeEach(() => {
    githubRest.mockReset();
    openPrs = new Map();
    details = new Map();
    githubRest.mockImplementation(async (_cfg, _method, url) => {
      const list = url.match(/^\/repos\/acme\/reconcile\/pulls\?/);
      if (list) {
        const branch = decodeURIComponent(url.match(/[?&]head=acme:([^&]+)/)?.[1] || '');
        return { ok: true, json: async () => openPrs.get(branch) || [] };
      }
      const one = url.match(/^\/repos\/acme\/reconcile\/pulls\/(\d+)$/);
      if (one) return { ok: true, json: async () => details.get(Number(one[1])) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });

  const pr = (number, branch) => ({
    number,
    html_url: `https://github.com/acme/reconcile/pull/${number}`,
    state: 'open',
    head: { ref: branch, sha: `sha-${number}` },
    base: { ref: 'main' },
  });

  it('with neither a branch nor a PR number there is nothing to match', () => {
    expect(syncSessionsOn('acme/shop')).toBe(0);
  });

  it('an empty registry matches nothing', () => {
    expect(syncSessionsOn('acme/shop', 'feature/x', 7)).toBe(0);
  });

  it('discovers and persists a PR opened during a worker turn from its branch event', async () => {
    const opened = pr(301, 'dev-reconcile-open');
    openPrs.set(opened.head.ref, [{ number: opened.number, base: opened.base }]);
    details.set(opened.number, opened);

    expect(syncSessionsOn('acme/reconcile', opened.head.ref)).toBe(1);
    await vi.waitFor(() => expect(getJob('reconcile-open').prStatus).toMatchObject({ number: 301 }));
    expect(getJob('reconcile-open').prAttachedByBranch).toBe(true);
  });

  it('recovers a missed association on a later push event', async () => {
    const later = pr(302, 'dev-reconcile-later');
    expect(syncSessionsOn('acme/reconcile', later.head.ref)).toBe(1);
    await vi.waitFor(() => expect(githubRest).toHaveBeenCalled());
    // syncSessionsOn intentionally answers synchronously; let its best-effort
    // branch lookup finish before the next push event arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getJob('reconcile-later').prStatus).toBeNull();

    openPrs.set(later.head.ref, [{ number: later.number, base: later.base }]);
    details.set(later.number, later);
    expect(syncSessionsOn('acme/reconcile', later.head.ref)).toBe(1);
    await vi.waitFor(() => expect(getJob('reconcile-later').prStatus).toMatchObject({ number: 302 }));
  });
});

// A loop's own sessions — its reviews, its fix sessions, its QA run — are the
// worker's work continued, so they run where the worker runs. The rounds here
// all fail to start on purpose (an unknown provider row, a repo no project
// claims): what the attempt asked for is what these tests read, out of the
// info line the loop leaves behind, and no session is ever spawned.
describe('the review loop: what a round runs on, and re-running one that could not', () => {
  const rows = [
    {
      id: 'rt-own',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/rt',
      // A provider row that no longer exists, which is what makes the attempt
      // name the runtime it asked for instead of spawning anything.
      providerId: 99,
      model: 'claude-fable-5-1',
      effort: 'high',
      branch: 'task/rt',
      startedOnPr: 55,
      prStatus: { number: 55, state: 'open', headSha: 'sha-rt' },
      reviewLoop: { rounds: 1, lastSha: 'sha-rt', failure: { round: 1, reason: 'boom', at: '2026-09-03' } },
    },
    {
      id: 'rt-override',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/rt-none',
      providerId: 99,
      model: 'claude-fable-5-1',
      effort: 'high',
      branch: 'task/rt',
      startedOnPr: 56,
      prStatus: { number: 56, state: 'open', headSha: 'sha-rt' },
      reviewLoop: { rounds: 1, lastSha: 'sha-rt' },
    },
    {
      id: 'rt-busy',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/rt-none',
      providerId: 1,
      branch: 'task/rt',
      startedOnPr: 57,
      prStatus: { number: 57, state: 'open', headSha: 'sha-rt' },
      reviewLoop: { rounds: 1, reviewing: true, reviewSessionId: 'rt-rev' },
    },
    {
      // An orchestrator needs no clone to reopen, which keeps this focused on
      // retry_review's recovery guard rather than workspace preparation.
      id: 'rt-interrupted',
      kind: 'devchat',
      status: 'closed',
      repo: 'acme/rt',
      orchestrator: true,
      providerId: 99,
      model: 'claude-fable-5-1',
      effort: 'high',
      turns: 1,
      startedOnPr: 58,
      prStatus: { number: 58, state: 'open', headSha: 'sha-rt' },
      reviewLoop: {
        rounds: 1,
        lastSha: 'sha-rt',
        failure: { round: 1, reason: 'Server restarted while the job was active', at: '2026-09-05' },
      },
    },
  ];

  beforeAll(async () => {
    state.stored = rows;
    await initJobs();
    for (const row of rows) getJob(row.id).status = 'idle';
  });

  beforeEach(() => {
    // The project configures a board reviewer of its own: what ⌕ Code review
    // opens on, and deliberately not what this session's loop follows.
    state.projects = [
      { repo: 'acme/shop', label: 'Shop', localDir: '' },
      { repo: 'acme/rt', label: 'RT', localDir: '', reviewProviderId: 1, reviewModel: 'claude-fable-5-1' },
    ];
  });

  const infoTexts = (job) => job.events.filter((e) => e.kind === 'info').map((e) => e.text);

  it('a round runs on the session it reviews for, not on the project’s board reviewer', async () => {
    const job = getJob('rt-own');

    const outcome = await retryLoopRound('rt-own');

    // The attempt named provider 99, the session's own: had it read the
    // project's reviewer it would have asked for provider 1.
    expect(infoTexts(job).join('\n')).toMatch(/could not start the code review: Unknown provider: 99/);
    // The round that could not start gives its number back, as every failed
    // start does, so the next one is still round 2.
    expect(outcome).toEqual({ started: false, round: 1 });
  });

  it('a retry moves the loop onto the runtime it names, and keeps it for later rounds', async () => {
    const job = getJob('rt-override');

    await retryLoopRound('rt-override', { providerId: 1, model: 'claude-fable-5-1', effort: 'high' });

    expect(job.reviewLoop.runtime).toEqual({
      providerId: 1,
      model: 'claude-fable-5-1',
      effort: 'high',
    });
    // Past the provider the session itself is stuck on, so far past it that
    // the only thing left to fail on is the repo no project claims.
    expect(infoTexts(job).join('\n')).toMatch(
      /could not start the code review: Unknown project: acme\/rt-none/,
    );
    expect(infoTexts(job).join('\n')).not.toMatch(/Unknown provider/);
  });

  it('refuses a runtime whose provider row does not exist', async () => {
    await expect(retryLoopRound('rt-override', { providerId: 42 })).rejects.toThrow(/Unknown provider: 42/);
  });

  it('keeps a failed round visible when its replacement reviewer cannot start', async () => {
    const job = getJob('rt-own');
    job.reviewLoop.failure = { round: 3, reason: 'Claude HD exited with code 1', at: '2026-09-03' };
    job.reviewLoop.stalled = true;
    job.reviewLoop.done = true;
    job.reviewLoop.lastSha = 'sha-rt';

    await retryLoopRound('rt-own');

    expect(job.reviewLoop.failure).toMatchObject({ round: 1, reason: 'Unknown provider: 99' });
    expect(job.reviewLoop.stalled).toBe(false);
    expect(job.reviewLoop.done).toBe(false);
    expect(infoTexts(job).join('\n')).toMatch(/retrying the review after round 3 failed/);
  });

  it('refuses to retry a round that is actually running', async () => {
    await expect(retryLoopRound('rt-busy')).rejects.toThrow(/Nothing to retry: a code review is running/);
    await expect(retryLoopRound('rt-busy', { providerId: 1 })).rejects.toThrow(/Nothing to retry/);
    // Refused, so nothing about the live round moved.
    expect(getJob('rt-busy').reviewLoop.reviewing).toBe(true);
    expect(getJob('rt-busy').reviewLoop.runtime).toBeFalsy();
  });

  it('keeps a reopened interrupted round retryable when reviewer creation fails', async () => {
    const job = getJob('rt-interrupted');
    job.status = 'interrupted';

    await expect(retryLoopRound('rt-interrupted')).resolves.toEqual({ started: false, round: 1 });

    // reopenDevSession runs asynchronously. It reaches an idle workspace and
    // attempts the queued retry. A refused reviewer must leave its failed
    // round visible, rather than silently clearing the restart failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.status).toBe('idle');
    expect(job.reviewLoop).toMatchObject({
      retryPending: true,
      failure: { round: 1, reason: 'Unknown provider: 99' },
    });
    expect(workerSummary(job).reviewLoop.failure).toEqual({
      round: 1,
      reason: 'Unknown provider: 99',
    });
    expect(job.turns).toBe(1);
    expect(infoTexts(job).join('\n')).toMatch(/reopening this session and retrying/);

    // The failed state makes the same no-chat retry available again; another
    // refused reviewer never turns it into a false success.
    await expect(retryLoopRound('rt-interrupted')).resolves.toEqual({ started: false, round: 1 });
    expect(job.reviewLoop.failure).toMatchObject({
      round: 1,
      reason: 'Unknown provider: 99',
    });
  });

  it('a session with no loop has no round to retry', async () => {
    await expect(retryLoopRound('rt-missing')).rejects.toThrow(/Session not found/);
  });
});
