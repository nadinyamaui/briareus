// @ts-check
// Agent tokens grant a supervisor authority over its own workers, plus closing the
// sessions of its own project that its owner could close from a client.
export function orchestratorRoutes({
  agentSession,
  getJob,
  ownerManages,
  closeDevSession,
  noteSession,
  startOrchestratorPrAction,
  spawnWorkerSession,
  eligibleWorkerProjects,
  workerSessionsFor,
  setQaLoop,
  workerSummary,
  deleteJobById,
  assertWorkerSlot,
  reopenDevSession,
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
    if (!worker || worker.id === orchestrator.id) {
      res.status(404).json({ error: `No worker session ${req.params.id} under this orchestrator` });
      return null;
    }
    return worker;
  }

  async function prAction(req, res) {
    const parent = orchestratorSession(req, res);
    if (!parent) return;
    try {
      // Pass only the supported fields: never accept ownership or runtime overrides.
      const { action, prNumber, repo } = req.body || {};
      const session = await startOrchestratorPrAction(parent, { action, prNumber, repo });
      res.status(201).json({ session: workerSummary(session) });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }

  function projects(req, res) {
    const parent = orchestratorSession(req, res);
    if (!parent) return;
    res.json({ projects: eligibleWorkerProjects(parent) });
  }

  function spawn(req, res) {
    const orchestrator = orchestratorSession(req, res);
    if (!orchestrator) return;
    try {
      const { title, prompt, repo, providerId, model, effort, branch, stackOn, qaLoop, tooling } =
        req.body || {};
      const session = spawnWorkerSession(orchestrator, {
        title,
        prompt,
        repo,
        providerId,
        model,
        effort,
        branch,
        stackOn,
        qaLoop: qaLoop === true,
        tooling: tooling === true,
      });
      res.status(201).json({ session: workerSummary(session) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
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

  function reopenWorker(req, res) {
    const parent = orchestratorSession(req, res);
    if (!parent) return;
    const worker = workerOf(req, res, parent);
    if (!worker) return;
    try {
      if (worker.status !== 'closed' || worker.closing || worker.closePending) {
        return res.status(409).json({ error: 'Only fully closed workers can be reopened' });
      }
      if (
        worker.qaBranch ||
        worker.autoClose ||
        worker.local ||
        worker.orchestrator ||
        (worker.activity && worker.activity !== 'worker')
      ) {
        return res.status(400).json({ error: 'Only task workers can be reopened through this route' });
      }
      assertWorkerSlot(parent);
      // The UI lifecycle retains the target project's config, workspace and history.
      // Preparation is asynchronous; accepting a reopen does not mean QA is ready.
      reopenDevSession(worker.id);
      res.status(202).json({
        session: workerSummary(worker),
        preparing: worker.status === 'preparing',
        qaReady: worker.status === 'idle' && !worker.awaitingAnswer,
        messageSent: false,
      });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }

  async function deleteWorker(req, res) {
    const parent = orchestratorSession(req, res);
    if (!parent) return;
    const worker = workerOf(req, res, parent);
    if (!worker) return;
    try {
      await deleteJobById(worker.id, { closedOnly: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  }

  // A pull request an orchestrator is asked to review is often held by a session the user
  // started by hand. Closing is all this grants on such a session: it keeps its transcript
  // and can be reopened, while reading, messaging and deleting stay with its own workers.
  // close_worker asks for its own workers only (?worker=1), so a wrong id still gets a 404.
  function closableSession(req, res, orchestrator) {
    const id = req.params.id;
    const job = id === orchestrator.id ? null : getJob(id);
    if (job?.kind === 'devchat' && job.parentId === orchestrator.id) return job;
    const sameProject =
      req.query.worker !== '1' &&
      job?.kind === 'devchat' &&
      // Closing an unattended session deletes its record, and closing a peer orchestrator
      // would leave its workers unsupervised.
      !job.autoClose &&
      !job.orchestrator &&
      typeof job.repo === 'string' &&
      job.repo.toLowerCase() === String(orchestrator.repo || '').toLowerCase();
    // One answer for a missing session, another project's and another user's: the id of a
    // session this orchestrator may not close must not confirm that it exists.
    if (!sameProject || !ownerManages(orchestrator, job)) {
      res.status(404).json({
        error: `No session ${id} this orchestrator can close: it closes its own workers and its owner's sessions in ${orchestrator.repo}`,
      });
      return null;
    }
    return job;
  }

  async function closeSession(req, res) {
    const orchestrator = orchestratorSession(req, res);
    if (!orchestrator) return;
    const target = closableSession(req, res, orchestrator);
    if (!target) return;
    const worker = target.parentId === orchestrator.id;
    // Only the call that starts the close says so; a retry meanwhile joins the same close.
    const closesIt = target.status !== 'closed' && !target.closing && !target.closePending;
    try {
      await closeDevSession(target.id);
      // Said in the closed session's own transcript, once it is closed: its user did not close it.
      if (!worker && closesIt) {
        noteSession(
          target.id,
          `Closed by orchestrator session ${orchestrator.id}${orchestrator.title ? ` (${orchestrator.title})` : ''}.`,
        );
      }
      // Closing grants no read access to a session that is not its worker.
      res.json({ session: worker ? workerSummary(target) : { id: target.id, status: target.status } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }

  return {
    projects,
    orchestratorSession,
    workerOf,
    prAction,
    spawn,
    qaLoop,
    reopenWorker,
    deleteWorker,
    closeSession,
  };
}
