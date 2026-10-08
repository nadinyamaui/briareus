// @ts-check
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { loadAppSetting, saveAppSetting } from './db.js';
import { seal, open } from './secretbox.js';

export const SSH_DEFAULTS = {
  label: '',
  repo: '',
  host: '',
  port: 22,
  username: '',
  identityFile: '',
  permissionMode: 'ask',
  enabled: true,
  // The database address as seen from the server, which a client's SSH tunnel forwards
  // to. Its login is sealed separately (dbCredentials); only GET …/db-credentials opens it.
  dbHost: '127.0.0.1',
  dbPort: 3306,
};

export function normalizeSshServer(input, existing = SSH_DEFAULTS) {
  const s = { ...existing };
  for (const key of ['label', 'repo', 'host', 'username', 'identityFile', 'permissionMode']) {
    if (Object.hasOwn(input, key)) s[key] = String(input[key] ?? '').trim();
  }
  if (!isIP(s.host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(s.host))
    throw new Error('Enter a hostname or IP address');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(s.username)) throw new Error('Enter a valid SSH username');
  if (!/^[\w.-]+\/[\w.-]+$/.test(s.repo)) throw new Error('Choose a project');
  if (Object.hasOwn(input, 'port')) s.port = Number(input.port);
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
    throw new Error('Enter a port from 1 to 65535');
  if (!['ask', 'allow'].includes(s.permissionMode)) throw new Error('Choose an SSH permission mode');
  if (Object.hasOwn(input, 'dbHost')) s.dbHost = String(input.dbHost ?? '').trim() || SSH_DEFAULTS.dbHost;
  s.dbHost ??= SSH_DEFAULTS.dbHost;
  if (!isIP(s.dbHost) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(s.dbHost))
    throw new Error('Enter a database hostname or IP address');
  if (Object.hasOwn(input, 'dbPort')) s.dbPort = Number(input.dbPort);
  s.dbPort ??= SSH_DEFAULTS.dbPort;
  if (!Number.isInteger(s.dbPort) || s.dbPort < 1 || s.dbPort > 65535)
    throw new Error('Enter a database port from 1 to 65535');
  if (s.identityFile && (!isAbsolute(s.identityFile) || /[\x00-\x1f%]/.test(s.identityFile))) {
    throw new Error('The private key needs an absolute path without control characters or % tokens');
  }
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be a boolean');
    s.enabled = input.enabled;
  }
  if (!s.label) s.label = `${s.username}@${s.host}:${s.port}`;
  if ([s.host, s.username, s.label, s.identityFile, s.repo, s.dbHost].some((v) => v.length > 1024))
    throw new Error('SSH field too long');
  return s;
}

// The database login arrives as dbUsername/dbPassword and is stored as one sealed blob. A
// body naming one keeps the other, so the user changes without retyping the password; an
// empty username clears the login.
function applyDbLogin(s, input, old = null) {
  const hasUser = Object.hasOwn(input, 'dbUsername');
  const hasPass = Object.hasOwn(input, 'dbPassword');
  if (!hasUser && !hasPass) return s;
  const prev =
    (!hasUser || !hasPass) && old?.dbCredentials
      ? JSON.parse(open(old.dbCredentials))
      : { username: '', password: '' };
  const username = hasUser ? String(input.dbUsername ?? '').trim() : prev.username;
  const password = hasPass ? String(input.dbPassword ?? '') : prev.password;
  if (!username) {
    if (password) throw new Error('A database password needs a database username');
    return { ...s, dbCredentials: '' };
  }
  if (username.length > 1024 || password.length > 1024) throw new Error('Database login too long');
  return { ...s, dbCredentials: seal(JSON.stringify({ username, password })) };
}

// What leaves the service: the sealed login stays behind, its presence does not.
function publicServer({ dbCredentials, ...s }) {
  return { ...s, hasDbCredentials: !!dbCredentials };
}

// No local shell, inherited SSH config, forwarding or interactive prompts.
// Host trust must already be established by the operator in known_hosts.
export function executeSsh(server, command, timeoutSeconds) {
  const args = [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-p',
    String(server.port),
    '-l',
    server.username,
  ];
  if (server.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', server.identityFile);
  args.push('--', server.host, command);
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      args,
      { timeout: timeoutSeconds * 1000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          error: error ? error.message : null,
        }),
    );
    child.stdin?.end();
  });
}

