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
 * }} deps
 */
export function printAgentRoutes({ service, agentSession, getProject, readFile }) {
  const router = Router();
  // Session id -> the CUPS job ids it sent. In memory: a restart mints new session tokens too.
  const sent = new Map();
  const allowed = (job) => printSessionAllowed(job, getProject(job.repo));
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
  const own = (job, id) => (sent.get(job.id) || []).includes(id);

  router.get(
    '/api/agent/print/printers',
    handle(() => service.printers()),
  );
  router.post(
    '/api/agent/print/jobs',
    handle(async (req, res) => {
      const job = res.locals.job;
      const { path: sourcePath, ...options } = req.body || {};
      const bytes = await readFile(job, sourcePath);
      if (!bytes.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
      // The read can wait on a slow disk; the opt-in is checked again just before paper moves.
      if (!allowed(job)) throw Object.assign(new Error(REFUSED), { status: 403 });
      const result = await service.print(bytes, {
        ...options,
        title: options.title || path.basename(sourcePath),
      });
      sent.set(job.id, [...(sent.get(job.id) || []), result.jobId].slice(-100));
      return { ...result, file: sourcePath, size: bytes.length };
    }),
  );
  router.get(
    '/api/agent/print/jobs',
    handle(async (_req, res) => ({ jobs: await service.jobs(sent.get(res.locals.job.id) || []) })),
  );
  router.delete(
    '/api/agent/print/jobs/:id',
    handle((req, res) => {
      // Another session's job, or one sent from outside Briareus, answers as one that does not exist.
      if (!own(res.locals.job, req.params.id))
        throw Object.assign(new Error('Print job not found'), { status: 404 });
      return service.cancel(req.params.id);
    }),
  );
  return router;
}
