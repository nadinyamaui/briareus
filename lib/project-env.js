// @ts-check
//
// A session's view of its project's .env template: the text seedCheckoutEnv (lib/jobs.js)
// writes into every checkout when it is prepared. Editing the checkout's own .env lasts only
// until that checkout is prepared again, so a value meant for the project goes here.
// Project settings are an admin's, so only an admin's interactive chat (or one nobody owns,
// from before users) gets these routes and the MCP tool (lib/project-env-mcp.js) on them.

import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { operatorInboxSession } from './mail-agent.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

// The key a dotenv line assigns, `export ` and surrounding blanks aside; null for comments,
// blanks and anything that is not an assignment.
function lineKey(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/);
  return m ? m[1] : null;
}

/**
 * Applies key edits to dotenv text, keeping its comments, order and every line it was not
 * asked to touch. A set key replaces its first assignment in place and drops any later one,
 * which would otherwise win; a new key is appended. Values go in verbatim after `KEY=`, so
 * quoting is the caller's, the way it is when editing the file by hand.
 * @param {string} text
 * @param {{ set?: Record<string, unknown>, unset?: unknown[] }} edits
 */
export function editEnvText(text, { set = {}, unset = [] } = {}) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('set must be an object');
  if (!Array.isArray(unset)) throw new Error('unset must be a list of keys');
  const values = new Map();
  for (const [key, value] of Object.entries(set)) {
    if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a valid .env key`);
    if (value === null || typeof value === 'object') throw new Error(`${key} needs a string value`);
    const v = String(value);
    if (/[\r\n]/.test(v)) throw new Error(`${key}: a value must be on one line`);
    values.set(key, v);
  }
  const removed = new Set();
  for (const key of unset) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error(`"${key}" is not a valid .env key`);
    if (values.has(key)) throw new Error(`${key} is both set and unset`);
    removed.add(key);
  }
  if (!values.size && !removed.size) throw new Error('Nothing to change: pass set and/or unset');

  const written = new Set();
  const lines = [];
  for (const line of String(text || '').split('\n')) {
    const key = lineKey(line);
    if (key && removed.has(key)) continue;
    if (key && values.has(key)) {
      if (!written.has(key)) lines.push(`${key}=${values.get(key)}`);
      written.add(key);
      continue;
    }
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of values) if (!written.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

// Same interactive chats as the inbox tools: a review, QA, worker, preview or unattended turn
// answers to something else and must not rewrite what every later session starts from.
export function projectEnvSessionAllowed(job, project, ownerMayEdit) {
  return operatorInboxSession(job, project) && ownerMayEdit(job);
}

export function projectEnvRoutes({
  agentSession,
  getProject,
  updateProject,
  ownerMayEdit,
  note = (/** @type {string} */ _id, /** @type {string} */ _text) => {},
}) {
  const router = Router();
  // Two sessions saving at once would each write back the template they read.
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  router.use('/api/agent/project-env', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    const project = getProject(job.repo);
    if (!projectEnvSessionAllowed(job, project, ownerMayEdit))
      return res.status(403).json({
        error: "Only an admin's interactive session may change its project's .env template",
      });
    res.set('Cache-Control', 'no-store');
    res.locals.job = job;
    next();
  });

  router.get('/api/agent/project-env', (_req, res) => {
    const project = getProject(res.locals.job.repo);
    res.json({ repo: project.repo, env: project.envTemplate || '' });
  });

  router.post('/api/agent/project-env', async (req, res) => {
    const job = res.locals.job;
    const body = req.body || {};
    try {
      let checkout = null;
      await serialized(async () => {
        const project = getProject(job.repo);
        if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
        await updateProject(project.id, { envTemplate: editEnvText(project.envTemplate, body) });
        if (body.applyToCheckout !== false) checkout = applyToCheckout(job, body);
      });
      // Names only: the values are often credentials and the transcript is shared.
      const set = Object.keys(body.set || {});
      const unset = body.unset || [];
      res.json({ repo: job.repo, checkout, set, unset });
      const parts = [set.length && `set ${set.join(', ')}`, unset.length && `removed ${unset.join(', ')}`];
      note(job.id, `Updated the project's .env template: ${parts.filter(Boolean).join('; ')}.`);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });
  return router;
}

// The same edits on this session's own checkout, so it need not wait for its next
// preparation. A local session runs in the project's main checkout, which the template does
// not seed, and a session database stays the checkout's DB_DATABASE as seeding leaves it.
function applyToCheckout(job, { set = {}, unset = [] }) {
  if (job.local || job.orchestrator || !job.workDir) return 'not applicable';
  const file = path.join(job.workDir, '.env');
  if (!fs.existsSync(file)) return 'no .env in the checkout';
  const own = (key) => !(job.sessionDb && key === 'DB_DATABASE');
  const edits = {
    set: Object.fromEntries(Object.entries(set).filter(([key]) => own(key))),
    unset: unset.filter(own),
  };
  if (!Object.keys(edits.set).length && !edits.unset.length) return 'unchanged';
  // The template is saved by now, so a checkout that cannot be written is reported, not fatal.
  try {
    fs.writeFileSync(file, editEnvText(fs.readFileSync(file, 'utf8'), edits), 'utf8');
    return 'updated';
  } catch (e) {
    return `not updated: ${e.message}`;
  }
}
