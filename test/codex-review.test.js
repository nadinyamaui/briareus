import { describe, expect, it } from 'vitest';
import {
  assertCodexReviewCompletion,
  codexReviewPreparationPrompt,
  recordCodexReviewDelegation,
} from '../lib/codex-review.js';

const head = 'a'.repeat(40);
const requirement = {
  source: 'AGENTS.md:12',
  requirement: 'Independent security review',
  reviewerId: 'reviewer-thread',
  evidence: 'Reviewed the changed authentication path; no defects found.',
};
const receipt = { head, status: 'complete', requirements: [requirement] };
const event = (item) => ({ type: 'item.completed', item });

describe('Codex review requirements', () => {
  it('accepts actual App Server spawn and completed wait events, not just a successful spawn', () => {
    const agents = {};
    recordCodexReviewDelegation(
      agents,
      event({
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['reviewer-thread'],
        agentsStates: { 'reviewer-thread': { status: 'running' } },
      }),
    );
    expect(() => assertCodexReviewCompletion(receipt, head, agents)).toThrow(/no observed completed/);
    recordCodexReviewDelegation(
      agents,
      event({
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: ['reviewer-thread'],
        agentsStates: { 'reviewer-thread': { status: 'completed' } },
      }),
    );
    expect(() => assertCodexReviewCompletion(receipt, head, agents)).not.toThrow();
  });

  it('accepts MultiAgentV2 activity and exec JSON delegation contracts', () => {
    const agents = {};
    for (const kind of ['started', 'completed'])
      recordCodexReviewDelegation(
        agents,
        event({ type: 'subAgentActivity', kind, agentThreadId: 'reviewer-thread' }),
      );
    expect(() => assertCodexReviewCompletion(receipt, head, agents)).not.toThrow();
    const execAgents = {};
    recordCodexReviewDelegation(
      execAgents,
      event({
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        status: 'completed',
        receiver_thread_ids: ['reviewer-thread'],
        agents_states: { 'reviewer-thread': { status: 'completed' } },
      }),
    );
    expect(() => assertCodexReviewCompletion(receipt, head, execAgents)).not.toThrow();
  });

  it.each(['failed', 'inProgress', 'interrupted'])(
    'does not accept %s calls or prose claiming delegation',
    (status) => {
      const agents = {};
      recordCodexReviewDelegation(
        agents,
        event({ type: 'agent_message', text: 'reviewer-thread completed' }),
      );
      recordCodexReviewDelegation(
        agents,
        event({
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status,
          receiverThreadIds: ['reviewer-thread'],
          agentsStates: { 'reviewer-thread': { status: 'completed' } },
        }),
      );
      expect(() => assertCodexReviewCompletion(receipt, head, agents)).toThrow(/no observed completed/);
    },
  );

  it('requires a receipt even for zero findings, but no agents when instructions require none', () => {
    expect(() => assertCodexReviewCompletion(null, head)).toThrow(/missing/);
    expect(() => assertCodexReviewCompletion({ status: 'complete', requirements: [] }, undefined)).toThrow(
      /missing/,
    );
    expect(() =>
      assertCodexReviewCompletion(
        { head, status: 'blocked', requirements: [], blocker: 'Tools unavailable' },
        head,
      ),
    ).toThrow(/Tools unavailable/);
    expect(() =>
      assertCodexReviewCompletion({ head, status: 'complete', requirements: [] }, head),
    ).not.toThrow();
    expect(() => assertCodexReviewCompletion({ ...receipt, head: 'b'.repeat(40) }, head)).toThrow(
      /different head/,
    );
    expect(() => assertCodexReviewCompletion({ head, status: 'complete' }, head)).toThrow(/incomplete/);
    expect(() =>
      assertCodexReviewCompletion({ ...receipt, requirements: [{ ...requirement, evidence: '' }] }, head, {
        'reviewer-thread': { started: true, completed: true },
      }),
    ).toThrow(/evidence/);
  });

  it('completes only required reviews before publication without repeating native discovery', () => {
    const prompt = codexReviewPreparationPrompt({
      head,
      base: 'refs/remotes/origin/stack/previous',
      completionPath: '/private/receipt.json',
    });
    expect(prompt).toContain('against "refs/remotes/origin/stack/previous"');
    expect(prompt).toContain('Read applicable AGENTS.md and review skills');
    expect(prompt).toContain('inheriting the selected provider, model and effort');
    expect(prompt).toContain('database isolation and authorization rules');
    expect(prompt).toContain('If none are required, do not spawn any');
    expect(prompt).toContain('do not rerun native discovery or create duplicate reviewers');
    expect(prompt).toContain('publish an explicitly INCOMPLETE summary');
    expect(prompt).toContain('Leave labels unchanged and submit no approval');
  });
});
