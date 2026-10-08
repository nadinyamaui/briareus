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
    name: 'spawn_worker',
    description:
      'Start a worker session on this project: a full coding agent in a fresh workspace clone on a branch of ' +
      'its own, which can edit code, run tests and open a pull request. The prompt is its first message, so ' +
      'make it a complete, self-contained task brief. Omitted, provider_id/model/effort default to the ' +
      'project’s worker runtime when one is configured (your briefing says), and to your own entry otherwise — ' +
      'usually too expensive for a worker, so pick a cheap one.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, shown in the sidebar' },
        prompt: { type: 'string', description: 'The complete task brief the worker starts on' },
        provider_id: { type: 'number', description: 'Provider row id from your briefing’s provider list' },
        model: {
          type: 'string',
          description:
            'Model to run on. Omitted together with provider_id, the project’s worker runtime applies when one ' +
            'is configured, your own model otherwise. Naming a model without provider_id pairs it with your own ' +
            'provider — name both when a task needs a specific model elsewhere.',
        },
        effort: { type: 'string', description: 'Reasoning effort from that provider’s list' },
        branch: {
          type: 'string',
          description: 'Existing branch to continue on; omitted, the worker cuts a fresh one off the default',
        },
        review_loop: {
          type: 'boolean',
          description:
            'Arm the review loop on this worker: every push it settles with on its pull request gets a code ' +
            'review, whose findings are implemented by a fix session, round after round until a review finds ' +
            'nothing. Worth it for code that lands; skip it for throwaway or investigation tasks.',
        },
        qa_loop: {
          type: 'boolean',
          description:
            'Queue a QA run behind the review loop (which review_loop must arm): once the reviews converge ' +
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
      'tool that errors or misleads, a briefing that sent a worker the wrong way, a review or QA loop that ' +
      'misbehaves, a capability you plainly needed and did not have. Like spawn_worker, but on the project ' +
      'flagged as the dashboard itself and with the review loop always armed, since the fix is code that ' +
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
            'Queue a QA run behind the review loop, for a fix with a user-facing surface in the dashboard. ' +
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
      'should answer), branch, pull request, review/QA state and recovery action, cost and the first line of its latest reply.',
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
    name: 'read_worker_question',
    description:
      'Read the pending question and transcript of your worker’s current review/fix child. Use the owning ' +
      'worker id from list_workers, not the child id. Does not expose unrelated, stale or closed sessions. ' +
      'Returns child_id and question_seq for answering; escalate decisions reserved for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The owning worker session id' },
        tail: { type: 'number', description: 'Recent entries (default 40, maximum 500)' },
        full_text: { type: 'boolean', description: 'Complete text for selected entries' },
      },
      required: ['id'],
    },
  },
  {
    name: 'answer_worker_question',
    description:
      'Answer the current idle review/fix child’s pending question through its owning worker. Supply the ' +
      'child_id and question_seq returned by read_worker_question to reject stale answers. Does not grant ' +
      'review triage or approval authority; never auto-approve pending requests or decide for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The owning worker session id' },
        child_id: { type: 'string', description: 'Current child id returned by read_worker_question' },
        question_seq: { type: 'number', description: 'Question sequence returned by read_worker_question' },
        message: { type: 'string', description: 'The answer to the pending question' },
      },
      required: ['id', 'child_id', 'question_seq', 'message'],
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
    name: 'triage_findings',
    description:
      'Rule on the review round a worker’s loop is holding, only when the user told you outright to decide for ' +
      'them: by default they rule on it themselves in the dashboard’s ⚑ Findings screen. One verdict per finding, by the ' +
      'key the update (or read_worker) showed. fix sends it to the fix session; dismissed drops it for good ' +
      '(it does not apply: say why in reason, it is recorded on the pull request); optional keeps it on the ' +
      'pull request without spending a round on it. Every finding of the round needs a verdict. An optional ' +
      'note rides into the fix session as guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The worker session id' },
        verdicts: {
          type: 'array',
          description: 'One entry per finding of the round',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'The finding key, as shown in [brackets]' },
              decision: { type: 'string', enum: ['fix', 'dismissed', 'optional'] },
              reason: {
                type: 'string',
                description: 'Why, for a dismissed or optional finding; written on the pull request',
              },
            },
            required: ['key', 'decision'],
          },
        },
        note: {
          type: 'string',
          description: 'Guidance for the fix session on the findings marked fix (how, what to watch out for)',
        },
      },
      required: ['id', 'verdicts'],
    },
  },
  {
    name: 'retry_review',
    description:
      'Re-run a review round of a worker’s review loop that could not run: list_workers says so when a round ' +
      'failed on its provider (an exhausted account, a CLI that exited non-zero), was interrupted by a dashboard ' +
      'restart, or closed without publishing. ' +
      'That is not a review that found nothing — nothing was approved — and the loop only starts a round on a ' +
      'new push, which a worker whose work is done will never make. Name provider_id to move the whole loop ' +
      'onto another runtime when the one it ran on is the problem — its fix sessions and its QA run go with it — ' +
      'and model/effort alone to move the reviews only, leaving the fix sessions where they are; the loop keeps ' +
      'either for its later rounds. A model the provider it settles on does not run is refused rather than ' +
      'silently swapped, so name one that provider has. It ' +
      'reopens an interrupted worker without sending it a chat message, re-runs the review, and is refused while ' +
      'a round is actually running.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The worker session id' },
        provider_id: {
          type: 'number',
          description: 'Provider row id to run this and later rounds on, fix sessions and QA included',
        },
        model: { type: 'string', description: 'Model to run this and later reviews on' },
        effort: { type: 'string', description: 'Reasoning effort from that provider’s list' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_worker_qa_loop',
    description:
      'Arm or disarm QA on one of your workers without changing its reviews, findings, fixes or CI. ' +
      'Use on: false when the user says no QA. Arming requires an open task worker with its review loop armed. ' +
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
];

