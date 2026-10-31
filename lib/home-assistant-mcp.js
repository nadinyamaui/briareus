#!/usr/bin/env node
// @ts-check
import { createApiClient, serveStdio } from './mcp-stdio.js';

const call = createApiClient(
  '/api/agent/home-assistant',
  'Home Assistant tools are not configured for this session',
);
const tools = [
  {
    name: 'ha_status',
    description:
      "Whether the user's Home Assistant is connected to Briareus and answering. When it is not configured, the user connects it from a client (PUT /api/v1/me/home-assistant), not from a session.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ha_entities',
    description:
      "List the user's Home Assistant entities (id, friendly name, current state), such as vacuum.living_room or light.kitchen. Filter by domain and by a search on the id or name to find the one the user means; ha_entity reads its attributes.",
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, such as vacuum, light, climate or switch' },
        search: { type: 'string', description: 'Case-insensitive text in the entity id or friendly name' },
      },
    },
  },
  {
    name: 'ha_entity',
    description: 'Read one Home Assistant entity: its state, every attribute and when it last changed.',
    inputSchema: {
      type: 'object',
      properties: { entityId: { type: 'string', description: 'Entity id, such as vacuum.living_room' } },
      required: ['entityId'],
    },
  },
  {
    name: 'ha_services',
    description:
      'List the actions (services) Home Assistant offers, to choose one and its data before ha_call_service. With a domain, each action comes with its fields; without one, only the action names of every domain.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Service domain, such as vacuum or light' } },
    },
  },
  {
    name: 'ha_call_service',
    description:
      "Run a Home Assistant action, such as vacuum.start or light.turn_on, on the user's real devices. Only light, switch, fan, vacuum, lawn_mower, media_player, remote, climate, humidifier, water_heater and todo actions; the user runs the rest from a client. Only for what the user explicitly asked, on the entity they meant: ask when more than one could be meant. Returns the entities whose state changed. After a timeout or an uncertain result, read the entity with ha_entity before calling again; a changed state does not prove the device finished.",
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain, such as vacuum' },
        service: { type: 'string', description: 'Service name, such as start' },
        data: {
          type: 'object',
          description: 'Service data, usually with entity_id, such as {"entity_id":"vacuum.living_room"}',
        },
        returnResponse: {
          type: 'boolean',
          description: 'Ask for the response data of a service that returns some',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'ha_fire_event',
    description:
      'Fire a briareus_* event on Home Assistant, such as briareus_command, for an automation the user set up to listen for it. Only when the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: {
        eventType: { type: 'string', description: 'Event type, such as briareus_command' },
        data: { type: 'object', description: 'Event data' },
      },
      required: ['eventType'],
    },
  },
];

const query = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return q.size ? `?${q}` : '';
};

async function runTool(name, args = {}) {
  if (name === 'ha_status') return JSON.stringify(await call('GET', ''));
  if (name === 'ha_entities')
    return JSON.stringify(
      await call('GET', `/entities${query({ domain: args.domain, search: args.search })}`),
    );
  if (name === 'ha_entity') {
    if (!args.entityId) throw new Error('entityId is required');
    return JSON.stringify(await call('GET', `/entities/${encodeURIComponent(args.entityId)}`));
  }
  if (name === 'ha_services')
    return JSON.stringify(await call('GET', `/services${query({ domain: args.domain })}`));
  if (name === 'ha_call_service') {
    if (!args.domain || !args.service) throw new Error('domain and service are required');
    return JSON.stringify(
      await call(
        'POST',
        `/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}${
          args.returnResponse ? '?returnResponse=1' : ''
        }`,
        args.data || {},
      ),
    );
  }
  if (name === 'ha_fire_event') {
    if (!args.eventType) throw new Error('eventType is required');
    return JSON.stringify(
      await call('POST', `/events/${encodeURIComponent(args.eventType)}`, args.data || {}),
    );
  }
  throw new Error(`Unknown tool ${name}`);
}
serveStdio({ name: 'reviewer-home-assistant', tools, runTool });
