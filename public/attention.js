(() => {
  if (location.pathname !== '/attention') return;
  const { api, esc, content, status } = window.BriareusOperations;
  const ssh = window.BriareusSshRequest;
  // `items` is what the cards on screen were drawn from, so it only changes
  // when they are redrawn. `latest` numbers each refresh: a poll that set out
  // before a decision and answers after it is dropped rather than repainting
  // the request that was just decided.
  let items = [],
    busy = false,
    signature = '',
    latest = 0;
  async function refresh() {
    if (busy) return;
    const mine = ++latest;
    try {
      const data = await api('/api/operations/attention');
      if (mine !== latest || busy) return;
      const next = JSON.stringify(data.items);
      if (next === signature) return;
      // An answer being written survives the redraw: drafts are keyed by item,
      // and the focused one gets its focus and caret back.
      const drafts = new Map(
        [...content.querySelectorAll('[data-item] textarea')].map((t) => [
          t.closest('[data-item]').dataset.item,
          t,
        ]),
      );
      const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      signature = next;
      items = data.items;
      status(items.length ? `${items.length} item(s) need your attention` : 'Nothing needs your attention.');
      content.innerHTML = items
        .map(
          (i) => `<article class="mb-4 rounded-lg border border-line bg-raise p-4" data-item="${esc(i.id)}">
        ${
          i.request
            ? ssh.card(i.request)
            : `<p class="text-xs text-muted">${esc(i.repo)} · ${esc(i.kind)}</p><h2 class="my-2 font-semibold">${esc(i.title)}</h2>
        <p class="whitespace-pre-wrap break-words">${esc(i.summary)}</p>`
        }
        ${i.kind === 'question' ? '<label class="mt-3 block">Answer<textarea class="mt-1 w-full rounded border border-line bg-canvas p-2" rows="3"></textarea></label><button class="btn" data-action="answer">Send answer</button>' : ''}
        <a class="ml-3 inline-block py-3 underline" href="${esc(i.href)}">${i.kind === 'findings' ? 'Decide findings' : 'Open conversation'}</a>
        <p class="text-danger" role="status"></p></article>`,
        )
        .join('');
      for (const t of content.querySelectorAll('[data-item] textarea')) {
        const old = drafts.get(t.closest('[data-item]').dataset.item);
        if (!old) continue;
        t.value = old.value;
        if (old === focused) {
          t.focus();
          t.setSelectionRange(old.selectionStart, old.selectionEnd);
        }
      }
    } catch (error) {
      if (mine === latest) status(error.message);
    }
  }
  content.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action], [data-decision]');
    if (!button || busy) return;
    const card = button.closest('[data-item]');
    const item = items.find((i) => i.id === card.dataset.item);
    if (!item) {
      card.querySelector('[role="status"]').textContent = 'This no longer needs your attention.';
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.action === 'answer') {
        const text = card.querySelector('textarea').value.trim();
        if (!text) throw new Error('Write an answer first');
        await api(`/api/dev/sessions/${encodeURIComponent(item.sessionId)}/message`, { text });
        card.querySelector('textarea').value = ''; // sent: not a draft to restore
      } else await ssh.decide(item.request.id, button.dataset.decision);
      signature = '';
    } catch (error) {
      card.querySelector('[role="status"]').textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
      button.blur();
    }
    await refresh();
  });
  void refresh();
  setInterval(refresh, 7000);
})();
