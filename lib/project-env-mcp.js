#!/usr/bin/env node
// @ts-check
//
// The project .env template tools as a stdio MCP server, mounted like memory-mcp.js on the
// turns lib/project-env.js allows; each tool is one call to /api/agent/project-env.

import { createApiClient, serveStdio } from './mcp-stdio.js';

const call = createApiClient(
  '/api/agent/project-env',
  'Project .env tools are not configured for this session',
);

const tools = [
  {
    name: 'project_env_read',
    description:
      "Read this project's .env template: the file Briareus writes into every session checkout when it is prepared. " +
      "Editing a checkout's .env lasts only until it is prepared again; use project_env_set for lasting changes.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_env_set',
    description:
      "Change keys in this project's .env template, which every later session, preview and Run starts from. " +
      'Set keys replace their existing line (or are appended); unset keys are removed; comments and other lines stay. ' +
      'Values are written verbatim after KEY=, so quote them as the file needs. The same edits are applied to this ' +
      "session's checkout .env unless applyToCheckout is false. Only change it when the user asked for it.",
    inputSchema: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Keys to add or replace, e.g. {"APP_DEBUG": "true"}',
        },
        unset: { type: 'array', items: { type: 'string' }, description: 'Keys to remove' },
        applyToCheckout: { type: 'boolean', default: true },
      },
    },
  },
];

async function runTool(name, args = {}) {
  if (name === 'project_env_read') {
    const { repo, env } = await call('GET', '');
    return env ? `# .env template of ${repo}\n${env}` : `${repo} has no .env template yet.`;
  }
  if (name === 'project_env_set') {
    const { repo, set, unset, checkout } = await call('POST', '', args);
    const parts = [set.length && `set ${set.join(', ')}`, unset.length && `removed ${unset.join(', ')}`];
    return `Updated the .env template of ${repo}: ${parts.filter(Boolean).join('; ')}. This checkout's .env: ${checkout}.`;
  }
  throw new Error(`Unknown tool ${name}`);
}

serveStdio({ name: 'reviewer-project-env', tools, runTool });
