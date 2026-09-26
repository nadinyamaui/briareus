(() => {
  if (location.pathname !== '/memory-health') return;
  const { api, esc, content, title, status } = window.BriareusOperations;
  title('Memory maintenance');
  let data,
    busy = false;
  async function refresh() {
    try {
      data = await api('/api/operations/memories');
      status(
        `${data.memories.length} memories · ${data.duplicates.length} possible duplicates. Verification means you checked the facts; age alone does not make a memory wrong.`,
      );
      content.innerHTML =
        data.duplicates
          .map((pair) => {
            const [a, b] = pair.ids.map((id) => data.memories.find((m) => m.id === id));
            return `<details class="mb-4 rounded border border-line p-3"><summary>Possible duplicate: ${esc(a.name)} / ${esc(b.name)}</summary><p class="my-2">Review the combined text. Save keeps ${esc(a.name)} and archives ${esc(b.name)}; archived text remains recoverable.</p><textarea class="w-full bg-canvas p-2" rows="8">${esc(a.body + '\n\n' + b.body)}</textarea><button class="btn" data-merge="${a.id},${b.id}">Save reviewed merge</button></details>`;
          })
          .join('') +
        data.memories
          .map(
            (m) =>
              `<article class="mb-4 rounded border border-line p-4" data-memory="${m.id}"><p class="text-xs text-muted">${esc(m.repo)} · ${m.archived ? 'Archived' : m.needsVerification ? 'Needs verification' : 'Verified'} · ${esc(m.verifiedAt || 'Never verified')}</p><h2 class="my-2 font-semibold">${esc(m.name)}</h2><p>${esc(m.description)}</p><details class="my-3"><summary>Read memory</summary><pre class="whitespace-pre-wrap break-words">${esc(m.body)}</pre></details><button class="btn" data-action="verify">I verified this</button> <button class="btn" data-action="${m.archived ? 'restore' : 'archive'}">${m.archived ? 'Restore' : 'Archive'}</button></article>`,
          )
          .join('');
    } catch (e) {
      status(e.message);
    }
  }
  content.onclick = async (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.merge) {
        const [a, b] = button.dataset.merge
          .split(',')
          .map((id) => data.memories.find((m) => m.id === Number(id)));
        await api('/api/operations/memories/merge/apply', {
          targetId: a.id,
          sourceId: b.id,
          revisions: [a.revision, b.revision],
          body: button.parentElement.querySelector('textarea').value,
        });
      } else {
        const m = data.memories.find((m) => m.id === Number(button.closest('[data-memory]').dataset.memory));
        await api(`/api/operations/memories/${m.id}`, {
          revision: m.revision,
          action: button.dataset.action,
        });
      }
      await refresh();
    } catch (e) {
      status(e.message);
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
  void refresh();
})();
