#!/usr/bin/env node
// @ts-check
//
// The memory tool as a stdio MCP server, not imported by the app: lib/jobs.js points each
// turn's CLI at it, and it runs with REVIEWER_MEMORY_URL and REVIEWER_MEMORY_TOKEN in its
// environment. Each tool is one HTTP call to /api/agent/memories; the token names the
// session and thus the project, so the tool only touches that project's memories.
// JSON-RPC plumbing is in mcp-stdio.js.

import { createApiClient, serveStdio } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'memory_save',
    description:
      'Save a memory about this project for future sessions: a fact about the user, feedback on how to work, ' +
      'ongoing project context, or a pointer to an external resource. Saving an existing name replaces it. ' +
      'Do not save what the repository already records (code structure, git history, CLAUDE.md).',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short kebab-case slug identifying the memory, e.g. prefers-small-prs',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'user: who the user is. feedback: guidance on how to work (include why). ' +
            'project: ongoing work or constraints not derivable from the code. reference: URLs, tickets, dashboards.',
        },
        description: {
          type: 'string',
          description: 'One line summarising the memory, used to decide relevance.',
        },
        body: {
          type: 'string',
          description: 'The memory itself. For feedback/project memories include Why and How to apply.',
        },
      },
      required: ['name', 'body'],
    },
  },
  {
    name: 'memory_list',
    description: 'List every memory saved for this project: name, type and description.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_read',
    description: 'Read one memory of this project in full, by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory of this project by name, when it turned out to be wrong or obsolete.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

const call = createApiClient('/api/agent/memories', 'The memory tool is not configured for this session');

function fmt(m) {
  return `${m.name} (${m.type})${m.description ? `: ${m.description}` : ''}`;
}

async function runTool(name, args = {}) {
  switch (name) {
    case 'memory_save': {
      const { memory } = await call('POST', '', args);
      return `Saved memory ${fmt(memory)}`;
    }
    case 'memory_list': {
      const { memories } = await call('GET', '');
      return memories.length ? memories.map(fmt).join('\n') : 'No memories saved for this project yet.';
    }
    case 'memory_read': {
      const { memory } = await call('GET', `/${encodeURIComponent(args.name || '')}`);
      return `# ${fmt(memory)}\n\n${memory.body}`;
    }
    case 'memory_delete': {
      await call('DELETE', `/${encodeURIComponent(args.name || '')}`);
      return `Deleted memory ${args.name}`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

serveStdio({ name: 'reviewer-memory', tools: TOOLS, runTool });
