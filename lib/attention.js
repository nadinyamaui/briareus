// @ts-check
// Stable keys describe unresolved work, so polling and push delivery can share
// one projection without manufacturing a new notification on every refresh.
const taskId = (s) => s.loopParentId || s.qaParentId || s.loopFixParentId || s.id;
export function attentionItems(sessions, requests = []) {
  const items = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    const add = (kind, summary, href, extra = {}) =>
      items.push({
        id: `${s.id}:${kind}`,
        sessionId: s.id,
        taskId: taskId(s),
        repo: s.repo,
        title: s.title || s.id,
        kind,
        summary,
        href,
        at: s.updatedAt || s.createdAt,
        ...extra,
      });
    const triage = s.reviewTriage || s.reviewLoop?.triage;
    if (triage)
      add('findings', 'Review findings need a decision', '/findings', {
        revision: triage.heldAt || triage.round,
      });
    if (s.status === 'closed') continue;
    if (s.awaitingAnswer)
      add('question', 'The agent needs your answer', `/sessions/${s.id}`, {
        revision: s.questionSeq || 'legacy',
      });
    if (s.status === 'interrupted' || s.status === 'failed')
      add('recovery', s.error || `Session ${s.status}`, `/recovery/${s.id}`, {
        revision: s.endedAt || s.createdAt,
      });
    else if (s.reviewLoop?.failure)
      add('review-failed', s.reviewLoop.failure.reason || 'Review could not finish', `/sessions/${s.id}`, {
        revision: s.reviewLoop.failure.at || s.reviewLoop.failure.round,
      });
    if (s.qaLoop?.failure || s.qaLoop?.failedScenarios || s.qaLoop?.verdictError)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason ||
          s.qaLoop.verdictError ||
          `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
        { revision: s.qaLoop.failure?.at || s.qaLoop.sessionId },
      );
  }
  for (const r of requests)
    items.push({
      id: `ssh:${r.id}`,
      kind: 'ssh',
      title: r.serverLabel,
      repo: r.repo,
      sessionId: r.jobId,
      taskId: byId.has(r.jobId) ? taskId(byId.get(r.jobId)) : r.jobId,
      summary: r.command,
      at: new Date(r.createdAt).toISOString(),
      href: `/sessions/${r.jobId}`,
      request: r,
    });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
