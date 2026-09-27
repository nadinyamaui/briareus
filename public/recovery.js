(() => {
  const { api, esc, content, status, title } = window.BriareusOperations;
  if (location.pathname === '/maintenance') {
    title('Maintenance');
    // `latest` numbers each refresh, so a poll that set out before a toggle
    // and answers after it is dropped instead of repainting the old state. A
    // hidden tab does not poll; it catches up when shown again.
    let busy = false,
      latest = 0;
    async function refresh({ poll = false } = {}) {
      if (poll && (busy || document.hidden)) return;
      const mine = ++latest;
      try {
        const state = await api('/api/operations/maintenance');
        if (mine !== latest || (poll && busy)) return;
        status(
          state.ready
            ? 'Active work has finished. The server is ready for your deployment procedure.'
            : state.draining
              ? 'Waiting for active work to finish…'
              : 'Accepting new work.',
        );
        content.innerHTML = `<button class="btn" id="maintenance-toggle">${state.draining ? 'Resume accepting work' : 'Drain active work'}</button><p class="my-4">Draining refuses new tasks and messages that would start a new turn, while existing turns, answers to their questions and their automatic follow-up work finish. It does not restart the server.</p>${state.active.map((s) => `<p><a class="underline" href="/sessions/${esc(s.id)}">${esc(s.title || s.id)}</a> · ${esc(s.status)}</p>`).join('')}<p>Running SSH commands: ${state.sshRunning}</p>`;
        content.querySelector('button').onclick = async () => {
          if (busy) return;
          busy = true;
          try {
            await api('/api/operations/maintenance', { draining: !state.draining });
            await refresh();
          } catch (e) {
            status(e.message);
          } finally {
            busy = false;
          }
        };
      } catch (e) {
        if (mine === latest) status(e.message);
      }
    }
    void refresh();
    setInterval(() => void refresh({ poll: true }), 5000);
    document.addEventListener('visibilitychange', () => void refresh({ poll: true }));
    return;
  }
  if (!location.pathname.startsWith('/recovery/')) return;
  title('Resume interrupted work');
  const id = location.pathname.split('/').pop();
  async function refresh() {
    try {
      const r = await api(`/api/operations/recovery/${encodeURIComponent(id)}`);
      status(r.reason);
      content.innerHTML = `<dl class="my-4"><dt>Expected branch</dt><dd>${esc(r.expectedBranch)}</dd><dt>Current branch</dt><dd>${esc(r.branch)}</dd><dt>Last commit</dt><dd class="break-all">${esc(r.head)}</dd><dt>Pending phase</dt><dd>${esc(r.phase)}</dd></dl><pre class="mb-4 overflow-auto whitespace-pre-wrap">${esc(r.changes || 'No working-file changes reported')}</pre><p class="mb-4">Resuming sends a new agent turn and may incur usage. Existing external actions are checked before continuing.</p><button class="btn" ${r.canResume ? '' : 'disabled'}>Resume from here</button> <a class="underline" href="/sessions/${encodeURIComponent(id)}">Conversation</a>`;
      content.querySelector('button').onclick = async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/operations/recovery/${encodeURIComponent(id)}`, { fingerprint: r.fingerprint });
          location.href = `/sessions/${encodeURIComponent(id)}`;
        } catch (e) {
          status(e.message);
          event.target.disabled = false;
        }
      };
    } catch (e) {
      status(e.message);
    }
  }
  void refresh();
})();
