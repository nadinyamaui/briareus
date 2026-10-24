import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { operationsRoutes } from '../lib/operations-routes.js';
import { setDraining } from '../lib/recovery.js';

afterEach(() => setDraining(false));

async function serve(deps, user = { id: 1, role: 'admin' }, repos = null) {
  const app = express();
  app.use(express.json());
  // The user and projects /api/v1 resolved the token to.
  app.use((_req, res, next) => {
    res.locals.apiUser = user;
    res.locals.apiRepos = repos;
    next();
  });
  app.use(
    operationsRoutes({
      listSessions: () => [{ id: 's', status: 'failed' }],
      ssh: { pending: () => [], runningCount: () => 0 },
      getJob: () => null,
      sendMessage: () => null,
      ...deps,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { body, headers = {} } = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

it('only exposes operator projections to browser requests', async () => {
  const { call, close } = await serve();
  try {
    expect((await (await call('/api/operations/attention')).json()).items[0].kind).toBe('recovery');
    const bearer = { authorization: 'Bearer internal' };
    expect((await call('/api/operations/attention', { headers: bearer })).status).toBe(403);
    expect((await call('/api/operations/maintenance', { headers: bearer })).status).toBe(403);
    expect(
      (await call('/api/operations/maintenance', { body: { draining: true }, headers: bearer })).status,
    ).toBe(403);
    expect((await call('/api/operations/recovery/s', { headers: bearer })).status).toBe(403);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: 'x' }, headers: bearer })).status,
    ).toBe(403);
  } finally {
    await close();
  }
});

it('toggles draining only on a boolean', async () => {
  const { call, close } = await serve();
  try {
    expect((await call('/api/operations/maintenance', { body: { draining: 'yes' } })).status).toBe(400);
    expect((await (await call('/api/operations/maintenance')).json()).draining).toBe(false);
    const on = await (await call('/api/operations/maintenance', { body: { draining: true } })).json();
    expect(on).toMatchObject({ draining: true, ready: true });
    expect(on.active).toEqual([]);
  } finally {
    await close();
  }
});

it('resumes only the recovery report the operator saw, and never while draining', async () => {
  const job = { id: 's', kind: 'devchat', status: 'interrupted', orchestrator: true, chatStarted: true };
  const sendMessage = vi.fn(() => ({ id: 's' }));
  const { call, close } = await serve({ getJob: (id) => (id === 's' ? job : null), sendMessage });
  try {
    const report = await (await call('/api/operations/recovery/s')).json();
    expect(report.canResume).toBe(true);
    expect((await call('/api/operations/recovery/s', { body: { fingerprint: 'stale' } })).status).toBe(409);
    expect((await call('/api/operations/recovery/nope', { body: {} })).status).toBe(400);
    setDraining(true);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: report.fingerprint } })).status,
    ).toBe(400);
    setDraining(false);
    // A turn under way cannot be resumed, whatever fingerprint is sent.
    job.status = 'running';
    const busy = await (await call('/api/operations/recovery/s')).json();
    expect(busy.canResume).toBe(false);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: busy.fingerprint } })).status,
    ).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
    job.status = 'interrupted';
    // A conversation that never started has nothing a resume prompt could
    // point back to.
    job.chatStarted = false;
    const unstarted = await (await call('/api/operations/recovery/s')).json();
    expect(unstarted.canResume).toBe(false);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: unstarted.fingerprint } })).status,
    ).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
    job.chatStarted = true;
    const ok = await call('/api/operations/recovery/s', { body: { fingerprint: report.fingerprint } });
    expect(ok.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('s', expect.stringContaining('Resume the interrupted task'));
  } finally {
    await close();
  }
});

it('shows a member only what waits on them', async () => {
  const sessions = [
    { id: 'mine', repo: 'o/a', status: 'failed', ownerId: 2 },
    { id: 'theirs', repo: 'o/a', status: 'failed', ownerId: 3 },
    { id: 'ownerless', repo: 'o/a', status: 'failed', ownerId: null },
    { id: 'outside', repo: 'o/b', status: 'failed', ownerId: 2 },
  ];
  const ssh = {
    pending: () => [
      { id: 'r1', jobId: 'mine', repo: 'o/a', status: 'pending', createdAt: 1 },
      { id: 'r2', jobId: 'theirs', repo: 'o/a', status: 'pending', createdAt: 1 },
      { id: 'r3', jobId: 'outside', repo: 'o/b', status: 'pending', createdAt: 1 },
    ],
    runningCount: () => 0,
  };
  const slack = {
    pending: vi.fn(() => [
      { id: 'm1', jobId: 'mine', repo: 'o/a', to: { label: 'Me' }, createdAt: 1 },
      { id: 'm2', jobId: 'outside', repo: 'o/b', to: { label: 'Me' }, createdAt: 1 },
    ]),
  };
  const { call, close } = await serve(
    {
      listSessions: () => sessions,
      ssh,
      slack,
      sshVisible: (_user, request) => request.jobId !== 'theirs',
    },
    { id: 2, role: 'member' },
    ['o/a'],
  );
  try {
    const { items } = await (await call('/api/operations/attention')).json();
    expect([...new Set(items.map((i) => i.sessionId))].sort()).toEqual(['mine', 'ownerless']);
    expect(items.filter((i) => i.kind === 'ssh').map((i) => i.id)).toEqual(['ssh:r1']);
    expect(items.filter((i) => i.kind === 'slack').map((i) => i.id)).toEqual(['slack:m1']);
    expect(slack.pending).toHaveBeenCalledWith(2);
  } finally {
    await close();
  }
});

it.each(['admin', 'member'])('keeps cross-project supervisor context for a %s', async (role) => {
  const supervisor = {
    id: 'supervisor',
    repo: 'client/app',
    ownerId: 2,
    orchestrator: true,
    status: 'idle',
    awaitingAnswer: true,
  };
  const worker = {
    id: 'worker',
    repo: 'team/briareus',
    ownerId: 2,
    parentId: supervisor.id,
    status: 'failed',
    awaitingAnswer: true,
    noticeUnheard: false,
    reviewLoop: { failure: { reason: 'quota' }, stalled: true },
    qaLoop: { failedScenarios: 1, verdictError: 'sheet 404' },
  };
  const { call, close } = await serve({ listSessions: () => [supervisor, worker] }, { id: 2, role }, [
    'team/briareus',
  ]);
  try {
    expect((await (await call('/api/operations/attention')).json()).items).toEqual([]);

    const workerItems = [
      'worker:question',
      'worker:recovery',
      'worker:review-failed',
      'worker:review-stalled',
      'worker:qa-failed',
      'worker:qa-verdict',
    ];
    worker.noticeUnheard = true;
    expect((await (await call('/api/operations/attention')).json()).items.map((item) => item.id)).toEqual(
      workerItems,
    );

    worker.noticeUnheard = false;
    supervisor.status = 'closed';
    expect((await (await call('/api/operations/attention')).json()).items.map((item) => item.id)).toEqual(
      workerItems,
    );
  } finally {
    await close();
  }
});
