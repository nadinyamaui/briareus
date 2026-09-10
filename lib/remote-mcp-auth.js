// @ts-check
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';

const SETTING = 'remote_mcp';
export const MCP_SCOPE = 'briareus:manage';
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const random = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const matches = (value, hash) =>
  typeof hash === 'string' &&
  hash.length === 64 &&
  timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
const oauthError = (error, message) => Object.assign(new Error(message), { oauthError: error });

// Only predefined clients created by the signed-in dashboard owner. Secrets and
// grants are persisted as hashes; one serial write queue makes code consumption,
// refresh rotation and revocation atomic in this single-process application.
export function createRemoteMcpAuth({ load = loadAppSetting, save = saveAppSetting, now = Date.now } = {}) {
  let state = { enabled: false, baseUrl: '', clients: [], grants: [] };
  let ready = false;
  let writes = Promise.resolve();
  const pending = new Map();
  const codes = new Map();
  function requireReady() {
    if (!ready)
      throw Object.assign(new Error('MCP settings are unavailable; check the database'), { status: 503 });
  }
  function prune() {
    for (const map of [pending, codes])
      for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  }
  function write(fn) {
    const operation = writes.then(async () => {
      requireReady();
      const next = structuredClone(state);
      next.grants = next.grants.filter((g) => g.refreshExpires > now());
      const result = fn(next);
      await save(SETTING, next);
      state = next;
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const clientFor = (clientId) => state.clients.find((c) => c.id === clientId);
  function available() {
    requireReady();
    if (!state.enabled || !state.baseUrl)
      throw Object.assign(new Error('Remote MCP is disabled'), { status: 404 });
  }
  function resource() {
    return `${state.baseUrl}/mcp`;
  }
  function clientCredentials(body, header) {
    let id = body.client_id,
      secret = body.client_secret;
    if (header) {
      if (!header.startsWith('Basic ') || secret !== undefined)
        throw oauthError('invalid_client', 'Invalid client authentication');
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) throw oauthError('invalid_client', 'Invalid client authentication');
      const basicId = decodeURIComponent(decoded.slice(0, colon));
      if (id && id !== basicId) throw oauthError('invalid_client', 'Invalid client authentication');
      id = basicId;
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = clientFor(id);
    if (!client || typeof secret !== 'string' || !matches(secret, client.secretHash))
      throw oauthError('invalid_client', 'Invalid client authentication');
    return client;
  }
  return {
    async init() {
      state = await load(SETTING, state);
      ready = true;
    },
    available,
    view() {
      requireReady();
      return {
        enabled: state.enabled,
        baseUrl: state.baseUrl,
        url: state.baseUrl ? resource() : '',
        clients: state.clients.map(({ secretHash, ...client }) => ({
          ...client,
          connected: state.grants.some((g) => g.clientId === client.id && g.refreshExpires > now()),
        })),
      };
    },
    async configure({ enabled, baseUrl }) {
      if (typeof enabled !== 'boolean') throw new Error('Choose whether the connection is enabled');
      const url = new URL(String(baseUrl));
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error('Enter a public HTTPS origin, e.g. https://briareus.example.com');
      const result = await write((next) => {
        if (next.baseUrl !== url.origin || !enabled) next.grants = [];
        next.enabled = enabled;
        next.baseUrl = url.origin;
      });
      pending.clear();
      codes.clear();
      return result;
    },
    createClient({ label, repos, redirectUri = CHATGPT_REDIRECT }) {
      if (typeof label !== 'string' || !label.trim() || label.length > 100)
        throw new Error('Enter a connection name (up to 100 characters)');
      if (
        !Array.isArray(repos) ||
        !repos.length ||
        repos.some((r) => typeof r !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r))
      )
        throw new Error('Select at least one project');
      // Exact allowlist copied from ChatGPT, never a wildcard or caller-chosen redirect.
      if (
        redirectUri !== CHATGPT_REDIRECT &&
        !/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(redirectUri)
      )
        throw new Error('Copy the exact OAuth redirect URL from ChatGPT');
      const secret = random();
      const client = {
        id: random(),
        secretHash: digest(secret),
        label: label.trim(),
        repos: [...new Set(repos)],
        redirectUri,
        createdAt: now(),
      };
      return write((next) => {
        if (next.clients.length >= 50) throw new Error('Revoke an unused connection before creating another');
        next.clients.push(client);
        return { clientId: client.id, clientSecret: secret };
      });
    },
    async revoke(id) {
      await write((next) => {
        next.clients = next.clients.filter((c) => c.id !== id);
        next.grants = next.grants.filter((g) => g.clientId !== id);
      });
    },
    metadata() {
      available();
      return {
        issuer: state.baseUrl,
        authorization_endpoint: `${state.baseUrl}/oauth/authorize`,
        token_endpoint: `${state.baseUrl}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [MCP_SCOPE],
        authorization_response_iss_parameter_supported: true,
      };
    },
    resourceMetadata() {
      available();
      return {
        resource: resource(),
        authorization_servers: [state.baseUrl],
        scopes_supported: [MCP_SCOPE],
        bearer_methods_supported: ['header'],
      };
    },
    consent(query) {
      available();
      prune();
      const client = clientFor(query.client_id);
      if (!client || query.redirect_uri !== client.redirectUri)
        throw new Error('Unknown OAuth client or redirect URI');
      if (query.resource !== resource()) throw new Error('Invalid OAuth resource');
      if (
        query.response_type !== 'code' ||
        query.code_challenge_method !== 'S256' ||
        typeof query.code_challenge !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
      )
        throw new Error('Authorization requires an S256 PKCE challenge');
      if (query.scope && query.scope !== MCP_SCOPE) throw new Error('Invalid OAuth scope');
      if (typeof query.state !== 'string' || !query.state || query.state.length > 2048)
        throw new Error('Missing or invalid OAuth state');
      if (pending.size >= 200) throw new Error('Too many pending authorizations');
      const nonce = random();
      pending.set(digest(nonce), {
        clientId: client.id,
        redirectUri: client.redirectUri,
        challenge: query.code_challenge,
        state: query.state,
        resource: resource(),
        expiresAt: now() + 600_000,
      });
      return { nonce, label: client.label, repos: client.repos };
    },
    approve(nonce, allow) {
      available();
      prune();
      const key = digest(nonce);
      const request = pending.get(key);
      pending.delete(key);
      if (!request || !clientFor(request.clientId))
        throw new Error('Authorization expired; reconnect from ChatGPT');
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set('state', request.state);
      redirect.searchParams.set('iss', state.baseUrl);
      if (allow) {
        if (codes.size >= 200) throw new Error('Too many pending authorization codes');
        const code = random();
        codes.set(digest(code), { ...request, expiresAt: now() + 60_000 });
        redirect.searchParams.set('code', code);
      } else redirect.searchParams.set('error', 'access_denied');
      return redirect.href;
    },
    exchange(body, header) {
      // All validation runs inside the queue: a concurrent revoke, disable or
      // refresh cannot resurrect a grant after it was invalidated.
      return write((next) => {
        available();
        prune();
        const client = clientCredentials(body, header);
        if (body.resource !== resource()) throw oauthError('invalid_target', 'Invalid OAuth resource');
        if (body.scope && body.scope !== MCP_SCOPE) throw oauthError('invalid_scope', 'Invalid OAuth scope');
        let grant;
        if (body.grant_type === 'authorization_code') {
          const key = digest(body.code);
          const code = codes.get(key);
          if (
            !code ||
            code.clientId !== client.id ||
            code.redirectUri !== body.redirect_uri ||
            code.resource !== resource()
          )
            throw oauthError('invalid_grant', 'Invalid or expired authorization code');
          if (
            typeof body.code_verifier !== 'string' ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) ||
            createHash('sha256').update(body.code_verifier).digest('base64url') !== code.challenge
          )
            throw oauthError('invalid_grant', 'Invalid PKCE verifier');
          codes.delete(key);
          if (next.grants.filter((g) => g.clientId === client.id).length >= 20)
            throw oauthError('invalid_grant', 'Too many connections; revoke and create a new client');
          grant = {
            clientId: client.id,
            resource: resource(),
            scope: MCP_SCOPE,
            refreshExpires: now() + 30 * 86400_000,
          };
          next.grants.push(grant);
        } else if (body.grant_type === 'refresh_token') {
          grant = next.grants.find(
            (g) => g.clientId === client.id && matches(body.refresh_token, g.refreshHash),
          );
          if (!grant || grant.resource !== resource())
            throw oauthError('invalid_grant', 'Invalid or expired refresh token');
        } else throw oauthError('unsupported_grant_type', 'Unsupported grant type');
        const access = random(),
          refresh = random();
        Object.assign(grant, {
          accessHash: digest(access),
          refreshHash: digest(refresh),
          accessExpires: now() + 3600_000,
        });
        return {
          access_token: access,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: MCP_SCOPE,
        };
      });
    },
    authenticate(header) {
      available();
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const token = header.slice(7);
      const grant = state.grants.find(
        (g) =>
          g.accessExpires > now() &&
          g.refreshExpires > now() &&
          g.resource === resource() &&
          g.scope === MCP_SCOPE &&
          matches(token, g.accessHash),
      );
      const client = grant && clientFor(grant.clientId);
      return client ? { id: client.id, label: client.label, repos: [...client.repos] } : null;
    },
  };
}
