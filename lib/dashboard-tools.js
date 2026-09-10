// @ts-check
// One explicit catalog for the MCP tools and the project-scoped HTTP bridge.
const string = { type: 'string', minLength: 1 };
const number = { type: 'integer', minimum: 1 };
const boolean = { type: 'boolean' };
const session = { sessionId: string };
const verdicts = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      key: string,
      decision: { enum: ['fix', 'optional', 'dismissed', null] },
      reason: { type: 'string' },
    },
    required: ['key', 'decision'],
    additionalProperties: false,
  },
};

function tool(name, description, method, path, properties = {}, required = [], extra = {}) {
  return {
    name: `dashboard_${name}`,
    description,
    method,
    path,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    ...extra,
  };
}

export function dashboardTools(actions) {
  return [
    tool('projects', 'List the Briareus projects this connection can manage.', 'GET', '/api/dev/projects'),
    tool('actions', 'List the project dashboard actions.', 'GET', '/api/dev/actions'),
    ...actions.map((a) =>
      tool(
        a.id.replaceAll('-', '_'),
        `${a.label}: ${a.hint}. Starts a paid agent session and may write to GitHub. Use only when requested; returns immediately with the session.`,
        'POST',
        '/api/dev/actions',
        { prNumber: number, ...(a.input ? { input: { ...string, description: a.input.label } } : {}) },
        ['prNumber', ...(a.input?.required ? ['input'] : [])],
        { action: a.id, starts: true },
      ),
    ),
    tool('pulls', 'List this project’s pull requests and issues.', 'GET', '/api/dev/pulls', {
      fresh: { enum: ['0', '1'] },
    }),
    tool(
      'pull',
      'Read a pull request, including checks and reviews.',
      'GET',
      '/api/dev/pull',
      { pr: number },
      ['pr'],
    ),
    tool('branches', 'List project branches.', 'GET', '/api/dev/branches'),
    tool('usage', 'Read project usage and costs.', 'GET', '/api/dev/usage'),
    tool('findings', 'Read findings for a pull request.', 'GET', '/api/pr/findings', { pr: number }, ['pr']),
    tool(
      'finding_decision',
      'Record a decision on a PR finding; may post to GitHub. Only when requested.',
      'POST',
      '/api/pr/findings/decision',
      { pr: number, key: string, decision: { enum: ['fix', 'optional', 'dismissed', null] } },
      ['pr', 'key', 'decision'],
    ),
    tool('sessions', 'List sessions belonging to this project.', 'GET', '/api/dev/sessions'),
    tool(
      'session',
      'Read session status and transcript; since is an event offset.',
      'GET',
      '/api/dev/sessions/:id',
      { ...session, since: { type: 'integer', minimum: 0 } },
      ['sessionId'],
    ),
    tool(
      'start_session',
      'Start a paid project session for an issue or task. Only when requested.',
      'POST',
      '/api/dev/sessions',
      {
        prompt: string,
        branch: string,
        prNumber: number,
        reviewLoop: boolean,
        qaLoop: boolean,
        orchestrator: boolean,
        zeus: boolean,
        local: boolean,
        activity: { enum: ['issue'] },
      },
      ['prompt'],
      { starts: true },
    ),
    tool(
      'review',
      'Start a paid code review on a pull request. Only when requested.',
      'POST',
      '/api/dev/sessions',
      { prNumber: number, branch: string },
      ['prNumber', 'branch'],
      { starts: true, defaults: { review: true } },
    ),
    tool(
      'qa',
      'Start paid QA (test sheet and execution) on a pull request. Only when requested.',
      'POST',
      '/api/dev/sessions',
      { prNumber: number, branch: string },
      ['prNumber', 'branch'],
      { starts: true, defaults: { qa: true } },
    ),
    tool(
      'serve_pull',
      'Prepare and serve a PR workspace using project run commands.',
      'POST',
      '/api/dev/pulls/:number/serve',
      { prNumber: number },
      ['prNumber'],
      { starts: true },
    ),
    tool(
      'message',
      'Send a message to a session; may start a paid turn. Only when requested.',
      'POST',
      '/api/dev/sessions/:id/message',
      { ...session, text: string },
      ['sessionId', 'text'],
    ),
    tool('rename', 'Rename a session.', 'PATCH', '/api/dev/sessions/:id', { ...session, title: string }, [
      'sessionId',
      'title',
    ]),
    tool(
      'link_pr',
      'Link a session to a verified pull request.',
      'POST',
      '/api/dev/sessions/:id/link-pr',
      { ...session, pr: string },
      ['sessionId', 'pr'],
    ),
    tool(
      'drop_message',
      'Remove a queued message.',
      'DELETE',
      '/api/dev/sessions/:id/queue/:index',
      { ...session, index: { type: 'integer', minimum: 0 } },
      ['sessionId', 'index'],
    ),
    tool(
      'review_loop',
      'Enable or disable automatic paid review rounds.',
      'POST',
      '/api/dev/sessions/:id/loop',
      { ...session, on: boolean },
      ['sessionId', 'on'],
    ),
    tool(
      'qa_loop',
      'Enable or disable automatic paid QA.',
      'POST',
      '/api/dev/sessions/:id/qa-loop',
      { ...session, on: boolean },
      ['sessionId', 'on'],
    ),
    tool(
      'complete_findings',
      'Complete findings triage; fix decisions may start paid agents and post to GitHub. Only when requested.',
      'POST',
      '/api/dev/sessions/:id/triage',
      { ...session, verdicts, note: { type: 'string' } },
      ['sessionId'],
    ),
    tool(
      'save_findings',
      'Save findings drafts and post comments to GitHub. Only when requested.',
      'POST',
      '/api/dev/sessions/:id/triage/save',
      { ...session, verdicts, note: { type: 'string' } },
      ['sessionId', 'verdicts'],
    ),
    tool(
      'reply_finding',
      'Reply on a finding’s GitHub thread. Only when requested.',
      'POST',
      '/api/dev/sessions/:id/findings/reply',
      { ...session, key: string, text: string },
      ['sessionId', 'key', 'text'],
    ),
    tool(
      'delete_finding',
      'Permanently delete a finding and its GitHub comment. Only when requested.',
      'POST',
      '/api/dev/sessions/:id/findings/delete',
      { ...session, key: string },
      ['sessionId', 'key'],
    ),
    ...['reopen', 'serve', 'cancel', 'close', 'delete'].map((action) =>
      tool(
        action,
        `${action} a project session${action === 'delete' ? ' and permanently remove its transcript' : ''}. Only when requested.`,
        action === 'delete' ? 'DELETE' : 'POST',
        `/api/dev/sessions/:id${action === 'delete' ? '' : `/${action}`}`,
        session,
        ['sessionId'],
      ),
    ),
  ].map((entry) => {
    const needsRepo =
      !['dashboard_projects', 'dashboard_actions'].includes(entry.name) &&
      !Object.hasOwn(entry.inputSchema.properties, 'sessionId');
    return {
      ...entry,
      inputSchema: {
        ...entry.inputSchema,
        properties: {
          ...(needsRepo
            ? { repo: { ...string, description: 'Repository from dashboard_projects, e.g. owner/repo' } }
            : {}),
          ...entry.inputSchema.properties,
        },
        required: [...(needsRepo ? ['repo'] : []), ...entry.inputSchema.required],
      },
      annotations: {
        readOnlyHint: entry.method === 'GET',
        destructiveHint: entry.method !== 'GET',
        openWorldHint: true,
      },
      securitySchemes: [{ type: 'oauth2', scopes: ['briareus:manage'] }],
    };
  });
}

export function validateArguments(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) throw new Error('Invalid argument value');
  if (!schema.type) return;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) throw new Error(`Missing argument: ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${key}`);
      validateArguments(schema.properties[key], entry);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error('Expected an array');
    for (const entry of value) validateArguments(schema.items, entry);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum) throw new Error('Invalid integer argument');
  } else if (typeof value !== schema.type || (schema.minLength && value.trim().length < schema.minLength)) {
    throw new Error(`Expected ${schema.type} argument`);
  }
}
