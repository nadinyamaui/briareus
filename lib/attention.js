// @ts-check
export function isLoopChild(s) {
  return !!(s.reviewParentId || s.qaParentId) && !s.failureUnreported;
}

const taskId = (s) => s.reviewParentId || s.qaParentId || s.id;

// Stable keys describe unresolved work, so polling and push share one projection without
// a new notification on every refresh.
export function attentionItems(sessions, requests = [], slackRequests = []) {
  const items = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    // Each item is dated from when it began to wait, where the record keeps that;
    // sessions have no updatedAt and creation time says nothing. `revision` names the
    // occurrence, so the same kind recurring (a second question) is new to a browser.
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
    if (s.status === 'closed') {
      continue;
    }
    // A worker's question, failure, loop failure, stall and QA result go to its
    // orchestrator (queueWorkerNotice, notifyParentLoop, notifyParentStalled) to answer,
    // retry or escalate. They are the operator's when no orchestrator is open, or when the
    // update reached it only as a plain line no turn acts on (noticeUnheard: paused by
    // breaker or budget, or dropped).
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
    // A loop child's failure is listed on its parent; listing the child would say it
    // twice (isLoopChild).
    if ((s.status === 'interrupted' || s.status === 'failed') && !isLoopChild(s) && !owedToOrchestrator)
      add(
        'recovery',
        s.error || `Session ${s.status}`,
        `/recovery/${s.id}`,
        s.endedAt,
        s.endedAt || s.createdAt,
      );
    // Loop failures, stalls and QA results wait for a person until the next push; a
    // merged or closed PR has nothing left to decide.
    const prOpen = !s.prStatus?.state || s.prStatus.state === 'open';
    if (s.reviewLoop?.failure && prOpen && !owedToOrchestrator)
      add(
        'review-failed',
        s.reviewLoop.failure.reason,
        `/sessions/${s.id}`,
        s.reviewLoop.failure.at,
        s.reviewLoop.failure.at,
      );
    if ((s.qaLoop?.failure || s.qaLoop?.failedScenarios) && prOpen && !owedToOrchestrator)
      add(
        'qa-failed',
        s.qaLoop.failure?.reason || `${s.qaLoop.failedScenarios} QA scenarios failed`,
        `/sessions/${s.id}`,
        s.qaLoop.failure?.at,
        s.qaLoop.failure?.at || s.qaLoop.sessionId,
      );
    if (s.qaLoop?.incomplete && prOpen && !owedToOrchestrator)
      add(
        'qa-incomplete',
        'QA coverage is incomplete; inspect manual/unexecuted rows in the test sheet',
        `/sessions/${s.id}`,
        undefined,
        s.qaLoop.sessionId,
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
    // A webhook that stopped taking deliveries (breaker, failed turn) waits on the
    // operator: nothing outside wakes the session until they look (pauseWebhook,
    // lib/jobs.js).
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
  // A Slack message waiting to go out as the operator (lib/slack.js).
  for (const r of slackRequests)
    items.push({
      id: `slack:${r.id}`,
      kind: 'slack',
      title: `Slack to ${r.to.label}`,
      repo: r.repo,
      sessionId: r.jobId,
      taskId: byId.has(r.jobId) ? taskId(byId.get(r.jobId)) : r.jobId,
      sessionTitle: r.sessionTitle,
      summary: r.text,
      at: new Date(r.createdAt).toISOString(),
      href: `/sessions/${r.jobId}`,
      request: r,
    });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
