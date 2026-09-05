(() => {
  const form = document.getElementById('form');
  const user = document.getElementById('username');
  const pw = document.getElementById('password');
  const err = document.getElementById('error');
  const submit = document.getElementById('submit');
  const next = new URLSearchParams(location.search).get('next') || '/';

  function fail(message) {
    err.textContent = message;
    err.classList.remove('hidden');
    submit.disabled = false;
    submit.textContent = 'Sign in';
    // The username is usually the half that was right, so leave it standing and
    // put the cursor where the retype goes.
    pw.select();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.value.trim(), password: pw.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || `Sign in failed (HTTP ${res.status})`);
      // Same-origin only: `next` comes from the URL, so anything absolute could
      // be an open redirect somebody else wrote.
      location.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (e) {
      fail(e.message);
    }
  });
})();
