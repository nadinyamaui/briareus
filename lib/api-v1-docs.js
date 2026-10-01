// @ts-check
import { API_V1_ROUTES, FIELDS, NOT_IN_API, OBJECTS, RETIRED } from './api-v1-catalog.js';

// The two documents a client builds against, both written from the catalog
// (lib/api-v1-catalog.js) so neither can say something the gateway does not
// do: the OpenAPI document /api/v1/openapi.json serves, and the reference in
// docs/api-v1-reference.md (scripts/api-docs.js writes it to disk).

const PREFIX = '/api/v1';
const PRIMITIVES = ['string', 'integer', 'number', 'boolean', 'object'];

// A catalog type as a JSON Schema: `Name[]?` is a list of Name or null.
export function schemaOf(type) {
  if (type.endsWith('?')) {
    const inner = schemaOf(type.slice(0, -1));
    if (inner.$ref) return { anyOf: [inner, { type: 'null' }] };
    // An enum lists every value it allows, so null has to be among them too.
    return { ...inner, type: [inner.type, 'null'], ...(inner.enum ? { enum: [...inner.enum, null] } : {}) };
  }
  if (type.endsWith('[]')) return { type: 'array', items: schemaOf(type.slice(0, -2)) };
  if (PRIMITIVES.includes(type)) return { type };
  if (OBJECTS[type]) return { $ref: `#/components/schemas/${type}` };
  return { type: 'string', enum: type.split('|') };
}

// The fields a route's query or body lists, each with its type and meaning:
// the route's own wording where it has one, the shared one otherwise.
function fieldsOf(entry, names) {
  return names.map((name) => {
    const [type, about] = entry.fields?.[name] || FIELDS[name] || [];
    if (!type) throw new Error(`${entry.id}: no description for the field ${name}`);
    return { name, type, about, required: (entry.required || []).includes(name) };
  });
}

const openApiPath = (path) => path.replace(/[:*](\w+)/g, '{$1}');
const operationId = (id) => id.replace(/\.(.)/g, (_, c) => c.toUpperCase());
const pathParams = (path) => [...path.matchAll(/[:*](\w+)/g)].map(([, name]) => name);

function returnsSchema(returns) {
  if (typeof returns === 'string') return schemaOf(returns);
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(returns).map(([key, type]) => [key, schemaOf(type)])),
  };
}

function objectSchema({ about, fields }, forBody = false) {
  return {
    type: 'object',
    description: about,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, [type, text]]) => [
        name,
        { ...schemaOf(type), ...(text ? { description: text } : {}) },
      ]),
    ),
    // The server may send more than is listed, and takes a partial body.
    additionalProperties: !forBody,
  };
}

