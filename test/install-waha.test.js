import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('uses saved WAHA image, port and key on first installation and repeat runs', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'briareus-waha-'));
  const installDir = join(scratch, 'install');
  const bin = join(scratch, 'bin');
  const log = join(scratch, 'compose.json');
  const digest = `devlikeapro/waha@sha256:${'a'.repeat(64)}`;
  const server = createServer(async (req, res) => {
    const saved = await readFile(join(installDir, '.env'), 'utf8');
    const key = saved.match(/^WAHA_API_KEY=(.*)$/m)[1];
    res.writeHead(req.headers['x-api-key'] === key ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  try {
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'pull' || args[1] === 'version') process.exit(0);
if (args[0] === 'image') { console.log('${digest}'); process.exit(0); }
if (args[0] !== 'compose' || !args.includes('up')) process.exit(1);
const project = args[args.indexOf('--project-directory') + 1];
const envFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : path.join(project, '.env');
const saved = Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map((line) => {
  const split = line.indexOf('=');
  return [line.slice(0, split), line.slice(split + 1)];
}));
// Compose gives exported variables priority over the selected env file.
const effective = Object.fromEntries(['WAHA_IMAGE', 'WAHA_ENGINE', 'WAHA_PORT', 'WAHA_API_KEY'].map((key) => [key, process.env[key] ?? saved[key]]));
fs.writeFileSync(process.env.WAHA_TEST_LOG, JSON.stringify(effective));
`,
      { mode: 0o700 },
    );
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = String(server.address().port);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WAHA_INSTALL_DIR: installDir,
      WAHA_TEST_LOG: log,
      WAHA_IMAGE: 'custom/waha:latest',
      WAHA_ENGINE: 'NOWEB',
      WAHA_PORT: port,
      WAHA_API_KEY: 'ambient-key',
    };
    const installer = resolve('scripts/install-waha.sh');
    await run('bash', [installer], { env, cwd: scratch });
    const original = await readFile(join(installDir, '.env'), 'utf8');
    const key = original.match(/^WAHA_API_KEY=(.*)$/m)[1];
    expect(key).not.toBe(env.WAHA_API_KEY);
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual({
      WAHA_IMAGE: digest,
      WAHA_ENGINE: 'NOWEB',
      WAHA_PORT: port,
      WAHA_API_KEY: key,
    });
    await run('bash', [installer], {
      env: {
        ...env,
        WAHA_IMAGE: 'other/waha:latest',
        WAHA_ENGINE: 'WEBJS',
        WAHA_PORT: '8303',
        WAHA_API_KEY: 'other-key',
      },
      cwd: scratch,
    });
    expect(await readFile(join(installDir, '.env'), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual({
      WAHA_IMAGE: digest,
      WAHA_ENGINE: 'NOWEB',
      WAHA_PORT: port,
      WAHA_API_KEY: key,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
