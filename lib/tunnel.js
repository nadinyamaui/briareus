// @ts-check
// Publishing a session's served app through the install's Cloudflare tunnel,
// so ▶ Run opens something a browser elsewhere can reach. Each app port gets
// one hostname (PREVIEW_HOSTNAME with {port} filled in), and each tenant a run
// profile names gets one more on that port (`demo--preview-8101`), created the
// first time they are served and reused after: ports and tenant keys are both
// small fixed sets, so the routes are too, and nothing has to be torn down
// when a session ends.
//
// The order is the point. The Access application goes first, then DNS, then
// the tunnel ingress, so there is never a moment when the hostname resolves to
// a session's app without Access standing in front of it. A failure part way
// leaves at most a guarded hostname that routes nowhere yet.
//
// Plain fetch against the v4 API: three resources, a handful of calls, no SDK.

import { getConfig } from './config.js';

const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, path, body) {
  const { previewTunnel } = getConfig();
  if (!previewTunnel) throw new Error('No Cloudflare tunnel is configured');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${previewTunnel.apiToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* judged by the status below */
  }
  if (!res.ok || !json || !json.success) {
    const detail = (json?.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare ${method} ${path.split('?')[0]}: ${detail}`);
  }
  return json.result;
}

// A multi-tenant app tells its tenants apart by the Host header, so a tenant
// needs a hostname of its own. It stays in the same label as the port
// (`demo--preview-8101.zone`, never `demo.preview-8101.zone`): Cloudflare's
// universal certificate only covers one level below the zone. The template may
// place `{tenant}` itself; without one, the tenant goes in front. The port's
// own hostname drops the token together with the hyphens that set it off.
export function previewHostname(port, tenant = null) {
  const { previewTunnel } = getConfig();
  if (!previewTunnel) return null;
  let template = previewTunnel.hostname;
  if (tenant) {
    if (!template.includes('{tenant}')) template = `{tenant}--${template}`;
    template = template.replace('{tenant}', tenant);
  } else {
    template = template.replace(/\{tenant\}-*|-*\{tenant\}/, '');
  }
  return template.replace('{port}', String(port));
}

// The same names without a tunnel, for a browser on this machine: Chromium
// resolves every *.localhost name to the loopback, so a tenant hostname works
// there with no /etc/hosts entry. The port's own stays the address the app
// binds.
export function localHostname(port, tenant = null) {
  return tenant ? `${tenant}--preview-${port}.localhost` : '127.0.0.1';
}

// What {host} / {host:<tenant>} stand for in a ▶ Run: the published name when
// there is a tunnel, the local one when there is not.
export function serveHostname(port, tenant = null) {
  return previewHostname(port, tenant) || localHostname(port, tenant);
}

// An existing application is left exactly as it is: its policy may have been
// widened by hand in the dashboard since, and rewriting it would undo that.
async function ensureAccessApp(t, host) {
  const apps = await cf('GET', `/accounts/${t.accountId}/access/apps?domain=${encodeURIComponent(host)}`);
  if ((apps || []).some((a) => a.domain === host)) return;
  await cf('POST', `/accounts/${t.accountId}/access/apps`, {
    name: `Briareus preview - ${host}`,
    type: 'self_hosted',
    domain: host,
    session_duration: '24h',
    app_launcher_visible: false,
    policies: [
      {
        name: 'Allowed users',
        decision: 'allow',
        include: t.accessEmails.map((email) => ({ email: { email } })),
      },
    ],
  });
}

// A record already at the name that points somewhere else belongs to someone;
// replacing it would take their site down, so that is an error to report.
async function ensureDns(t, host) {
  const target = `${t.tunnelId}.cfargotunnel.com`;
  const records = await cf('GET', `/zones/${t.zoneId}/dns_records?name=${encodeURIComponent(host)}`);
  if (records && records.length) {
    if (records.some((r) => r.type === 'CNAME' && r.content === target)) return;
    throw new Error(
      `${host} already has a DNS record that does not point at the tunnel; remove it or pick another PREVIEW_HOSTNAME`,
    );
  }
  await cf('POST', `/zones/${t.zoneId}/dns_records`, {
    type: 'CNAME',
    name: host,
    content: target,
    proxied: true,
    comment: 'Briareus preview',
  });
}

// The tunnel configuration is one document, replaced whole on every PUT, so
// this is a read-modify-write that must keep every other hostname and the
// catch-all rule, which cloudflared requires to be last.
async function ensureIngress(t, host, service) {
  const path = `/accounts/${t.accountId}/cfd_tunnel/${t.tunnelId}/configurations`;
  const current = await cf('GET', path);
  const config = current?.config || {};
  const ingress = Array.isArray(config.ingress) ? config.ingress : [];
  if (ingress.some((r) => r.hostname === host && r.service === service)) return;
  const last = ingress[ingress.length - 1];
  const catchAll = last && !last.hostname ? last : { service: 'http_status:404' };
  const routes = ingress.filter((r) => r.hostname && r.hostname !== host);
  await cf('PUT', path, {
    config: { ...config, ingress: [...routes, { hostname: host, service }, catchAll] },
  });
}

// Two hostnames published at once would each read the tunnel document, add
// their own route and write it back, and the second write would drop the
// first's. Every publish runs behind the one before it.
/** @type {Promise<unknown>} */
let chain = Promise.resolve();
/** @type {Map<string, Promise<string>>} */
const published = new Map();

// Every tenant hostname gets an Access application of its own, with the same
// policy the port's gets: a wildcard application would also cover names this
// app never publishes.
async function publish(host, port) {
  const t = getConfig().previewTunnel;
  if (!t) throw new Error('No Cloudflare tunnel is configured');
  await ensureAccessApp(t, host);
  await ensureDns(t, host);
  await ensureIngress(t, host, `http://127.0.0.1:${port}`);
  return `https://${host}`;
}

// The public URL for an app port, or for one tenant on it, publishing it first
// when this process has not yet. Null when no tunnel is configured: the caller
// keeps the local URL. A failed publish is forgotten so the next ▶ Run tries
// again.
export function publicAppUrl(port, tenant = null) {
  const host = previewHostname(port, tenant);
  if (!host) return Promise.resolve(null);
  let pending = published.get(host);
  if (!pending) {
    pending = chain.then(() => publish(host, port));
    chain = pending.catch(() => {});
    published.set(host, pending);
    pending.catch(() => published.delete(host));
  }
  return pending;
}

export function _resetForTests() {
  chain = Promise.resolve();
  published.clear();
}
