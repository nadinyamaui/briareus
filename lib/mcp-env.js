// @ts-check
//
// Starts a stdio MCP server for codex with variables it could only be given by name.
//
//   node mcp-env.js <prefix> <command> [args…]
//
// Codex takes a server's literal env only as a -c override, which puts every token on its
// command line for anyone on the machine to read with ps. Its env_vars passes a variable
// from its own environment instead, but only under the same name, and the server's names
// (SENTRY_ACCESS_TOKEN…) could clash with the session's own. So they travel prefixed and are
// renamed back here, where nothing else sees them.
import { spawn } from 'child_process';

const [prefix, command, ...args] = process.argv.slice(2);
if (!prefix || !command) {
  console.error('Usage: node mcp-env.js <prefix> <command> [args…]');
  process.exit(2);
}

const env = { ...process.env };
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith(prefix)) continue;
  delete env[key];
  env[key.slice(prefix.length)] = value;
}

const child = spawn(command, args, { env, stdio: 'inherit' });
// Codex stops a server by signalling it, which must reach the server itself.
for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP']))
  process.on(signal, () => child.kill(signal));
child.on('error', (e) => {
  console.error(`Could not start ${command}: ${e.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
