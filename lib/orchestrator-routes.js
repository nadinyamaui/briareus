// @ts-check

// Agent tokens grant a supervisor authority over only its own workers.
export function orchestratorRoutes({ agentSession, workerSessionsFor, setQaLoop, workerSummary }) {
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
      const qaSessionId = qaStillRunning ? worker.qaLoop.sessionId || null : null;
      setQaLoop(worker.id, on);
      res.json({ session: workerSummary(worker), qaStillRunning, qaSessionId });
    } catch (e) {
      res.status(e.status === 503 ? 503 : 400).json({ error: e.message });
    }
  }

  return { orchestratorSession, workerOf, qaLoop };
}
