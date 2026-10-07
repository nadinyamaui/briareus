// @ts-check
// MCP servers the operator adds, mounted into every Claude and Codex session
// of the projects they are for, beside Briareus's own tools.
//
// A remote server is never handed to the CLI directly. The turn mounts a URL
// of this server's (/api/agent/mcp/<id>, behind the session's own token) and
// the proxy (lib/mcp-routes.js) forwards each request with the real
// credentials added. So the remote's token never sits in a turn's config file
// or argv, and one that expires an hour into a long turn is refreshed here
// instead of failing there.
//
// Signing in is part of adding a server, as a client would expect of a
// connector: adding a remote one asks it how it is authorized, and one that
// answers 401 with OAuth details (the MCP authorization spec: protected
// resource metadata, then the authorization server's, then dynamic client
// registration) comes back with a `signInUrl`. The operator opens it on any
// device, signs in, and the provider sends the browser to
// PUBLIC_BASE_URL/webhooks/mcp-oauth/callback, where the code is exchanged.
// One sign-in serves every provider account, where `claude mcp add` wanted a
// terminal session per config dir.
//
// Servers live in `app_settings` with their headers, env, client registration
// and tokens sealed under CREDENTIALS_KEY (lib/secretbox.js). A sign-in that
// is under way is held in memory only: a restart asks for a fresh one.

import crypto from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';
import { seal, open } from './secretbox.js';

// Under /webhooks because that is the one path the public hostname lets
// through without a Cloudflare Access login, and the provider's redirect
// must land whatever the browser is signed in to. The state parameter, not a
// token, is what authenticates the request.
export const MCP_OAUTH_CALLBACK_PATH = '/webhooks/mcp-oauth/callback';

export const MCP_SERVER_DEFAULTS = {
  name: '',
  label: '',
  transport: 'http',
  url: '',
  command: '',
  args: [],
  repos: [],
  enabled: true,
  oauthClientId: '',
  oauthScope: '',
  oauthClientName: '',
  oauthRedirect: 'callback',
};

// Briareus's own servers go by these; one of the operator's must not shadow them.
const RESERVED = new Set([
  'reviewer_memory',
  'reviewer_ssh',
  'reviewer_slack',
  'reviewer_workers',
  'browser',
]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Long enough to find the password, short enough that a stray link dies.
const SIGN_IN_TTL = 15 * 60_000;
// Refreshed this long before it expires, so a request does not go out with
// a token that dies on the way.
const REFRESH_EARLY = 60_000;
const REQUEST_TIMEOUT = 15_000;
const PROTOCOL_VERSION = '2025-06-18';

/** @param {string} message @param {number} [status] */
function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const b64url = (/** @type {Buffer} */ buf) => buf.toString('base64url');

// The string a field must be, or a 400 saying which.
/** @param {unknown} v @param {string} what @param {number} max @param {boolean} [trim] */
function text(v, what, max, trim = true) {
  const raw = String(v ?? '');
  const s = trim ? raw.trim() : raw;
  if (s.length > max || /[\x00-\x1f]/.test(s))
    throw httpError(`${what} is too long or has control characters`);
  return s;
}

/** @param {Record<string, any>} input @param {Record<string, any>} existing */
export function normalizeMcpServer(input, existing = MCP_SERVER_DEFAULTS) {
  const s = { ...MCP_SERVER_DEFAULTS, ...existing };
  if (Object.hasOwn(input, 'name')) s.name = text(input.name, 'The name', 64);
  if (!NAME.test(s.name)) throw httpError('Name it with letters, digits, _ and - only (up to 64)');
  if (RESERVED.has(s.name)) throw httpError(`${s.name} is the name of one of Briareus's own tools`);
  if (Object.hasOwn(input, 'label')) s.label = text(input.label, 'The label', 200);
  if (!s.label) s.label = s.name;
  if (Object.hasOwn(input, 'transport')) s.transport = String(input.transport);
  if (!['http', 'stdio'].includes(s.transport)) throw httpError('Choose http or stdio');
  if (Object.hasOwn(input, 'url')) s.url = text(input.url, 'The URL', 2048);
  if (Object.hasOwn(input, 'command')) s.command = text(input.command, 'The command', 1024);
  if (Object.hasOwn(input, 'args')) {
    if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some((a) => typeof a !== 'string'))
      throw httpError('args must be a list of up to 64 strings');
    if (input.args.some((a) => a.length > 4096 || a.includes('\0')))
      throw httpError('An argument is too long');
    s.args = input.args;
  }
  if (s.transport === 'http') {
    let url;
    try {
      url = new URL(s.url);
    } catch {
      throw httpError('Enter the server’s URL');
    }
    // A token goes to it; plain http only where nothing is on the wire.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
      throw httpError('The URL must be https (or http on this machine)');
    s.url = url.href;
    s.command = '';
    s.args = [];
  } else {
    if (!s.command) throw httpError('Enter the command that starts the server');
    s.url = '';
  }
  if (Object.hasOwn(input, 'repos')) {
    if (!Array.isArray(input.repos) || input.repos.some((r) => typeof r !== 'string' || !REPO.test(r)))
      throw httpError('repos must be a list of projects as owner/name');
    s.repos = [...new Set(input.repos)];
  }
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw httpError('Enabled must be a boolean');
    s.enabled = input.enabled;
  }
  if (Object.hasOwn(input, 'oauthClientId'))
    s.oauthClientId = text(input.oauthClientId, 'The client id', 256);
  if (Object.hasOwn(input, 'oauthScope')) s.oauthScope = text(input.oauthScope, 'The scope', 1024);
  if (Object.hasOwn(input, 'oauthClientName'))
    s.oauthClientName = text(input.oauthClientName, 'The client name', 100);
  if (Object.hasOwn(input, 'oauthRedirect')) s.oauthRedirect = String(input.oauthRedirect);
  if (!['callback', 'loopback'].includes(s.oauthRedirect)) throw httpError('Choose callback or loopback');
  return s;
}

