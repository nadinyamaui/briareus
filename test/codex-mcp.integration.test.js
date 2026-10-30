import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BINARIES } from '../lib/providers.js';
import { codexMcpShellArgs } from '../lib/codex-config.js';

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
