import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiV1Routes } from '../lib/api-v1.js';
import { agentOnly } from '../lib/auth.js';
import { approvalRoutes } from '../lib/approval-routes.js';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { normalizeApprovalPolicy } from '../lib/review-risk.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ auth: { secret: 'owner-secret' } }) }));

// The approval routes behind the real gateway, as a client reaches them: the token store
// and the catalog decide who gets through, the handlers what an approval needs. The store
// and the outcome are stand-ins kept in memory; GitHub is the `pull` the test sets.
const repo = 'acme/shop';
const secret = 'owner-secret';
const head = 'a'.repeat(40);
const next = 'b'.repeat(40);

let server,
  url,
  handlers,
  tokens,
  people,
  sharedRepos,
  projects,
  approvals,
  pull,
  risk,
  view,
  refreshed,
  sessions,
  linked,
  history,
  owners,
  asked;
// Who wrote the pull request as read from GitHub: somebody who is no user here.
const written = (over = {}) => ({
  author: { id: 900, login: 'octo-author' },
  commits: [{ id: 900, login: 'octo-author' }],
  shas: ['c'.repeat(40)],
  complete: true,
  ...over,
});
// From which computation on the outcome cannot be stored; 0 for never.
let failFrom;
// The outcome as lib/review-enforcement.js answers it, as far as the routes read it.
const outcomeNow = () => ({
  outcome: 'passed',
  stale: false,
  reviewId: 5,
  execution: 'completed',
  headSha: head,
  baseRef: 'main',
  reviewed: { headSha: head, baseRef: 'main' },
  ...view,
  approvals: {
    enabled: true,
    result: 'pending',
    approvals: approvals.map((a) => ({
      id: a.id,
      source: a.source,
      by: { userId: a.userId, name: a.approver },
      headSha: a.headSha,
      counted: a.status === 'approved',
      reason: a.status === 'approved' ? null : a.status,
      withdrawNote: a.withdrawNote ?? null,
    })),
  },
});

