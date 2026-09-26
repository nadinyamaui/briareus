(() => {
  if (location.pathname !== '/attention') return;
  const { api, esc, content, status } = window.BriareusOperations;
  const drafts = new Map(),
    questions = new Map();
  const occurrence = (item) => JSON.stringify([item.id, item.revision]);
  content.addEventListener('input', (event) => {
    const card = event.target.closest('[data-item]');
    if (card && event.target.tagName === 'TEXTAREA') drafts.set(card.dataset.occurrence, event.target.value);
  });
  let items = [],
    busy = false,
    signature = '';
  async function refresh() {
    if (busy) return;
    try {
      const data = await api('/api/operations/attention');
      if (busy) return;
      const task = new URLSearchParams(location.search).get('task');
      const nextItems = task
        ? data.items.filter((i) => (i.taskId || i.sessionId || i.id) === task)
        : data.items;
      const live = new Set(nextItems.map(occurrence));
      for (const cache of [questions, drafts])
        for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
      const next = JSON.stringify(nextItems);
      if (next === signature) return;
      // Do not erase an answer being written when the polling state changes.
      const focused = document.activeElement?.closest('[data-item]');
      const removed = items.some((i) => !live.has(occurrence(i)));
      if (focused && !removed && live.has(focused.dataset.occurrence)) return;
      items = nextItems;
      signature = next;
      status(items.length ? `${items.length} item(s) need your attention` : 'Nothing needs your attention.');
      content.innerHTML = items
        .map(
          (
            i,
          ) => `<article class="mb-4 rounded-lg border border-line bg-raise p-4" data-item="${esc(i.id)}" data-occurrence="${esc(occurrence(i))}">
        <p class="text-xs text-muted">${esc(i.repo)} · ${esc(i.kind)}</p><h2 class="my-2 font-semibold">${esc(i.title)}</h2>
        <p class="whitespace-pre-wrap break-words">${esc(i.summary)}</p>
        ${i.request ? `<p class="my-2 text-xs text-muted">${esc(i.request.username)}@${esc(i.request.host)}:${esc(i.request.port)} · timeout ${esc(i.request.timeoutSeconds)}s · expires ${esc(new Date(i.request.expiresAt).toLocaleTimeString())}</p><button class="btn" data-action="approve">Approve command</button> <button class="btn" data-action="deny">Deny</button>` : ''}
        ${i.kind === 'question' ? `<button class="btn my-2" data-action="read">Read question</button><p class="whitespace-pre-wrap" data-question>${esc(questions.get(occurrence(i)) || '')}</p><label class="mt-3 block">Answer<textarea class="mt-1 w-full rounded border border-line bg-canvas p-2" rows="3">${esc(drafts.get(occurrence(i)) || '')}</textarea></label><button class="btn" data-action="answer">Send answer</button>` : ''}
        <a class="ml-3 inline-block py-3 underline" href="${esc(i.href)}">${i.kind === 'findings' ? 'Decide findings' : i.kind === 'recovery' ? 'Inspect recovery' : 'Open conversation'}</a>
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
    if (!item || occurrence(item) !== card.dataset.occurrence) return;
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.action === 'read') {
        const data = await api(`/api/dev/sessions/${encodeURIComponent(item.sessionId)}`);
        const ask = data.events?.findLast((e) => e.kind === 'ask');
        if (!data.session?.awaitingAnswer || (item.revision !== 'legacy' && ask?.seq !== item.revision))
          throw new Error('The pending question changed. Refresh the inbox before answering.');
        const question = ask
          ? [ask.question, ...(ask.options || []).map((o) => (typeof o === 'string' ? o : o.label))].join(
              '\n',
            )
          : 'Open the conversation to read the latest question.';
        questions.set(occurrence(item), question);
        card.querySelector('[data-question]').textContent = question;
        return;
      }
      if (button.dataset.action === 'answer') {
        const text = card.querySelector('textarea').value.trim();
        if (!text) throw new Error('Write an answer first');
        await api(`/api/dev/sessions/${encodeURIComponent(item.sessionId)}/message`, { text });
        drafts.delete(occurrence(item));
        questions.delete(occurrence(item));
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
