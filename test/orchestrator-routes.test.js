import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerTranscript } from '../lib/worker-transcript.js';
import { orchestratorRoutes } from '../lib/orchestrator-routes.js';

let server, base, worker, setQaLoop, child, sendDevMessage, jobEventsFor;
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
  const routes = orchestratorRoutes({
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
