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
      'fix: must change before merging. optional: real but not worth requiring. dismiss: the finding did not hold up.',
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

const tools = [
  {
    name: 'review_finding_add',
    description:
      'Register one finding of this code review, with your verdict on whether it must be fixed. Register every ' +
      'finding you assessed, including dismissed ones, before publishing the review. Returns the finding id.',
    inputSchema: { type: 'object', properties: FIELDS, required: ['severity', 'shouldFix', 'title'] },
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
    name: 'review_findings_list',
    description: 'List the findings registered for this review so far.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function fmt(f) {
  const where = f.filePath ? ` ${f.filePath}${f.startLine ? `:${f.startLine}` : ''}` : '';
  const checked = f.verification ? `, ${f.verification}` : '';
  return `#${f.id} [${f.severity}, ${f.shouldFix}${checked}]${where} ${f.title}`;
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
  if (name === 'review_findings_list') {
    const { findings } = await call('GET', '');
    return findings.length ? findings.map(fmt).join('\n') : 'No findings registered for this review yet.';
  }
  throw new Error(`Unknown tool ${name}`);
}

serveStdio({ name: 'reviewer-code-review', tools, runTool });
