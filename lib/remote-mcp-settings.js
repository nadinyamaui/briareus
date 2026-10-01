// @ts-check
import express from 'express';

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// The OAuth consent page ChatGPT sends the owner's browser to, behind the
// login and the same-origin write gate. Connections themselves are managed
// through /api/v1 (`/settings/mcp`), which also has this step as data for a
// client that draws the page itself.
export function remoteMcpSettingsRoutes({ auth, loginEnabled, signedIn }) {
  const router = express.Router();
  router.use('/oauth/authorize', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.authorization || !loginEnabled() || !signedIn(req))
      return res.status(403).json({ error: 'Configure the login and sign in first' });
    next();
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
<p>You can revoke this connection at any time.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${esc(consent.nonce)}"><button name="allow" value="yes">Allow connection</button><button name="allow" value="no">Cancel</button></form></html>`);
  });
  router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    res.redirect(303, auth.approve(req.body?.nonce, req.body?.allow === 'yes'));
  });
  router.use((err, _req, res, _next) => res.status(err.status || 400).json({ error: err.message }));
  return router;
}
