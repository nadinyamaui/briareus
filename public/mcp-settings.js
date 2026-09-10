(() => {
  const $ = (id) => document.getElementById(id);
  let state;
  const notice = (message) => {
    $('notice').textContent = message;
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function clearCredentials() {
    $('credentials').classList.add('hidden');
    $('client-secret').type = 'password';
    for (const id of ['client-id', 'client-secret', 'mcp-url']) $(id).value = '';
  }
  async function load() {
    state = await api('/api/mcp');
    $('base-url').value = state.baseUrl || (location.protocol === 'https:' ? location.origin : '');
    $('enabled').checked = state.enabled;
    $('server-url').value = state.url;
    $('save').disabled = !state.loginEnabled;
    $('create').disabled = !state.loginEnabled || !state.enabled;
    if (!state.loginEnabled)
      notice(
        'Password login is required. Configure it on the server with npm run set-password, then restart Briareus.',
      );
    $('projects').replaceChildren();
    for (const project of state.projects) {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 text-sm';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = project.repo;
      label.append(input, document.createTextNode(`${project.label} · ${project.repo}`));
      $('projects').append(label);
    }
    if (!state.projects.length) $('projects').textContent = 'Add a project in Settings first.';
    $('clients').replaceChildren();
    for (const client of state.clients) {
      const row = document.createElement('div');
      row.className = 'rounded border border-line p-3';
      const title = document.createElement('p');
      title.textContent = `${client.label} · ${client.connected ? 'Connected' : 'Ready to connect'}`;
      const repos = document.createElement('p');
      repos.className = 'mt-1 text-xs text-muted';
      repos.textContent = client.repos.join(', ');
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn mt-2';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke ${client.label}? ChatGPT will lose access through this connection.`))
          return;
        revoke.disabled = true;
        try {
          await api(`/api/mcp/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE' });
          clearCredentials();
          await load();
          notice('Connection revoked.');
        } catch (e) {
          notice(e.message);
          revoke.disabled = false;
        }
      });
      row.append(title, repos, revoke);
      $('clients').append(row);
    }
    if (!state.clients.length) $('clients').textContent = 'No connections yet.';
  }
  $('config-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('save').disabled = true;
    try {
      await api('/api/mcp', {
        method: 'PUT',
        body: JSON.stringify({ baseUrl: $('base-url').value.trim(), enabled: $('enabled').checked }),
      });
      clearCredentials();
      await load();
      notice('Saved. Disabling the connection or changing its address requires ChatGPT to reconnect.');
    } catch (e) {
      notice(e.message);
      $('save').disabled = false;
    }
  });
  $('client-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('create').disabled = true;
    clearCredentials();
    try {
      const credentials = await api('/api/mcp/clients', {
        method: 'POST',
        body: JSON.stringify({
          label: $('label').value.trim(),
          redirectUri: $('redirect-uri').value.trim(),
          repos: Array.from($('projects').querySelectorAll('input:checked'), (input) => input.value),
        }),
      });
      // Keep the one-time secret visible even if the following list refresh fails.
      $('mcp-url').value = state.url;
      $('client-id').value = credentials.clientId;
      $('client-secret').value = credentials.clientSecret;
      $('credentials').classList.remove('hidden');
      await load();
      notice('Connection created. Copy the values into ChatGPT.');
    } catch (e) {
      notice(e.message);
      $('create').disabled = false;
    }
  });
  $('copy-secret').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('client-secret').value);
      notice('Client secret copied.');
    } catch {
      $('client-secret').type = 'text';
      $('client-secret').select();
      notice('Select and copy the client secret.');
    }
  });
  load().catch((e) => notice(e.message));
})();
