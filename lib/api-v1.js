// @ts-check
import express from 'express';

// The client API: the one HTTP surface a client that is not this repo's own
// pages talks to (the web app in its own repo, the iOS and Windows apps). It
// adds no handlers of its own beyond the few at the bottom: every route in the
// catalog below names the handler the dashboard already has, and the gateway
// decides who may reach it. So a client gets exactly what the dashboard does,
// and a fix to a handler is a fix for every client at once.
//
// The catalog is the contract. /openapi.json is generated from it, the
// permission each route needs is declared in it, and a handler that is not
// listed here cannot be reached with a token at all: the agent's own routes
// (/api/agent/*), the webhooks and the pages that mint credentials (devices,
// ChatGPT connections) are deliberately absent.

export const API_V1_PREFIX = '/api/v1';

const RANK = { read: 0, manage: 1, admin: 2 };
const fail = (status, message) => Object.assign(new Error(message), { status });

// One route: `path` is what a client calls (under the prefix), `to` the
// handler's own path. `access` is the least permission that may call it.
// `scope` says how a token limited to some projects is held to them:
//   repo     the request names a project (`repo`, in the query of a GET or
//            DELETE and in the body otherwise), which must be one of its own
//   session  the :id is a session of one of its projects
//   any      nothing to check: the route is not about one project, or the
//            handler filters its list to the token's projects itself
// An admin token is the operator's own and is not held to a project list.
//
// The rest describes the request: `query` and `body` name the fields a client
// may send (for the OpenAPI document; the handlers validate, not the gateway),
// `params` copies a path parameter into the query or body under the name the
// handler reads, `set` adds fixed query values, `raw` takes the body as bytes,
// `stream` marks a server-sent event stream, and `runtime` fills in the
// project's configured provider when a start names none.
/** @returns {Record<string, any>} */
function route(id, method, path, to, access, scope, summary, extra = {}) {
  return { id, method, path, to, access, scope, summary, ...extra };
}

const RUNTIME = ['provider', 'model', 'effort'];
const VERDICTS = ['verdicts', 'note'];
const pullSection = (section, summary, query = []) =>
  route(
    `pulls.${section.replace(/-(.)/g, (_, c) => c.toUpperCase())}`,
    'GET',
    `/pulls/:number/${section}`,
    '/api/pr/view',
    'read',
    'repo',
    summary,
    { params: { number: 'pr' }, set: { section }, query: ['repo', ...query, 'headSha', 'baseSha'] },
  );
const sessionAction = (name, to, summary, extra = {}) =>
  route(
    `sessions.${name.replace(/-(.)/g, (_, c) => c.toUpperCase())}`,
    'POST',
    `/sessions/:id/${name}`,
    `/api/dev/sessions/:id/${to}`,
    'manage',
    'session',
    summary,
    extra,
  );
const crud = (name, path, to, label, { order = false } = {}) => [
  route(
    `${name}.list`,
    'GET',
    path,
    to,
    'admin',
    'any',
    `List ${label}s, with the defaults a new one starts from`,
  ),
  route(`${name}.create`, 'POST', path, to, 'admin', 'any', `Add a ${label}`),
  ...(order
    ? [
        route(`${name}.order`, 'PUT', `${path}/order`, `${to}/order`, 'admin', 'any', `Reorder ${label}s`, {
          body: ['ids'],
        }),
      ]
    : []),
  route(`${name}.update`, 'PUT', `${path}/:id`, `${to}/:id`, 'admin', 'any', `Change a ${label}`),
  route(`${name}.delete`, 'DELETE', `${path}/:id`, `${to}/:id`, 'admin', 'any', `Remove a ${label}`),
];

