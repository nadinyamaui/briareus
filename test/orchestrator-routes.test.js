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
beforeEach(async () => {
  worker = {
    id: 'w1',
    parentId: 'o1',
    qaLoop: { running: false, sessionId: null },
    reviewLoop: { reviewing: true },
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
  const routes = orchestratorRoutes({
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
  app.post('/api/agent/sessions/pr-actions', routes.prAction);
  app.post('/api/agent/sessions', routes.spawn);
  app.post('/api/agent/sessions/:id/qa-loop', routes.qaLoop);
  app.get('/api/agent/sessions/:id/question', routes.readQuestion);
  app.post('/api/agent/sessions/:id/question', routes.answerQuestion);
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
      reviewLoop: true,
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
        reviewLoop: true,
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
      session: { reviewLoop: { reviewing: true } },
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

const readQuestion = (token = 'o1', id = 'w1') =>
  fetch(`${base}/${id}/question?tail=4&full_text=true`, { headers: { Authorization: `Bearer ${token}` } });
const answerQuestion = (body = {}, token = 'o1', id = 'w1') =>
  fetch(`${base}/${id}/question`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId: 'f1', questionSeq: 9, text: 'Use option one', ...body }),
  });

describe('owning worker question proxy', () => {
  it('reads its current fix question and answers only that question as an unattended instruction', async () => {
    expect(await (await readQuestion()).json()).toMatchObject({
      question: { childId: 'f1', questionSeq: 9, role: 'fix', answerable: true },
      events: [{ question: 'Which option?' }],
    });
    expect((await answerQuestion()).status).toBe(200);
    expect(sendDevMessage).toHaveBeenCalledExactlyOnceWith('f1', 'Use option one', undefined, {
      instruction: true,
    });
    expect((await answerQuestion()).status).toBe(409);
    expect(sendDevMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['invalid', 'w1', 401],
    ['w1', 'w1', 403],
    ['o2', 'w1', 404],
    ['o1', 'f1', 404],
  ])('denies both reads and answers for %s on %s', async (token, id, status) => {
    expect((await readQuestion(token, id)).status).toBe(status);
    expect((await answerQuestion({}, token, id)).status).toBe(status);
    expect(jobEventsFor).not.toHaveBeenCalled();
    expect(sendDevMessage).not.toHaveBeenCalled();
  });
  it.each([
    { loopFixParentId: 'other' },
    { repo: 'other/repo' },
    { status: 'closed' },
    { awaitingAnswer: false },
    { id: 'old-child' },
  ])('denies unavailable/unrelated children: %s', async (change) => {
    Object.assign(child, change);
    expect((await readQuestion()).status).toBe(409);
    expect((await answerQuestion()).status).toBe(409);
    expect(sendDevMessage).not.toHaveBeenCalled();
  });
  it.each([{ childId: 'stale' }, { questionSeq: 8 }, { questionSeq: '9' }])(
    'refuses stale answer tokens: %s',
    async (body) => {
      expect((await answerQuestion(body)).status).toBe(409);
      expect(sendDevMessage).not.toHaveBeenCalled();
    },
  );
  it.each(['running', 'interrupted', 'failed'])(
    'allows reading but refuses resuming a %s child',
    async (status) => {
      child.status = status;
      expect(await (await readQuestion()).json()).toMatchObject({ question: { status, answerable: false } });
      expect((await answerQuestion()).status).toBe(409);
      expect(sendDevMessage).not.toHaveBeenCalled();
    },
  );
  it('reads a closing child as non-answerable and rejects its answer', async () => {
    child.closing = true;
    expect(await (await readQuestion()).json()).toMatchObject({ question: { answerable: false } });
    expect((await answerQuestion()).status).toBe(409);
    expect(sendDevMessage).not.toHaveBeenCalled();
  });
  it('refuses a question replaced during transcript loading', async () => {
    jobEventsFor.mockImplementation(async () => {
      child.questionSeq++;
      return [];
    });
    expect((await readQuestion()).status).toBe(409);
  });
  it.each(['', '  ', '/btw bypass', null, 3])('refuses invalid answer %s', async (text) => {
    expect((await answerQuestion({ text })).status).toBe(400);
    expect(sendDevMessage).not.toHaveBeenCalled();
  });
  it('does not authorize QA or arbitrary descendants', async () => {
    worker.reviewLoop = null;
    worker.qaLoop = { running: true, sessionId: child.id };
    expect((await readQuestion()).status).toBe(409);
    expect((await answerQuestion()).status).toBe(409);
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
});
