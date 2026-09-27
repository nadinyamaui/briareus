(() => {
  if (!location.pathname.startsWith('/tasks/')) return;
  const { api, esc, content, title, status } = window.BriareusOperations;
  title('Task history');
  async function refresh() {
    try {
      const report = await api(
        '/api/operations/tasks/' + encodeURIComponent(location.pathname.split('/').pop()),
      );
      const { root, usage, sessions, prUrl } = report;
      const cost =
        usage.costUsd == null
          ? 'Unpriced'
          : `${usage.estimatedTurns ? '~' : ''}$${usage.costUsd.toFixed(2)}${usage.unpricedTurns ? ' + unpriced turns' : ''}`;
      status(root.title || root.id);
      const review = root.reviewDone
        ? 'Approved'
        : root.reviewRounds
          ? `${root.reviewRounds} round(s), not approved`
          : 'Not recorded';
      const qa = root.qaFailure
        ? 'Interrupted / failed'
        : root.qaFailed
          ? `${root.qaFailed} failing scenarios`
          : root.qaDone
            ? 'Passed'
            : 'Not recorded';
      content.innerHTML = `<p class="mb-4">${esc(root.repo)} · ${esc(root.branch)} · ${esc(root.status)}</p><div class="mb-5 grid gap-3 sm:grid-cols-3"><div class="rounded border border-line p-3">Total task cost<strong class="block">${esc(cost)}</strong></div><div class="rounded border border-line p-3">Agent time<strong class="block">${Math.round(usage.durationMs / 60000)} min</strong></div><div class="rounded border border-line p-3">Review rounds<strong class="block">${root.reviewRounds}</strong></div></div><p>Review: ${esc(review)} · QA: ${esc(qa)} · PR: ${esc(root.prState || 'Not linked')}</p>${prUrl ? `<a class="my-3 inline-block underline" href="${esc(prUrl)}" target="_blank" rel="noopener">Open PR, findings and QA evidence</a>` : ''}<p class="my-4 text-xs text-muted">Totals use each recorded turn once, including archived auxiliary sessions; estimates are marked ~. Sessions deleted before task history was installed cannot be reconstructed.</p><ol>${sessions.map((s) => `<li class="mb-3 rounded border border-line p-3"><p class="text-xs text-muted">${esc(s.createdAt)}${s.endedAt ? ` → ${esc(s.endedAt)}` : ''}</p><p class="my-2 font-semibold">${esc(s.activity)} · ${esc(s.title)}</p><p>${esc(s.status)}${s.prNumber ? ` · PR #${s.prNumber}` : ''}</p>${s.conversationAvailable ? `<a class="underline" href="/sessions/${encodeURIComponent(s.id)}">Conversation</a>` : '<span class="text-xs text-muted">Conversation deleted; task metadata retained</span>'}</li>`).join('')}</ol>`;
    } catch (e) {
      status(e.message);
    }
  }
  void refresh();
  setInterval(refresh, 15000);
})();
