#!/usr/bin/env node
// @ts-check
//
// A code review session's findings tools as a stdio MCP server, mounted like memory-mcp.js
// but only on review sessions; each tool is one call to /api/agent/code-review
// (lib/code-reviews.js), whose token names the session and so its review.

import { createApiClient, serveStdio } from './mcp-stdio.js';

const call = createApiClient(
  '/api/agent/code-review',
  'Review findings tools are not configured for this session',
);

const FIELDS = {
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  type: {
    type: 'string',
    description: 'Short kebab-case kind of defect, e.g. correctness, security, efficiency, test-coverage',
  },
  shouldFix: {
    type: 'string',
    enum: ['fix', 'optional', 'dismiss'],
    description:
      'Set by the verification step. fix: must change before merging. optional: real but not worth requiring. dismiss: the finding did not hold up.',
  },
  verification: {
    type: 'string',
    enum: ['confirmed', 'plausible'],
    description:
      'confirmed: reproduced or proven against the reviewed head. plausible: likely, not proven. Omit when not checked.',
  },
  title: { type: 'string', description: 'One-line statement of the defect' },
  body: { type: 'string', description: 'Impact, the concrete failure scenario and the evidence' },
  filePath: { type: 'string', description: 'Repository-relative path' },
  startLine: { type: 'integer', minimum: 1 },
  endLine: { type: 'integer', minimum: 1 },
  comments: { type: 'string', description: 'Why the verdict is what it is, e.g. why it is not worth fixing' },
};

// How a finding relates to the PR's earlier review threads. Stated once, when the
// finding is registered; the server checks it against the thread history it read.
const RECONCILE = {
  reconciliation: {
    type: 'string',
    enum: ['new', 'adopted', 'suppressed', 'revisit'],
    description:
      'new (the default): posted as a new comment. adopted: the same claim already has an unresolved thread, so no ' +
      'duplicate was posted. suppressed: an earlier thread already dismissed or addressed the same claim, so it was ' +
      'not posted again. revisit: an earlier decision on the same claim no longer holds, and it was posted again.',
  },
  commentId: {
    type: 'integer',
    minimum: 1,
    description: 'The id GitHub returned for the inline comment this finding was posted as (new and revisit)',
  },
  priorThreadId: {
    type: 'string',
    description: 'threadId, from the review history file, of the earlier thread making the same claim',
  },
  priorFindingRef: {
    type: 'string',
    description: 'findingRef of an earlier decision that has no thread, instead of priorThreadId',
  },
  revisitReason: {
    type: 'string',
    description: 'Required for revisit: what changed since the earlier decision, with the evidence',
  },
};

const tools = [
  {
    name: 'review_finding_add',
    description:
      'Register one finding of this code review. Register every finding the review reports, including one an ' +
      'earlier thread already decided (reconciliation suppressed); the verification step records the verdict ' +
      'later with review_finding_update. Returns the finding id.',
    inputSchema: { type: 'object', properties: { ...FIELDS, ...RECONCILE }, required: ['severity', 'title'] },
  },
  {
    name: 'review_finding_update',
    description:
      'Change a finding of this review by id, e.g. after verification changes its verdict. Only the given fields change.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, ...FIELDS },
      required: ['id'],
    },
  },
  {
    name: 'review_summary_set',
    description: 'Store the Markdown of the summary comment this review posted on the PR.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
  {
    name: 'review_findings_list',
    description: 'List the findings registered for this review so far.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function fmt(f) {
  const where = f.filePath ? ` ${f.filePath}${f.startLine ? `:${f.startLine}` : ''}` : '';
  const checked = f.verification ? `, ${f.verification}` : '';
  // Where the verification step replies, and which earlier thread a finding answers to.
  const related = f.reconciliation && f.reconciliation !== 'new' ? `, ${f.reconciliation}` : '';
  const comment = f.commentId ? ` (comment ${f.commentId})` : '';
  const prior =
    related && (f.priorUrl || f.priorThreadId)
      ? ` (earlier ${f.priorDisposition || 'thread'}: ${f.priorUrl || f.priorThreadId})`
      : '';
  return `#${f.id} [${f.severity}, ${f.shouldFix || 'unverified'}${checked}${related}]${where} ${f.title}${comment}${prior}`;
}

async function runTool(name, args = {}) {
  if (name === 'review_finding_add') {
    const { finding } = await call('POST', '/findings', args);
    return `Registered finding ${fmt(finding)}`;
  }
  if (name === 'review_finding_update') {
    const { id, ...changes } = args;
    const { finding } = await call('PATCH', `/findings/${encodeURIComponent(id)}`, changes);
    return `Updated finding ${fmt(finding)}`;
  }
  if (name === 'review_summary_set') {
    await call('PUT', '/summary', { summary: args.summary });
    return 'Stored the review summary.';
  }
  if (name === 'review_findings_list') {
    const { findings } = await call('GET', '');
    return findings.length ? findings.map(fmt).join('\n') : 'No findings registered for this review yet.';
  }
  throw new Error(`Unknown tool ${name}`);
}

serveStdio({ name: 'reviewer-code-review', tools, runTool });
