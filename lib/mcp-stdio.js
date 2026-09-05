// @ts-check
//
// The plumbing every stdio MCP server in this repo shares: the dashboard API
// client bound to the session's environment, and the hand-rolled JSON-RPC loop
// over stdin/stdout. The servers themselves (memory-mcp.js, orchestrator-mcp.js)
// keep only what makes them different — their tool list and what each tool does.
// Hand-rolled rather than the MCP SDK: the protocol surface a tools-only server
// needs is four methods, and the app has no runtime dependencies beyond express
// and mysql2 on purpose.

import readline from 'readline';

// An HTTP client for one family of /api/agent routes. The two environment
// variables carry what every agent tool needs: the dashboard's loopback base
// URL and the session's own bearer token. Read at call time so each server
// picks them up at its own import, fresh per process.
export function createApiClient(prefix, notConfiguredMessage) {
  const base = (process.env.REVIEWER_MEMORY_URL || '').replace(/\/+$/, '');
  const token = process.env.REVIEWER_MEMORY_TOKEN || '';
  return async function call(method, path, body) {
    if (!base || !token) throw new Error(notConfiguredMessage);
    const res = await fetch(`${base}${prefix}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
}

// Wire a tools-only MCP server to stdin/stdout. runTool(name, args) returns the
// text of the tool result; whatever it throws becomes an isError tool result,
// which the CLI shows the model instead of dropping the connection.
export function serveStdio({ name, tools, runTool }) {
  function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  async function handle(req) {
    const { id, method, params = {} } = req;
    // Notifications carry no id and expect no reply.
    if (id === undefined) return;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name, version: '1.0.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools };
          break;
        case 'tools/call':
          try {
            result = { content: [{ type: 'text', text: await runTool(params.name, params.arguments) }] };
          } catch (e) {
            result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
          }
          break;
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
          return;
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(req);
  });
  rl.on('close', () => process.exit(0));
}
