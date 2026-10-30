#!/usr/bin/env node
// @ts-check
//
// An orchestrator session's worker tools as a stdio MCP server, like memory-mcp.js: not
// imported by the app, pointed at per turn by lib/jobs.js, one HTTP call per tool. It
// reuses the memory tool's two env vars (loopback base URL and the session's bearer
// token). Only a session created as an orchestrator gets past /api/agent/sessions, so a
// worker that reached this script still could not spawn siblings. JSON-RPC plumbing is in
// mcp-stdio.js.

import { createApiClient, serveStdio } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'list_worker_projects',
    description:
      'List registered, enabled projects accessible to this session’s owner for spawn_worker. Returns only id, name, repo and enabled metadata; does not register or enable projects. PR actions remain limited to your own project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_pr_action',
    description:
      'Run the board’s Code review or Solve conflicts action on an existing open PR in your project, using project runtimes and prompts. Use review rather than a worker briefed to review a PR. Follow its session with list_workers/read_worker. Forks and concurrent sessions are refused; runtime overrides are not accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['review', 'solve-conflicts'] },
        pr_number: { type: 'integer', minimum: 1 },
      },
      required: ['action', 'pr_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_worker',
    description:
      'Start a worker on this project, or an explicitly named authorized project: a full coding agent in a fresh ' +
      'workspace clone on its own branch, which can edit code, run tests and open a pull request. The prompt is ' +
      'its first message, so make it a complete, self-contained task brief. Omitted provider_id/model use your ' +
      'worker pick then the project’s worker runtime for this project, or the target project’s worker runtime ' +
      'then your worker pick for a different repo, finally your own entry; effort defaults to that runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, shown in the sidebar' },
        prompt: { type: 'string', description: 'The complete task brief the worker starts on' },
        repo: {
          type: 'string',
          description:
            'Optional owner/repository from list_worker_projects of an already registered, enabled project accessible to this session’s owner; ' +
            'omitted, use this project. A different target uses its configured worker runtime first, then your worker ' +
            'pick, then your own runtime. Keeps this orchestrator as parent; config, memories, PRs and QA use ' +
            'the target. Unknown, disabled and unauthorized projects are refused; never auto-register a repository.',
        },
        provider_id: { type: 'number', description: 'Provider row id from your briefing’s provider list' },
        model: {
          type: 'string',
          description:
            'Model to run on. Omitted together with provider_id, use the default worker runtime described above. ' +
            'Naming a model without provider_id pairs it with your own ' +
            'provider — name both when a task needs a specific model elsewhere.',
        },
        effort: { type: 'string', description: 'Reasoning effort from that provider’s list' },
        branch: {
          type: 'string',
          description:
            'Existing branch to continue on; omitted, the worker cuts a fresh one off the default. For a stacked ' +
            'PR, the worker may cut its own branch off this one and open its PR from it: the worker then tracks ' +
            'that PR, not the one open from this branch. The PR open from this branch is picked up once the worker ' +
            'tracking it settles; while that one is still working on it, it is not claimed twice.',
        },
        qa_loop: {
          type: 'boolean',
          description:
            'Start QA once the worker settles on an open pull request: ' +
            'cleanly, a session writes a test sheet for the pull request and executes it against the running ' +
            'app. For work with a user-facing surface; a refactor or a library change rarely earns one.',
        },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'fix_tooling',
    description:
      'Start a worker on the dashboard’s own repository to fix a flaw in the tooling that runs you: a worker ' +
      'tool that errors or misleads, a briefing that sent a worker the wrong way, QA that ' +
      'misbehaves, a capability you plainly needed and did not have. Like spawn_worker, but on the project ' +
      'flagged as the dashboard itself and with a complete task brief, since the fix is code that ' +
      'lands. The worker wakes up in a checkout of the dashboard knowing nothing of your task, so the prompt ' +
      'must carry the evidence: what was done, what the tooling did, what it should have done, where you ' +
      'suspect it lives. Only for real, repeatable flaws; never to loosen a rule that got in your way. ' +
      'Refused when no project is flagged as the dashboard: tell the user what you found instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the fix, shown in the sidebar' },
        prompt: {
          type: 'string',
          description:
            'The complete report: the evidence, the expected behaviour, and where you suspect the flaw lives',
        },
        provider_id: { type: 'number', description: 'Provider row id from your briefing’s provider list' },
        model: {
          type: 'string',
          description:
            'Model to run on. Omitted together with provider_id, the dashboard project’s worker runtime applies ' +
            'when one is configured, your own model otherwise.',
        },
        effort: { type: 'string', description: 'Reasoning effort from that provider’s list' },
        qa_loop: {
          type: 'boolean',
          description:
            'Run QA for a fix with a user-facing surface in the dashboard. ' +
            'Rarely worth it for a prompt or a tool.',
        },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'list_workers',
    description:
      'List every worker session of this orchestrator: status (a "waiting" worker stopped on a question you ' +
      'should answer), branch, pull request, QA state and recovery action, cost and the first line of its latest reply.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_worker',
    description:
      'Read the tail of one worker’s conversation. Keep the default tail: reading whole transcripts fills ' +
      'your own context and is rarely needed; the worker’s pull request is usually the better thing to read. ' +
      'Text is clipped at 2000 characters per entry by default; use full_text with a small tail to read a complete proposal.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The worker session id' },
        tail: { type: 'number', description: 'How many recent entries to read (default 40, maximum 500)' },
        full_text: {
          type: 'boolean',
          description:
            'Return complete text for the selected entries (default false); does not expand the tail or recent-log window',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'send_to_worker',
    description:
      'Send a message into a worker session: a follow-up task, a correction, or the answer to a question the ' +
      'worker stopped on. A claude worker still reading its input gets it at once, mid-turn or while its ' +
      'background agents work; any other worker queues it until the current turn ends.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The worker session id' },
        message: { type: 'string', description: 'The message the worker receives as its next turn' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'set_worker_qa_loop',
    description:
      'Arm or disarm QA on one of your workers. ' +
      'Use on: false when the user says no QA. Arming requires an open task worker that is ready to test. ' +
      'Disarming removes queued QA; an already running QA session finishes on its own and reports nothing back. ' +
      'The result explicitly says whether that QA session is still running; it does not cancel it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The worker session id' },
        on: { type: 'boolean', description: 'Explicitly true to arm QA or false to disarm it' },
      },
      required: ['id', 'on'],
    },
  },
  {
    name: 'close_worker',
    description:
      'Close a worker session once its work is done (or abandoned): its workspace clone and database server ' +
      'go back to the pool. The conversation stays readable and the session can be reopened from the UI.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The worker session id' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_worker',
    description:
      'Permanently erase a closed worker’s transcript and session history. Use ONLY when the user explicitly ' +
      'requests deletion; a request to close a worker does not authorize deletion. Only your own fully closed ' +
      'workers without active child or QA operations can be deleted. Branches and pull requests are preserved. ' +
      'Use close_worker to release resources while keeping readable history and the ability to reopen.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The closed worker session id' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const call = createApiClient('/api/agent/sessions', 'The worker tools are not configured for this session');

// One worker as one line: what list_workers prints and spawn/send/close confirmations
// lead with.
function fmt(w) {
  const state = w.awaitingAnswer && w.status === 'idle' ? 'waiting on a question' : w.status;
  const bits = [`${w.id} [${state}] ${w.title || '(untitled)'}`];
  // Branch names and PR numbers can repeat across companion repositories.
  if (w.repo) bits.push(w.toolingFor ? `tooling fix on ${w.repo}` : `repo ${w.repo}`);
  if (w.branch) bits.push(`branch ${w.branch}`);
  bits.push(`${w.provider} ${w.model}`);
  if (w.pr) bits.push(`PR #${w.pr.number} ${w.pr.state}${w.pr.checks ? ` (${w.pr.checks})` : ''}`);
  // A task is not done while its QA runs, and a failed QA is the loudest thing on the line.
  if (w.qaLoop) {
    const qa = w.qaLoop;
    const retry = 'not running — send_to_worker starts a retry when the worker settles';
    bits.push(
      `QA ${
        qa.waitingForDatabase
          ? 'waiting for a database slot; starts automatically'
          : qa.running
            ? 'running'
            : qa.awaitingVerdict
              ? "finished; reading the test sheet's verdict"
              : qa.verdictError
                ? `verdict unavailable (${qa.verdictError}) — not passed; inspect the test sheet`
                : qa.failure
                  ? `${qa.failure.kind} (${qa.failure.reason}); ${retry}`
                  : qa.done && qa.failedScenarios
                    ? `failed: ${qa.failedScenarios} scenario(s)`
                    : qa.done && qa.incomplete
                      ? 'incomplete coverage — inspect manual/unexecuted rows; not passed'
                      : qa.done
                        ? 'passed'
                        : `waiting for the worker to settle; ${retry}`
      }`,
    );
  }
  const cost = w.usage ? w.usage.costUsd : w.costUsd;
  if (cost != null) bits.push(`$${cost.toFixed(2)}`);
  if (w.lastText) bits.push(`last: ${w.lastText}`);
  return bits.join(' · ');
}

// The transcript tail, one line per entry, in the shapes the event log uses.
function fmtEvent(e) {
  switch (e.kind) {
    case 'user':
      return `[to worker] ${e.text || ''}`;
    case 'text':
      return `[worker] ${e.text || ''}`;
    case 'ask': {
      const options = (e.options || []).map((o) => o.label).join(' | ');
      return `[worker asks] ${e.question}${options ? ` — options: ${options}` : ''}`;
    }
    case 'result':
      return `[turn ended] ${e.isError ? 'with an error' : 'ok'}${e.costUsd != null ? `, $${e.costUsd.toFixed(2)}` : ''}`;
    case 'status':
      return `[status] ${e.status}${e.error ? `: ${e.error}` : ''}`;
    case 'stderr':
    case 'tool_error':
      return `[error] ${e.text || ''}`;
    default:
      return `[${e.kind}] ${e.text || ''}`;
  }
}

// A by-id tool without an id would hit the list route and die on a shape mismatch; say
// what is missing instead.
function requireId(args) {
  if (!args.id) throw new Error('This tool needs the worker session id — call list_workers to find it');
  return args.id;
}

async function runTool(name, args = {}) {
  switch (name) {
    case 'list_worker_projects': {
      const { projects } = await call('GET', '/projects');
      return JSON.stringify({ projects });
    }
    case 'start_pr_action': {
      const { session } = await call('POST', '/pr-actions', {
        action: args.action,
        prNumber: args.pr_number,
      });
      return `Started PR action ${fmt(session)}. Follow with list_workers/read_worker; updates arrive automatically.`;
    }
    case 'spawn_worker': {
      const { session } = await call('POST', '', {
        title: args.title,
        prompt: args.prompt,
        repo: args.repo,
        providerId: args.provider_id,
        model: args.model,
        effort: args.effort,
        branch: args.branch,
        qaLoop: args.qa_loop === true,
      });
      return `Started worker ${fmt(session)}`;
    }
    case 'fix_tooling': {
      const { session } = await call('POST', '', {
        title: args.title,
        prompt: args.prompt,
        providerId: args.provider_id,
        model: args.model,
        effort: args.effort,
        qaLoop: args.qa_loop === true,
        tooling: true,
      });
      return `Started tooling-fix worker ${fmt(session)}. Its pull request lands on ${session.repo}; the running dashboard keeps its current code until the user redeploys.`;
    }
    case 'list_workers': {
      const { sessions } = await call('GET', '');
      return sessions.length ? sessions.map(fmt).join('\n') : 'No worker sessions yet.';
    }
    case 'read_worker': {
      const tail = Number.isFinite(args.tail) && args.tail > 0 ? Math.floor(args.tail) : 40;
      const fullText = args.full_text === true ? '&full_text=true' : '';
      const { session, events } = await call(
        'GET',
        `/${encodeURIComponent(requireId(args))}?tail=${tail}${fullText}`,
      );
      const lines = events.map(fmtEvent).filter((l) => l.trim());
      const hint = events.some((e) => e.textTruncated)
        ? '\n\n[Text clipped at 2000 characters per entry. Retry read_worker with full_text: true and a small tail to read complete messages; increasing tail only adds entries.]'
        : '';
      return `${fmt(session)}\n\n${lines.length ? lines.join('\n') : 'No conversation yet.'}${hint}`;
    }
    case 'send_to_worker': {
      const { session } = await call('POST', `/${encodeURIComponent(requireId(args))}/message`, {
        text: args.message,
      });
      return `Sent. Worker is now: ${fmt(session)}`;
    }
    case 'set_worker_qa_loop': {
      const id = requireId(args);
      if (typeof args.on !== 'boolean') throw new Error('on must be a boolean');
      const { session, qaStillRunning, qaSessionId } = await call(
        'POST',
        `/${encodeURIComponent(id)}/qa-loop`,
        { on: args.on },
      );
      return `QA loop ${args.on ? 'armed' : 'off'}. ${
        args.on
          ? 'QA starts when the worker settles on its pull request.'
          : qaStillRunning
            ? `QA session${qaSessionId ? ` ${qaSessionId}` : ''} is still running; it was not cancelled and finishes without reporting back.`
            : 'No active QA session was left running by this change.'
      } Worker is now: ${fmt(session)}`;
    }
    case 'close_worker': {
      const { session } = await call('POST', `/${encodeURIComponent(requireId(args))}/close`);
      return `Closed worker ${fmt(session)}`;
    }
    case 'delete_worker': {
      const id = requireId(args);
      await call('DELETE', `/${encodeURIComponent(id)}`);
      return `Permanently deleted worker ${id} and its transcript/history. Branches and pull requests are preserved.`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

serveStdio({ name: 'reviewer-workers', tools: TOOLS, runTool });
