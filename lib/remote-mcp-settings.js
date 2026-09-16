// @ts-check
import express from 'express';

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// Browser-only connection management and explicit OAuth consent. This router
// sits behind the dashboard login and the existing same-origin write gate.
export function remoteMcpSettingsRoutes({ auth, loginEnabled, signedIn, getProject, listProjects }) {
  const router = express.Router();
  router.use(['/api/mcp', '/oauth/authorize'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Use the dashboard to manage ChatGPT connections' });
    // Reading setup instructions is useful before login is configured. Every
    // authorization and settings write requires a real authenticated owner.
    if (req.baseUrl !== '/oauth/authorize' && req.method === 'GET' && !loginEnabled()) return next();
    if (!loginEnabled() || !signedIn(req))
      return res.status(403).json({ error: 'Configure dashboard login and sign in first' });
    next();
  });
  router.get('/api/mcp', (_req, res) =>
    res.json({
      ...auth.view(),
      loginEnabled: loginEnabled(),
      projects: listProjects().map(({ repo, label }) => ({ repo, label })),
    }),
  );
  router.put('/api/mcp', async (req, res) => {
    await auth.configure(req.body || {});
    res.json(auth.view());
  });
  router.post('/api/mcp/clients', async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.repos) || body.repos.some((repo) => !getProject(repo)))
      return res.status(400).json({ error: 'Select existing projects' });
    res.status(201).json(await auth.createClient(body));
  });
  router.delete('/api/mcp/clients/:id', async (req, res) => {
    await auth.revoke(req.params.id);
    res.json({ ok: true });
  });
  router.get('/oauth/authorize', (req, res) => {
    const consent = auth.consent(req.query);
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'",
    );
    res.type('html')
      .send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect ChatGPT · Briareus</title>
<style>body{font:16px system-ui;max-width:560px;margin:60px auto;padding:24px;background:#181818;color:#eee}li{margin:8px 0}button{padding:12px 20px;margin:16px 12px 0 0;cursor:pointer}</style>
<h1>Connect ChatGPT to Briareus</h1><p>Allow <strong>${esc(consent.label)}</strong> to manage these projects?</p>
<ul>${consent.repos.map((repo) => `<li>${esc(repo)}</li>`).join('')}</ul>
<p>ChatGPT will be able to read sessions and pull requests, start paid agents, send messages, manage findings, and close or delete sessions. Some actions write to GitHub.</p>
<p>You can revoke this connection at any time in Settings → ChatGPT.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${esc(consent.nonce)}"><button name="allow" value="yes">Allow connection</button><button name="allow" value="no">Cancel</button></form></html>`);
  });
  router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    res.redirect(303, auth.approve(req.body?.nonce, req.body?.allow === 'yes'));
  });
  router.use((err, _req, res, _next) => res.status(err.status || 400).json({ error: err.message }));
  return router;
}