// Requests are intentionally ephemeral: a restart never resumes a remote command.
// Injected dependencies let the approval boundary be exercised without a real SSH server.
export function createSshService({
  load = loadAppSetting,
  save = saveAppSetting,
  execute = executeSsh,
  getJob = (_id) => null,
} = {}) {
  let servers = [];
  let writes = Promise.resolve();
  const requests = new Map();
  const publicRequest = (r) => {
    const { snapshot, ...view } = r;
    return { ...view };
  };
  function active(r) {
    const job = getJob(r.jobId);
    return job && job.status === 'running' && job.repo === r.repo && job.turns === r.turn;
  }
  function sweep() {
    for (const [id, r] of requests) {
      if (r.status === 'pending' && (Date.now() >= r.expiresAt || !active(r))) {
        r.status = 'cancelled';
        r.error = 'Approval expired or the session turn ended';
      }
      if (!['pending', 'running'].includes(r.status) && Date.now() - r.createdAt > 3600000)
        requests.delete(id);
    }
  }
  function mutate(fn) {
    const task = writes.then(async () => {
      const next = fn(servers);
      await save('ssh_servers', next);
      servers = next;
      // Any edit invalidates approvals for the old connection or policy.
      for (const r of requests.values()) {
        if (
          r.status === 'pending' &&
          JSON.stringify(servers.find((s) => s.id === r.serverId)) !== r.snapshot
        ) {
          r.status = 'cancelled';
          r.error = 'SSH server settings changed; submit a new command';
        }
      }
    });
    writes = task.catch(() => {});
    return task;
  }
  async function run(r) {
    // Claim synchronously before awaiting: two browser tabs cannot execute twice.
    r.status = 'running';
    try {
      r.result = await execute(JSON.parse(r.snapshot), r.command, r.timeoutSeconds);
      r.status = r.result.error ? 'failed' : 'completed';
    } catch (e) {
      r.status = 'failed';
      r.error = e.message;
    }
  }
  return {
    async init() {
      servers = (await load('ssh_servers', [])).map((s) => normalizeSshServer(s, s));
    },
    list(repo) {
      return servers.filter((s) => repo === undefined || (s.repo === repo && s.enabled)).map(publicServer);
    },
    async create(input) {
      const s = { ...applyDbLogin(normalizeSshServer(input), input), id: 0 };
      await mutate((rows) => {
        s.id = Math.max(Date.now(), ...rows.map((r) => r.id + 1));
        return [...rows, s];
      });
      return publicServer(s);
    },
    async update(id, input) {
      let updated;
      await mutate((rows) => {
        const old = rows.find((s) => s.id === id);
        if (!old) throw new Error('SSH server not found');
        updated = applyDbLogin(normalizeSshServer(input, old), input, old);
        return rows.map((s) => (s.id === id ? updated : s));
      });
      return publicServer(updated);
    },
    // The opened login, for a client that tunnels to the server's database.
    dbLogin(id) {
      const s = servers.find((s) => s.id === id);
      if (!s) throw Object.assign(new Error('SSH server not found'), { status: 404 });
      if (!s.dbCredentials)
        throw Object.assign(new Error('No database login is stored for this server'), { status: 404 });
      const { username, password } = JSON.parse(open(s.dbCredentials));
      return { host: s.dbHost, port: s.dbPort, username, password };
    },
    async remove(id) {
      await mutate((rows) => {
        if (!rows.some((s) => s.id === id)) throw new Error('SSH server not found');
        return rows.filter((s) => s.id !== id);
      });
    },
    request(job, input) {
      sweep();
      const s = servers.find((s) => s.id === Number(input.serverId) && s.repo === job.repo && s.enabled);
      if (!s) throw new Error('SSH server unavailable for this project');
      if (job.status !== 'running') throw new Error('SSH commands require a running session turn');
      if (
        typeof input.command !== 'string' ||
        !input.command.trim() ||
        input.command.length > 32768 ||
        input.command.includes('\0')
      )
        throw new Error('Enter a command of 1–32768 characters without NUL bytes');
      const timeoutSeconds = input.timeoutSeconds ?? 60;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300)
        throw new Error('Timeout must be 1–300 seconds');
      if (requests.size >= 100) {
        // Bound retained output without imposing an hourly command quota.
        const oldest = [...requests.values()].find((r) => !['pending', 'running'].includes(r.status));
        if (oldest) requests.delete(oldest.id);
        else throw new Error('Too many SSH commands are pending or running; wait for one to finish');
      }
      // A webhook-started turn has nobody watching and outside words set it off, so an
      // allow-mode server asks here too, unless the session's operator waived it.
      const unwatched = !!job.unattendedTurn && !(job.webhook && job.webhook.sshUnattended);
      const r = {
        id: randomUUID(),
        serverId: s.id,
        serverLabel: s.label,
        host: s.host,
        port: s.port,
        username: s.username,
        jobId: job.id,
        sessionTitle: job.title || job.id,
        repo: job.repo,
        turn: job.turns,
        command: input.command,
        timeoutSeconds,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        snapshot: JSON.stringify(s),
        // Said on the approval card, so an allow-mode server asking is no puzzle.
        unattended: !!job.unattendedTurn,
      };
      requests.set(r.id, r);
      if (s.permissionMode === 'allow' && !unwatched) void run(r);
      return publicRequest(r);
    },
    result(job, id) {
      sweep();
      const r = requests.get(id);
      if (!r || r.jobId !== job.id) throw new Error('SSH request not found');
      return publicRequest(r);
    },
    runningCount() {
      return [...requests.values()].filter((r) => r.status === 'running').length;
    },
    pending() {
      sweep();
      return [...requests.values()].filter((r) => r.status === 'pending').map(publicRequest);
    },
    decide(id, decision) {
      sweep();
      if (!['approve', 'deny'].includes(decision)) throw new Error('Choose approve or deny');
      const r = requests.get(id);
      if (!r || r.status !== 'pending') throw new Error('SSH request is no longer awaiting approval');
      if (decision === 'deny') {
        r.status = 'denied';
        r.error = 'The user denied this command';
      } else {
        if (JSON.stringify(servers.find((s) => s.id === r.serverId)) !== r.snapshot)
          throw new Error('SSH server settings changed');
        void run(r);
      }
      return publicRequest(r);
    },
  };
}
