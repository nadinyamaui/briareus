// @ts-check
import { getConfig } from './config.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function identifier(value, entity = false) {
  if (
    typeof value !== 'string' ||
    !(entity ? /^[a-z\p{Nd}_]+\.[a-z\p{Nd}_]+$/u : /^[a-z\p{Nd}_]+$/u).test(value)
  )
    throw fail(entity ? 'Invalid Home Assistant entity ID' : 'Invalid Home Assistant domain or service');
  return value;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Send a JSON object');
  return value;
}

function entity(value) {
  if (!value || typeof value.entity_id !== 'string' || typeof value.state !== 'string')
    throw fail('Home Assistant returned an invalid entity', 502);
  return {
    id: value.entity_id,
    name:
      typeof value.attributes?.friendly_name === 'string'
        ? value.attributes.friendly_name || value.entity_id
        : value.entity_id,
    state: value.state,
    attributes: value.attributes || {},
    lastChanged: value.last_changed || null,
    lastUpdated: value.last_updated || null,
  };
}

// A Home Assistant address a user may connect: http(s), with no credentials, query or
// fragment, the same rule the server's own HOME_ASSISTANT_URL follows (lib/config.js).
/** @param {unknown} url */
export function homeAssistantUrl(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw fail('Enter the Home Assistant address, such as http://homeassistant.local:8123', 400);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /[?#]/.test(text)
  )
    throw fail('The Home Assistant address must be http(s), without credentials, query or fragment', 400);
  return text.replace(/\/+$/, '');
}

/**
 * `unconfigured` is what a call says with no connection: the server's own one is set in
 * .env, a user's through PUT /me/home-assistant.
 * @param {{config?: () => {url: string, token: string} | null, fetcher?: typeof fetch, timeoutMs?: number, unconfigured?: string}} [deps]
 */
export function createHomeAssistantService({
  config = () => getConfig().homeAssistant,
  fetcher = fetch,
  timeoutMs = 30000,
  unconfigured = 'Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN on the server',
} = {}) {
  async function request(path, body = undefined) {
    const cfg = config();
    if (!cfg) throw fail(unconfigured, 503);
    try {
      const res = await fetcher(`${cfg.url}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel();
        if ([401, 403].includes(res.status))
          throw fail('Home Assistant refused the access token it is connected with', 502);
        // The API root always exists, so a 404 there means the address is not Home Assistant's.
        if (res.status === 404 && path === '')
          throw fail('No Home Assistant API at that address; use its base URL without /api', 502);
        if (res.status === 404) throw fail('Home Assistant entity, service or event not found', 404);
        if (res.status === 400) throw fail('Home Assistant refused the request; check the service data', 400);
        if (res.status === 429) throw fail('Home Assistant is rate limiting requests', 429);
        throw fail('Home Assistant could not complete the request', 502);
      }
      return await res.json();
    } catch (e) {
      if (e.status) throw e;
      throw fail(
        body === undefined
          ? 'Home Assistant could not be read; check its connection and response'
          : 'Home Assistant did not confirm the operation; check its state before retrying',
        502,
      );
    }
  }

  return {
    async status() {
      if (!config()) return { configured: false, connected: false };
      await request('');
      return { configured: true, connected: true };
    },
    async entities(query = {}) {
      if (query.domain !== undefined) identifier(query.domain);
      const values = await request('states');
      if (!Array.isArray(values)) throw fail('Home Assistant returned an invalid entity list', 502);
      return {
        entities: values.map(entity).filter((e) => !query.domain || e.id.startsWith(`${query.domain}.`)),
      };
    },
    async entity(id) {
      return { entity: entity(await request(`states/${identifier(id, true)}`)) };
    },
    async services() {
      const values = await request('services');
      if (!Array.isArray(values)) throw fail('Home Assistant returned an invalid service list', 502);
      return { services: values };
    },
    async callService(domain, service, data = {}, query = {}) {
      identifier(domain);
      identifier(service);
      object(data);
      if (query.returnResponse !== undefined && !['0', '1'].includes(query.returnResponse))
        throw fail('returnResponse must be 0 or 1');
      const response = query.returnResponse === '1';
      const value = await request(`services/${domain}/${service}${response ? '?return_response' : ''}`, data);
      const states = response ? value?.changed_states : value;
      if (!Array.isArray(states))
        throw fail('Home Assistant returned an invalid receipt; check its state before retrying', 502);
      return { entities: states.map(entity), response: response ? (value.service_response ?? null) : null };
    },
    async fireEvent(type, data = {}) {
      if (typeof type !== 'string' || !type.length) throw fail('Invalid Home Assistant event type');
      await request(`events/${encodeURIComponent(type)}`, object(data));
      return { ok: true };
    },
  };
}
