// @ts-check
// Laravel Forge, proxied: a client lists a Forge account's servers and their
// sites and edits a site's deployment script and .env through /api/v1, and the
// server makes the call with that account's token (lib/forge-accounts.js). The
// token can rebuild every server the organization has, so it stays sealed on
// the server and never reaches a client or an agent.
//
// Forge answers in JSON:API (`{ data: { id, type, attributes } }`); what goes
// back to a client is each resource flattened to `{ id, ...attributes }`, with
// the attributes named as Forge names them.

const BASE = 'https://forge.laravel.com/api';

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** @param {{ id: string | number, attributes?: Record<string, any> }} resource */
const flatten = (resource) => ({ ...resource.attributes, id: Number(resource.id) });

// The ids go into Forge's path as they are, so anything but a plain number is
// refused here rather than handed on as a path segment.
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

// What Forge's refusal means for the client that asked. Its 401 and 403 are
// about the server's token, not the client's, and passing them on as they are
// would read as the client's own token being refused, so they become a 502
// naming the real cause. A 404 or a 422 is about what the client sent, and its
// message is Forge's own.
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

// The client is a function of the account: `client(id).servers()`. `account`
// opens a stored one by id, `{ organization, token }`, or throws a 404 for one
// that is not there.
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
      // Forge reads one site by its id under the organization, not the server,
      // so the server it is asked under is checked against the answer: a site
      // read as server 1's must not turn out to be server 2's.
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
      // Forge accepts the new file (202) and writes it to the server after, so
      // the answer says it was accepted, not what the file now holds.
      /** @param {unknown} server @param {unknown} siteId @param {Record<string, any>} input */
      async setEnvironment(server, siteId, input) {
        if (typeof input.content !== 'string') throw httpError('Send the file as `content`', 400);
        await call('PUT', `${site(server, siteId)}/environment`, { environment: input.content });
        return { ok: true };
      },
    };
  };
}
