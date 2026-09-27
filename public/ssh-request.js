// One SSH approval card and its decision call, shared by the floating panel
// (ssh-approvals.js) and the /attention inbox, so both show the operator the
// same destination, session and command before they approve it.
(() => {
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const card = (r) => `
    <div class="font-semibold">${esc(r.serverLabel)} · ${esc(r.username)}@${esc(r.host)}:${esc(r.port)}</div>
    <div class="text-xs text-muted">${esc(r.repo)} · ${esc(r.sessionTitle)}</div>
    <pre class="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 text-xs">${esc(r.command)}</pre>
    <div class="mb-2 text-xs text-muted">Timeout: ${esc(r.timeoutSeconds)}s · approval expires ${esc(new Date(r.expiresAt).toLocaleTimeString())}</div>
    <div class="flex gap-2"><button type="button" class="btn btn-primary" data-decision="approve">Approve command</button><button type="button" class="btn" data-decision="deny">Deny</button></div>`;
  async function decide(id, decision) {
    const res = await fetch(`/api/ssh/requests/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const body = await res.json().catch(() => ({})); // a proxy's error page is not JSON
    if (!res.ok) throw new Error(body.error || 'Could not save this decision');
    return body;
  }
  window.BriareusSshRequest = { esc, card, decide };
})();