export function apiV1OpenApi() {
  const error = {
    description: 'An error; `error` says what went wrong',
    content: {
      'application/json': {
        schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      },
    },
  };
  const paths = {};
  for (const entry of API_V1_ROUTES) {
    const parameters = [
      ...pathParams(entry.path).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...fieldsOf(entry, entry.query || []).map((field) => ({
        name: field.name,
        in: 'query',
        required: field.required,
        description: field.about,
        schema: schemaOf(field.type),
      })),
    ];
    const bodyFields = fieldsOf(entry, entry.body || []);
    const required = bodyFields.filter((f) => f.required).map((f) => f.name);
    const requestBody = entry.raw
      ? {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        }
      : entry.bodyObject
        ? {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${entry.bodyObject}` } } },
          }
        : bodyFields.length
          ? {
              required: required.length > 0,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: Object.fromEntries(
                      bodyFields.map((f) => [f.name, { ...schemaOf(f.type), description: f.about }]),
                    ),
                    ...(required.length ? { required } : {}),
                  },
                },
              },
            }
          : null;
    const ok = entry.stream
      ? {
          description: 'A server-sent event stream',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        }
      : entry.binary
        ? { description: 'The file', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }
        : {
            description: entry.notes || 'The result',
            content: { 'application/json': { schema: returnsSchema(entry.returns) } },
          };
    paths[openApiPath(entry.path)] = {
      ...paths[openApiPath(entry.path)],
      [entry.method.toLowerCase()]: {
        operationId: operationId(entry.id),
        summary: entry.summary,
        ...(parameters.length ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses: { [entry.status || 200]: ok, default: error },
        'x-briareus-access': entry.access,
        'x-briareus-scope': entry.scope,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Briareus API',
      version: '1.0.0',
      description:
        'Every operation needs a bearer token. x-briareus-access is the least permission that may call it (read, manage or admin), x-briareus-scope how a token limited to some projects is held to them (repo: it must name one of its projects; session: the session must belong to one; any: nothing to name).',
    },
    servers: [{ url: PREFIX }],
    security: [{ token: [] }],
    paths,
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(
        Object.entries(OBJECTS).map(([name, object]) => [name, objectSchema(object)]),
      ),
    },
  };
}

// ---- the reference, as markdown ----

/** @type {[string, RegExp][]} */
const SECTIONS = [
  ['The token', /^(client|openapi|token|events)\./],
  ['Projects', /^(projects\.|branches\.|runtimes\.|usage\.project$|actions\.)/],
  ['Pull requests', /^(pulls|commits)\./],
  ['Sessions', /^(sessions|tasks)\./],
  ['Composer', /^(prompts|uploads|transcribe|providers)\./],
  ['Memory', /^memories\./],
  ['Operations', /^(usage\.overall$|attention\.|maintenance\.|ssh\.|deployments\.|notifications\.|videos\.)/],
  ['Settings', /^settings\.(?!devices|mcp)/],
  ['Tokens and connections', /^settings\.(devices|mcp)\./],
];

const cell = (text) => String(text).replace(/\|/g, '\\|');
const typeText = (type) => `\`${type}\``;
const returnsText = (returns) =>
  typeof returns === 'string'
    ? typeText(returns)
    : `\`{ ${Object.entries(returns)
        .map(([key, type]) => `${key}: ${type}`)
        .join(', ')} }\``;

function fieldTable(fields) {
  return [
    '| Field | Type | |',
    '| --- | --- | --- |',
    ...fields.map(
      (f) =>
        `| \`${f.name}\`${f.required ? ' **required**' : ''} | ${cell(typeText(f.type))} | ${cell(f.about)} |`,
    ),
  ].join('\n');
}

function routeText(entry) {
  const held =
    entry.access === 'admin'
      ? ''
      : entry.scope === 'repo'
        ? (entry.required || []).includes('repo')
          ? ', held to `repo`'
          : ', held to `repo` (an admin token may leave it out)'
        : entry.scope === 'session'
          ? ', held to the session’s project'
          : '';
  const lines = [
    `### \`${entry.method} ${openApiPath(entry.path)}\``,
    '',
    `${entry.summary}. Needs \`${entry.access}\`${held}.`,
  ];
  const query = fieldsOf(entry, entry.query || []);
  if (query.length) lines.push('', '**Query**', '', fieldTable(query));
  if (entry.raw)
    lines.push('', '**Body**: the raw bytes, up to 25 MiB, with any content type other than JSON.');
  else if (entry.bodyObject)
    lines.push(
      '',
      `**Body**: a [${entry.bodyObject}](#${entry.bodyObject.toLowerCase()}), whole or in part.`,
    );
  else if (entry.body?.length) lines.push('', '**Body**', '', fieldTable(fieldsOf(entry, entry.body)));
  if (entry.stream) lines.push('', '**Returns** a server-sent event stream; see the guide’s Events section.');
  else if (entry.binary) lines.push('', '**Returns** the file.');
  else
    lines.push(
      '',
      `**Returns** ${entry.status ? `${entry.status} ` : ''}${returnsText(entry.returns)}${entry.notes ? `. ${entry.notes}` : ''}`,
    );
  return lines.join('\n');
}

function objectText(name, { about, fields }) {
  return [
    `### ${name}`,
    '',
    about,
    '',
    '| Field | Type | |',
    '| --- | --- | --- |',
    ...Object.entries(fields).map(
      ([field, [type, text]]) => `| \`${field}\` | ${cell(typeText(type))} | ${cell(text)} |`,
    ),
  ].join('\n');
}

export function apiV1Reference() {
  const used = new Set();
  const sections = SECTIONS.map(([title, pattern]) => {
    const entries = API_V1_ROUTES.filter((entry) => pattern.test(entry.id));
    for (const entry of entries) used.add(entry.id);
    return [`## ${title}`, '', ...entries.map((entry) => `${routeText(entry)}\n`)].join('\n');
  });
  const stray = API_V1_ROUTES.filter((entry) => !used.has(entry.id));
  if (stray.length) throw new Error(`No reference section for ${stray.map((e) => e.id).join(', ')}`);
  return [
    '# Client API v1 reference',
    '',
    '<!-- Written by `npm run build:api-docs` from lib/api-v1-catalog.js. Edit the catalog, not this file. -->',
    '',
    `Every route of \`${PREFIX}\`, what it takes and what it answers. Read the [guide](api-v1.md) first: it covers tokens, permissions, errors and the event streams. Paths are relative to \`${PREFIX}\`.`,
    '',
    'A type followed by `[]` is a list and by `?` may be null. `a|b` is one of those strings. A capitalised type is an [object](#objects) described at the end. Responses may carry more fields than are listed; ignore what you do not know.',
    '',
    ...sections,
    '## Objects',
    '',
    ...Object.entries(OBJECTS).map(([name, object]) => `${objectText(name, object)}\n`),
    '## Coming from the dashboard’s routes',
    '',
    'The built-in dashboard called its handlers by the paths on the left, with the login cookie. Those paths are retired and answer 410; each has the route on the right, and a client ported from the dashboard’s pages swaps one for the other.',
    '',
    '| Dashboard | API |',
    '| --- | --- |',
    ...API_V1_ROUTES.filter((entry) => entry.to).map(
      (entry) =>
        `| \`${entry.method} ${entry.to}${entry.set ? `?${new URLSearchParams(entry.set)}` : ''}\` | \`${entry.method} ${openApiPath(entry.path)}\` |`,
    ),
    ...Object.entries({ ...RETIRED, ...NOT_IN_API }).map(([key, why]) => `| \`${key}\` | ${cell(why)} |`),
    '',
  ].join('\n');
}
