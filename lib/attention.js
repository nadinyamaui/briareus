// @ts-check
// Stable keys describe unresolved work, so polling and push delivery can share
// one projection without manufacturing a new notification on every refresh.
export function attentionItems(sessions, requests = []) {
  const items = [];
  for (const s of sessions) {
    // Each item is dated by the moment it began to wait where the record keeps
    // one; sessions carry no updatedAt, and their creation says nothing about
    // when a question or finding appeared.
    const add = (kind, summary, href, at, extra = {}) =>
      items.push({
        id: `${s.id}:${kind}`,
        sessionId: s.id,
        repo: s.repo,
        title: s.title || s.id,
        kind,
        summary,
        href,
        at: at || s.createdAt,
        ...extra,
      });
    const triage = s.reviewTriage || s.reviewLoop?.triage;
    const findings = () => add('findings', 'Review findings need a decision', '/findings', triage.heldAt);
    // Findings outlive their session: a hand-started review closes once it
    // publishes, and its held round still waits in ⚑ Findings.
    if (s.status === 'closed') {
      if (triage) findings();
      continue;
    }
    if (s.awaitingAnswer) add('question', 'The agent needs your answer', `/sessions/${s.id}`, s.askedAt);
    if (triage) findings();
    // A loop's review, fix and QA sessions report their failure on the parent,
    // which is where it is retried; listing the child too says it twice.
    const loopChild = s.loopParentId || s.qaParentId || s.loopFixParentId;
    if ((s.status === 'interrupted' || s.status === 'failed') && !loopChild)
      add('recovery', s.error || `Session ${s.status}`, `/sessions/${s.id}`, s.endedAt);
    else if (s.reviewLoop?.failure)
      add(
        'review-failed',
        s.reviewLoop.failure.reason || 'Review could not finish',
        `/sessions/${s.id}`,
        s.reviewLoop.failure.at,
      );
    // A stall waits for a person until the next push; a pull request that is
    // merged or closed has nothing left to decide.
    if (s.reviewLoop?.stalled && (!s.prStatus?.state || s.prStatus.state === 'open'))
      add(
        'review-stalled',
        'The review loop stopped with findings left to judge by hand',
        `/sessions/${s.id}`,
      );
    if (s.qaLoop?.failure || s.qaLoop?.failedScenarios)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason || `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
        s.qaLoop.failure?.at,
      );
    // QA ran, but its verdict could not be read: not a pass, and nothing retries it.
    if (s.qaLoop?.verdictError)
      add(
        'qa-verdict',
        `QA ran but its verdict could not be read (${s.qaLoop.verdictError}); read the sheet and decide`,
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
      sessionTitle: r.sessionTitle,
      summary: r.command,
      at: new Date(r.createdAt).toISOString(),
      href: `/sessions/${r.jobId}`,
      request: r,
    });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