export const API_V1_ROUTES = [
  // ---- projects, as a session picker sees them ----
  route(
    'projects.list',
    'GET',
    '/projects',
    '/api/dev/projects',
    'read',
    'any',
    'List the projects this token can use',
  ),
  route(
    'branches.list',
    'GET',
    '/branches',
    '/api/dev/branches',
    'read',
    'repo',
    'List a project’s branches',
    {
      query: ['repo'],
    },
  ),
  route(
    'runtimes.list',
    'GET',
    '/runtimes',
    '/api/dev/runtimes',
    'read',
    'repo',
    'List the providers, models and efforts a session can start on, and the project’s default',
    { query: ['repo'] },
  ),
  route(
    'usage.project',
    'GET',
    '/usage',
    '/api/dev/usage',
    'read',
    'repo',
    'Read a project’s usage and costs this month',
    {
      query: ['repo'],
    },
  ),
  route(
    'actions.list',
    'GET',
    '/actions',
    '/api/dev/actions',
    'read',
    'any',
    'List the pull request errands',
  ),
  route(
    'actions.start',
    'POST',
    '/actions',
    '/api/dev/actions',
    'manage',
    'repo',
    'Start an errand on a pull request; starts a paid session',
    { body: ['action', 'repo', 'prNumber', 'input', ...RUNTIME], runtime: true },
  ),

  // ---- pull requests ----
  route(
    'pulls.list',
    'GET',
    '/pulls',
    '/api/dev/pulls',
    'read',
    'repo',
    'List a project’s pull requests and issues',
    {
      query: ['repo', 'fresh'],
    },
  ),
  route(
    'pulls.get',
    'GET',
    '/pulls/:number',
    '/api/dev/pull',
    'read',
    'repo',
    'Read a pull request’s overview: state, size, commit headlines, linked issues, review verdicts and checks summary',
    { params: { number: 'pr' }, query: ['repo'] },
  ),
  pullSection('description', 'Read a pull request’s body, mergeability and allowed merge methods'),
  pullSection('files', 'Read one page (100) of a pull request’s changed files with their patches', ['page']),
  pullSection('commits', 'Read one page (100) of a pull request’s commits', ['page']),
  pullSection('checks', 'Read every check run and commit status on a pull request’s head'),
  pullSection('comments', 'Read one page (100) of a pull request’s conversation comments', ['page']),
  pullSection('reviews', 'Read one page (100) of a pull request’s reviews', ['page']),
  pullSection('review-comments', 'Read one page (100) of a pull request’s inline review comments', ['page']),
  route(
    'pulls.findings',
    'GET',
    '/pulls/:number/findings',
    '/api/pr/findings',
    'read',
    'repo',
    'Read the review findings declared on a pull request, with their verdicts',
    { params: { number: 'pr' }, query: ['repo'] },
  ),
  route(
    'pulls.decideFinding',
    'POST',
    '/pulls/:number/findings/decision',
    '/api/pr/findings/decision',
    'manage',
    'repo',
    'Record a verdict on a finding; may post to GitHub',
    { params: { number: 'pr' }, body: ['repo', 'key', 'decision'] },
  ),
  route(
    'pulls.merge',
    'POST',
    '/pulls/:number/merge',
    '/api/pr/merge',
    'manage',
    'repo',
    'Merge a pull request on GitHub',
    {
      params: { number: 'pr' },
      body: ['repo', 'method', 'headSha', 'baseRef'],
    },
  ),
  route(
    'pulls.serve',
    'POST',
    '/pulls/:number/serve',
    '/api/dev/pulls/:number/serve',
    'manage',
    'repo',
    'Prepare a workspace for a pull request and serve it with the project’s run commands',
    { body: ['repo', ...RUNTIME], runtime: true },
  ),
  route(
    'commits.get',
    'GET',
    '/commits/:sha',
    '/api/pr/commit',
    'read',
    'repo',
    'Read one commit with the files it changed and their patches',
    { params: { sha: 'sha' }, query: ['repo'] },
  ),

  // ---- sessions ----
  route(
    'sessions.list',
    'GET',
    '/sessions',
    '/api/dev/sessions',
    'read',
    'any',
    'List the sessions of this token’s projects',
  ),
  route(
    'sessions.create',
    'POST',
    '/sessions',
    '/api/dev/sessions',
    'manage',
    'repo',
    'Start a session; starts a paid agent',
    {
      body: [
        'repo',
        'prompt',
        ...RUNTIME,
        'branch',
        'prNumber',
        'review',
        'qa',
        'local',
        'orchestrator',
        'zeus',
        'workerRuntime',
        'zeusRoles',
        'attachments',
        'reviewLoop',
        'qaLoop',
        'activity',
      ],
      runtime: true,
    },
  ),
  route(
    'sessions.get',
    'GET',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'read',
    'session',
    'Read a session and its transcript from an event offset',
    { query: ['since', 'all'] },
  ),
  route(
    'sessions.events',
    'GET',
    '/sessions/:id/events',
    '/api/dev/sessions/:id/events',
    'read',
    'session',
    'Follow one session: its transcript lines, resumable with Last-Event-ID, and `session` record pushes',
    { query: ['since'], stream: true },
  ),
  route(
    'sessions.update',
    'PATCH',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'manage',
    'session',
    'Edit a session’s title or compaction settings, one per request',
    {
      body: ['title', 'autoCompact', 'compactInstructions'],
    },
  ),
  route(
    'sessions.delete',
    'DELETE',
    '/sessions/:id',
    '/api/dev/sessions/:id',
    'manage',
    'session',
    'Close a session and delete its record and transcript',
  ),
  route(
    'sessions.message',
    'POST',
    '/sessions/:id/messages',
    '/api/dev/sessions/:id/message',
    'manage',
    'session',
    'Send a message to a session; may start a paid turn',
    { body: ['text', 'attachments', 'zeusRoles'] },
  ),
  route(
    'sessions.dropQueued',
    'DELETE',
    '/sessions/:id/queue/:index',
    '/api/dev/sessions/:id/queue/:index',
    'manage',
    'session',
    'Take back a queued message',
  ),
  sessionAction('cancel', 'cancel', 'Stop the running turn'),
  sessionAction('close', 'close', 'Close a session, releasing its workspace and database server'),
  sessionAction('reopen', 'reopen', 'Reopen a closed session without messaging the agent'),
  sessionAction('serve', 'serve', 'Serve the session’s checkout with one of the project’s run profiles', {
    body: ['profile'],
  }),
  sessionAction('compact', 'compact', 'Compact the session’s context'),
  sessionAction('clear', 'clear', 'Hide the transcript so far; the stored log keeps it'),
  sessionAction('review-loop', 'loop', 'Arm or disarm automatic review rounds', { body: ['on'] }),
  sessionAction('qa-loop', 'qa-loop', 'Arm or disarm automatic QA', { body: ['on'] }),
  sessionAction('link-pr', 'link-pr', 'Attach a pull request to the session after verifying its branch', {
    body: ['pr'],
  }),
  sessionAction(
    'findings/triage',
    'triage',
    'Complete findings triage; may start paid agents and post to GitHub',
    {
      id: 'sessions.completeFindings',
      body: VERDICTS,
    },
  ),
  sessionAction('findings/save', 'triage/save', 'Save findings drafts and post them to GitHub', {
    id: 'sessions.saveFindings',
    body: VERDICTS,
  }),
  sessionAction('findings/reply', 'findings/reply', 'Reply on a finding’s GitHub thread', {
    id: 'sessions.replyFinding',
    body: ['key', 'text'],
  }),
  sessionAction('findings/delete', 'findings/delete', 'Delete a finding and its GitHub comment', {
    id: 'sessions.deleteFinding',
    body: ['key'],
  }),
  route(
    'sessions.preview',
    'GET',
    '/sessions/:id/preview',
    '/api/operations/preview/:id',
    'read',
    'session',
    'Read the links of a session’s running preview',
  ),
  route(
    'sessions.previewFeedback',
    'POST',
    '/sessions/:id/preview/feedback',
    '/api/operations/preview/:id',
    'manage',
    'session',
    'Send feedback on a preview page as a message with an annotated screenshot',
    { body: ['url', 'width', 'height', 'x', 'y', 'text', 'uploadId'] },
  ),
  // The webhook's signing keys let their holder put words in a session's
  // mouth, and recovery reaches any job by id, so both are the operator's.
  route(
    'sessions.webhook',
    'GET',
    '/sessions/:id/webhook',
    '/api/dev/sessions/:id/webhook',
    'admin',
    'any',
    'Read a session’s webhook settings, URL and signing keys',
  ),
  route(
    'sessions.setWebhook',
    'PUT',
    '/sessions/:id/webhook',
    '/api/dev/sessions/:id/webhook',
    'admin',
    'any',
    'Change a session’s webhook settings',
  ),
  route(
    'sessions.rotateWebhook',
    'POST',
    '/sessions/:id/webhook/rotate',
    '/api/dev/sessions/:id/webhook/rotate',
    'admin',
    'any',
    'Replace a session’s webhook signing keys',
  ),
  route(
    'sessions.recovery',
    'GET',
    '/sessions/:id/recovery',
    '/api/operations/recovery/:id',
    'admin',
    'any',
    'Inspect what an interrupted session left behind',
  ),
  route(
    'sessions.resume',
    'POST',
    '/sessions/:id/recovery',
    '/api/operations/recovery/:id',
    'admin',
    'any',
    'Resume an interrupted session from its recovery report',
    {
      body: ['fingerprint'],
    },
  ),
  route(
    'tasks.get',
    'GET',
    '/tasks/:id',
    '/api/operations/tasks/:id',
    'admin',
    'any',
    'Read a task’s history: every session filed under it and what it cost',
  ),

  // ---- composer ----
  route(
    'prompts.list',
    'GET',
    '/prompts',
    '/api/dev/prompts',
    'read',
    'repo',
    'List the saved prompts a project offers; without `repo`, the whole library',
    {
      query: ['repo'],
    },
  ),
  ...crud('prompts', '/prompts', '/api/dev/prompts', 'saved prompt').slice(1),
  route(
    'uploads.create',
    'POST',
    '/uploads',
    '/api/dev/uploads',
    'manage',
    'any',
    'Upload one attachment; send the returned id with a message',
    {
      query: ['name'],
      raw: true,
    },
  ),
  route(
    'transcribe.status',
    'GET',
    '/transcribe',
    '/api/dev/transcribe',
    'read',
    'any',
    'Whether this server can transcribe voice notes',
  ),
  route(
    'transcribe.create',
    'POST',
    '/transcribe',
    '/api/dev/transcribe',
    'manage',
    'any',
    'Turn a recorded voice note into text',
    {
      raw: true,
    },
  ),
  route(
    'providers.available',
    'GET',
    '/providers',
    '/api/dev/providers',
    'admin',
    'any',
    'List the providers a session can start on, with every account’s login state and quota',
    { query: ['fresh'] },
  ),

  // ---- memory ----
  route(
    'memories.list',
    'GET',
    '/memories',
    '/api/memories',
    'read',
    'repo',
    'List a project’s memories; without `repo`, every project’s',
    {
      query: ['repo'],
    },
  ),
  route(
    'memories.health',
    'GET',
    '/memories/health',
    '/api/operations/memories',
    'admin',
    'any',
    'Read the memory health report',
    {
      query: ['repo'],
    },
  ),
  route(
    'memories.merge',
    'POST',
    '/memories/merge',
    '/api/operations/memories/merge/apply',
    'admin',
    'any',
    'Merge two memories of one project',
    {
      body: ['targetId', 'sourceId', 'body', 'revisions'],
    },
  ),
  route(
    'memories.policy',
    'POST',
    '/memories/:id/policy',
    '/api/operations/memories/:id',
    'admin',
    'any',
    'Mark a memory verified, archive it or restore it',
    {
      body: ['revision', 'action'],
    },
  ),
  ...crud('memories', '/memories', '/api/memories', 'memory').slice(1),

  // ---- operations ----
  route(
    'usage.overall',
    'GET',
    '/usage/all',
    '/api/dev/usage/all',
    'admin',
    'any',
    'Read usage and costs across every project',
    {
      query: [
        'period',
        'project',
        'model',
        'provider',
        'activity',
        'account',
        'session',
        'pricing',
        'from',
        'to',
      ],
    },
  ),
  route(
    'attention.list',
    'GET',
    '/attention',
    '/api/operations/attention',
    'admin',
    'any',
    'List what is waiting on the operator',
  ),
  route(
    'maintenance.get',
    'GET',
    '/maintenance',
    '/api/operations/maintenance',
    'admin',
    'any',
    'Read whether the server is draining work',
  ),
  route(
    'maintenance.set',
    'POST',
    '/maintenance',
    '/api/operations/maintenance',
    'admin',
    'any',
    'Start or stop draining work',
    {
      body: ['draining'],
    },
  ),
  route(
    'ssh.requests',
    'GET',
    '/ssh/requests',
    '/api/ssh/requests',
    'admin',
    'any',
    'List the SSH commands waiting for approval',
  ),
  route(
    'ssh.decide',
    'POST',
    '/ssh/requests/:id/decision',
    '/api/ssh/requests/:id/decision',
    'admin',
    'any',
    'Approve or deny an SSH command',
    {
      body: ['decision'],
    },
  ),
  route(
    'deployments.get',
    'GET',
    '/deployments',
    '/api/operations/deployments',
    'admin',
    'any',
    'Read a project’s deployment overview',
    {
      query: ['repo'],
    },
  ),
  route(
    'deployments.config',
    'GET',
    '/deployments/config',
    '/api/operations/deployments/config',
    'admin',
    'any',
    'Read a project’s deployment settings',
    {
      query: ['repo'],
    },
  ),
  ...['config', 'plan', 'dispatch', 'acknowledge'].map((step) =>
    route(
      `deployments.${step === 'config' ? 'configure' : step}`,
      'POST',
      `/deployments/${step}`,
      `/api/operations/deployments/${step}`,
      'admin',
      'any',
      `${{ config: 'Change a project’s deployment settings', plan: 'Plan a deployment', dispatch: 'Run a planned deployment', acknowledge: 'Acknowledge the last deployment so another can be requested' }[step]}`,
      { query: ['repo'], ...(step === 'dispatch' ? { body: ['planId'] } : {}) },
    ),
  ),
  route(
    'notifications.get',
    'GET',
    '/notifications',
    '/api/operations/notifications',
    'admin',
    'any',
    'Read the push notification status',
  ),
  ...['config', 'subscribe', 'unsubscribe'].map((step) =>
    route(
      `notifications.${step === 'config' ? 'configure' : step}`,
      'POST',
      `/notifications/${step}`,
      `/api/operations/notifications/${step}`,
      'admin',
      'any',
      `${{ config: 'Set the push contact address', subscribe: 'Subscribe a browser to push notifications', unsubscribe: 'Remove a push subscription' }[step]}`,
      {
        body: { config: ['contact'], subscribe: ['subscription', 'repos'], unsubscribe: ['endpoint'] }[step],
      },
    ),
  ),
  route(
    'videos.get',
    'GET',
    '/videos/*file',
    '/videos/*file',
    'admin',
    'any',
    'Download a video a test run recorded',
    {
      binary: true,
    },
  ),

  // ---- settings ----
  ...crud('settings.projects', '/settings/projects', '/api/projects', 'project', { order: true }),
  route(
    'settings.templates',
    'GET',
    '/settings/templates',
    '/api/templates',
    'admin',
    'any',
    'Read the prompt templates and their catalog',
  ),
  route(
    'settings.setTemplates',
    'PUT',
    '/settings/templates',
    '/api/templates/1',
    'admin',
    'any',
    'Change the prompt templates',
    {
      body: ['values'],
    },
  ),
  route(
    'settings.providers.test',
    'POST',
    '/settings/providers/test',
    '/api/providers/test',
    'admin',
    'any',
    'Probe a provider endpoint and key as a form holds them',
    {
      body: ['id', 'binary', 'baseUrl', 'apiKey', 'defaultModel', 'models'],
    },
  ),
  ...crud('settings.providers', '/settings/providers', '/api/providers', 'provider'),
  route(
    'settings.providers.status',
    'GET',
    '/settings/providers/:id/status',
    '/api/providers/:id/status',
    'admin',
    'any',
    'Read one provider’s login state, account and quota',
    {
      query: ['fresh'],
    },
  ),
  route(
    'settings.providers.login',
    'POST',
    '/settings/providers/:id/login',
    '/api/providers/:id/login',
    'admin',
    'any',
    'Start a codex or grok device login; returns the URL to approve it at',
  ),
  route(
    'settings.providers.loginStart',
    'POST',
    '/settings/providers/:id/login/start',
    '/api/providers/:id/login/start',
    'admin',
    'any',
    'Start a claude login; returns the authorization URL',
  ),
  route(
    'settings.providers.loginFinish',
    'POST',
    '/settings/providers/:id/login/finish',
    '/api/providers/:id/login/finish',
    'admin',
    'any',
    'Finish a claude login with the code the authorization page showed',
    {
      body: ['code'],
    },
  ),
  route(
    'settings.dbServers.test',
    'POST',
    '/settings/db-servers/test',
    '/api/dbservers/test',
    'admin',
    'any',
    'Probe a database server as a form holds it',
    {
      body: ['id', 'host', 'port', 'username', 'password'],
    },
  ),
  ...crud('settings.dbServers', '/settings/db-servers', '/api/dbservers', 'database server'),
  route(
    'settings.workspaces.list',
    'GET',
    '/settings/workspaces',
    '/api/workspaces',
    'admin',
    'any',
    'List the workspace clone slots',
  ),
  route(
    'settings.workspaces.resetSetup',
    'POST',
    '/settings/workspaces/:slot/reset-setup',
    '/api/workspaces/:slot/reset-setup',
    'admin',
    'any',
    'Forget an idle slot’s install fingerprints',
  ),
  route(
    'settings.workspaces.clean',
    'POST',
    '/settings/workspaces/:slot/clean',
    '/api/workspaces/:slot/clean',
    'admin',
    'any',
    'Remove an idle slot’s dependency trees',
  ),
  ...crud('settings.sshServers', '/settings/ssh/servers', '/api/ssh/servers', 'SSH server'),
];

