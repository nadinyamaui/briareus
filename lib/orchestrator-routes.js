// @ts-check

import { workerQuestion, workerReviewChild } from './worker-question.js';

// Agent tokens grant a supervisor authority over only its own workers.
export function orchestratorRoutes({
  agentSession,
  workerSessionsFor,
  setQaLoop,
  workerSummary,
  getJob,
  workerTranscript,
  jobEventsFor,
  sendDevMessage,
}) {
  function orchestratorSession(req, res) {
    const job = agentSession(req, res);
    if (!job) return null;
    if (!job.orchestrator) {
      res.status(403).json({ error: 'Only an orchestrator session can manage worker sessions' });
      return null;
    }
    return job;
  }

  function workerOf(req, res, orchestrator) {
    const worker = workerSessionsFor(orchestrator).find((j) => j.id === req.params.id);
    if (!worker) {
      res.status(404).json({ error: `No worker session ${req.params.id} under this orchestrator` });
      return null;
    }
    return worker;
  }

  function qaLoop(req, res) {
    const orchestrator = orchestratorSession(req, res);
    if (!orchestrator) return;
    const worker = workerOf(req, res, orchestrator);
    if (!worker) return;
    const { on } = req.body || {};
    if (typeof on !== 'boolean') {
      res.status(400).json({ error: 'on must be a boolean' });
      return;
    }
    try {
      // Disarming drops the loop record, not the running child. Capture its
      // state before that record disappears so the caller can see the limit.
      const qaStillRunning = !on && !!worker.qaLoop?.running;
      const qaSessionId = qaStillRunning
        ? worker.qaLoop.sessionId || worker.qaLoop.staleSessionId || null
        : null;
      setQaLoop(worker.id, on);
      res.json({ session: workerSummary(worker), qaStillRunning, qaSessionId });
    } catch (e) {
      res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
    }
  }

  async function readQuestion(req, res) {
    const orchestrator = orchestratorSession(req, res);
    if (!orchestrator) return;
    const worker = workerOf(req, res, orchestrator);
    if (!worker) return;
    const question = workerQuestion(worker, getJob);
    if (!question)
      return res.status(409).json({ error: 'No current review/fix child has a pending question' });
    const { child } = workerReviewChild(worker, getJob);
    const events = await workerTranscript(child, req.query, jobEventsFor);
    // Transcript loading is async; refuse a replaced or answered question.
    const latest = workerQuestion(worker, getJob);
    if (!latest || latest.childId !== question.childId || latest.questionSeq !== question.questionSeq)
      return res.status(409).json({ error: 'The pending question changed; read it again' });
    res.json({ question: latest, events });
  }

  function answerQuestion(req, res) {
    const orchestrator = orchestratorSession(req, res);
    if (!orchestrator) return;
    const worker = workerOf(req, res, orchestrator);
    if (!worker) return;
    const question = workerQuestion(worker, getJob);
    const { childId, questionSeq, text } = req.body || {};
    if (!question?.answerable || childId !== question.childId || questionSeq !== question.questionSeq)
      return res.status(409).json({
        error: 'No matching idle pending question; read_worker_question again or use the dashboard',
      });
    if (typeof text !== 'string' || !text.trim() || /^\s*\/btw(?:\s|$)/i.test(text))
      return res.status(400).json({ error: 'A non-empty answer is required (not /btw)' });
    try {
      // An orchestrator is not an operator watching the dashboard: preserve
      // unattended SSH/Slack approval gates, and never approve pending requests.
      sendDevMessage(childId, text, undefined, { instruction: true });
      res.json({ session: workerSummary(worker) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }

  return { orchestratorSession, workerOf, qaLoop, readQuestion, answerQuestion };
}
