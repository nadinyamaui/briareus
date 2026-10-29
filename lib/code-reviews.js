// @ts-check
// The findings a code review session registers about the PR it reviews, through
// /api/agent/code-review (and lib/code-review-mcp.js on top of it). The session's
// token names its review, so a review can only ever write its own findings. The
// review row itself is created when the session starts (lib/jobs.js).
import { Router } from 'express';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const SHOULD_FIX = ['fix', 'optional', 'dismiss'];
export const VERIFICATIONS = ['confirmed', 'plausible'];
// Far above any honest review; stops a looping agent from filling the table.
export const MAX_FINDINGS = 100;

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

function text(value, name, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${name} is longer than ${max} characters`);
  return trimmed || null;
}

function choice(value, name, allowed) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (!allowed.includes(v)) throw invalid(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}

function line(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) throw invalid(`${name} must be a positive integer`);
  return value;
}

// The columns a finding may set, checked. A new finding needs severity, shouldFix and
// title; an update (`partial`) checks only the fields it carries.
export function findingFields(input, { partial = false } = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  /** @type {Record<string, any>} */
  const out = {};
  if (!partial || has('severity')) out.severity = choice(body.severity, 'severity', SEVERITIES);
  if (!partial || has('shouldFix')) out.shouldFix = choice(body.shouldFix, 'shouldFix', SHOULD_FIX);
  if (!partial || has('title')) {
    out.title = text(body.title, 'title', 1000);
    if (!out.title) throw invalid('title is required');
  }
  if (has('verification'))
    out.verification =
      body.verification == null ? null : choice(body.verification, 'verification', VERIFICATIONS);
  if (has('type')) out.type = text(body.type, 'type', 40) || '';
  if (has('body')) out.body = text(body.body, 'body', 60000);
  if (has('filePath')) out.filePath = text(body.filePath, 'filePath', 1000);
  if (has('startLine')) out.startLine = line(body.startLine, 'startLine');
  if (has('endLine')) out.endLine = line(body.endLine, 'endLine');
  if (has('comments')) out.comments = text(body.comments, 'comments', 10000);
  if (out.startLine != null && out.endLine != null && out.endLine < out.startLine)
    throw invalid('endLine must not be before startLine');
  return out;
}

/**
 * @param {{
 *   agentSession: (req: any, res: any) => any,
 *   store: {
 *     getCodeReviewByJob: (jobId: string) => Promise<any>,
 *     listCodeReviewFindings: (reviewId: number) => Promise<any[]>,
 *     getCodeReviewFinding: (reviewId: number, id: number) => Promise<any>,
 *     addCodeReviewFinding: (reviewId: number, finding: object) => Promise<any>,
 *     updateCodeReviewFinding: (reviewId: number, id: number, changes: object) => Promise<any>,
 *   },
 * }} deps
 */
export function codeReviewRoutes({ agentSession, store }) {
  const router = Router();

  router.use('/api/agent/code-review', async (req, res, next) => {
    const job = agentSession(req, res);
    if (!job) return;
    if (job.activity !== 'review')
      return res.status(403).json({ error: 'Only a code review session can register review findings' });
    try {
      const review = await store.getCodeReviewByJob(job.id);
      if (!review) return res.status(409).json({ error: 'No code review is recorded for this session' });
      res.set('Cache-Control', 'no-store');
      res.locals.review = review;
      next();
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/agent/code-review', async (_req, res) => {
    const review = res.locals.review;
    res.json({ review, findings: await store.listCodeReviewFindings(review.id) });
  });

  router.post('/api/agent/code-review/findings', async (req, res) => {
    const review = res.locals.review;
    try {
      const fields = findingFields(req.body);
      const existing = await store.listCodeReviewFindings(review.id);
      if (existing.length >= MAX_FINDINGS)
        return res.status(409).json({ error: `A review holds at most ${MAX_FINDINGS} findings` });
      res.status(201).json({ finding: await store.addCodeReviewFinding(review.id, fields) });
    } catch (e) {
      res.status(e.status || 503).json({ error: e.message });
    }
  });

  router.patch('/api/agent/code-review/findings/:id', async (req, res) => {
    const review = res.locals.review;
    const id = Number(req.params.id);
    try {
      if (!Number.isInteger(id) || id < 1) throw invalid('Finding id must be a positive integer');
      const changes = findingFields(req.body, { partial: true });
      const current = await store.getCodeReviewFinding(review.id, id);
      if (!current) return res.status(404).json({ error: `No finding ${id} in this review` });
      const startLine = 'startLine' in changes ? changes.startLine : current.startLine;
      const endLine = 'endLine' in changes ? changes.endLine : current.endLine;
      if (startLine != null && endLine != null && endLine < startLine)
        throw invalid('endLine must not be before startLine');
      res.json({ finding: await store.updateCodeReviewFinding(review.id, id, changes) });
    } catch (e) {
      res.status(e.status || 503).json({ error: e.message });
    }
  });

  return router;
}
