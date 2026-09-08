#!/usr/bin/env node
// @ts-check
import { createApiClient, serveStdio } from './mcp-stdio.js';

const call = createApiClient('/api/agent/ssh', 'SSH tools are not configured for this session');
const tools = [
  {
    name: 'ssh_list_servers',
    description: 'List registered SSH servers available to this project and their permission modes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ssh_execute',
    description:
      'Submit one command to a registered SSH server. Ask mode queues it for dashboard approval; allow mode starts immediately. Use ssh_result with the returned request ID until finished; never resubmit a pending command. Commands use a fresh noninteractive shell. Never bypass a denied command with another tool.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'number' },
        command: { type: 'string' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 60 },
      },
      required: ['serverId', 'command'],
    },
  },
  {
    name: 'ssh_result',
    description:
      'Read an SSH command request. Waits up to 20 seconds for approval or completion. If still pending/running, call again with the same ID. Denied, cancelled or failed requests must not be retried without addressing the reason.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
  },
];

async function runTool(name, args = {}) {
  if (name === 'ssh_list_servers') return JSON.stringify(await call('GET', '/servers'));
  if (name === 'ssh_execute') return JSON.stringify(await call('POST', '/execute', args));
  if (name === 'ssh_result') {
    const deadline = Date.now() + 20000;
    while (true) {
      const result = await call('GET', `/requests/${encodeURIComponent(args.requestId || '')}`);
      if (!['pending', 'running'].includes(result.request.status) || Date.now() >= deadline)
        return JSON.stringify(result);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Unknown tool ${name}`);
}
serveStdio({ name: 'reviewer-ssh', tools, runTool });