const call = createApiClient('/api/agent/sessions', 'The worker tools are not configured for this session');

// One worker as one line: what list_workers prints and spawn/send/close confirmations
// lead with.
function fmt(w) {
  const pending = w.pendingWorkerQuestion;
  const state = pending
    ? 'review/fix paused on a question'
    : w.awaitingAnswer && w.status === 'idle'
      ? 'waiting on a question'
      : w.status;
  const bits = [`${w.id} [${state}] ${w.title || '(untitled)'}`];
  // A tooling fix works on the dashboard's own repository; said on the line so the two
  // are never confused.
  if (w.toolingFor) bits.push(`tooling fix on ${w.repo}`);
  if (w.branch) bits.push(`branch ${w.branch}`);
  bits.push(`${w.provider} ${w.model}`);
  if (w.pr) bits.push(`PR #${w.pr.number} ${w.pr.state}${w.pr.checks ? ` (${w.pr.checks})` : ''}`);
  // A worker whose review loop is still reviewing or fixing is not finished, however idle
  // it looks.
  if (w.reviewLoop) {
    const loop = w.reviewLoop;
    const where = pending
      ? `${pending.role} paused on a question in ${pending.childId} — ${pending.answerable ? `read_worker_question({id: '${w.id}'}) then answer_worker_question with child_id and question_seq` : 'recover the child in the dashboard before answering'}`
      : loop.reviewing
        ? 'reviewing'
        : loop.awaitingResult
          ? "reading the round's result off the pull request"
          : loop.triage
            ? `${loop.triage.findings.length} finding(s) awaiting the user's triage`
            : loop.fixing
              ? 'fixing findings'
              : loop.stalled
                ? 'stalled, needs you'
                : loop.discoveryError
                  ? `PR discovery failed (${loop.discoveryError}); retry ${loop.discoveryRetries || 0}/3${
                      loop.discoveryRetryPending ? ' pending' : ' exhausted'
                    }`
                  : loop.failure
                    ? `round ${loop.failure.round} could not run (${loop.failure.reason}) — nothing approved, retry_review re-runs it`
                    : loop.done
                      ? 'converged'
                      : 'waiting for a push';
    bits.push(`review loop round ${loop.rounds}: ${where}`);
  }
  // A task is not done while its QA runs, and a failed QA is the loudest thing on the line.
  if (w.qaLoop) {
    const qa = w.qaLoop;
    const retry = 'not running — send_to_worker starts a retry when the worker settles';
    bits.push(
      `QA ${
        qa.running
          ? 'running'
          : qa.awaitingVerdict
            ? "finished; reading the test sheet's verdict"
            : qa.verdictError
              ? `verdict unavailable (${qa.verdictError}) — not passed; inspect the test sheet`
              : qa.failure
                ? `${qa.failure.kind} (${qa.failure.reason}); ${retry}`
                : qa.done && qa.failedScenarios
                  ? `failed: ${qa.failedScenarios} scenario(s)`
                  : qa.done
                    ? 'passed'
                    : w.reviewLoop?.done
                      ? `retry pending after an incomplete run; ${retry}`
                      : 'queued behind the review loop'
      }`,
    );
  }
  // The task's whole cost, its reviews, fixes and QA run included.
  const cost = w.usage ? w.usage.costUsd : w.costUsd;
  if (cost != null) bits.push(`$${cost.toFixed(2)}`);
  if (w.lastText) bits.push(`last: ${w.lastText}`);
  return bits.join(' · ');
}

