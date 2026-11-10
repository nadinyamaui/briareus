import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerTranscript } from '../lib/worker-transcript.js';
import { orchestratorRoutes } from '../lib/orchestrator-routes.js';

let server,
  base,
  worker,
  setQaLoop,
  child,
  sendDevMessage,
  jobEventsFor,
  startOrchestratorPrAction,
  spawnWorkerSession;
let deleteJobById, eligibleWorkerProjects, reopenDevSession, assertWorkerSlot;
let sessions, foreign, closeDevSession, noteSession, ownerManages;
beforeEach(async () => {
  worker = {
    id: 'w1',
    kind: 'devchat',
    parentId: 'o1',
    qaLoop: { running: false, sessionId: null },
  };
  child = {
    id: 'f1',
    kind: 'devchat',
    repo: 'own/repo',
    loopFixParentId: 'w1',
    status: 'idle',
    awaitingAnswer: true,
    questionSeq: 9,
  };
  worker.repo = child.repo;
  worker.reviewLoop = { fixing: true, fixSessionId: child.id, reviewing: true };
  sendDevMessage = vi.fn(() => {
    child.awaitingAnswer = false;
    child.status = 'running';
  });
  jobEventsFor = vi.fn(async () => [{ kind: 'ask', question: 'Which option?', seq: 9 }]);
  setQaLoop = vi.fn((_id, on) => {
    worker.qaLoop = on ? { running: false } : null;
  });
  sessions = { o1: { id: 'o1', orchestrator: true }, o2: { id: 'o2', orchestrator: true }, w1: worker };
  // A session the user started by hand, holding a pull request in the orchestrator's project.
  foreign = { id: 's1', kind: 'devchat', repo: 'own/repo', status: 'idle', parentId: null };
  closeDevSession = vi.fn(async (id) => {
    if (id === foreign.id) foreign.status = 'closed';
  });
  noteSession = vi.fn();
  ownerManages = vi.fn(() => true);
  startOrchestratorPrAction = vi.fn(async () => worker);
  spawnWorkerSession = vi.fn((parent, opts) => ({ ...worker, ...opts, parentId: parent.id }));
  deleteJobById = vi.fn(async () => {
    worker.parentId = null;
    return true;
  });
  eligibleWorkerProjects = vi.fn(() => [{ id: 1, name: 'Shop', repo: 'acme/shop', enabled: true }]);
  assertWorkerSlot = vi.fn();
  reopenDevSession = vi.fn(() => {
    worker.status = 'preparing';
  });
  const routes = orchestratorRoutes({
    assertWorkerSlot,
    reopenDevSession,
    eligibleWorkerProjects,
    deleteJobById,
    startOrchestratorPrAction,
    spawnWorkerSession,
    agentSession(req, res) {
      const job = sessions[req.headers.authorization?.replace('Bearer ', '')];
      if (!job) res.status(401).json({ error: 'Invalid session token' });
      return job;
    },
    workerSessionsFor: (orchestrator) => (worker.parentId === orchestrator.id ? [worker] : []),
    setQaLoop,
    getJob: (id) => (id === child.id ? child : id === foreign.id ? foreign : sessions[id] || null),
    closeDevSession,
    noteSession,
    ownerManages,
    workerTranscript,
    jobEventsFor,
    sendDevMessage,
    workerSummary: (job) => job,
  });
  const app = express();
  app.use(express.json());
  app.get('/api/agent/sessions/projects', routes.projects);
  app.post('/api/agent/sessions/pr-actions', routes.prAction);
  app.post('/api/agent/sessions', routes.spawn);
  app.post('/api/agent/sessions/:id/qa-loop', routes.qaLoop);
  app.post('/api/agent/sessions/:id/reopen', routes.reopenWorker);
  app.delete('/api/agent/sessions/:id', routes.deleteWorker);
  app.post('/api/agent/sessions/:id/close', routes.closeSession);
  app.get('/api/agent/sessions', (req, res) => {
    const parent = routes.orchestratorSession(req, res);
    if (parent) res.json({ sessions: worker.parentId === parent.id ? [worker] : [] });
  });
  app.get('/api/agent/sessions/:id', (req, res) => {
    const parent = routes.orchestratorSession(req, res);
    if (!parent) return;
    const found = routes.workerOf(req, res, parent);
    if (found) res.json({ session: found });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/agent/sessions`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const post = (body, token = 'o1', id = 'w1') =>
  fetch(`${base}/${id}/qa-loop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const spawnWorker = (body, token = 'o1') =>
  fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('scoped task worker reopening', () => {
  const reopen = (token = 'o1', id = 'w1', body = {}) =>
    fetch(`${base}/${id}/reopen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    worker.status = 'closed';
    worker.activity = 'worker';
  });
  it.each([
    ['invalid', 'w1', 401],
    ['w1', 'w1', 403],
    ['o2', 'w1', 404],
    ['o1', 'o1', 404],
    ['o1', 'missing', 404],
  ])('rejects %s reopening %s', async (token, id, status) => {
    expect((await reopen(token, id)).status).toBe(status);
    expect(reopenDevSession).not.toHaveBeenCalled();
    expect(assertWorkerSlot).not.toHaveBeenCalled();
  });
  it.each(['idle', 'preparing', 'running', 'failed', 'interrupted'])(
    'rejects a %s worker',
    async (status) => {
      worker.status = status;
      expect((await reopen()).status).toBe(409);
      expect(reopenDevSession).not.toHaveBeenCalled();
    },
  );
  it.each([
    { closing: true },
    { closePending: true },
    { qaBranch: 'feature' },
    { autoClose: true },
    { local: true },
    { orchestrator: true },
    { activity: 'review' },
    { activity: 'solve-conflicts' },
  ])('rejects an ineligible worker: %j', async (fields) => {
    Object.assign(worker, fields);
    expect((await reopen()).ok).toBe(false);
    expect(reopenDevSession).not.toHaveBeenCalled();
  });
  it.each(['own/repo', 'authorized/companion'])(
    'prepares the existing %s worker without accepting configuration overrides',
    async (repo) => {
      worker.repo = repo;
      worker.lastText = 'Implementation finished';
      const res = await reopen('o1', 'w1', {
        repo: 'foreign/repo',
        ownerId: 99,
        model: 'override',
        recovering: true,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        session: { id: 'w1', repo, status: 'preparing', lastText: 'Implementation finished' },
        preparing: true,
        qaReady: false,
        messageSent: false,
      });
      expect(assertWorkerSlot).toHaveBeenCalledExactlyOnceWith({ id: 'o1', orchestrator: true });
      expect(reopenDevSession).toHaveBeenCalledExactlyOnceWith('w1');
      expect(setQaLoop).not.toHaveBeenCalled();
      expect(sendDevMessage).not.toHaveBeenCalled();
      expect((await reopen()).status).toBe(409);
      worker.status = 'idle';
      expect((await post({ on: true })).status).toBe(200);
      expect(setQaLoop).toHaveBeenCalledExactlyOnceWith('w1', true);
    },
  );
  it('applies the worker cap before reclaiming resources', async () => {
    assertWorkerSlot.mockImplementation(() => {
      throw new Error('close one before starting another');
    });
    expect((await reopen()).status).toBe(400);
    expect(reopenDevSession).not.toHaveBeenCalled();
  });
  it.each([400, 503])('surfaces lifecycle/project-access refusal %s without retry', async (status) => {
    reopenDevSession.mockImplementation(() => {
      throw Object.assign(new Error('Project unavailable'), { status });
    });
    const res = await reopen();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'Project unavailable' });
    expect(reopenDevSession).toHaveBeenCalledTimes(1);
    expect(worker.status).toBe('closed');
  });
});

describe('scoped worker deletion', () => {
  const remove = (token = 'o1', id = 'w1') =>
    fetch(`${base}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  it.each([
    ['invalid', 'w1', 401],
    ['w1', 'w1', 403],
    ['o2', 'w1', 404],
    ['o1', 'o1', 404],
    ['o1', 'missing', 404],
  ])('refuses %s deleting %s', async (token, id, status) => {
    expect((await remove(token, id)).status).toBe(status);
    expect(deleteJobById).not.toHaveBeenCalled();
  });
  it.each(['own/repo', 'authorized/companion'])(
    'deletes an owned worker on %s through the lifecycle',
    async (repo) => {
      worker.repo = repo;
      worker.status = 'closed';
      expect(await (await remove()).json()).toEqual({ ok: true });
      expect(deleteJobById).toHaveBeenCalledExactlyOnceWith('w1', { closedOnly: true });
      const headers = { Authorization: 'Bearer o1' };
      expect((await fetch(`${base}/w1`, { headers })).status).toBe(404);
      expect(await (await fetch(base, { headers })).json()).toEqual({ sessions: [] });
      expect((await remove()).status).toBe(404);
      expect(deleteJobById).toHaveBeenCalledTimes(1);
    },
  );
  it.each([409, 503, 502])('returns lifecycle refusal %s without retrying', async (status) => {
    deleteJobById.mockRejectedValue(Object.assign(new Error('refused'), { status }));
    const res = await remove();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'refused' });
    expect(deleteJobById).toHaveBeenCalledTimes(1);
  });
});

describe('closing sessions', () => {
  const close = (token = 'o1', id = 's1', query = '') =>
    fetch(`${base}/${id}/close${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  beforeEach(() => {
    Object.assign(sessions.o1, { kind: 'devchat', repo: 'Own/Repo', title: 'Weekly work' });
    Object.assign(sessions.o2, { kind: 'devchat', repo: 'other/repo' });
  });
  it('closes an own worker without a note, whatever its project', async () => {
    worker.repo = 'authorized/companion';
    const res = await close('o1', 'w1');
    expect(res.status).toBe(200);
    expect((await res.json()).session.id).toBe('w1');
    expect(closeDevSession).toHaveBeenCalledExactlyOnceWith('w1');
    expect(noteSession).not.toHaveBeenCalled();
    expect(ownerManages).not.toHaveBeenCalled();
  });
  it('closes a session of its own project it did not start, and says so in its transcript', async () => {
    const res = await close();
    expect(res.status).toBe(200);
    expect((await res.json()).session).toMatchObject({ id: 's1', status: 'closed' });
    expect(ownerManages).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }), foreign);
    expect(noteSession).toHaveBeenCalledExactlyOnceWith(
      's1',
      'Closed by orchestrator session o1 (Weekly work).',
    );
    expect(closeDevSession).toHaveBeenCalledExactlyOnceWith('s1');
  });
  it('leaves an already closed session without a second note', async () => {
    foreign.status = 'closed';
    expect((await close()).status).toBe(200);
    expect(noteSession).not.toHaveBeenCalled();
  });
  it('answers only the id and status of a session that is not its worker', async () => {
    Object.assign(foreign, { title: 'Private title', lastText: 'secret' });
    expect(await (await close()).json()).toEqual({ session: { id: 's1', status: 'closed' } });
  });
  it('notes nothing while a close already under way finishes', async () => {
    foreign.closePending = true;
    expect((await close()).status).toBe(200);
    expect(closeDevSession).toHaveBeenCalledExactlyOnceWith('s1');
    expect(noteSession).not.toHaveBeenCalled();
  });
  it('keeps close_worker to its own workers', async () => {
    expect((await close('o1', 'w1', '?worker=1')).status).toBe(200);
    expect((await close('o1', 's1', '?worker=1')).status).toBe(404);
    expect(closeDevSession).toHaveBeenCalledExactlyOnceWith('w1');
  });
  it.each([
    ['an unattended session, whose close deletes it', { autoClose: true }],
    ['another orchestrator', { orchestrator: true }],
  ])('refuses %s', async (_label, fields) => {
    Object.assign(foreign, fields);
    expect((await close()).status).toBe(404);
    expect(closeDevSession).not.toHaveBeenCalled();
  });
  it.each([
    ['invalid', 's1', 401],
    ['w1', 's1', 403],
    // Another project's orchestrator, the orchestrator itself, and ids that match nothing.
    ['o2', 's1', 404],
    ['o1', 'o1', 404],
    ['o1', 'o2', 404],
    ['o1', 'missing', 404],
  ])('refuses %s closing %s', async (token, id, status) => {
    expect((await close(token, id)).status).toBe(status);
    expect(closeDevSession).not.toHaveBeenCalled();
    expect(noteSession).not.toHaveBeenCalled();
  });
  it('refuses a session its owner could not close, with the answer a missing one gets', async () => {
    ownerManages.mockReturnValue(false);
    const refused = await close();
    const missing = await close('o1', 'missing');
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.replace('s1', 'missing')).toBe((await missing.json()).error);
    expect(closeDevSession).not.toHaveBeenCalled();
  });
  it('refuses a session that is not a dev session', async () => {
    foreign.kind = 'review';
    expect((await close()).status).toBe(404);
    expect(closeDevSession).not.toHaveBeenCalled();
  });
  it('reports a failed close', async () => {
    closeDevSession.mockRejectedValue(new Error('database drop failed'));
    const res = await close();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'database drop failed' });
    expect(noteSession).not.toHaveBeenCalled();
  });
});

describe('scoped worker spawning', () => {
  it.each([
    ['invalid', 401],
    ['w1', 403],
  ])('refuses %s before spawning', async (token, status) => {
    expect((await spawnWorker({ prompt: 'x', repo: 'companion/repo' }, token)).status).toBe(status);
    expect(spawnWorkerSession).not.toHaveBeenCalled();
  });

  it('forwards the target and loop options without allowing ownership injection', async () => {
    const res = await spawnWorker({
      title: 'Companion',
      prompt: 'x',
      repo: 'companion/repo',
      branch: 'stack-base',
      qaLoop: true,
      ownerId: 99,
      parentId: 'o2',
    });
    expect(res.status).toBe(201);
    expect(spawnWorkerSession).toHaveBeenCalledExactlyOnceWith(
      { id: 'o1', orchestrator: true },
      {
        title: 'Companion',
        prompt: 'x',
        repo: 'companion/repo',
        branch: 'stack-base',
        qaLoop: true,
        tooling: false,
        providerId: undefined,
        model: undefined,
        effort: undefined,
      },
    );
    expect(await res.json()).toMatchObject({ session: { repo: 'companion/repo', parentId: 'o1' } });
  });

  it('forwards the branch a stacked worker cuts its own off', async () => {
    const res = await spawnWorker({ title: 'UI', prompt: 'x', stackOn: 'dev-lower' });
    expect(res.status).toBe(201);
    expect(spawnWorkerSession.mock.lastCall[1]).toMatchObject({ stackOn: 'dev-lower', branch: undefined });
  });

  it('leaves repo omitted for default and tooling spawns', async () => {
    for (const tooling of [false, true]) {
      expect((await spawnWorker({ prompt: 'x', tooling })).status).toBe(201);
      expect(spawnWorkerSession.mock.lastCall[1]).toMatchObject({ repo: undefined, tooling });
    }
  });

  it.each(['Unknown or disabled project', 'Project unavailable for the user who owns this session'])(
    'returns a refused target without retry or fallback: %s',
    async (error) => {
      spawnWorkerSession.mockImplementation(() => {
        throw new Error(error);
      });
      const res = await spawnWorker({ prompt: 'x', repo: 'companion/repo' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
      expect(spawnWorkerSession).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the scoped worker QA toggle', () => {
  it.each([
    ['invalid', 'w1', 401],
    ['w1', 'w1', 403],
    ['o2', 'w1', 404],
    ['o1', 'o2', 404],
    ['o1', 'missing', 404],
  ])('isolates %s from %s', async (token, id, status) => {
    expect((await post({ on: false }, token, id)).status).toBe(status);
    expect(setQaLoop).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'false', 0, 1, {}, []])('rejects invalid on: %s', async (on) => {
    expect((await post({ on })).status).toBe(400);
    expect(setQaLoop).not.toHaveBeenCalled();
  });
  it.each([true, false])('delegates on: %s to the existing state transition', async (on) => {
    const res = await post({ on });
    expect(res.status).toBe(200);
    expect(setQaLoop).toHaveBeenCalledExactlyOnceWith('w1', on);
    expect(await res.json()).toMatchObject({
      session: {},
      qaStillRunning: false,
      qaSessionId: null,
    });
  });
  it('reports the QA child that disarming leaves running', async () => {
    worker.qaLoop = { running: true, sessionId: 'qa-child' };
    expect(await (await post({ on: false })).json()).toMatchObject({
      session: { qaLoop: null },
      qaStillRunning: true,
      qaSessionId: 'qa-child',
    });
  });
  it('reports the active QA child after a newer push moves its ID', async () => {
    worker.qaLoop = { running: true, sessionId: null, staleSessionId: 'qa-before-push' };
    expect(await (await post({ on: false })).json()).toMatchObject({
      session: { qaLoop: null },
      qaStillRunning: true,
      qaSessionId: 'qa-before-push',
    });
  });
  it.each([400, 503])('surfaces a state or maintenance refusal (%s)', async (status) => {
    setQaLoop.mockImplementation(() => {
      throw Object.assign(new Error('refused'), { status });
    });
    const res = await post({ on: true });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'refused' });
  });
});

describe('scoped PR action route', () => {
  const action = (token, body) =>
    fetch(`${base}/pr-actions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  it.each([
    ['invalid', 401],
    ['w1', 403],
  ])('rejects %s tokens', async (token, status) => {
    expect((await action(token, { action: 'review', prNumber: 1 })).status).toBe(status);
    expect(startOrchestratorPrAction).not.toHaveBeenCalled();
  });
  it('forwards only action, PR and scope assertion, preserving the authenticated parent', async () => {
    const response = await action('o1', {
      action: 'review',
      prNumber: 12,
      repo: 'own/repo',
      provider: 999,
      model: 'unapproved',
      ownerId: 999,
      parentId: 'o2',
      prompt: 'bypass',
    });
    expect(response.status).toBe(201);
    expect(startOrchestratorPrAction).toHaveBeenCalledExactlyOnceWith(
      { id: 'o1', orchestrator: true },
      { action: 'review', prNumber: 12, repo: 'own/repo' },
    );
    expect(await response.json()).toEqual({ session: worker });
  });
  it('preserves explicit scope and validation failures', async () => {
    startOrchestratorPrAction.mockRejectedValue(Object.assign(new Error('wrong project'), { status: 403 }));
    expect((await action('o1', { action: 'review', prNumber: 12, repo: 'other/repo' })).status).toBe(403);
  });
  it.each([
    'This pull request already has an open session',
    'This pull request already has an open session. Blocking session: {"id":"review-1","status":"idle","activity":"review","title":"Review feature","provider":"codex","model":"configured"}',
  ])('preserves a concurrency refusal verbatim: %s', async (message) => {
    startOrchestratorPrAction.mockRejectedValue(Object.assign(new Error(message), { status: 409 }));
    const response = await action('o1', { action: 'review', prNumber: 12 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: message });
  });
});

describe('eligible worker project discovery', () => {
  it.each([
    ['bad', 401],
    ['w1', 403],
  ])('rejects token %s', async (token, status) => {
    const response = await fetch(`${base}/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(status);
    expect(eligibleWorkerProjects).not.toHaveBeenCalled();
  });
  it('returns eligible metadata only for the authenticated orchestrator', async () => {
    const response = await fetch(`${base}/projects`, { headers: { Authorization: 'Bearer o1' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [{ id: 1, name: 'Shop', repo: 'acme/shop', enabled: true }],
    });
    expect(eligibleWorkerProjects).toHaveBeenCalledExactlyOnceWith({ id: 'o1', orchestrator: true });
  });
});
