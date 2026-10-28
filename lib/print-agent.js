// @ts-check
// Printing for a project's sessions, behind its own per-project opt-in. Paper comes out of a
// physical printer in someone's office, so it reaches only the interactive chats the operator's
// inboxes do (operatorInboxSession): never review, QA, workers or a turn nobody is watching.
// A session prints only files it could upload over SSH (the server hands in
// lib/ssh-upload.js's reader, which lib/jobs.js, importing the gate, must not pull in) and
// sees and cancels only the jobs it sent.
import path from 'node:path';
import { Router } from 'express';
import { operatorInboxSession } from './mail-agent.js';

const REFUSED = 'Printing requires an interactive session in a project with print tools enabled';

export function printSessionAllowed(job, project) {
  return project?.printToolsEnabled === true && operatorInboxSession(job, project);
}

/**
 * @param {{
 *   service: ReturnType<typeof import('./print.js').createPrintService>,
 *   agentSession: (req: any, res: any) => any,
 *   getProject: (repo: string) => any,
 *   readFile: (job: any, sourcePath: any) => Promise<Buffer>,
 *   sessions?: import('node:events').EventEmitter,
 * }} deps
 */
export function printAgentRoutes({ service, agentSession, getProject, readFile, sessions }) {
  const router = Router();
  // Session id -> the CUPS job ids it sent. In memory: a restart mints new session tokens too.
  const sent = new Map();
  let inFlight = 0;
  const forget = (id) => {
    const history = sent.get(id);
    if (history) history.active = false;
    sent.delete(id);
  };
  sessions?.on('deleted', forget);
  sessions?.on('job', (job) => {
    if (job.status === 'closed') forget(job.id);
  });
  const allowed = (job) => printSessionAllowed(job, getProject(job.repo));
  // Stop marks the turn canceled and bumps its cancellation count, so a request that outlives
  // its turn cannot act even after a new turn has started.
  const authorize = (job, stops) => {
    if (!allowed(job) || job.closing || job.turnCanceled || (job.sshCancellationVersion || 0) !== stops)
      throw Object.assign(new Error(REFUSED), { status: 403 });
  };
  router.use('/api/agent/print', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!allowed(job)) return res.status(403).json({ error: REFUSED });
    res.set('Cache-Control', 'no-store');
    res.locals.job = job;
    res.locals.stops = job.sshCancellationVersion || 0;
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  const reconcile = async (history) => {
    if (!history) return;
    const uncertain = [...history.entries].filter((entry) => entry.uncertain);
    if (!uncertain.length) return;
    const recovered = await service.recover(uncertain.map((entry) => entry.submission));
    for (const entry of uncertain) {
      const result = recovered.find((result) => result.marker === entry.submission.marker);
      if (result) {
        entry.submission = result;
        entry.uncertain = false;
      }
    }
  };

  router.get(
    '/api/agent/print/printers',
    handle(() => service.printers()),
  );
  router.post(
    '/api/agent/print/jobs',
    handle(async (req, res) => {
      const job = res.locals.job;
      // Hold admission through reading and lp completion, including errors and disconnects.
      if (inFlight >= 4)
        throw Object.assign(new Error('Print capacity is busy; wait for a submission to finish'), {
          status: 429,
        });
      inFlight++;
      let history, entry;
      try {
        history = sent.get(job.id);
        if (!history) {
          history = { active: true, entries: new Set() };
          sent.set(job.id, history);
        }
        if (history.entries.size >= 100) {
          const ids = [...history.entries]
            .filter((entry) => entry.submission && !entry.uncertain && !entry.inFlight)
            .map((entry) => entry.submission.jobId);
          // A successful query reporting an acknowledged job unknown means CUPS no longer retains
          // it, so it is reclaimed like a finished one; uncertain submissions are never queried.
          const terminal = new Set(
            (await service.jobs(ids))
              .filter((job) => ['completed', 'canceled', 'aborted', 'ended', 'unknown'].includes(job.state))
              .map((job) => job.jobId),
          );
          for (const entry of history.entries)
            if (terminal.has(entry.submission?.jobId)) history.entries.delete(entry);
        }
        authorize(job, res.locals.stops);
        if (!history.active) throw Object.assign(new Error(REFUSED), { status: 403 });
        if (history.entries.size >= 100)
          throw Object.assign(new Error('Print history is full of active or uncertain jobs'), {
            status: 409,
          });
        // Reserve before any await so concurrent submissions cannot overrun the cap.
        entry = { inFlight: true, uncertain: false, submission: null };
        history.entries.add(entry);
        const { path: sourcePath, ...options } = req.body || {};
        const bytes = await readFile(job, sourcePath);
        if (!bytes.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
        authorize(job, res.locals.stops);
        const result = await service.print(
          bytes,
          {
            ...options,
            title: options.title || path.basename(sourcePath),
          },
          {
            authorize: () => {
              authorize(job, res.locals.stops);
              if (!history.active) throw Object.assign(new Error(REFUSED), { status: 403 });
            },
            submitting: (submission) => {
              entry.submission = submission;
            },
          },
        );
        entry.submission = result;
        return { ...result, file: sourcePath, size: bytes.length };
      } catch (e) {
        // A spawn failure submitted nothing; once lp ran, a retry could print the job twice.
        if (entry?.submission && !e.cupsNotStarted) {
          entry.uncertain = true;
          e.message = `${e.message}. The submission is uncertain: CUPS may already have accepted it. Do not resubmit; check print_jobs for ${entry.submission.jobId}`;
        } else if (entry) history.entries.delete(entry);
        throw e;
      } finally {
        if (entry) entry.inFlight = false;
        if (history?.entries.size === 0 && sent.get(job.id) === history) sent.delete(job.id);
        inFlight--;
      }
    }),
  );
  router.get(
    '/api/agent/print/jobs',
    handle(async (_req, res) => {
      const history = sent.get(res.locals.job.id);
      // A failed recovery leaves the uncertain entries as they are; the confirmed ones still answer.
      let recoveryError;
      try {
        await reconcile(history);
      } catch (e) {
        recoveryError = e.message;
      }
      const entries = [...(history?.entries || [])].filter((entry) => entry.submission);
      const known = entries.filter((entry) => !entry.uncertain && !entry.inFlight);
      const jobs = await service.jobs(known.map((entry) => entry.submission.jobId));
      return {
        jobs: [
          ...jobs,
          ...entries
            .filter((entry) => !known.includes(entry))
            .map((entry) => ({
              jobId: entry.submission.jobId,
              printer: entry.submission.printer,
              state: 'uncertain',
            })),
        ],
        ...(recoveryError && { recoveryError }),
      };
    }),
  );
  router.delete(
    '/api/agent/print/jobs/:id',
    handle(async (req, res) => {
      // Another session's job, or one sent from outside Briareus, answers as one that does not exist.
      const job = res.locals.job;
      const history = sent.get(job.id);
      const find = () =>
        [...(history?.entries || [])].find((entry) => entry.submission?.jobId === req.params.id);
      // A confirmed job needs no recovery, so a failing recovery query cannot block canceling it.
      let entry = find();
      if (!entry) {
        await reconcile(history);
        entry = find();
      }
      if (!entry) throw Object.assign(new Error('Print job not found'), { status: 404 });
      if (entry.uncertain || entry.inFlight)
        throw Object.assign(new Error('Submission is uncertain; check print_jobs before canceling'), {
          status: 409,
        });
      // Recovery can block; permission must still hold at the queue mutation.
      authorize(job, res.locals.stops);
      if (!history.active) throw Object.assign(new Error(REFUSED), { status: 403 });
      return service.cancel(req.params.id);
    }),
  );
  return router;
}