// The round a worker's loop holds, one finding per line with the key a verdict must name,
// for read_worker: the announcing update has left the orchestrator's context by then.
function fmtTriage(w) {
  const t = w.reviewLoop && w.reviewLoop.triage;
  if (!t) return '';
  const lines = t.findings.map((f) => {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
    const advice = f.parked ? ` — the loop would have parked it: ${f.parked}` : '';
    return `- [${f.key}] ${String(f.severity).toUpperCase()}: ${f.title}${loc}${advice}`;
  });
  return `\n\nReview round ${t.round} of PR #${t.prNumber} is on hold, waiting for the user's verdicts in the dashboard's ⚑ Findings screen (triage_findings rules on it only if they asked you to):\n${lines.join('\n')}`;
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
    case 'spawn_worker': {
      const { session } = await call('POST', '', {
        title: args.title,
        prompt: args.prompt,
        providerId: args.provider_id,
        model: args.model,
        effort: args.effort,
        branch: args.branch,
        reviewLoop: args.review_loop === true,
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
      return `${fmt(session)}${fmtTriage(session)}\n\n${lines.length ? lines.join('\n') : 'No conversation yet.'}${hint}`;
    }
    case 'read_worker_question': {
      const tail = Number.isFinite(args.tail) && args.tail > 0 ? Math.floor(args.tail) : 40;
      const fullText = args.full_text === true ? '&full_text=true' : '';
      const { question, events } = await call(
        'GET',
        `/${encodeURIComponent(requireId(args))}/question?tail=${tail}${fullText}`,
      );
      return `Pending ${question.role} question: child_id=${question.childId}, question_seq=${question.questionSeq}, status=${question.status}, answerable=${question.answerable}\n${events.map(fmtEvent).join('\n')}`;
    }
    case 'answer_worker_question': {
      const { session } = await call('POST', `/${encodeURIComponent(requireId(args))}/question`, {
        childId: args.child_id,
        questionSeq: args.question_seq,
        text: args.message,
      });
      return `Answer sent. Worker is now: ${fmt(session)}`;
    }
    case 'triage_findings': {
      const { session, fixing, converged, reviewing, deferred } = await call(
        'POST',
        `/${encodeURIComponent(requireId(args))}/triage`,
        { verdicts: args.verdicts, note: args.note },
      );
      const outcome = converged
        ? 'Nothing left to fix: the loop converged on this round.'
        : fixing
          ? 'A fix session is implementing what you kept; its push is reviewed as the next round.'
          : reviewing
            ? 'Nothing left to fix, but the branch moved while the round was held, so the new commits are being reviewed as the next round.'
            : deferred
              ? 'Nothing left to fix, but the branch moved while the round was held; the new commits are reviewed once the worker settles idle.'
              : 'No fix session started; read the worker for why.';
      return `Triaged. ${outcome} Worker is now: ${fmt(session)}`;
    }
    case 'send_to_worker': {
      const { session } = await call('POST', `/${encodeURIComponent(requireId(args))}/message`, {
        text: args.message,
      });
      return `Sent. Worker is now: ${fmt(session)}`;
    }
    case 'retry_review': {
      const { session, started, round } = await call(
        'POST',
        `/${encodeURIComponent(requireId(args))}/retry-review`,
        { providerId: args.provider_id, model: args.model, effort: args.effort },
      );
      return `${
        started
          ? `Review round ${round} is running again.`
          : 'The round is queued: it starts as soon as the worker is free (its turn ends, its pull request is open).'
      } Worker is now: ${fmt(session)}`;
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
          ? 'QA follows the review loop.'
          : qaStillRunning
            ? `QA session${qaSessionId ? ` ${qaSessionId}` : ''} is still running; it was not cancelled and finishes without reporting back.`
            : 'No active QA session was left running by this change.'
      } Worker is now: ${fmt(session)}`;
    }
    case 'close_worker': {
      const { session } = await call('POST', `/${encodeURIComponent(requireId(args))}/close`);
      return `Closed worker ${fmt(session)}`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

serveStdio({ name: 'reviewer-workers', tools: TOOLS, runTool });
