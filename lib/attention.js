// @ts-check
// Stable keys describe unresolved work, so polling and push delivery can share
// one projection without manufacturing a new notification on every refresh.
export function attentionItems(sessions, requests = []) {
  const items = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
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
    // A worker's question, failure and loop failure go to its orchestrator
    // (queueWorkerNotice), which answers or retries them with send_to_worker
    // and retry_review, or escalates them; they are the operator's only when
    // there is no open orchestrator to hand them to.
    const parent = s.parentId && byId.get(s.parentId);
    const owedToOrchestrator = !!parent && !!parent.orchestrator && parent.status !== 'closed';
    if (s.awaitingAnswer && !owedToOrchestrator)
      add('question', s.askText || 'The agent needs your answer', `/sessions/${s.id}`, s.askedAt);
    if (triage) findings();
    // A loop's review, fix and QA sessions report their failure on the parent,
    // which is where it is retried; listing the child too says it twice.
    const loopChild = s.loopParentId || s.qaParentId || s.loopFixParentId;
    if ((s.status === 'interrupted' || s.status === 'failed') && !loopChild && !owedToOrchestrator)
      add('recovery', s.error || `Session ${s.status}`, `/sessions/${s.id}`, s.endedAt);
    // Loop failures, stalls and QA results wait for a person until the next
    // push; a pull request that is merged or closed has nothing left to decide.
    const prOpen = !s.prStatus?.state || s.prStatus.state === 'open';
    if (s.reviewLoop?.failure && prOpen && !owedToOrchestrator)
      add(
        'review-failed',
        s.reviewLoop.failure.reason || 'Review could not finish',
        `/sessions/${s.id}`,
        s.reviewLoop.failure.at,
      );
    if (s.reviewLoop?.stalled && prOpen)
      add(
        'review-stalled',
        'The review loop stopped with findings left to judge by hand',
        `/sessions/${s.id}`,
      );
    if ((s.qaLoop?.failure || s.qaLoop?.failedScenarios) && prOpen)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason || `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
        s.qaLoop.failure?.at,
      );
    // QA ran, but its verdict could not be read: not a pass, and nothing retries it.
    if (s.qaLoop?.verdictError && prOpen)
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