// A `{ name: value }` map from a body, for headers or env. Present replaces
// the whole set: there is no reading the old values back to merge with.
/** @param {unknown} v @param {RegExp} key @param {string} what */
function secretMap(v, key, what) {
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v))
    throw httpError(`${what} must be an object of names to values`);
  const out = Object.create(null);
  const entries = Object.entries(v);
  if (entries.length > 32) throw httpError(`At most 32 ${what}`);
  for (const [k, val] of entries) {
    if (!key.test(k)) throw httpError(`${k} is not a valid name for ${what}`);
    if (typeof val !== 'string' || val.length > 8192 || /[\r\n\0]/.test(val))
      throw httpError(`The value of ${k} must be one line of text`);
    out[k] = val;
  }
  return out;
}

// The `scope` and `resource_metadata` a 401's WWW-Authenticate offers.
/** @param {string | null} header */
export function parseBearerChallenge(header) {
  const out = /** @type {Record<string, string>} */ ({});
  let bearer = false;
  // Commas inside quoted strings belong to a parameter, not a new challenge.
  for (const part of (header || '').match(/(?:[^",]|"(?:\\.|[^"\\])*")+/g) || []) {
    let value = part.trim();
    const scheme = value.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s+|$)(?!\s*=)/);
    if (scheme) {
      if (bearer) break;
      bearer = scheme[1].toLowerCase() === 'bearer';
      value = value.slice(scheme[0].length);
    }
    if (!bearer) continue;
    const param = value.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s]+))\s*$/);
    if (param) out[param[1].toLowerCase()] = (param[2] ?? param[3]).replace(/\\(.)/g, '$1');
  }
  return bearer ? out : null;
}

// RFC 8414's well-known locations for an issuer, path inserted, and the
// OpenID ones the MCP spec also accepts.
/** @param {string} issuer */
function authServerMetadataUrls(issuer) {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, '');
  return p
    ? [
        `${u.origin}/.well-known/oauth-authorization-server${p}`,
        `${u.origin}/.well-known/openid-configuration${p}`,
        `${u.origin}${p}/.well-known/openid-configuration`,
      ]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

/** @param {string} endpoint */
function secureEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw httpError('Invalid OAuth endpoint URL', 502);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    throw httpError('OAuth endpoints must be https (or http on this machine)', 502);
}

// Read only the initialize response, even when an SSE connection stays open.
// Bound both the wait and the bytes retained from an untrusted server.
/** @param {Response} res */
async function initializeResponse(res) {
  const reader = res.body?.getReader();
  if (!reader) throw httpError('The server returned no initialize response', 502);
  const sse = res.headers.get('content-type')?.includes('text/event-stream');
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let buffer = '',
          bytes = 0;
        for (;;) {
          const { value, done } = await reader.read();
          bytes += value?.byteLength || 0;
          if (bytes > 64 * 1024) throw httpError('The initialize response is too large', 502);
          buffer += decoder.decode(value, { stream: !done });
          if (!sse && done) return JSON.parse(buffer);
          if (sse) {
            buffer = buffer.replace(/\r\n/g, '\n');
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = event
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).replace(/^ /, ''))
                .join('\n');
              if (!data) continue;
              const message = JSON.parse(data);
              if (message.id === 1) return message;
            }
          }
          if (done) throw httpError('The server returned no initialize response', 502);
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(httpError('The initialize response timed out', 502)),
          REQUEST_TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

/**
 * @param {{
 *   load?: (name: string, fallback: any) => Promise<any>,
 *   save?: (name: string, value: any) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 *   callbackUrl?: () => string,
 *   now?: () => number,
 * }} [deps]
 */
