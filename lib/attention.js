// @ts-check
// Stable keys describe unresolved work, so polling and push delivery can share
// one projection without manufacturing a new notification on every refresh.
export function attentionItems(sessions, requests = []) {
  const items = [];
  for (const s of sessions) {
    if (s.status === 'closed') continue;
    const add = (kind, summary, href, extra = {}) =>
      items.push({
        id: `${s.id}:${kind}`,
        sessionId: s.id,
        repo: s.repo,
        title: s.title || s.id,
        kind,
        summary,
        href,
        at: s.updatedAt || s.createdAt,
        ...extra,
      });
    if (s.awaitingAnswer) add('question', 'The agent needs your answer', `/sessions/${s.id}`);
    const triage = s.reviewTriage || s.reviewLoop?.triage;
    if (triage) add('findings', 'Review findings need a decision', '/findings');
    if (s.status === 'interrupted' || s.status === 'failed')
      add('recovery', s.error || `Session ${s.status}`, `/sessions/${s.id}`);
    else if (s.reviewLoop?.failure)
      add('review-failed', s.reviewLoop.failure.reason || 'Review could not finish', `/sessions/${s.id}`);
    if (s.qaLoop?.failure || s.qaLoop?.failedScenarios)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason || `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
      );
  }
  for (const r of requests)
    items.push({
      id: `ssh:${r.id}`,
      kind: 'ssh',
      title: r.serverLabel,
      repo: r.repo,
      sessionId: r.jobId,
      summary: r.command,
      at: new Date(r.createdAt).toISOString(),
      href: `/sessions/${r.jobId}`,
      request: r,
    });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
