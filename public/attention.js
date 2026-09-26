(() => {
  if (location.pathname !== '/attention') return;
  const { api, esc, content, status } = window.BriareusOperations;
  let items = [],
    busy = false,
    signature = '';
  async function refresh() {
    if (busy) return;
    try {
      const data = await api('/api/operations/attention');
      items = data.items;
      const next = JSON.stringify(items);
      if (next === signature) return;
      // Do not erase an answer being written when the polling state changes.
      if (content.contains(document.activeElement)) return;
      signature = next;
      status(items.length ? `${items.length} item(s) need your attention` : 'Nothing needs your attention.');
      content.innerHTML = items
        .map(
          (i) => `<article class="mb-4 rounded-lg border border-line bg-raise p-4" data-item="${esc(i.id)}">
        <p class="text-xs text-muted">${esc(i.repo)} · ${esc(i.kind)}</p><h2 class="my-2 font-semibold">${esc(i.title)}</h2>
        <p class="whitespace-pre-wrap break-words">${esc(i.summary)}</p>
        ${i.request ? `<p class="my-2 text-xs text-muted">${esc(i.request.username)}@${esc(i.request.host)}:${esc(i.request.port)} · timeout ${esc(i.request.timeoutSeconds)}s · expires ${esc(new Date(i.request.expiresAt).toLocaleTimeString())}</p><button class="btn" data-action="approve">Approve command</button> <button class="btn" data-action="deny">Deny</button>` : ''}
        ${i.kind === 'question' ? '<label class="mt-3 block">Answer<textarea class="mt-1 w-full rounded border border-line bg-canvas p-2" rows="3"></textarea></label><button class="btn" data-action="answer">Send answer</button>' : ''}
        <a class="ml-3 inline-block py-3 underline" href="${esc(i.href)}">${i.kind === 'findings' ? 'Decide findings' : 'Open conversation'}</a>
        <p class="text-danger" role="status"></p></article>`,
        )
        .join('');
    } catch (error) {
      status(error.message);
    }
  }
  content.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || busy) return;
    const card = button.closest('[data-item]');
    const item = items.find((i) => i.id === card.dataset.item);
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.action === 'answer') {
        const text = card.querySelector('textarea').value.trim();
        if (!text) throw new Error('Write an answer first');
        await api(`/api/dev/sessions/${encodeURIComponent(item.sessionId)}/message`, { text });
      } else
        await api(`/api/ssh/requests/${encodeURIComponent(item.request.id)}/decision`, {
          decision: button.dataset.action,
        });
      signature = '';
      button.blur();
    } catch (error) {
      card.querySelector('[role="status"]').textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
    await refresh();
  });
  void refresh();
  setInterval(refresh, 7000);
})();
