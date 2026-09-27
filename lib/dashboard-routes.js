// @ts-check
import { dashboardTools, validateArguments } from './dashboard-tools.js';
import { reviewerRuntime, stepRuntime } from './projects.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

// What start_session may name instead of the project's review runtime. Only
// its schema lists them, so no other operation gets this far carrying one.
const RUNTIME_ARGS = ['providerId', 'model', 'effort'];

// A picked runtime, passed on as named: createDevSession rejects an unknown
// provider or a fully inactive group, and resolves the model and effort
// against the login it balances onto, falling back to that login's defaults.
// null when nothing was picked.
function pickedRuntime(args) {
  if (!RUNTIME_ARGS.some((key) => Object.hasOwn(args, key))) return null;
  if (!Object.hasOwn(args, 'providerId')) throw fail(400, 'A model or effort needs its providerId');
  return { providerId: args.providerId, model: args.model, effort: args.effort };
}

// The browser, mobile API and remote MCP server invoke the same dashboard handlers.
// This registry has no agent-facing HTTP endpoints and accepts no session tokens.
export function dashboardRoutes({ app, getProject, getJob, listActions }) {
  const handlers = new Map();
  const catalog = () => dashboardTools(listActions());
  return {
    tools() {
      return catalog().map(({ name, description, inputSchema, annotations, securitySchemes }) => ({
        name,
        description,
        inputSchema,
        annotations,
        securitySchemes,
      }));
    },
    async call(principal, name, args = {}) {
      const tool = catalog().find((entry) => entry.name === name);
      if (!tool) throw fail(404, 'Unknown dashboard tool');
      try {
        validateArguments(tool.inputSchema, args);
      } catch (e) {
        throw fail(400, e.message);
      }
      if (name === 'dashboard_projects') {
        return {
          projects: principal.repos
            .map((repo) => getProject(repo))
            .filter(Boolean)
            .map(({ repo, label }) => ({ repo, label })),
        };
      }
      let repo = args.repo;
      if (args.sessionId) {
        const target = getJob(args.sessionId);
        if (!target || target.kind !== 'devchat' || !principal.repos.includes(target.repo))
          throw fail(404, 'Session not found in the permitted projects');
        repo = target.repo;
      }
      const project = repo ? getProject(repo) : null;
      if (name !== 'dashboard_actions' && (!project || !principal.repos.includes(repo)))
        throw fail(403, 'Project not permitted for this connection');
      const handler = handlers.get(`${tool.method} ${tool.path}`);
      if (!handler) throw fail(503, 'Dashboard action unavailable');
      const body = { ...args, ...tool.defaults, repo };
      for (const key of ['sessionId', ...RUNTIME_ARGS]) delete body[key];
      if (tool.action) body.action = tool.action;
      if (tool.starts) {
        const step = { 'test-sheet': 'testSheet', 'test-run': 'testRun' }[tool.action];
        const runtime =
          pickedRuntime(args) || (step && stepRuntime(project, step)) || reviewerRuntime(project);
        if (!runtime) throw fail(400, 'Choose a review provider and model in this project’s Settings first');
        Object.assign(body, { provider: runtime.providerId, model: runtime.model, effort: runtime.effort });
      }
      const request = {
        body,
        query: { ...args, ...tool.defaults, repo },
        params: { id: args.sessionId, number: args.prNumber, index: args.index },
        mcpProject: repo,
        mcpActor: principal.actor || `ChatGPT connection ${principal.label}`,
      };
      let status = 200;
      let result;
      const response = {
        status(code) {
          status = code;
          return response;
        },
        json(value) {
          result = value;
          return response;
        },
      };
      await handler(request, response);
      if (status >= 400) throw fail(status, result?.error || `Dashboard returned HTTP ${status}`);
      return result;
    },
    register(method, path, handler) {
      handlers.set(`${method.toUpperCase()} ${path}`, handler);
      app[method.toLowerCase()](path, handler);
    },
  };
}
