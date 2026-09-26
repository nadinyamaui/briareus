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
  const { esc, card, decide } = window.BriareusSshRequest;
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
        <article class="mb-4 border-t border-line pt-3" data-request="${esc(r.id)}">${card(r)}
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
    const article = button.closest('[data-request]');
    busy = true;
    article.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      await decide(article.dataset.request, button.dataset.decision);
      previous = '';
    } catch (e) {
      article.querySelector('[role="status"]').textContent = e.message;
    } finally {
      busy = false;
      article.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
    await refresh();
  });
  void refresh();
  setInterval(refresh, 3000);
})();
