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

// Dotenv text as entries, each the whole lines one assignment takes in Node's parseEnv, or a
// line of anything else (key null). Node trims blanks, line breaks included, off the text and
// around keys and values, so a value left blank takes the next line, and an empty key leaves
// the rest of its line to be read again. A quoted value ends at the next matching quote,
// whatever the backslashes, or with its line if none follows; `export ` goes, except on an
// empty `KEY=`. Every \r is dropped first, which keeps the line numbers.
function envEntries(text) {
  const lines = String(text || '')
    .replace(/[ \t\n\r]+$/, '')
    .split('\n');
  const s = lines.join('\n').replace(/\r/g, '');
  const blank = (/** @type {number} */ i) => {
    while (i < s.length && ' \t\n\r'.includes(s[i])) i++;
    return i;
  };
  const lineEnd = (/** @type {number} */ i) => {
    const nl = s.indexOf('\n', i);
    return nl === -1 ? s.length : nl;
  };
  const lineOf = (/** @type {number} */ i) => s.slice(0, i).split('\n').length - 1;
  const found = [];
  // Where a run of empty keys (a bare `=`) began: Node reads on past them into the entry.
  let from = -1;
  for (let i = blank(0); i < s.length;) {
    let eq = i;
    while (eq < s.length && s[eq] !== '=' && s[eq] !== '\n') eq++;
    // A comment, or a line with no `=`.
    if (s[i] === '#' || s[eq] !== '=') {
      i = blank(lineEnd(i) + 1);
      from = -1;
      continue;
    }
    if (from < 0) from = i;
    let key = s.slice(i, eq).replace(/[ \t\n\r]+$/, '');
    let v = eq + 1;
    if (v === s.length || s[v] === '\n') {
      found.push({ key, start: from, end: eq });
      i = blank(v);
      from = -1;
      continue;
    }
    if (!key) {
      i = blank(v);
      continue;
    }
    if (key.startsWith('export ')) key = key.slice(7).replace(/^[ \t\n\r]+/, '');
    v = blank(v);
    const close = `"'\``.includes(s[v]) ? s.indexOf(s[v], v + 1) : -1;
    const end = lineEnd(close === -1 ? v : close);
    found.push({ key, start: from, end });
    i = blank(end + 1);
    from = -1;
  }
  const entries = [];
  let line = 0;
  for (const { key, start, end } of found) {
    for (const first = lineOf(start); line < first; line++) entries.push({ key: null, lines: [lines[line]] });
    const last = lineOf(end);
    entries.push({ key, lines: lines.slice(line, last + 1) });
    line = last + 1;
  }
  for (; line < lines.length; line++) entries.push({ key: null, lines: [lines[line]] });
  return entries;
}

/**
 * Applies key edits to dotenv text, keeping its comments, order and every line it was not
 * asked to touch, with entries read the way Node's parseEnv reads them. A set key replaces its
 * first assignment (every line of it) in place and drops any later one, which would otherwise
 * win; a new key is appended. Values go in verbatim after `KEY=`, so quoting is the caller's,
 * the way it is when editing the file by hand, but one that would run into the lines around it
 * is refused. Removing every key leaves "\n", which seeding still writes, unlike the
 * unconfigured "".
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
  for (const entry of envEntries(text)) {
    const key = entry.key;
    if (key && removed.has(key)) continue;
    if (key && values.has(key)) {
      if (!written.has(key)) lines.push(`${key}=${values.get(key)}`);
      written.add(key);
      continue;
    }
    lines.push(...entry.lines);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of values) if (!written.has(key)) lines.push(`${key}=${value}`);
  const edited = `${lines.join('\n')}\n`;
  // A blank value or an unmatched quote would run into the lines around it, taking them in or
  // being taken by a quote an earlier line left open.
  const reread = envEntries(edited);
  for (const key of values.keys()) {
    const own = reread.filter((e) => e.key === key);
    if (own.length !== 1 || own[0].lines.length !== 1)
      throw new Error(`${key}: Node would not read that value on its own line (a blank or unmatched quote)`);
  }
  return edited;
}

// Same interactive chats as the inbox tools: a review, QA, worker, preview or unattended turn
// answers to something else and must not rewrite what every later session starts from.
export function projectEnvSessionAllowed(job, project, ownerMayEdit) {
  return operatorInboxSession(job, project) && ownerMayEdit(job);
}

export function projectEnvRoutes({
  agentSession,
  getProject,
  editProject,
  ownerMayEdit,
  holdsCheckout,
  note = (/** @type {string} */ _id, /** @type {string} */ _text) => {},
}) {
  const router = Router();
  const refused = () =>
    Object.assign(new Error("Only an admin's interactive session may change its project's .env template"), {
      status: 403,
    });

  router.use('/api/agent/project-env', (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    const project = getProject(job.repo);
    if (!projectEnvSessionAllowed(job, project, ownerMayEdit))
      return res.status(403).json({ error: refused().message });
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
    // The checkout this request is about; by the time the save returns it may be another's.
    const dir = job.workDir;
    try {
      const project = getProject(job.repo);
      if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
      // editProject runs this after any write queued ahead of it (another edit, a Settings
      // save) on the row as stored now, so the session may have lost its say meanwhile.
      await editProject(project.id, (stored) => {
        if (!projectEnvSessionAllowed(job, stored, ownerMayEdit)) throw refused();
        // A rename saved meanwhile makes this row another repository's, not the session's.
        if (String(stored.repo).toLowerCase() !== String(job.repo).toLowerCase())
          throw Object.assign(new Error('Project not found'), { status: 404 });
        return { envTemplate: editEnvText(stored.envTemplate, body) };
      });
      const checkout = body.applyToCheckout !== false ? applyToCheckout(job, dir, body, holdsCheckout) : null;
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
function applyToCheckout(job, dir, { set = {}, unset = [] }, holdsCheckout) {
  if (job.local || job.orchestrator || !dir) return 'not applicable';
  // A session closed during the save has handed its directory back, maybe to another one.
  if (!holdsCheckout(job, dir)) return 'not updated: the session no longer holds its checkout';
  const file = path.join(dir, '.env');
  const own = (key) => !(job.sessionDb && key === 'DB_DATABASE');
  const edits = {
    set: Object.fromEntries(Object.entries(set).filter(([key]) => own(key))),
    unset: unset.filter(own),
  };
  // The template is saved by now, so a checkout that cannot be written is reported, not fatal.
  try {
    let current = '';
    if (fs.existsSync(file)) {
      if (!Object.keys(edits.set).length && !edits.unset.length) return 'unchanged';
      current = fs.readFileSync(file, 'utf8');
    }
    // Prepared from an empty template, the checkout has no .env until its first keys, even
    // if the only one is a DB_DATABASE the session database stands in for.
    else if (!Object.keys(set).length) return 'unchanged';
    else if (job.sessionDb) edits.set.DB_DATABASE = job.sessionDb;
    fs.writeFileSync(file, editEnvText(current, edits), 'utf8');
    return 'updated';
  } catch (e) {
    return `not updated: ${e.message}`;
  }
}
