import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Let the installed CLI resolve system, provider and trusted-project layers with the same
// overrides as the turn. Reading config.toml ourselves would duplicate its precedence rules.
export function codexMcpShellArgs({ bin, args, cwd, env, spawnProcess = spawn, timeoutMs = 10000 }) {
  const overrides = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') overrides.push('-c', args[++i]);
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(bin, ['app-server', ...overrides], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let result;
    let failure;
    let finishing = false;
    let killTimer;
    const finish = (error) => {
      if (finishing) return;
      finishing = true;
      failure = error;
      clearTimeout(timer);
      lines.close();
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const timer = setTimeout(() => finish(new Error('Codex shell policy lookup timed out')), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    // Fail closed without including configuration, stderr or credentials in errors.
    child.stdin.on('error', () => finish(new Error('Codex shell policy lookup failed')));
    child.once('error', () => finish(new Error('Codex shell policy lookup failed')));
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      lines.close();
      if (result && !failure) resolve(result);
      else reject(failure || new Error('Codex stopped before resolving shell policy'));
    });
    lines.on('line', (line) => {
      if (finishing) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error && [0, 1].includes(message.id))
        return finish(new Error('Codex shell policy lookup failed'));
      if (message.id === 0) {
        send({ method: 'initialized', params: {} });
        send({ id: 1, method: 'config/read', params: { cwd, includeLayers: false } });
      } else if (message.id === 1) {
        const config = message.result?.config;
        const exclude = config?.shell_environment_policy?.exclude ?? [];
        if (!config || !Array.isArray(exclude) || exclude.some((v) => typeof v !== 'string'))
          return finish(new Error('Codex returned an invalid shell policy'));
        result = [
          ...args,
          '-c',
          `shell_environment_policy.exclude=${JSON.stringify([...new Set([...exclude, 'BRIAREUS_MCP_*'])])}`,
        ];
        finish();
      }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'briareus', version: '1.0.0' } } });
  });
}
