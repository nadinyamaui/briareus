// @ts-check
// A loop's review, fix and QA sessions report their failure on the parent,
// which is where it is retried. One its parent had stopped tracking (the loop
// was switched off or re-armed while it ran) reported nothing, and stands on
// its own.
export function isLoopChild(s) {
  return !!(s.loopParentId || s.qaParentId || s.loopFixParentId) && !s.failureUnreported;
}

// The task an item belongs to: a loop's review, fix and QA sessions are part of
// the session they work for, so push delivery groups them under it.
const taskId = (s) => s.loopParentId || s.qaParentId || s.loopFixParentId || s.id;

// Stable keys describe unresolved work, so polling and push delivery can share
// one projection without manufacturing a new notification on every refresh.
export function attentionItems(sessions, requests = []) {
  const items = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    // Each item is dated by the moment it began to wait where the record keeps
    // one; sessions carry no updatedAt, and their creation says nothing about
    // when a question or finding appeared. `revision` names the occurrence:
    // the same kind coming up again on a session (a second question, another
    // failed round) is new to a browser that was told about the first.
    const add = (kind, summary, href, at, revision = at) =>
      items.push({
        id: `${s.id}:${kind}`,
        sessionId: s.id,
        taskId: taskId(s),
        revision: revision || 'legacy',
        repo: s.repo,
        title: s.title || s.id,
        kind,
        summary,
        href,
        at: at || s.createdAt,
      });
    const triage = s.reviewTriage || s.reviewLoop?.triage;
    const findings = () =>
      add(
        'findings',
        'Review findings need a decision',
        '/findings',
        triage.heldAt,
        triage.heldAt || triage.round,
      );
    // Findings outlive their session: a hand-started review closes once it
    // publishes, and its held round still waits in ⚑ Findings.
    if (s.status === 'closed') {
      if (triage) findings();
      continue;
    }
    // A worker's question, failure, loop failure, stall and QA result go to
    // its orchestrator (queueWorkerNotice, notifyParentLoop,
    // notifyParentStalled), which answers or retries them with send_to_worker
    // and retry_review, or escalates them; they are the operator's when there
    // is no open orchestrator to hand them to, or when the worker's latest
    // update reached it only as a plain line (noticeUnheard: paused by its
    // breaker or budget, or dropped), which no turn acts on.
    const parent = s.parentId && byId.get(s.parentId);
    const owedToOrchestrator =
      !!parent && !!parent.orchestrator && parent.status !== 'closed' && !s.noticeUnheard;
    if (s.awaitingAnswer && !owedToOrchestrator)
      add(
        'question',
        s.askText || 'The agent needs your answer',
        `/sessions/${s.id}`,
        s.askedAt,
        s.questionSeq || s.askedAt,
      );
    if (triage) findings();
    // A loop child's failure is listed on its parent; listing the child too
    // says it twice (isLoopChild).
    if ((s.status === 'interrupted' || s.status === 'failed') && !isLoopChild(s) && !owedToOrchestrator)
      add(
        'recovery',
        s.error || `Session ${s.status}`,
        `/recovery/${s.id}`,
        s.endedAt,
        s.endedAt || s.createdAt,
      );
    // Loop failures, stalls and QA results wait for a person until the next
    // push; a pull request that is merged or closed has nothing left to decide.
    const prOpen = !s.prStatus?.state || s.prStatus.state === 'open';
    if (s.reviewLoop?.failure && prOpen && !owedToOrchestrator)
      add(
        'review-failed',
        s.reviewLoop.failure.reason || 'Review could not finish',
        `/sessions/${s.id}`,
        s.reviewLoop.failure.at,
        s.reviewLoop.failure.at || s.reviewLoop.failure.round,
      );
    if (s.reviewLoop?.stalled && prOpen && !owedToOrchestrator)
      add(
        'review-stalled',
        'The review loop stopped with findings left to judge by hand',
        `/sessions/${s.id}`,
        undefined,
        s.reviewLoop.rounds,
      );
    if ((s.qaLoop?.failure || s.qaLoop?.failedScenarios) && prOpen && !owedToOrchestrator)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason || `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
        s.qaLoop.failure?.at,
        s.qaLoop.failure?.at || s.qaLoop.sessionId,
      );
    // QA ran, but its verdict could not be read: not a pass, and nothing retries it.
    if (s.qaLoop?.verdictError && prOpen && !owedToOrchestrator)
      add(
        'qa-verdict',
        `QA ran but its verdict could not be read (${s.qaLoop.verdictError}); read the sheet and decide`,
        `/sessions/${s.id}`,
        undefined,
        s.qaLoop.sessionId,
      );
    // A webhook that stopped taking deliveries (its breaker, a turn that
    // failed) waits on the operator: nothing from outside wakes the
    // session again until they have looked (pauseWebhook in lib/jobs.js).
    if (s.webhookPaused)
      add('webhook-paused', s.webhookPaused.reason, `/sessions/${s.id}`, s.webhookPaused.at);
  }
  for (const r of requests)
    items.push({
      id: `ssh:${r.id}`,
      kind: 'ssh',
      title: r.serverLabel,
      repo: r.repo,
      sessionId: r.jobId,
      // An approval asked by a loop's child belongs to the task it works for.
      taskId: byId.has(r.jobId) ? taskId(byId.get(r.jobId)) : r.jobId,
      sessionTitle: r.sessionTitle,
      summary: r.command,
      at: new Date(r.createdAt).toISOString(),
      href: `/sessions/${r.jobId}`,
      request: r,
    });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
