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
let deleteJobById, eligibleWorkerProjects;
beforeEach(async () => {
  worker = {
    id: 'w1',
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
  const sessions = { o1: { id: 'o1', orchestrator: true }, o2: { id: 'o2', orchestrator: true }, w1: worker };
  startOrchestratorPrAction = vi.fn(async () => worker);
  spawnWorkerSession = vi.fn((parent, opts) => ({ ...worker, ...opts, parentId: parent.id }));
  deleteJobById = vi.fn(async () => {
    worker.parentId = null;
    return true;
  });
  eligibleWorkerProjects = vi.fn(() => [{ id: 1, name: 'Shop', repo: 'acme/shop', enabled: true }]);
  const routes = orchestratorRoutes({
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
    getJob: (id) => (id === child.id ? child : null),
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
  app.delete('/api/agent/sessions/:id', routes.deleteWorker);
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
