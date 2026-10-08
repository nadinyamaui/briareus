// @ts-check
// Laravel Forge, proxied: a client lists an account's servers and sites and edits a
// site's deploy script and .env through /api/v1, with the server calling Forge using the
// account's token (lib/forge-accounts.js). That token can rebuild every server, so it
// never reaches a client or an agent. Forge's JSON:API resources go back flattened to
// `{ id, ...attributes }` with Forge's attribute names.

const BASE = 'https://forge.laravel.com/api';

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** @param {{ id: string | number, attributes?: Record<string, any> }} resource */
const flatten = (resource) => ({ ...resource.attributes, id: Number(resource.id) });

// The ids go into Forge's path verbatim, so anything but a plain number is refused.
/** @param {unknown} value @param {string} name */
function forgeId(value, name) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,17}$/.test(text)) throw httpError(`Invalid ${name} id`, 400);
  return text;
}

/** @param {unknown} cursor */
function pageQuery(cursor) {
  const query = new URLSearchParams({ 'page[size]': '100' });
  if (typeof cursor === 'string' && cursor) query.set('page[cursor]', cursor);
  return `?${query}`;
}

// Forge's 401 and 403 are about the server's token, and passed on would read as the
// client's own token being refused, so they become a 502 naming the cause. A 404 or 422
// is about what the client sent and keeps Forge's message.
/** @param {Response} res */
async function refusal(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403)
    return httpError(
      `Forge refused the account's token (${res.status}): check the token and its scopes`,
      502,
    );
  if (res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    return httpError(
      `Forge is rate limiting this server${reset ? ` until ${reset}` : ''}; try again shortly`,
      429,
    );
  }
  if (res.status === 404) return httpError('Not found on Forge', 404);
  if (res.status === 400 || res.status === 422) {
    const detail =
      body.message ||
      body.errors?.[0]?.detail ||
      Object.values(body.errors || {})
        .flat()
        .find((e) => typeof e === 'string');
    return httpError(detail || 'Forge rejected the request', 422);
  }
  return httpError(`Forge answered ${res.status}`, 502);
}

// `client(id).servers()`: `account` opens a stored `{ organization, token }` by id, or
// throws a 404.
/**
 * @param {{ account: (id: unknown) => { organization: string, token: string }, request?: typeof fetch }} deps
 */
export function createForgeClient({ account, request = fetch }) {
  /** @param {unknown} accountId @param {string} method @param {string} path @param {object} [body] */
  async function callAs(accountId, method, path, body) {
    const cfg = account(accountId);
    const org = encodeURIComponent(cfg.organization);
    let res;
    try {
      res = await request(`${BASE}/orgs/${org}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw httpError('Forge did not answer', 502);
    }
    if (!res.ok) throw await refusal(res);
    if (res.status === 202 || res.status === 204) return null;
    return res.json();
  }
  const page = (doc) => ({ items: doc.data.map(flatten), nextCursor: doc.meta?.next_cursor || null });
  const site = (server, siteId) => `/servers/${forgeId(server, 'server')}/sites/${forgeId(siteId, 'site')}`;

  /** @param {unknown} accountId */
  return (accountId) => {
    /** @param {string} method @param {string} path @param {object} [body] */
    const call = (method, path, body) => callAs(accountId, method, path, body);
    return {
      /** @param {unknown} [cursor] */
      async servers(cursor) {
        const { items, nextCursor } = page(await call('GET', `/servers${pageQuery(cursor)}`));
        return { servers: items, nextCursor };
      },
      /** @param {unknown} server @param {unknown} [cursor] */
      async sites(server, cursor) {
        const doc = await call('GET', `/servers/${forgeId(server, 'server')}/sites${pageQuery(cursor)}`);
        const { items, nextCursor } = page(doc);
        return { sites: items, nextCursor };
      },
      // Forge reads a site by id under the organization, not the server, so the server
      // in the request is checked against the answer.
      /** @param {unknown} server @param {unknown} siteId */
      async site(server, siteId) {
        const serverId = forgeId(server, 'server');
        const doc = await call('GET', `/sites/${forgeId(siteId, 'site')}`);
        const serverOf = doc.data.relationships?.server?.data?.id;
        if (serverOf != null && String(serverOf) !== serverId) throw httpError('Not found on Forge', 404);
        return { site: flatten(doc.data) };
      },
      /** @param {unknown} server @param {unknown} siteId */
      async deploymentScript(server, siteId) {
        const { attributes } = (await call('GET', `${site(server, siteId)}/deployments/script`)).data;
        return { content: attributes.content ?? '', autoSource: !!attributes.auto_source };
      },
      /** @param {unknown} server @param {unknown} siteId @param {Record<string, any>} input */
      async setDeploymentScript(server, siteId, input) {
        if (typeof input.content !== 'string') throw httpError('Send the script as `content`', 400);
        if (input.autoSource != null && typeof input.autoSource !== 'boolean')
          throw httpError('`autoSource` is true or false', 400);
        const doc = await call('PUT', `${site(server, siteId)}/deployments/script`, {
          content: input.content,
          ...(input.autoSource != null ? { auto_source: input.autoSource } : {}),
        });
        return { content: doc.data.attributes.content ?? '', autoSource: !!doc.data.attributes.auto_source };
      },
      /** @param {unknown} server @param {unknown} siteId */
      async environment(server, siteId) {
        const { attributes } = (await call('GET', `${site(server, siteId)}/environment`)).data;
        return { content: attributes.content ?? '' };
      },
      // Forge accepts the file (202) and writes it later, so the answer means accepted,
      // not written.
      /** @param {unknown} server @param {unknown} siteId @param {Record<string, any>} input */
      async setEnvironment(server, siteId, input) {
        if (typeof input.content !== 'string') throw httpError('Send the file as `content`', 400);
        await call('PUT', `${site(server, siteId)}/environment`, { environment: input.content });
        return { ok: true };
      },
    };
  };
}
