// Shared by sessions and settings: approval is available wherever the operator is.
(() => {
  const panel = document.createElement('section');
  panel.id = 'ssh-approvals';
  panel.setAttribute('aria-label', 'SSH command approvals');
  panel.className =
    'fixed right-4 bottom-4 z-50 max-h-[60vh] w-[min(480px,calc(100vw-2rem))] overflow-auto rounded-lg border border-line bg-raise p-4 shadow-xl hidden';
  document.body.append(panel);
  let previous = '';
  let busy = false;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  async function refresh() {
    if (busy) return;
    try {
      const res = await fetch('/api/ssh/requests', { cache: 'no-store' });
      if (!res.ok) return;
      const { requests } = await res.json();
      const key = JSON.stringify(requests);
      if (key === previous) return;
      previous = key;
      panel.classList.toggle('hidden', !requests.length);
      panel.innerHTML =
        `<h2 class="mb-3 font-semibold">SSH commands awaiting approval (${requests.length})</h2>` +
        requests
          .map(
            (r) => `
        <article class="mb-4 border-t border-line pt-3" data-request="${esc(r.id)}">
          <div class="font-semibold">${esc(r.serverLabel)} · ${esc(r.username)}@${esc(r.host)}:${r.port}</div>
          <div class="text-xs text-muted">${esc(r.repo)} · ${esc(r.sessionTitle)}</div>
          <pre class="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 text-xs">${esc(r.command)}</pre>
          <div class="mb-2 text-xs text-muted">Timeout: ${r.timeoutSeconds}s · approval expires ${esc(new Date(r.expiresAt).toLocaleTimeString())}</div>
          <div class="flex gap-2"><button type="button" class="btn btn-primary" data-decision="approve">Approve command</button><button type="button" class="btn" data-decision="deny">Deny</button></div>
          <div class="mt-2 text-xs text-danger" role="status"></div>
        </article>`,
          )
          .join('');
    } catch {
      /* Keep outstanding approvals visible while reconnecting. */
    }
  }
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-decision]');
    if (!button || busy) return;
    const card = button.closest('[data-request]');
    busy = true;
    card.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      const res = await fetch(`/api/ssh/requests/${encodeURIComponent(card.dataset.request)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: button.dataset.decision }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save this decision');
      previous = '';
    } catch (e) {
      card.querySelector('[role="status"]').textContent = e.message;
    } finally {
      busy = false;
      card.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
    await refresh();
  });
  void refresh();
  setInterval(refresh, 3000);
})();