beforeEach(async () => {
  let saved = [];
  const auth = createMobileAuth({
    load: async () => structuredClone(saved),
    save: async (_name, value) => {
      saved = structuredClone(value);
    },
  });
  await auth.init();
  people = [
    { id: 1, name: 'Ada', role: 'admin', createdAt: 1, disabledAt: null },
    { id: 2, name: 'Grace', role: 'member', createdAt: 1, disabledAt: null },
    { id: 3, name: 'Linus', role: 'member', createdAt: 1, disabledAt: null },
  ];
  sharedRepos = { 2: [repo], 3: [] };
  const create = async (userId, permission, repos = [repo]) =>
    (await auth.create({ userId, label: `${permission} of ${userId}`, repos, permission, days: 30 }, secret))
      .token;
  tokens = {
    ada: await create(1, 'manage'),
    adaRead: await create(1, 'read'),
    adaElsewhere: await create(1, 'manage', ['acme/other']),
    grace: await create(2, 'manage'),
    // Holds a token for the project, which is not shared with him.
    linus: await create(3, 'manage'),
  };
  projects = {
    [repo]: { id: 1, repo, approvalPolicy: normalizeApprovalPolicy({ enabled: true }) },
    'acme/plain': { id: 2, repo: 'acme/plain' },
  };
  approvals = [];
  pull = { state: 'open', headSha: head, baseRef: 'main', author: 'octo-author' };
  risk = { headSha: head, authors: written() };
  view = {};
  failFrom = 0;
  refreshed = [];
  sessions = [];
  // The GitHub account each user has linked now, every account they ever linked, and
  // the users whose sessions made commits of the pull request.
  linked = { 1: { id: 101, login: 'ada-dev' }, 2: { id: 102, login: 'grace-dev' } };
  history = {};
  owners = [];
  asked = [];
  const store = {
    getCodeReviewRisk: vi.fn(async () => risk),
    listCodeReviewCommitOwners: vi.fn(async () => owners),
    listCodeReviewApprovals: vi.fn(async () => approvals.map((a) => ({ ...a }))),
    addCodeReviewApproval: vi.fn(async (_repo, _pr, approval) => {
      const standing = approvals.find(
        (a) =>
          a.userId === approval.userId &&
          a.headSha === approval.headSha &&
          a.baseRef === approval.baseRef &&
          a.status === 'approved',
      );
      if (standing) return { approval: { ...standing }, created: false };
      const row = { id: approvals.length + 1, source: 'briareus', status: 'approved', ...approval };
      approvals.push(row);
      return { approval: { ...row }, created: true };
    }),
    withdrawCodeReviewApproval: vi.fn(async (_repo, _pr, id, userId, { note }) => {
      const row = approvals.find((a) => a.id === id && a.userId === userId);
      const changed = row?.status === 'approved';
      if (changed) Object.assign(row, { status: 'withdrawn', withdrawNote: note });
      return { approval: row ? { ...row } : null, changed };
    }),
  };
  handlers = express.Router();
  handlers.use(
    approvalRoutes({
      getProject: (name) => projects[name] || null,
      outcome: {
        read: vi.fn(async () => outcomeNow()),
        refresh: vi.fn(async (_project, _pr, current = null, options = {}) => {
          refreshed.push(current);
          asked.push(!!options.asked);
          if (failFrom && refreshed.length >= failFrom) throw new Error('Connection lost');
          return outcomeNow();
        }),
      },
      store,
      readPull: vi.fn(async () => {
        if (pull instanceof Error) throw pull;
        return pull;
      }),
      linkedAccount: (user) => linked[user.id] || null,
      accountsOf: (user) => [...(history[user.id] || []), ...(linked[user.id] ? [linked[user.id]] : [])],
      openedPull: (user, name, prNumber) =>
        sessions.some((s) => s.ownerId === user.id && s.repo === name && s.pr === prNumber),
    }),
  );
  const app = express();
  app.use(
    apiV1Routes({
      auth,
      users: { get: (id) => people.find((u) => u.id === id) || null, list: () => people },
      memberRepos: (user) => sharedRepos[user.id] || [],
      apiEnabled: () => true,
      ownerSecret: () => secret,
      handlers,
      getJob: () => null,
      getProject: (name) => projects[name] || null,
      listSessions: () => [],
      bus: { on() {}, off() {} },
    }),
  );
  // An agent reaches only its own routes on the handlers' router, as in server.js.
  app.use(express.json(), agentOnly(handlers));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const call = async (method, path, token, body) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const approve = (token, body = {}, number = 7) =>
  call('POST', `/api/v1/pulls/${number}/approvals`, token, { repo, headSha: head, ...body });
const withdraw = (token, id, body = {}) =>
  call('POST', `/api/v1/pulls/7/approvals/${id}/withdraw`, token, { repo, ...body });

describe('recording an approval', () => {
  it('stores who approved which revision, and answers the requirement computed after it', async () => {
    const res = await approve(tokens.ada, { note: '  Read the migration twice.  ' });
    expect(res.status).toBe(201);
    expect(approvals).toEqual([
      {
        id: 1,
        source: 'briareus',
        status: 'approved',
        userId: 1,
        approver: 'Ada',
        githubLogin: 'ada-dev',
        githubUserId: 101,
        headSha: head,
        baseRef: 'main',
        codeReviewId: 5,
        reviewOutcome: 'passed',
        note: 'Read the migration twice.',
        authorship: null,
      },
    ]);
    expect(res.body.approval).toMatchObject({ id: 1, by: { userId: 1, name: 'Ada' }, counted: true });
    expect(res.body.approvals.approvals).toHaveLength(1);
    expect(res.body.reviewOutcome.outcome).toBe('passed');
    // Computed for the revision before the approval was taken, and again after it.
    expect(refreshed).toEqual([
      { headSha: head, baseRef: 'main' },
      { headSha: head, baseRef: 'main' },
    ]);
  });

  it('records one approval however often the same request is sent', async () => {
    expect((await approve(tokens.ada)).status).toBe(201);
    const again = await approve(tokens.ada, { note: 'Sent twice' });
    expect(again.status).toBe(200);
    expect(again.body.approval.id).toBe(1);
    expect(approvals).toHaveLength(1);
    // Another person's is another approval.
    expect((await approve(tokens.grace)).status).toBe(201);
    expect(approvals.map((a) => a.userId)).toEqual([1, 2]);
  });

  it('is refused to anything but a person’s own manage token for the project', async () => {
    expect((await approve(null)).status).toBe(401);
    // A session's token is not a client token: the gateway does not know it.
    expect((await approve('session-token-of-a-running-agent')).status).toBe(401);
    expect(await approve(tokens.adaRead)).toEqual({
      status: 403,
      body: { error: 'This token has read-only access' },
    });
    expect((await approve(tokens.adaElsewhere)).status).toBe(403);
    // A project not shared with the member, whatever the token was issued with.
    expect((await approve(tokens.linus)).status).toBe(403);
    people[1].disabledAt = Date.now();
    expect((await approve(tokens.grace)).status).toBe(401);
    expect(approvals).toEqual([]);
  });

  it('cannot be reached by an agent going around the gateway', async () => {
    // By its own path the route is not an agent route at all.
    const direct = await call('POST', '/api/pr/approvals', 'session-token', { repo, pr: 7, headSha: head });
    expect(direct.status).toBe(404);
    // And the handlers themselves refuse a request that still carries a credential, or
    // that no user stands behind.
    const app = express();
    app.use(express.json(), handlers);
    const bare = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const at = `http://127.0.0.1:${bare.address().port}/api/pr/approvals`;
      const send = (headers) =>
        fetch(at, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ repo, pr: 7, headSha: head }),
        });
      const carrying = await send({ Authorization: 'Bearer session-token' });
      expect(carrying.status).toBe(403);
      expect((await carrying.json()).error).toMatch(/person’s own token/);
      const anonymous = await send({});
      expect(anonymous.status).toBe(401);
      expect(
        (await fetch(`${at}/1/withdraw`, { method: 'POST', headers: { Authorization: 'Bearer x' } })).status,
      ).toBe(403);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
    expect(approvals).toEqual([]);
  });

  it('has to name the head the pull request is at', async () => {
    const moved = await approve(tokens.ada, { headSha: next });
    expect(moved).toEqual({
      status: 409,
      body: {
        error: expect.stringMatching(/is at aaaaaaa, not at bbbbbbb/),
        code: 'head_moved',
        headSha: head,
      },
    });
    for (const headSha of [undefined, '', 'aaaaaaa', 'HEAD', 42, 'g'.repeat(40)]) {
      const res = await call('POST', '/api/v1/pulls/7/approvals', tokens.ada, { repo, headSha });
      expect(res.status).toBe(400);
    }
    expect((await approve(tokens.ada, { verdict: 'ok' })).body.error).toMatch(
      /Unknown approval fields: verdict/,
    );
    expect((await approve(tokens.ada, { note: 'x'.repeat(2001) })).status).toBe(400);
    expect((await approve(tokens.ada, { note: 7 })).status).toBe(400);
    expect((await approve(tokens.ada, {}, 0)).status).toBe(400);
    expect(approvals).toEqual([]);
  });

  it('is for a reviewed revision: not before a review covers it, nor while one runs', async () => {
    view = { reviewed: null, outcome: 'pending', reviewId: null, execution: null };
    const none = await approve(tokens.ada);
    expect(none).toMatchObject({ status: 409, body: { code: 'review_not_current' } });
    // Nothing is computed or stored for a pull request no review ever covered.
    expect(refreshed).toEqual([]);
    view = { reviewed: { headSha: next, baseRef: 'main' }, stale: true, outcome: 'pending' };
    const stale = await approve(tokens.ada);
    expect(stale).toMatchObject({
      status: 409,
      body: { code: 'review_not_current', error: expect.stringMatching(/covered bbbbbbb, not aaaaaaa/) },
    });
    view = { execution: 'running', outcome: 'pending' };
    expect(await approve(tokens.ada)).toMatchObject({ status: 409, body: { code: 'review_running' } });
    expect(approvals).toEqual([]);
    // A review that ended without passing can still be approved: the outcome says so itself.
    view = { outcome: 'changes_required' };
    expect((await approve(tokens.ada)).status).toBe(201);
    expect(approvals[0].reviewOutcome).toBe('changes_required');
  });

  it('needs the policy, an open pull request and GitHub', async () => {
    expect(
      await call('POST', '/api/v1/pulls/7/approvals', tokens.ada, { repo: 'acme/plain', headSha: head }),
    ).toMatchObject({
      status: 403,
    });
    projects[repo] = { id: 1, repo };
    expect(await approve(tokens.ada)).toMatchObject({ status: 409, body: { code: 'approvals_not_enabled' } });
    projects[repo] = { id: 1, repo, approvalPolicy: normalizeApprovalPolicy({ enabled: false }) };
    expect(await approve(tokens.ada)).toMatchObject({ status: 409, body: { code: 'approvals_not_enabled' } });
    projects[repo] = { id: 1, repo, approvalPolicy: normalizeApprovalPolicy({ enabled: true }) };
    pull = { ...pull, state: 'merged' };
    expect(await approve(tokens.ada)).toMatchObject({ status: 409, body: { code: 'pull_not_open' } });
    pull = new Error('GitHub answered 502 reading the pull request');
    expect(await approve(tokens.ada)).toMatchObject({ status: 502, body: { code: 'github_unreadable' } });
    expect(approvals).toEqual([]);
  });

  it('keeps an approval that landed when the computation after it fails', async () => {
    // The computation before the approval works, the one after it does not.
    failFrom = 2;
    const res = await approve(tokens.ada);
    expect(res.status).toBe(201);
    expect(approvals).toHaveLength(1);
    // Answered from the stored reading meanwhile.
    expect(res.body.approval).toMatchObject({ id: 1 });
  });
});

