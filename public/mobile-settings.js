(() => {
  const $ = (id) => document.getElementById(id);
  const notice = (text) => {
    $('notice').textContent = text;
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    if (response.status === 401) throw new Error('Sign in to Briareus again, then reload this page.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function clearToken() {
    $('token').value = '';
    $('token').type = 'password';
    $('credentials').classList.add('hidden');
  }
  async function load() {
    const state = await api('/api/mobile-devices');
    const selected = new Set(
      Array.from($('projects').querySelectorAll('input:checked'), (input) => input.value),
    );
    $('projects').replaceChildren();
    for (const project of state.projects) {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 text-sm';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = project.repo;
      input.checked = selected.has(project.repo);
      label.append(input, document.createTextNode(`${project.label} · ${project.repo}`));
      $('projects').append(label);
    }
    if (!state.projects.length) $('projects').textContent = 'Add a project in Settings first.';
    $('create').disabled = !state.projects.length;
    $('devices').replaceChildren();
    for (const device of state.devices) {
      const row = document.createElement('div');
      row.className = 'rounded border border-line p-3';
      const title = document.createElement('p');
      title.textContent = `${device.label} · ${device.permission === 'read' ? 'Read only' : 'Manage'}`;
      const details = document.createElement('p');
      details.className = 'mt-1 text-xs text-muted';
      details.textContent = `${device.repos.join(', ')} · ${device.expiresAt <= Date.now() ? 'Expired' : 'Expires'} ${new Date(device.expiresAt).toLocaleString()}`;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn mt-2';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke access for ${device.label}?`)) return;
        revoke.disabled = true;
        try {
          await api(`/api/mobile-devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
          clearToken();
          await load();
          notice('Device revoked.');
        } catch (e) {
          notice(e.message);
          revoke.disabled = false;
        }
      });
      row.append(title, details, revoke);
      $('devices').append(row);
    }
    if (!state.devices.length) $('devices').textContent = 'No devices connected.';
  }
  $('device-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('create').disabled = true;
    clearToken();
    try {
      const { token } = await api('/api/mobile-devices', {
        method: 'POST',
        body: JSON.stringify({
          label: $('label').value.trim(),
          permission: $('permission').value,
          days: Number($('days').value),
          repos: Array.from($('projects').querySelectorAll('input:checked'), (input) => input.value),
        }),
      });
      $('api-url').value = `${location.origin}/api/mobile/v1`;
      $('token').value = token;
      $('credentials').classList.remove('hidden');
      await load();
      notice('Device created. Copy its token into the mobile app.');
    } catch (e) {
      notice(e.message);
      $('create').disabled = false;
    }
  });
  $('copy-token').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('token').value);
      notice('Token copied.');
    } catch {
      $('token').type = 'text';
      $('token').select();
      notice('Select and copy the token.');
    }
  });
  $('hide-token').addEventListener('click', clearToken);
  window.addEventListener('pagehide', clearToken);
  load().catch((e) => notice(e.message));
})();