export function createMcpService({
  load = loadAppSetting,
  save = saveAppSetting,
  fetchImpl = fetch,
  callbackUrl = () => '',
  now = Date.now,
} = {}) {
  /** @type {any[]} */
  let servers = [];
  let writes = Promise.resolve();
  const signIns = new Map(); // state -> { id, verifier, redirectUri, url, expiresAt }
  const refreshing = new Map(); // active grant generation -> Promise<string>
  // Pending sign-ins follow configuration changes; refreshes follow the active grant.
  const generations = new Map();
  const grantGenerations = new Map();
  const grantGeneration = (id) => grantGenerations.get(id) || 0;
  const generation = (id) => generations.get(id) || 0;
  const advance = (id, replacesGrant = true) => {
    if (replacesGrant) grantGenerations.set(id, grantGeneration(id) + 1);
    const next = generation(id) + 1;
    generations.set(id, next);
    return next;
  };
  const assertCurrent = (id, version, grant = false) => {
    if (!find(id) || (grant ? grantGeneration(id) : generation(id)) !== version)
      throw httpError('The MCP connection changed; retry with its current credentials', 409);
  };

  /** @param {(rows: any[]) => any[]} fn */
  function mutate(fn) {
    const task = writes.then(async () => {
      const next = fn(servers);
      await save('mcp_servers', next);
      servers = next;
    });
    writes = task.catch(() => {});
    return task;
  }
  /** @param {number} id @param {number} version @param {(s: any) => any} fn @param {boolean} [grant] */
  const patchCurrent = (id, version, fn, grant = false) =>
    mutate((rows) => {
      assertCurrent(id, version, grant);
      return rows.map((row) => (row.id === id ? fn(row) : row));
    });
  /** @param {number} id */
  const find = (id) => servers.find((s) => s.id === id);
  /** @param {number} id */
  function get(id) {
    const s = find(id);
    if (!s) throw httpError('MCP server not found', 404);
    return s;
  }
  /** @param {any} s @returns {Record<string, any>} */
  const secretsOf = (s) => (s.secrets ? JSON.parse(open(s.secrets)) : {});
  /** @param {any} s @param {Record<string, any>} sec */
  const withSecrets = (s, sec) => ({ ...s, secrets: seal(JSON.stringify(sec)) });

  /** @param {number} id */
  function pendingSignIn(id) {
    for (const [state, p] of signIns) {
      if (p.expiresAt <= now() || p.version !== generation(p.id)) signIns.delete(state);
      else if (p.id === id) return p;
    }
    return null;
  }

  // What leaves the service: names of what is sealed, never the values.
  /** @param {any} s */
  function publicServer(s) {
    const { secrets, ...rest } = s;
    const sec = secrets ? secretsOf(s) : {};
    return {
      ...rest,
      headerNames: Object.keys(sec.headers || {}),
      envNames: Object.keys(sec.env || {}),
      hasOAuthClientSecret: !!sec.clientSecret,
      signedIn: !!sec.oauth?.tokens?.accessToken,
      signInUrl: pendingSignIn(s.id)?.url || null,
      signInNeedsPaste: !!pendingSignIn(s.id)?.loopback,
    };
  }

  /** @param {string} url @param {RequestInit} init */
  async function call(url, init = {}) {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
  }
  /** @param {string} url */
  async function getJson(url) {
    secureEndpoint(url);
    let res;
    try {
      res = await call(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw httpError('OAuth metadata redirects are not supported', 502);
    }
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  // An initialize, to learn whether the server takes these credentials. The
  // session it may open is closed again straight away.
  /** @param {string} url @param {Record<string, string>} headers */
  async function probe(url, headers) {
    const probeHeaders = new Headers(headers);
    probeHeaders.set('Content-Type', 'application/json');
    probeHeaders.set('Accept', 'application/json, text/event-stream');
    probeHeaders.set('MCP-Protocol-Version', PROTOCOL_VERSION);
    const res = await call(url, {
      method: 'POST',
      redirect: 'error',
      headers: probeHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'briareus', version: '1' },
        },
      }),
    });
    let error = '';
    let protocolVersion = PROTOCOL_VERSION;
    if (res.ok) {
      try {
        const message = await initializeResponse(res);
        protocolVersion = message.result?.protocolVersion || PROTOCOL_VERSION;
        if (
          message.jsonrpc !== '2.0' ||
          message.id !== 1 ||
          !Object.hasOwn(message, 'result') ||
          message.error
        )
          error = `Initialize failed: ${String(message.error?.message || 'invalid response').slice(0, 500)}`;
      } catch (e) {
        error = `Initialize failed: ${e.message}`;
      }
    } else await res.body?.cancel().catch(() => {});
    const session = res.headers.get('mcp-session-id');
    if (res.ok && session) {
      const cleanupHeaders = new Headers(headers);
      cleanupHeaders.set('Mcp-Session-Id', session);
      cleanupHeaders.set('MCP-Protocol-Version', protocolVersion);
      call(url, {
        method: 'DELETE',
        redirect: 'error',
        headers: cleanupHeaders,
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
    return {
      ok: res.ok && !error,
      error,
      status: res.status,
      challenge: parseBearerChallenge(res.headers.get('www-authenticate')),
    };
  }

  // Where the server's authorization lives, the MCP spec's way round: the
  // protected resource metadata names the authorization server, whose own
  // metadata names the endpoints. A server from before that spec (2025-03-26)
  // has neither and keeps its endpoints at fixed paths on its own origin.
  /** @param {any} s @param {Record<string, string> | null} challenge */
  async function discover(s, challenge) {
    const mcp = new URL(s.url);
    const path = mcp.pathname.replace(/\/+$/, '');
    const prmUrls = [
      ...(challenge?.resource_metadata ? [challenge.resource_metadata] : []),
      ...(path ? [`${mcp.origin}/.well-known/oauth-protected-resource${path}`] : []),
      `${mcp.origin}/.well-known/oauth-protected-resource`,
    ];
    let prm = null;
    for (const url of prmUrls) if ((prm = await getJson(url))) break;
    if (!prm && challenge?.resource_metadata)
      throw httpError('The advertised resource metadata is unavailable; try again later', 502);
    const resourceMatches =
      prm?.resource === s.url || (s.url === `${mcp.origin}/` && prm?.resource === mcp.origin);
    if (prm && !resourceMatches)
      throw httpError('The resource metadata does not match the configured MCP URL', 502);
    const issuer = prm?.authorization_servers?.[0] || mcp.origin;
    secureEndpoint(issuer);
    let meta = null;
    for (const url of authServerMetadataUrls(issuer)) if ((meta = await getJson(url))) break;
    if (!meta && prm?.authorization_servers?.[0])
      throw httpError('The advertised authorization server has no available metadata; try again later', 502);
    meta ||= {
      authorization_endpoint: `${mcp.origin}/authorize`,
      token_endpoint: `${mcp.origin}/token`,
      registration_endpoint: `${mcp.origin}/register`,
    };
    if (!meta.authorization_endpoint || !meta.token_endpoint)
      throw httpError('The server’s authorization server does not say where to sign in', 502);
    if (meta.issuer) secureEndpoint(meta.issuer);
    for (const endpoint of [meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint])
      if (endpoint) secureEndpoint(endpoint);
    const scope =
      s.oauthScope ||
      challenge?.scope ||
      (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(' ') : '');
    return {
      issuer: meta.issuer || issuer,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      registrationEndpoint: meta.registration_endpoint || '',
      authMethods: Array.isArray(meta.token_endpoint_auth_methods_supported)
        ? meta.token_endpoint_auth_methods_supported
        : [],
      resource: prm?.resource || s.url,
      scope,
    };
  }

  /** @param {string[]} methods */
  function requireSupportedAuth(methods) {
    if (
      methods.length &&
      !methods.some((m) => ['none', 'client_secret_basic', 'client_secret_post'].includes(m))
    )
      throw httpError(
        `Unsupported OAuth token authentication methods: ${methods.join(', ')}. Briareus supports none, client_secret_basic and client_secret_post; JWT authentication is not supported.`,
      );
  }

  // The OAuth client Briareus signs in as: the operator's own when they gave
  // one, else the one it registered before (for this redirect, at this
  // server, under this name), else a fresh registration. The redirect a
  // registration answers with is the one to use: a server may rewrite it
  // (Meta turns localhost into 127.0.0.1).
  /** @param {any} s @param {Record<string, any>} sec @param {any} as @param {string} redirectUri */
  async function clientFor(s, sec, as, redirectUri) {
    requireSupportedAuth(as.authMethods);
    if (s.oauthClientId) {
      const secret = sec.clientSecret || '';
      const authMethod = !secret
        ? 'none'
        : as.authMethods.includes('client_secret_basic') || !as.authMethods.length
          ? 'client_secret_basic'
          : 'client_secret_post';
      return { clientId: s.oauthClientId, clientSecret: secret, authMethod, registered: false, redirectUri };
    }
    const clientName = s.oauthClientName || 'Briareus';
    const old = sec.oauth?.client;
    if (
      old?.registered &&
      old.requestedRedirectUri === redirectUri &&
      old.registrationEndpoint === as.registrationEndpoint &&
      old.clientName === clientName &&
      old.registrationScope === as.scope
    )
      return old;
    if (!as.registrationEndpoint)
      throw httpError(
        'This server does not let clients register themselves: create an OAuth app with it and set oauthClientId (and oauthClientSecret)',
      );
    secureEndpoint(as.registrationEndpoint);
    const requestedAuthMethod =
      ['none', 'client_secret_basic', 'client_secret_post'].find((m) => as.authMethods.includes(m)) || 'none';
    const res = await call(as.registrationEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: requestedAuthMethod,
        ...(as.scope ? { scope: as.scope } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.client_id)
      throw httpError(
        `The server refused to register ${clientName} as a client: ${body.error_description || body.error || `HTTP ${res.status}`}. If it only lets clients it knows register, set oauthClientName to one of theirs and oauthRedirect to loopback`,
        502,
      );
    const authMethod = body.token_endpoint_auth_method || requestedAuthMethod;
    requireSupportedAuth([authMethod]);
    if (as.authMethods.length && !as.authMethods.includes(authMethod))
      throw httpError('The registered client uses an unadvertised token authentication method', 502);
    if (authMethod !== 'none' && !body.client_secret)
      throw httpError('The registered client is missing its OAuth client secret', 502);
    return {
      clientId: body.client_id,
      clientSecret: body.client_secret || '',
      authMethod,
      registered: true,
      clientName,
      requestedRedirectUri: redirectUri,
      redirectUri:
        Array.isArray(body.redirect_uris) && body.redirect_uris[0]
          ? String(body.redirect_uris[0])
          : redirectUri,
      registrationEndpoint: as.registrationEndpoint,
      registrationScope: as.scope,
    };
  }

  // For a server that only sends its sign-ins back to the signing-in
  // machine's own loopback, as it does for the desktop clients it knows.
  // Nothing listens there: the browser lands on a page that will not load,
  // and the operator pastes its address back (finishSignIn). The port is the
  // server's own, so a registration made for it is still good next time.
  /** @param {number} id */
  const loopbackRedirect = (id) => `http://127.0.0.1:${20000 + (id % 40000)}/callback`;

  /** @param {number} id @param {Record<string, string> | null} challenge @param {number} version */
  async function beginSignIn(id, challenge, version) {
    assertCurrent(id, version);
    const s = get(id);
    const loopback = s.oauthRedirect === 'loopback';
    const wanted = loopback ? loopbackRedirect(id) : callbackUrl();
    if (!wanted) throw httpError('Set PUBLIC_BASE_URL so the sign-in has somewhere to come back to', 500);
    const sec = secretsOf(s);
    // Explicit reconnects have no new challenge; retain the resource's metadata
    // URL and scope so rediscovery finds the same authorization server and client.
    const challengeScope = challenge?.scope ?? sec.oauth?.challengeScope ?? '';
    const challengeResourceMetadata = challenge
      ? challenge.resource_metadata || ''
      : sec.oauth?.challengeResourceMetadata || '';
    const as = await discover(
      s,
      challenge || { scope: challengeScope, resource_metadata: challengeResourceMetadata },
    );
    assertCurrent(id, version);
    const client = await clientFor(s, sec, as, wanted);
    const redirectUri = client.redirectUri;
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(32));
    const url = new URL(as.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('resource', as.resource);
    if (as.scope) url.searchParams.set('scope', as.scope);
    const { authMethods, scope, ...endpoints } = as;
    await patchCurrent(id, version, (row) => {
      grantGenerations.set(id, grantGeneration(id) + 1);
      return withSecrets(
        { ...row, auth: 'oauth', status: 'needs-sign-in', error: '', checkedAt: now() },
        {
          ...secretsOf(row),
          oauth: { ...endpoints, authMethods, client, challengeScope, challengeResourceMetadata },
        },
      );
    });
    assertCurrent(id, version);
    for (const [k, p] of signIns) if (p.id === id) signIns.delete(k);
    signIns.set(state, {
      id,
      verifier,
      version,
      redirectUri,
      loopback,
      url: url.href,
      expiresAt: now() + SIGN_IN_TTL,
    });
  }

  // The token endpoint, form-encoded, with the client authenticated the way
  // it registered to be.
  /** @param {Record<string, any>} oauth @param {Record<string, string>} params */
  async function tokenRequest(oauth, params) {
    const { client } = oauth;
    requireSupportedAuth([client.authMethod]);
    const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: oauth.resource });
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (client.clientSecret && client.authMethod === 'client_secret_post')
      body.set('client_secret', client.clientSecret);
    else if (client.clientSecret)
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
      ).toString('base64')}`;
    secureEndpoint(oauth.tokenEndpoint);
    const res = await call(oauth.tokenEndpoint, { method: 'POST', headers, body, redirect: 'error' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.access_token)
      throw Object.assign(
        httpError(
          out.error_description || out.error || `The token endpoint answered HTTP ${res.status}`,
          res.ok ? 502 : res.status,
        ),
        { oauthError: out.error },
      );
    return {
      accessToken: String(out.access_token),
      refreshToken: out.refresh_token ? String(out.refresh_token) : '',
      expiresAt: Number(out.expires_in) > 0 ? now() + Number(out.expires_in) * 1000 : null,
    };
  }

  /** @param {number} id @param {number} version @param {string} message */
  const needsSignIn = (id, version, message) =>
    patchCurrent(
      id,
      version,
      (row) => {
        const sec = secretsOf(row);
        const { tokens, ...oauth } = sec.oauth || {};
        return withSecrets(
          { ...row, status: 'needs-sign-in', error: message, checkedAt: now() },
          { ...sec, oauth },
        );
      },
      true,
    );

  // One refresh per server at a time: a turn's tool calls arrive together.
  /** @param {number} id */
  function refresh(id) {
    const version = grantGeneration(id);
    const key = `${id}:${version}`;
    let task = refreshing.get(key);
    if (task) return task;
    task = (async () => {
      const oauth = secretsOf(get(id)).oauth || {};
      if (!oauth.tokens?.refreshToken) {
        await needsSignIn(id, version, 'The sign-in expired; sign in again');
        throw httpError('The sign-in expired; sign in again', 401);
      }
      let tokens;
      try {
        tokens = await tokenRequest(oauth, {
          grant_type: 'refresh_token',
          refresh_token: oauth.tokens.refreshToken,
        });
      } catch (e) {
        assertCurrent(id, version, true);
        // Only invalid_grant identifies a revoked or expired refresh grant.
        if (e.oauthError === 'invalid_grant')
          await needsSignIn(id, version, 'The sign-in was revoked or expired; sign in again');
        throw Object.assign(httpError(e.message, e.oauthError === 'invalid_grant' ? 401 : 502), {
          temporaryRefreshFailure:
            e.oauthError !== 'invalid_grant' &&
            (!e.status ||
              e.status >= 500 ||
              ['temporarily_unavailable', 'server_error'].includes(e.oauthError)),
        });
      }
      tokens.refreshToken ||= oauth.tokens.refreshToken;
      await patchCurrent(
        id,
        version,
        (row) => {
          const sec = secretsOf(row);
          return withSecrets(row, { ...sec, oauth: { ...sec.oauth, tokens } });
        },
        true,
      );
      assertCurrent(id, version, true);
      return tokens.accessToken;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, task);
    return task;
  }

  // The bearer for a signed-in server, fresh.
  /** @param {number} id @param {{ force?: boolean, rejectedBearer?: string }} [opts] */
  async function accessToken(id, { force = false, rejectedBearer } = {}) {
    const version = grantGeneration(id);
    const inFlight = refreshing.get(`${id}:${version}`);
    const tokens = secretsOf(get(id)).oauth?.tokens;
    if (!tokens?.accessToken) throw httpError('Sign in to this server first', 401);
    if (force && rejectedBearer && rejectedBearer !== `Bearer ${tokens.accessToken}`) force = false;
    const early = tokens.refreshToken ? REFRESH_EARLY : 0;
    if (!inFlight && !force && (!tokens.expiresAt || tokens.expiresAt - early > now()))
      return tokens.accessToken;
    try {
      return await (inFlight || refresh(id));
    } catch (e) {
      assertCurrent(id, version, true);
      const current = secretsOf(get(id)).oauth?.tokens;
      if (
        !force &&
        e.temporaryRefreshFailure &&
        current?.accessToken &&
        (!current.expiresAt || current.expiresAt > now())
      )
        return current.accessToken;
      throw e;
    }
  }

  /** @param {number} id @param {{ force?: boolean, rejectedBearer?: string }} [opts] */
  async function upstreamHeaders(id, opts) {
    const s = get(id);
    const token = s.auth === 'oauth' ? await accessToken(id, opts) : null;
    const headers = { ...(secretsOf(get(id)).headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  // Whether the server takes what is stored, and if it wants a sign-in, the
  // start of one. Keeps the outcome on the row, so a client sees why.
  /** @param {number} id @param {{ signIn?: boolean }} [opts] */
  async function check(id, { signIn = false } = {}) {
    await writes;
    const s = get(id);
    let version = generation(id);
    if (s.transport !== 'http') {
      await patchCurrent(id, version, (row) => ({ ...row, status: 'ready', error: '', checkedAt: now() }));
      return;
    }
    try {
      const sec = secretsOf(s);
      const ownAuth = Object.keys(sec.headers || {}).some((k) => k.toLowerCase() === 'authorization');
      if (signIn && !ownAuth) {
        version = advance(id, false);
        return await beginSignIn(id, null, version);
      }
      let headers;
      try {
        headers = await upstreamHeaders(id);
      } catch (e) {
        if (e.status !== 401) throw e;
        headers = { ...(sec.headers || {}) };
      }
      const r = await probe(s.url, headers);
      if (r.ok) {
        await patchCurrent(id, version, (row) => ({ ...row, status: 'ready', error: '', checkedAt: now() }));
      } else if (r.status === 401 && !ownAuth) {
        assertCurrent(id, version);
        version = advance(id, false);
        await beginSignIn(id, r.challenge, version);
      } else {
        const why =
          r.status === 401
            ? 'The server refused the headers you gave it'
            : r.error || `The server answered HTTP ${r.status}`;
        await patchCurrent(id, version, (row) => ({ ...row, status: 'error', error: why, checkedAt: now() }));
      }
    } catch (e) {
      if (!find(id) || generation(id) !== version) return;
      const message = e.name === 'TimeoutError' ? 'The server did not answer in time' : e.message;
      await patchCurrent(id, version, (row) => ({
        ...row,
        status: 'error',
        error: message,
        checkedAt: now(),
      }));
    }
  }

  /** @param {any} s @param {Record<string, any>} input @param {any} [old] */
  function applySecrets(s, input, old = null) {
    const sec = old ? secretsOf(old) : {};
    if (Object.hasOwn(input, 'headers')) sec.headers = secretMap(input.headers, HEADER, 'headers');
    if (Object.hasOwn(input, 'env')) sec.env = secretMap(input.env, ENV, 'env');
    if (Object.hasOwn(input, 'oauthClientSecret'))
      sec.clientSecret = text(input.oauthClientSecret, 'The client secret', 1024, false);
    if (s.transport === 'http') delete sec.env;
    else delete sec.headers;
    // A different server, or a different client, is a different sign-in.
    if (
      !old ||
      old.url !== s.url ||
      old.oauthClientId !== s.oauthClientId ||
      s.transport !== 'http' ||
      (Object.hasOwn(input, 'headers') &&
        Object.keys(sec.headers || {}).some((k) => k.toLowerCase() === 'authorization'))
    ) {
      delete sec.oauth;
      s = { ...s, auth: 'none' };
    } else if (
      Object.hasOwn(input, 'oauthClientSecret') &&
      s.oauthClientId &&
      sec.oauth?.client &&
      !sec.oauth.client.registered
    ) {
      const methods = sec.oauth.authMethods || [];
      sec.oauth.client = {
        ...sec.oauth.client,
        clientSecret: sec.clientSecret,
        authMethod: !sec.clientSecret
          ? 'none'
          : methods.includes('client_secret_basic') || !methods.length
            ? 'client_secret_basic'
            : 'client_secret_post',
      };
    }
    return withSecrets(s, sec);
  }

  const CONNECTION = [
    'transport',
    'url',
    'headers',
    'oauthClientId',
    'oauthClientSecret',
    'oauthScope',
    'oauthClientName',
    'oauthRedirect',
  ];

  const service = {
    async init() {
      servers = await load('mcp_servers', []);
    },
    list() {
      return servers.map(publicServer);
    },
    /** @param {Record<string, any>} input */
    async create(input) {
      const s = normalizeMcpServer(input);
      if (servers.some((o) => o.name === s.name))
        throw httpError(`There is already a server named ${s.name}`);
      let row = applySecrets(
        { ...s, id: 0, auth: 'none', status: 'unchecked', error: '', checkedAt: null },
        input,
      );
      await mutate((rows) => {
        if (rows.some((o) => o.name === s.name)) throw httpError(`There is already a server named ${s.name}`);
        row = { ...row, id: Math.max(now(), ...rows.map((r) => r.id + 1)) };
        return [...rows, row];
      });
      await check(row.id);
      return publicServer(get(row.id));
    },
    /** @param {number} id @param {Record<string, any>} input */
    async update(id, input) {
      await mutate((rows) => {
        const old = rows.find((o) => o.id === id);
        if (!old) throw httpError('MCP server not found', 404);
        const s = normalizeMcpServer(input, old);
        if (rows.some((o) => o.id !== id && o.name === s.name))
          throw httpError(`There is already a server named ${s.name}`);
        const next = applySecrets(s, input, old);
        const changesGrant = CONNECTION.some((k) =>
          k === 'oauthClientSecret'
            ? (secretsOf(old).clientSecret || '') !== (secretsOf(next).clientSecret || '')
            : k !== 'headers' && old[k] !== next[k],
        );
        const replacesAuthorization =
          Object.hasOwn(input, 'headers') &&
          [secretsOf(old).headers, secretsOf(next).headers].some((headers) =>
            Object.keys(headers || {}).some((k) => k.toLowerCase() === 'authorization'),
          );
        if (changesGrant || replacesAuthorization) {
          // Maintenance invalidates pending sign-ins, but a retained active
          // grant must still accept a refresh already consumed by its provider.
          const retainsGrant = !!secretsOf(old).oauth?.tokens && !!secretsOf(next).oauth?.tokens;
          advance(id, !retainsGrant);
        }
        return rows.map((o) => (o.id === id ? next : o));
      });
      if (CONNECTION.some((k) => Object.hasOwn(input, k))) await check(id);
      return publicServer(get(id));
    },
    /** @param {number} id */
    async remove(id) {
      await mutate((rows) => {
        if (!rows.some((s) => s.id === id)) throw httpError('MCP server not found', 404);
        advance(id);
        return rows.filter((s) => s.id !== id);
      });
      for (const [k, p] of signIns) if (p.id === id) signIns.delete(k);
    },
    // Check again, and with signIn, start a fresh sign-in even when the
    // stored one still works (another account, more scopes).
    /** @param {number} id @param {{ signIn?: boolean }} [opts] */
    async connect(id, opts) {
      get(id);
      await check(id, opts);
      return publicServer(get(id));
    },
    // A loopback sign-in's last step: the address the browser was sent to,
    // pasted back. Only for the server it was started for.
    /** @param {number} id @param {unknown} pasted */
    async finishSignIn(id, pasted) {
      get(id);
      const raw = String(pasted ?? '').trim();
      let query;
      try {
        query = Object.fromEntries(new URL(raw).searchParams);
      } catch {
        query = Object.fromEntries(new URLSearchParams(raw.replace(/^[^?]*\?/, '')));
      }
      if (!query.state || (!query.code && !query.error))
        throw httpError('Paste the whole address the browser ended on, with its code and state');
      const p = signIns.get(String(query.state));
      if (p && p.id !== id) throw httpError('That address is from another server’s sign-in');
      return service.complete(query);
    },
    // The provider's redirect. Throws a message fit for the browser that
    // landed here.
    /** @param {Record<string, any>} query */
    async complete(query) {
      const state = String(query.state || '');
      const p = signIns.get(state);
      if (!p || p.expiresAt <= now())
        throw httpError(
          'This sign-in link has expired or was already used. Start the sign-in again from Briareus.',
        );
      signIns.delete(state);
      await writes;
      let version = p.version;
      assertCurrent(p.id, version);
      const s = get(p.id);
      if (query.error) {
        const why = String(query.error_description || query.error).slice(0, 500);
        await patchCurrent(p.id, version, (row) => ({
          ...row,
          status: 'needs-sign-in',
          error: `Sign-in failed: ${why}`,
        }));
        throw httpError(`Sign-in failed: ${why}`);
      }
      const oauth = secretsOf(s).oauth || {};
      let tokens;
      try {
        tokens = await tokenRequest(oauth, {
          grant_type: 'authorization_code',
          code: String(query.code || ''),
          redirect_uri: p.redirectUri,
          code_verifier: p.verifier,
        });
      } catch (e) {
        await patchCurrent(p.id, version, (row) => ({
          ...row,
          status: 'needs-sign-in',
          error: `Sign-in failed: ${e.message}`,
        }));
        throw httpError(`Sign-in failed: ${e.message}`, 502);
      }
      await patchCurrent(p.id, version, (row) => {
        const sec = secretsOf(row);
        version = advance(p.id);
        return withSecrets({ ...row, signedInAt: now() }, { ...sec, oauth: { ...sec.oauth, tokens } });
      });
      // Signed in is not the same as let in; say which it is.
      try {
        assertCurrent(p.id, version);
        const headers = await upstreamHeaders(p.id);
        assertCurrent(p.id, version);
        const r = await probe(s.url, headers);
        await patchCurrent(p.id, version, (row) => ({
          ...row,
          status: r.ok ? 'ready' : 'error',
          error: r.ok ? '' : r.error || `Signed in, but the server answered HTTP ${r.status}`,
          checkedAt: now(),
        }));
      } catch (e) {
        await patchCurrent(p.id, version, (row) => ({
          ...row,
          status: 'error',
          error: e.message,
          checkedAt: now(),
        }));
      }
      return publicServer(get(p.id));
    },
    // What a session of `repo` mounts: enabled servers for it, less any
    // remote one still waiting for its sign-in (a CLI would only fail on it).
    /** @param {string} repo */
    mounts(repo) {
      return servers
        .filter((s) => s.enabled && (!s.repos.length || s.repos.includes(repo)))
        .filter(
          (s) => s.transport !== 'http' || s.auth !== 'oauth' || secretsOf(s).oauth?.tokens?.accessToken,
        )
        .map((s) =>
          s.transport === 'http'
            ? { id: s.id, name: s.name, transport: 'http' }
            : {
                id: s.id,
                name: s.name,
                transport: 'stdio',
                command: s.command,
                args: s.args,
                env: secretsOf(s).env || {},
              },
        );
    },
    // Where the proxy sends a session's request, and with what. Only a
    // server the session's project mounts.
    /** @param {number} id @param {string} repo @param {{ force?: boolean, rejectedBearer?: string }} [opts] */
    async upstream(id, repo, opts) {
      await writes;
      const s = find(id);
      if (!s || s.transport !== 'http' || !s.enabled || (s.repos.length && !s.repos.includes(repo)))
        throw httpError('MCP server unavailable for this project', 404);
      const version = grantGeneration(id);
      const headers = await upstreamHeaders(id, opts);
      assertCurrent(id, version, true);
      const current = get(id);
      if (!current.enabled || (current.repos.length && !current.repos.includes(repo)))
        throw httpError('MCP server unavailable for this project', 404);
      return { url: s.url, headers, oauth: s.auth === 'oauth' };
    },
  };
  return service;
}
