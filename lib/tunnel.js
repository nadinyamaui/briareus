// @ts-check
// Publishes a session's served app through the Cloudflare tunnel so ▶ Run is
// reachable elsewhere. Each port, and each tenant on it, gets a hostname created on
// first use and reused after; the sets are small and fixed, so nothing is torn down.
//
// Order matters: Access application, then DNS, then ingress, so a hostname never
// resolves to an app without Access in front. A partial failure leaves at most a
// guarded hostname that routes nowhere.

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

// Tenants are told apart by Host, so each needs a hostname. It stays in the same
// label as the port (`demo--preview-8101.zone`) because Cloudflare's universal
// certificate covers only one level below the zone. Without `{tenant}` in the
// template, the tenant goes in front.
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

// Local equivalents: Chromium resolves *.localhost to loopback, so tenant names
// need no /etc/hosts entry.
export function localHostname(port, tenant = null) {
  return tenant ? `${tenant}--preview-${port}.localhost` : '127.0.0.1';
}

// What {host} / {host:<tenant>} stand for in a ▶ Run: the published name when
// there is a tunnel, the local one when there is not.
export function serveHostname(port, tenant = null) {
  return previewHostname(port, tenant) || localHostname(port, tenant);
}

// Policies need the token's id, but config only holds its client id. Looked up once
// per process and forgotten on failure.
/** @type {Promise<string> | null} */
let serviceTokenId = null;

function serviceTokenIdFor(t) {
  if (!serviceTokenId) {
    serviceTokenId = (async () => {
      const tokens = await cf('GET', `/accounts/${t.accountId}/access/service_tokens?per_page=1000`).catch(
        (e) => {
          throw new Error(
            `${e.message} (reading service tokens needs Account > Access: Service Tokens > Read on CLOUDFLARE_API_TOKEN)`,
          );
        },
      );
      const token = (tokens || []).find((tok) => tok.client_id === t.serviceToken.clientId);
      if (!token)
        throw new Error(
          `No Cloudflare Access service token has the client id ${t.serviceToken.clientId} (PREVIEW_ACCESS_CLIENT_ID); create one in Zero Trust → Access → Service credentials, or correct the setting`,
        );
      return token.id;
    })();
    serviceTokenId.catch(() => (serviceTokenId = null));
  }
  return serviceTokenId;
}

// What lets a Briareus client through without the emailed code: Service Auth
// (`non_identity`) is evaluated ahead of the Allow policy, whatever the order.
const clientsPolicy = (tokenId) => ({
  name: 'Briareus clients',
  decision: 'non_identity',
  include: [{ service_token: { token_id: tokenId } }],
});

// An existing application is left as is, since its policy may have been edited by
// hand; only a missing service-token policy is appended. That step only logs on
// failure, because the app is already guarded and a working ▶ Run must not break.
async function ensureAccessApp(t, host) {
  const apps = await cf('GET', `/accounts/${t.accountId}/access/apps?domain=${encodeURIComponent(host)}`);
  const app = (apps || []).find((a) => a.domain === host);
  if (app) {
    if (t.serviceToken)
      await serviceTokenIdFor(t)
        .then((tokenId) => ensureClientsPolicy(t, app, tokenId))
        .catch((e) =>
          console.error(
            `Could not add the Briareus clients policy to ${host}'s Access application:`,
            e.message,
          ),
        );
    return;
  }
  const tokenId = t.serviceToken ? await serviceTokenIdFor(t) : null;
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
      ...(tokenId ? [clientsPolicy(tokenId)] : []),
    ],
  });
}

// Added through the app's policies endpoint, since a PUT of the whole application
// could reorder hand edits. Any policy already including the token counts.
async function ensureClientsPolicy(t, app, tokenId) {
  const policies = Array.isArray(app.policies)
    ? app.policies
    : (await cf('GET', `/accounts/${t.accountId}/access/apps/${app.id}`))?.policies || [];
  const namesToken = (rule) => rule?.service_token?.token_id === tokenId;
  if (policies.some((p) => (p.include || []).some(namesToken))) return;
  const precedence = Math.max(0, ...policies.map((p) => Number(p.precedence) || 0)) + 1;
  await cf('POST', `/accounts/${t.accountId}/access/apps/${app.id}/policies`, {
    ...clientsPolicy(tokenId),
    precedence,
  });
}

// A record pointing elsewhere belongs to someone; replacing it could take a site down.
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

// The tunnel config is replaced whole on PUT, so keep every other route and the
// catch-all, which cloudflared requires last.
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

// Publishes are serialized, since concurrent read-modify-writes of the tunnel
// config would drop each other's routes.
/** @type {Promise<unknown>} */
let chain = Promise.resolve();
/** @type {Map<string, Promise<string>>} */
const published = new Map();

// One Access application per hostname: a wildcard would cover names never published.
async function publish(host, port) {
  const t = getConfig().previewTunnel;
  if (!t) throw new Error('No Cloudflare tunnel is configured');
  await ensureAccessApp(t, host);
  await ensureDns(t, host);
  await ensureIngress(t, host, `http://127.0.0.1:${port}`);
  return `https://${host}`;
}

// The public URL for a port or tenant, publishing it on first use; null without a
// tunnel. A failed publish is forgotten so the next ▶ Run retries.
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

// The credentials a client sends past Access, and the host suffix to send them to
// (after the first label, where {port} and {tenant} live). Null without a token.
export function previewAccess() {
  const t = getConfig().previewTunnel;
  if (!t?.serviceToken) return null;
  return {
    clientId: t.serviceToken.clientId,
    clientSecret: t.serviceToken.clientSecret,
    hostSuffix: t.hostname.slice(t.hostname.indexOf('.') + 1),
  };
}

export function _resetForTests() {
  chain = Promise.resolve();
  published.clear();
  serviceTokenId = null;
}