// The routes this module answers itself, described for the OpenAPI document.
const NATIVE_ROUTES = [
  route(
    'client.get',
    'GET',
    '/',
    null,
    'read',
    'any',
    'The token’s own record, the API version and what this server can do',
  ),
  route('openapi.get', 'GET', '/openapi.json', null, 'read', 'any', 'This API as an OpenAPI 3.1 document'),
  route('token.revoke', 'DELETE', '/token', null, 'read', 'any', 'Revoke the token used for this request'),
  route(
    'events.stream',
    'GET',
    '/events',
    null,
    'read',
    'any',
    'Follow every session of this token’s projects: `session` on each record change, `session.deleted`, and with transcripts=1 a `transcript` event per transcript line',
    { query: ['transcripts'], stream: true },
  ),
];

const openApiPath = (path) => path.replace(/[:*](\w+)/g, '{$1}');
const operationId = (id) => id.replace(/\.(.)/g, (_, c) => c.toUpperCase());

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
  for (const entry of [...NATIVE_ROUTES, ...API_V1_ROUTES]) {
    const parameters = [
      ...[...entry.path.matchAll(/[:*](\w+)/g)].map(([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...(entry.query || []).map((name) => ({
        name,
        in: 'query',
        // The one query field the gateway itself insists on.
        required: name === 'repo' && entry.scope === 'repo' && entry.access !== 'admin',
        schema: { type: 'string' },
      })),
    ];
    const body = entry.raw
      ? {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        }
      : ['POST', 'PUT', 'PATCH'].includes(entry.method)
        ? {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  ...(entry.body
                    ? { properties: Object.fromEntries(entry.body.map((name) => [name, {}])) }
                    : {}),
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
        : { description: 'A JSON result', content: { 'application/json': { schema: { type: 'object' } } } };
    paths[openApiPath(entry.path)] = {
      ...paths[openApiPath(entry.path)],
      [entry.method.toLowerCase()]: {
        operationId: operationId(entry.id),
        summary: entry.summary,
        ...(parameters.length ? { parameters } : {}),
        ...(body ? { requestBody: body } : {}),
        responses: { 200: ok, default: error },
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
        'Every operation needs a bearer token. x-briareus-access is the least permission that may call it (read, manage or admin), x-briareus-scope how a token limited to some projects is held to them.',
    },
    servers: [{ url: API_V1_PREFIX }],
    security: [{ token: [] }],
    paths,
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
  };
}

// How often an open stream asks whether its token still stands. A stream is
// the one request that outlives the check made when it was admitted, so a
// revoked or expired token would otherwise keep reading until it reconnected.
const STREAM_RECHECK_MS = 15_000;

// `handlers` is the router the dashboard's own API routes are registered on;
// a catalog route is answered by handing it the request under the handler's
// path. The rest is what the gateway needs to judge a request: the token
// store (lib/mobile-auth.js), the sessions and projects a scope is checked
// against, and the project runtimes a start falls back on.
export function apiV1Routes({
  auth,
  loginEnabled,
  ownerSecret,
  handlers,
  getJob,
  getProject,
  listSessions,
  bus,
  reviewerRuntime = /** @type {(project: object) => any} */ (() => null),
  stepRuntime = /** @type {(project: object, step: string) => any} */ (() => null),
  transcribeAvailable = () => false,
  recheckMs = STREAM_RECHECK_MS,
}) {
  const router = express.Router();

  // Throws unless the request carries a token that stands right now. Called
  // when a request arrives and again once its body has: a body can take a
  // while, and a token revoked meanwhile must not start work.
  const authenticate = (header) => {
    if (!loginEnabled()) throw fail(503, 'Configure dashboard login before using the API');
    return auth.authenticate(header, ownerSecret());
  };
  // The projects a token is held to, or null for the operator's own.
  const reposOf = (client) => (client.permission === 'admin' ? null : client.repos);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // A browser page is never a client of this API: a token in page script is
    // a token any injected script can read, so CORS stays off and the web app
    // calls from its server. A request that names an Origin is a browser's.
    if (req.headers.origin)
      throw fail(403, 'Call this API from a server or a native client, not a browser page');
    const header = req.headers.authorization;
    const client = authenticate(header);
    res.locals.apiClient = client;
    res.locals.apiToken = header;
    res.locals.apiRepos = reposOf(client);
    next();
  });

  // Ends a stream whose token stopped standing while it was open.
  const guardStream = (res) => {
    const timer = setInterval(() => {
      try {
        authenticate(res.locals.apiToken);
      } catch {
        res.destroy();
      }
    }, recheckMs);
    res.on('close', () => clearInterval(timer));
  };

  router.get('/', (_req, res) =>
    res.json({ version: 1, client: res.locals.apiClient, transcribe: !!transcribeAvailable() }),
  );
  router.get('/openapi.json', (_req, res) => res.json(apiV1OpenApi()));
  router.delete('/token', async (_req, res) => {
    await auth.revoke(res.locals.apiClient.id);
    res.json({ ok: true });
  });

  // Every session the token can see, on one connection: what a client that
  // relays to its own users (the web app's server) holds open instead of one
  // stream per conversation. Nothing here is replayed: a client that dropped
  // reads what it missed from /sessions and /sessions/:id?since=.
  router.get('/events', (req, res) => {
    const repos = res.locals.apiRepos;
    const inScope = (repo) => !repos || repos.includes(repo);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const session of listSessions()) if (inScope(session.repo)) send('session', session);
    const onJob = (record) => {
      if (record.kind === 'devchat' && inScope(record.repo)) send('session', record);
    };
    const onDeleted = (id, repo) => {
      if (inScope(repo)) send('session.deleted', { id });
    };
    const onEvent = (id, event) => {
      const job = getJob(id);
      if (job && job.kind === 'devchat' && inScope(job.repo)) send('transcript', { sessionId: id, event });
    };
    bus.on('job', onJob);
    bus.on('deleted', onDeleted);
    if (req.query.transcripts === '1') bus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    guardStream(res);
    res.on('close', () => {
      clearInterval(ping);
      bus.off('job', onJob);
      bus.off('deleted', onDeleted);
      bus.off('event', onEvent);
    });
  });

  const json = express.json({ limit: '1mb' });
  const raw = express.raw({ type: () => true, limit: '25mb' });

  for (const entry of API_V1_ROUTES) {
    const admit = (_req, res, next) => {
      const client = res.locals.apiClient;
      if (RANK[client.permission] < RANK[entry.access])
        throw fail(
          403,
          entry.access === 'admin' ? 'This needs an admin token' : 'This token has read-only access',
        );
      next();
    };
    const dispatch = (req, res, next) => {
      const client = authenticate(res.locals.apiToken);
      const repos = reposOf(client);
      const reads = entry.method === 'GET' || entry.method === 'DELETE';
      const query = new URLSearchParams(req.url.split('?')[1] || '');
      if (!reads && (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) && !entry.raw)
        req.body = {};
      for (const [param, name] of Object.entries(entry.params || {})) {
        if (reads) query.set(name, String(req.params[param]));
        else req.body[name] = req.params[param];
      }
      for (const [name, value] of Object.entries(entry.set || {})) query.set(name, value);

      if (repos && entry.scope === 'repo') {
        // Exactly one: a second `repo` in the query would reach the handler
        // as a list, and which entry it then reads is not this check's to
        // guess.
        const named = reads ? query.getAll('repo') : [req.body.repo];
        const repo = named.length === 1 ? named[0] : null;
        // The same answer for a project that does not exist and one this
        // token was not given, so a token cannot list the server's projects
        // by guessing at them.
        if (typeof repo !== 'string' || !repos.includes(repo))
          throw fail(403, 'Name one of this token’s projects in `repo`');
      }
      if (repos && entry.scope === 'session') {
        const job = getJob(String(req.params.id));
        if (!job || job.kind !== 'devchat' || !repos.includes(job.repo)) throw fail(404, 'Session not found');
      }
      if (entry.runtime && req.body.provider == null) {
        if (req.body.model != null || req.body.effort != null)
          throw fail(400, 'A model or effort needs its provider');
        const project = getProject(req.body.repo || '');
        const step = { 'test-sheet': 'testSheet', 'test-run': 'testRun' }[req.body.action];
        const runtime = project && ((step && stepRuntime(project, step)) || reviewerRuntime(project));
        if (project && !runtime)
          throw fail(
            400,
            'Name a provider, or choose a review provider and model in this project’s Settings',
          );
        if (runtime)
          Object.assign(req.body, {
            provider: runtime.providerId,
            model: runtime.model,
            effort: runtime.effort,
          });
      }

      // What the handlers read instead of a credential: which projects a list
      // is cut down to, and who to name as the author of a change.
      res.locals.apiRepos = repos;
      req.mcpActor = `API client ${client.label}`;
      // The token has been judged and is spent here. The operator's handlers
      // refuse any request still carrying an Authorization header, which is
      // how they keep an agent's session token out; this request's authority
      // is the check above, not the header.
      delete req.headers.authorization;
      if (entry.stream) guardStream(res);
      const path = entry.to.replace(/[:*](\w+)/g, (_, name) =>
        [req.params[name]].flat().map(encodeURIComponent).join('/'),
      );
      const search = query.toString();
      req.url = search ? `${path}?${search}` : path;
      handlers(req, res, next);
    };
    router[entry.method.toLowerCase()](entry.path, admit, entry.raw ? raw : json, dispatch);
  }

  router.use((_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  router.use((err, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const status = err.status || err.statusCode || 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="briareus"');
    if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(status).json({
      error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message || 'Server error',
    });
  });

  const root = express.Router();
  root.use(API_V1_PREFIX, router);
  return root;
}
