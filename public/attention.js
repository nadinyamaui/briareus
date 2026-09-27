(() => {
  if (location.pathname.replace(/\/+$/, '') !== '/attention') return;
  const { api, esc, content, status } = window.BriareusOperations;
  const ssh = window.BriareusSshRequest;
  // `items` is what the cards on screen were drawn from, so it only changes
  // when they are redrawn. `latest` numbers each refresh: a poll that set out
  // before a decision and answers after it is dropped rather than repainting
  // the request that was just decided. `inFlight` counts the refreshes under
  // way: a poll tick skips while one is, so a server slower than the interval
  // is waited for rather than every answer being superseded by the next tick.
  let items = [],
    busy = false,
    signature = '',
    latest = 0,
    inFlight = 0;
  // `sent` holds the questions answered from here, by item id and the time
  // the question was asked: an answer handed to a live turn leaves the
  // question standing until the CLI reads it, and an empty box under it would
  // look unsent.
  const sent = new Map();
  // A hidden tab does not poll (every poll walks every session record); it
  // catches up as soon as it is shown again.
  async function refresh({ poll = false } = {}) {
    if (busy || document.hidden || (poll && inFlight)) return;
    const mine = ++latest;
    inFlight++;
    try {
      const data = await api('/api/operations/attention');
      if (mine !== latest || busy) return;
      // Before the unchanged check: a success after a failed poll has to
      // replace that poll's error even when the items are the same.
      status(
        data.items.length
          ? `${data.items.length} item(s) need your attention`
          : 'Nothing needs your attention.',
      );
      const next = JSON.stringify(data.items);
      if (next === signature) return;
      // An answer being written survives the redraw: drafts are keyed by item
      // and by when its question was asked, so a newer question on the same
      // session does not inherit an answer written for the one before, and the
      // focused one gets its focus and caret back.
      const draftKey = (t) => {
        const card = t.closest('[data-item]');
        return `${card.dataset.item}@${card.dataset.at}`;
      };
      const drafts = new Map(
        [...content.querySelectorAll('[data-item] textarea')].map((t) => [draftKey(t), t]),
      );
      const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      signature = next;
      items = data.items;
      for (const [id, at] of sent) if (!items.some((i) => i.id === id && i.at === at)) sent.delete(id);
      content.innerHTML = items
        .map(
          (i) => `<article class="mb-4 rounded-lg border border-line bg-raise p-4" data-item="${esc(i.id)}"
          data-at="${esc(i.at)}">
        ${
          i.request
            ? ssh.card(i.request)
            : `<p class="text-xs text-muted">${esc(i.repo)} · ${esc(i.kind)}</p><h2 class="my-2 font-semibold">${esc(i.title)}</h2>
        <p class="whitespace-pre-wrap break-words">${esc(i.summary)}</p>`
        }
        ${
          i.kind !== 'question'
            ? ''
            : sent.get(i.id) === i.at
              ? '<p class="mt-3 text-muted">Answer sent; the agent reads it when its turn takes it in.</p>'
              : '<label class="mt-3 block">Answer<textarea class="mt-1 w-full rounded border border-line bg-canvas p-2" rows="3"></textarea></label><button class="btn" data-action="answer">Send answer</button>'
        }
        <a class="ml-3 inline-block py-3 underline" href="${esc(i.href)}">${i.kind === 'findings' ? 'Decide findings' : 'Open conversation'}</a>
        <p class="text-danger" role="status"></p></article>`,
        )
        .join('');
      for (const t of content.querySelectorAll('[data-item] textarea')) {
        const old = drafts.get(draftKey(t));
        if (!old) continue;
        t.value = old.value;
        if (old === focused) {
          t.focus();
          t.setSelectionRange(old.selectionStart, old.selectionEnd);
        }
      }
    } catch (error) {
      if (mine === latest) status(error.message);
    } finally {
      inFlight--;
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
        sent.set(item.id, item.at);
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
  setInterval(() => refresh({ poll: true }), 7000);
  document.addEventListener('visibilitychange', () => void refresh({ poll: true }));
})();
