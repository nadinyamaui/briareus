// @ts-check
import { dashboardTools, validateArguments } from './dashboard-tools.js';
import { reviewerRuntime, stepRuntime } from './projects.js';

// The browser and the remote MCP server invoke the same dashboard handlers.
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
      if (!tool) throw new Error('Unknown dashboard tool');
      validateArguments(tool.inputSchema, args);
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
          throw new Error('Session not found in the permitted projects');
        repo = target.repo;
      }
      const project = repo ? getProject(repo) : null;
      if (name !== 'dashboard_actions' && (!project || !principal.repos.includes(repo)))
        throw new Error('Project not permitted for this connection');
      const handler = handlers.get(`${tool.method} ${tool.path}`);
      if (!handler) throw new Error('Dashboard action unavailable');
      const body = { ...args, ...tool.defaults, repo };
      delete body.sessionId;
      if (tool.action) body.action = tool.action;
      if (tool.starts) {
        const step = { 'test-sheet': 'testSheet', 'test-run': 'testRun' }[tool.action];
        const runtime = (step && stepRuntime(project, step)) || reviewerRuntime(project);
        if (!runtime) throw new Error('Choose a review provider and model in this project’s Settings first');
        Object.assign(body, { provider: runtime.providerId, model: runtime.model, effort: runtime.effort });
      }
      const request = {
        body,
        query: { ...args, repo },
        params: { id: args.sessionId, number: args.prNumber, index: args.index },
        mcpProject: repo,
        mcpActor: `ChatGPT connection ${principal.label}`,
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
      if (status >= 400) throw new Error(result?.error || `Dashboard returned HTTP ${status}`);
      return result;
    },
    register(method, path, handler) {
      handlers.set(`${method.toUpperCase()} ${path}`, handler);
      app[method.toLowerCase()](path, handler);
    },
  };
}
