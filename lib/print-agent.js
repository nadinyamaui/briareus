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
  const authorize = (job) => {
    if (!allowed(job) || job.closing) throw Object.assign(new Error(REFUSED), { status: 403 });
  };
  router.use('/api/agent/print', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (!allowed(job)) return res.status(403).json({ error: REFUSED });
    res.set('Cache-Control', 'no-store');
    res.locals.job = job;
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
          const terminal = new Set(
            (await service.jobs(ids))
              .filter((job) => ['completed', 'canceled', 'aborted'].includes(job.state))
              .map((job) => job.jobId),
          );
          for (const entry of history.entries)
            if (terminal.has(entry.submission?.jobId)) history.entries.delete(entry);
        }
        authorize(job);
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
        authorize(job);
        const result = await service.print(
          bytes,
          {
            ...options,
            title: options.title || path.basename(sourcePath),
          },
          {
            authorize: () => {
              authorize(job);
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
        if (entry?.submission) entry.uncertain = true;
        else if (entry) history.entries.delete(entry);
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
      await reconcile(history);
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
      };
    }),
  );
  router.delete(
    '/api/agent/print/jobs/:id',
    handle(async (req, res) => {
      // Another session's job, or one sent from outside Briareus, answers as one that does not exist.
      const history = sent.get(res.locals.job.id);
      await reconcile(history);
      const entry = [...(history?.entries || [])].find((entry) => entry.submission?.jobId === req.params.id);
      if (!entry) throw Object.assign(new Error('Print job not found'), { status: 404 });
      if (entry.uncertain || entry.inFlight)
        throw Object.assign(new Error('Submission is uncertain; check print_jobs before canceling'), {
          status: 409,
        });
      return service.cancel(req.params.id);
    }),
  );
  return router;
}