describe('approving one’s own change', () => {
  it('is refused for the author, for commits under one’s account and for commits one’s sessions made', async () => {
    risk.authors = written({ author: { id: 101, login: 'Ada-Dev' }, commits: [] });
    expect(await approve(tokens.ada)).toEqual({
      status: 403,
      body: {
        error:
          'You opened this pull request, and this project does not count an approval of one’s own change',
        code: 'own_change',
        authorship: 'author',
      },
    });
    risk.authors = written({
      commits: [
        { id: 900, login: 'octo-author' },
        { id: 101, login: 'ada-dev' },
      ],
    });
    expect(await approve(tokens.ada)).toMatchObject({ status: 403, body: { authorship: 'commits' } });
    // Grace's sessions commit as the server: what ties her to the change is the record
    // of the commits they made, whatever those sessions were started for.
    risk.authors = written();
    owners = [2];
    expect(await approve(tokens.grace)).toMatchObject({
      status: 403,
      body: {
        code: 'own_change',
        authorship: 'session',
        error: expect.stringMatching(/A session you own committed to this pull request/),
      },
    });
    // Or, for work from before commits were recorded, the session that opened it.
    owners = [];
    sessions = [{ ownerId: 2, repo, pr: 7 }];
    expect(await approve(tokens.grace)).toMatchObject({ status: 403, body: { authorship: 'session' } });
    expect(approvals).toEqual([]);
    // Somebody else's work, or hers on another pull request, is not hers on this one.
    owners = [3];
    sessions = [
      { ownerId: 1, repo, pr: 8 },
      { ownerId: 3, repo, pr: 7 },
    ];
    expect((await approve(tokens.grace)).status).toBe(201);
    expect((await approve(tokens.ada)).status).toBe(201);
  });

  it('cannot be got around by unlinking the account first', async () => {
    // Ada opened the pull request as ada-dev, then removed the account from Briareus.
    risk.authors = written({
      author: { id: 101, login: 'ada-dev' },
      commits: [{ id: 101, login: 'ada-dev' }],
    });
    history = { 1: [{ id: 101, login: 'ada-dev' }] };
    delete linked[1];
    // With no account linked nothing would tie her to anything: an approval needs one.
    expect(await approve(tokens.ada)).toMatchObject({
      status: 403,
      body: { code: 'github_account_required', error: expect.stringMatching(/Link your GitHub account/) },
    });
    // Linking another one does not help: the one she had is still hers.
    linked[1] = { id: 777, login: 'ada-second' };
    expect(await approve(tokens.ada)).toMatchObject({
      status: 403,
      body: { code: 'own_change', authorship: 'author' },
    });
    // Nor does renaming the account on GitHub: it is known by its id.
    linked[1] = { id: 101, login: 'ada-renamed' };
    history = {};
    expect(await approve(tokens.ada)).toMatchObject({ status: 403, body: { code: 'own_change' } });
    expect(approvals).toEqual([]);
  });

  it('needs a linked account wherever two records could be one person', async () => {
    delete linked[2];
    expect(await approve(tokens.grace)).toMatchObject({
      status: 403,
      body: { code: 'github_account_required' },
    });
    // Also where one's own change may be approved, once approvals on GitHub count too.
    projects[repo].approvalPolicy = normalizeApprovalPolicy({
      enabled: true,
      allowSelfApproval: true,
      acceptGithubApprovals: true,
    });
    expect(await approve(tokens.grace)).toMatchObject({
      status: 403,
      body: { code: 'github_account_required' },
    });
    // Not where neither rule is in play.
    projects[repo].approvalPolicy = normalizeApprovalPolicy({ enabled: true, allowSelfApproval: true });
    expect((await approve(tokens.grace)).status).toBe(201);
    expect(approvals[0]).toMatchObject({ userId: 2, githubLogin: null, githubUserId: null });
  });

  it('is recorded as such where the project allows it', async () => {
    projects[repo].approvalPolicy = normalizeApprovalPolicy({ enabled: true, allowSelfApproval: true });
    risk.authors = written({ author: { id: 101, login: 'ada-dev' } });
    expect((await approve(tokens.ada)).status).toBe(201);
    expect(approvals[0]).toMatchObject({ userId: 1, authorship: 'author' });
    // And taken without knowing who wrote the pull request, which then decides nothing.
    risk = null;
    expect((await approve(tokens.grace)).status).toBe(201);
    expect(approvals[1]).toMatchObject({ userId: 2, authorship: null });
  });

  it('is not taken when who wrote the pull request could not be read, and says when to ask again', async () => {
    risk = { headSha: head, authors: null, error: 'GitHub answered 502 reading the pull request’s commits' };
    expect(await approve(tokens.ada)).toEqual({
      status: 503,
      body: {
        code: 'authorship_unknown',
        error:
          'Briareus could not read who wrote this pull request from GitHub (GitHub answered 502 reading the pull request’s commits). It reads it again when you next ask, at most every 15 seconds',
        retryAfter: 15,
      },
    });
    // The computation before it was made as one a person waits on, which reads again.
    expect(asked).toEqual([true]);
    // What is stored is of another head.
    risk = { headSha: next, authors: written() };
    expect((await approve(tokens.ada)).status).toBe(503);
    risk = null;
    expect((await approve(tokens.ada)).status).toBe(503);
    expect(approvals).toEqual([]);
  });

  it('is not taken when the pull request has more commits than GitHub lists', async () => {
    risk.authors = written({ complete: false });
    expect(await approve(tokens.ada)).toMatchObject({
      status: 409,
      body: {
        code: 'authorship_incomplete',
        error: expect.stringMatching(/more commits than GitHub lists \(250\)/),
      },
    });
    expect(approvals).toEqual([]);
  });
});

