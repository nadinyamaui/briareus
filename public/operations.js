(() => {
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  async function api(url, body, method = 'POST') {
    const response = await fetch(
      url,
      body === undefined
        ? { cache: 'no-store' }
        : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (response.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      throw new Error('Sign in to continue');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  window.BriareusOperations = {
    esc,
    api,
    content: document.getElementById('operations-content'),
    title: (text) => {
      document.getElementById('operations-title').textContent = text;
    },
    status: (text) => {
      document.getElementById('operations-status').textContent = text;
    },
  };
})();
