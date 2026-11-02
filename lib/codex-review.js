// @ts-check
// Codex 0.165.0's ReviewTask explicitly disables Collab and MultiAgentV2:
// https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tasks/review.rs
// Keep native discovery; finish repository-required delegation in the existing
// normal publication turn, where those tools are available when configured.
export const CODEX_REVIEW_CAPABILITIES = `\n\n# Native review capabilities\n\nNative Codex review disables subagent delegation. Read the applicable AGENTS.md and review skills and perform native discovery, recording any independent reviewer requirements still pending. The next official phase is a normal turn of this same conversation: it must complete those requirements with real subagents before publication and finalization. Do not simulate independent reviewers or treat missing delegation in native discovery as evidence that the PR is correct. Do not launch a nested CLI or repeat native discovery to work around this restriction.`;

/** @param {{head: string, base: string, completionPath: string}} p */
export function codexReviewPreparationPrompt({ head, base, completionPath }) {
  return `Before publishing, complete the repository's review requirements for ${head} against ${JSON.stringify(base)} in this normal Codex turn. Read applicable AGENTS.md and review skills, including repository-local skills referenced by them; identify required independent reviewers from those instructions, without inventing global reviewer roles.

Keep the native discovery report intact. Use real subagent tools for each required independent review, on this same reviewed head and base, inheriting the selected provider, model and effort and the review's database isolation and authorization rules. Wait for their results and combine their findings with native discovery for publication and subsequent verification. Record the instruction source, requirement, actual reviewer thread ID and result evidence for each required review. Reuse reviewers already completed in this official phase after an interruption; do not rerun native discovery or create duplicate reviewers. If none are required, do not spawn any.

Write a JSON completion receipt to ${JSON.stringify(completionPath)} with exactly this shape: {"head":"${head}","status":"complete","requirements":[{"source":"instruction file:line","requirement":"required review","reviewerId":"actual subagent thread ID","evidence":"result and evidence"}]}. An empty requirements array means the instructions require no independent reviewers. Mark complete only after every required reviewer has actually completed; the host checks the IDs against Codex delegation events.

If required delegation is unavailable, fails or remains incomplete, write status "blocked" instead and include a nonempty "blocker" explaining the missing capability or result, retain the pending requirements, and publish an explicitly INCOMPLETE summary with the blocker. Zero findings never establishes completion. Do not simulate reviewers, use a general worker as a substitute, switch provider/account, change infrastructure or relax requirements. Leave labels unchanged and submit no approval. The host will stop before verification and labelling. Otherwise continue with publication below, including the required reviewers' results and evidence in the summary. Do not change labels or submit approval during publication.`;
}

// Observe the CLI's actual events, not agent prose or a claimed ID in the receipt.
// App Server 0.165.0 emits collabAgentToolCall or subAgentActivity; exec uses
// collab_tool_call (same pinned release's protocol schemas / exec_events.rs).
export function recordCodexReviewDelegation(agents, message) {
  if (message.type !== 'item.completed') return false;
  const item = message.item;
  if (item?.type === 'subAgentActivity') {
    const id = item.agentThreadId;
    if (!id || !['started', 'completed'].includes(item.kind)) return false;
    agents[id] = { ...agents[id], [item.kind]: true };
    return true;
  }
  if (!['collabAgentToolCall', 'collab_tool_call'].includes(item?.type) || item.status !== 'completed')
    return false;
  const spawned = ['spawnAgent', 'spawn_agent'].includes(item.tool);
  const states = item.agentsStates || item.agents_states || {};
  for (const id of item.receiverThreadIds || item.receiver_thread_ids || []) {
    agents[id] = {
      ...agents[id],
      ...(spawned ? { started: true } : {}),
      ...(states[id]?.status === 'completed' ? { completed: true } : {}),
    };
  }
  return true;
}

export function assertCodexReviewCompletion(receipt, head, agents = {}) {
  const nonempty = (v) => typeof v === 'string' && !!v.trim();
  if (!nonempty(head) || receipt?.head !== head)
    throw new Error('Review requirements receipt is missing or names a different head');
  if (receipt.status === 'blocked' || nonempty(receipt.blocker))
    throw new Error(`Required independent review is incomplete: ${receipt.blocker || 'no blocker details'}`);
  if (receipt.status !== 'complete' || !Array.isArray(receipt.requirements))
    throw new Error('Review requirements receipt is incomplete');
  for (const requirement of receipt.requirements) {
    if (
      !requirement ||
      !['source', 'requirement', 'reviewerId', 'evidence'].every((key) => nonempty(requirement[key])) ||
      !agents[requirement.reviewerId]?.started ||
      !agents[requirement.reviewerId]?.completed
    )
      throw new Error('Required independent reviewer has no observed completed delegation and evidence');
  }
}