describe('withdrawing an approval', () => {
  beforeEach(async () => {
    await approve(tokens.ada);
    await approve(tokens.grace);
    refreshed = [];
  });

  it('is the approver’s own to do, is recorded, and is computed at once', async () => {
    const res = await withdraw(tokens.ada, 1, { note: 'Missed the index' });
    expect(res.status).toBe(200);
    expect(approvals[0]).toMatchObject({ id: 1, status: 'withdrawn', withdrawNote: 'Missed the index' });
    expect(res.body.approval).toMatchObject({
      id: 1,
      counted: false,
      reason: 'withdrawn',
      withdrawNote: 'Missed the index',
    });
    expect(res.body.approvals.approvals.map((a) => a.counted)).toEqual([false, true]);
    expect(refreshed).toEqual([null]);
    // Again changes nothing.
    expect((await withdraw(tokens.ada, 1)).status).toBe(200);
    expect(approvals[0].withdrawNote).toBe('Missed the index');
    // And the person can approve the same revision anew.
    expect((await approve(tokens.ada)).status).toBe(201);
    expect(approvals.map((a) => [a.userId, a.status])).toEqual([
      [1, 'withdrawn'],
      [2, 'approved'],
      [1, 'approved'],
    ]);
  });

  it('is nobody else’s, an admin’s included', async () => {
    // Ada is an admin; the approval is Grace's.
    expect(await withdraw(tokens.ada, 2)).toEqual({
      status: 403,
      body: { error: 'Only the person who gave an approval can withdraw it', code: 'not_yours' },
    });
    expect((await withdraw(tokens.adaRead, 1)).status).toBe(403);
    expect((await withdraw('session-token', 1)).status).toBe(401);
    expect(approvals.map((a) => a.status)).toEqual(['approved', 'approved']);
  });

  it('answers what it cannot withdraw', async () => {
    expect(await withdraw(tokens.ada, 99)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    approvals.push({
      id: 3,
      source: 'github',
      userId: null,
      githubLogin: 'octo-reviewer',
      status: 'approved',
      headSha: head,
    });
    expect(await withdraw(tokens.ada, 3)).toMatchObject({ status: 409, body: { code: 'github_approval' } });
    expect((await withdraw(tokens.ada, 'x')).status).toBe(400);
    expect((await withdraw(tokens.ada, 1, { reason: 'typo' })).body.error).toMatch(
      /Unknown approval fields: reason/,
    );
  });
});

describe('reading the requirement', () => {
  it('answers it with the outcome, to anybody who may read the project', async () => {
    await approve(tokens.grace);
    const res = await call(
      'GET',
      `/api/v1/pulls/7/approvals?repo=${encodeURIComponent(repo)}`,
      tokens.adaRead,
    );
    expect(res.status).toBe(200);
    expect(res.body.approvals).toEqual(res.body.reviewOutcome.approvals);
    expect(res.body.approvals.approvals).toHaveLength(1);
    expect(
      (await call('GET', `/api/v1/pulls/7/approvals?repo=${encodeURIComponent(repo)}`, tokens.linus)).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/v1/pulls/7/approvals?repo=acme%2Fother', tokens.adaElsewhere)).status,
    ).toBe(404);
    expect(
      (await call('GET', `/api/v1/pulls/zero/approvals?repo=${encodeURIComponent(repo)}`, tokens.ada)).status,
    ).toBe(400);
  });
});
