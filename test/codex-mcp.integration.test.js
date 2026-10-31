import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { BINARIES } from '../lib/providers.js';
import { codexMcpShellArgs } from '../lib/codex-config.js';

it.each(['provider', 'project'])(
  'forwards current session credentials despite %s literal MCP environment settings',
  async (layer) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-mcp-env-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd);
    execFileSync('git', ['init', '-q', cwd]);
    mkdirSync(join(cwd, '.codex'));
    const received = [];
    let authenticated;
    const requests = new Promise((r) => (authenticated = r));
    const server = createServer((req, res) => {
      received.push({ path: req.url, authorization: req.headers.authorization });
      const ok = req.headers.authorization === 'Bearer current-session-token';
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Invalid session token' }));
      if (received.length === 2) authenticated();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let child, exited, lines, timer;
    try {
      const script = join(root, 'probe.mjs');
      const plumbing = pathToFileURL(resolve('lib/mcp-stdio.js')).href;
      writeFileSync(
        script,
        `import { createApiClient, serveStdio } from ${JSON.stringify(plumbing)};
await createApiClient('/probe', 'Missing session credentials')('GET', '/' + process.argv[2]).catch(() => {});
serveStdio({ name: 'probe', tools: [], runTool: async () => '' });
`,
      );
      const literals = ['reviewer_memory', 'renamed']
        .map((name) => `[mcp_servers.${name}.env]\nREVIEWER_MEMORY_TOKEN="stale-token"\n`)
        .join('');
      writeFileSync(join(root, 'config.toml'), layer === 'provider' ? literals : '');
      writeFileSync(join(cwd, '.codex/config.toml'), layer === 'project' ? literals : '');
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: root,
        REVIEWER_MEMORY_URL: `http://127.0.0.1:${server.address().port}`,
        REVIEWER_MEMORY_TOKEN: 'current-session-token',
      };
      const built = BINARIES.codex.buildArgs({
        model: 'gpt-6.1-sol',
        effort: 'low',
        live: true,
        cwd,
        inheritedEnv: env,
        mcp: ['reviewer_memory', 'renamed'].map((name) => ({
          name,
          command: process.execPath,
          args: [script, name],
          env: {
            REVIEWER_MEMORY_URL: env.REVIEWER_MEMORY_URL,
            REVIEWER_MEMORY_TOKEN: env.REVIEWER_MEMORY_TOKEN,
            ...(name === 'renamed' ? { EXTRA: 'server-only' } : {}),
          },
        })),
      });
      expect(built.args.join(' ')).not.toContain(env.REVIEWER_MEMORY_TOKEN);
      child = spawn(resolve('node_modules/.bin/codex'), built.args, {
        cwd,
        env: { ...env, ...built.env },
        detached: true,
      });
      exited = new Promise((r, reject) => {
        child.once('error', reject);
        child.once('close', r);
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.stdin.on('error', () => {});
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === 0) {
          send({ method: 'initialized', params: {} });
          send({ id: 1, method: 'thread/start', params: { cwd } });
        }
      });
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'probe', version: '1' } } });
      await Promise.race([
        requests,
        exited.then(() => {
          throw new Error(`Codex exited before MCP authentication: ${stderr}`);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP startup timed out: ${stderr}`)), 10000);
        }),
      ]);
      expect(received).toEqual(
        expect.arrayContaining(
          ['reviewer_memory', 'renamed'].map((name) => ({
            path: `/probe/${name}`,
            authorization: 'Bearer current-session-token',
          })),
        ),
      );
    } finally {
      clearTimeout(timer);
      lines?.close();
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          expect(error.code).toBe('ESRCH');
        }
      }
      if (exited) await exited;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

// Real CLI, synthetic environment, local Responses stub: no credentials or paid requests.
it.each(['provider', 'project'])(
  'preserves %s shell exclusions with remote and renamed stdio MCP credentials',
  async (layer) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd);
    execFileSync('git', ['init', '-q', cwd]);
    mkdirSync(join(cwd, '.codex'));
    const outputs = [];
    const server = createServer(async (req, res) => {
      if (!req.url.includes('/responses')) return res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const output = request.input.findLast((v) => v.type === 'function_call_output');
      if (output) outputs.push(output.output);
      const item = output
        ? {
            id: 'msg_done',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'DONE', annotations: [] }],
          }
        : {
            id: 'fc_probe',
            type: 'function_call',
            call_id: 'probe',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: 'printf "PRIVATE=%s MCP_HEADER=%s MCP_STDIO=%s PUBLIC=%s\\n" "${PRIVATE_CREDENTIAL+visible}" "${BRIAREUS_MCP_0_HEADER_0+visible}" "${BRIAREUS_MCP_0_CREDENTIAL+visible}" "${PUBLIC_KEEP+visible}"',
              max_output_tokens: 100,
            }),
          };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('response.created', { response: { id: 'resp_probe', status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id: 'resp_probe',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let child;
    try {
      const policy = '[shell_environment_policy]\nexclude=["PRIVATE_*"]\n';
      writeFileSync(
        join(root, 'config.toml'),
        `model="gpt-6.1-sol"\nmodel_provider="local_test"\n[model_providers.local_test]\nname="Local test"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n` +
          (layer === 'provider' ? policy : '[shell_environment_policy]\nexclude=["PUBLIC_*"]\n'),
      );
      writeFileSync(join(cwd, '.codex/config.toml'), layer === 'project' ? policy : '');
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: root,
        PRIVATE_CREDENTIAL: 'synthetic',
        PUBLIC_KEEP: 'synthetic',
      };
      const bin = resolve('node_modules/.bin/codex');
      for (const transport of ['none', 'remote', 'stdio', 'cli']) {
        const mcp =
          transport === 'remote' || transport === 'cli'
            ? [
                {
                  name: 'probe',
                  url: `http://127.0.0.1:${server.address().port}/mcp`,
                  headers: { Authorization: 'synthetic' },
                },
              ]
            : transport === 'stdio'
              ? [
                  {
                    name: 'probe',
                    command: process.execPath,
                    args: ['-e', 'process.exit(0)'],
                    env: { CREDENTIAL: 'synthetic' },
                  },
                ]
              : [];
        const build = BINARIES.codex.buildArgs({
          model: 'gpt-6.1-sol',
          effort: 'low',
          cwd,
          mcp,
          inheritedEnv: env,
        });
        if (transport === 'cli') {
          build.args.push('-c', 'shell_environment_policy.exclude=["PUBLIC_*"]');
        }
        const args =
          transport === 'none' ? build.args : await codexMcpShellArgs({ bin, args: build.args, cwd, env });
        if (transport !== 'none') {
          expect(args.at(-1)).toBe(
            `shell_environment_policy.exclude=["${transport === 'cli' ? 'PUBLIC_*' : 'PRIVATE_*'}","BRIAREUS_MCP_*"]`,
          );
        }
        child = spawn(bin, args, { cwd, env: { ...env, ...build.env } });
        let stderr = '';
        child.stderr.on('data', (c) => {
          stderr += c;
        });
        child.stdout.resume();
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.stdin.end('Run the shell probe.');
        try {
          const code = await new Promise((r, reject) => {
            child.once('error', reject);
            child.once('close', r);
          });
          expect(code, stderr).toBe(0);
          expect(outputs.at(-1), transport).toContain(
            transport === 'cli'
              ? 'PRIVATE=visible MCP_HEADER= MCP_STDIO= PUBLIC='
              : 'PRIVATE= MCP_HEADER= MCP_STDIO= PUBLIC=visible',
          );
        } finally {
          clearTimeout(timer);
        }
      }
      expect(outputs).toHaveLength(4);
    } finally {
      child?.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    }
  },
  40000,
);
