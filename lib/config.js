// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  try {
    return parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Every claude on PATH. WSL inherits the Windows PATH, which puts the host's
// npm shim (/mnt/c/Users/...) ahead of the Linux install, and that shim points
// at JS under a drive letter no Linux node can load. A binary on a mounted
// Windows drive is never the one to run.
function claudeOnPath() {
  try {
    return execFileSync('which', ['-a', 'claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith('/mnt/'));
  } catch {
    return [];
  }
}

function findClaudeBin(envOverride) {
  const candidates = [];
  if (envOverride) candidates.push({ bin: envOverride, source: 'CLAUDE_BIN' });
  for (const f of claudeOnPath()) candidates.push({ bin: f, source: 'PATH' });

  // npm's global prefix is per-user here (~/.npm-global) so the CLI can update
  // itself without sudo; a system-wide install lands under /usr/local instead.
  candidates.push({ bin: path.join(os.homedir(), '.npm-global', 'bin', 'claude'), source: 'npm global' });
  candidates.push({ bin: '/usr/local/bin/claude', source: 'npm global (system)' });
  candidates.push({ bin: path.join(os.homedir(), '.local', 'bin', 'claude'), source: 'native installer' });

  for (const c of candidates) {
    try {
      if (fs.existsSync(c.bin) && fs.statSync(c.bin).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const env = loadEnv();
const claude = findClaudeBin(env.CLAUDE_BIN);

// ---------------------------------------------------------------------------
// what .env must say
// ---------------------------------------------------------------------------
//
// Anything that describes this machine (where the database is, which port to
// listen on, what this install is called from outside, which model to run)
// has no default. A default for one of those is a guess at somebody else's
// setup, and the wrong guess is quiet: the app comes up on the wrong port,
// writes to a database nobody meant, or hands out video links pointing at
// localhost. So a missing key stops the boot with its name in the message
// instead.
//
// What keeps a default is behavior with no machine in it: how long a session
// may idle, how often to poll, how long a login lasts. Those read the same on
// every install, and .env.example documents them for the installs that disagree.

const missing = [];

// Present and not empty.
function req(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) missing.push(key);
  return value;
}

// Present, but legitimately empty: a MySQL user without a password is a real
// answer, "you forgot to say" is not. The key has to be in the file either way.
function reqAllowEmpty(key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) missing.push(key);
  return String(env[key] ?? '');
}

function reqNumber(key) {
  const raw = req(key);
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    missing.push(`${key} (not a number: ${raw})`);
    return 0;
  }
  return n;
}

// The optional R2 video bucket. Configured the moment any of its keys is
// present, and then every key is required: a bucket the app can sign uploads
// for but no public hostname (or the other way around) would mean links on
// pull requests pointing at videos that never arrive, quietly. Absent
// entirely, videos stay served from this install at /videos.
//
// These five, alone in this file, may come from the server's process
// environment instead of .env. The file is readable by every shell command a
// session runs (same user), while the process environment is stripped of R2_*
// before it reaches any job child (jobEnv in lib/jobs.js), so the
// environment is where a write credential can live without every agent being
// able to read it. The container leans on exactly that: its entrypoint
// deliberately leaves R2_* out of the .env it writes.
//
// The environment wins whenever it says something: it is the recommended home
// for these five, and an entry left behind in the file (blank after a move,
// or stale after a rotation) must not shadow what the operator exported.
function r2Config() {
  const read = (k) => String(process.env[k] ?? '').trim() || String(env[k] ?? '').trim();
  const keys = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
  if (!keys.some(read)) return null;
  const reqR2 = (k) => {
    const value = read(k);
    if (!value) missing.push(k);
    return value;
  };
  return {
    endpoint: reqR2('R2_ENDPOINT').replace(/\/+$/, ''),
    accessKeyId: reqR2('R2_ACCESS_KEY_ID'),
    secretAccessKey: reqR2('R2_SECRET_ACCESS_KEY'),
    bucket: reqR2('R2_BUCKET'),
    publicBaseUrl: reqR2('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  };
}

let cached = null;

export function getConfig() {
  if (cached) return cached;
  cached = build();
  if (missing.length) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error(
        `.env is missing ${missing.length === 1 ? 'a setting' : 'settings'}: ${missing.join(', ')}` +
          '\n  every one of them describes this machine, so there is nothing safe to assume:' +
          '\n  copy .env.example over the gaps and fill them in.',
      )
    );
    error.code = 'CONFIG_INCOMPLETE';
    throw error;
  }
  return cached;
}

function build() {
  return {
    port: reqNumber('PORT'),
    // Which interface to listen on. Loopback is the answer on a machine (the
    // README's whole exposure story is a tunnel in front of it, not an open
    // port) so it stays the default. A container is the exception: there the
    // port is inside a network namespace nobody else shares, and binding
    // loopback would hide the app from its own published port.
    bindHost: env.BIND_HOST || '127.0.0.1',
    // Used for the sessions' gh CLI and the branch-PR/CI sync in the sidebar.
    // Nothing this app does with a pull request works without it, so it is not
    // optional: an install with no token is a dashboard that silently shows an
    // empty board.
    githubToken: req('GITHUB_TOKEN'),
    // The app's own login. Off unless both a password hash and a signing secret
    // are set: a machine-local install needs neither, and an app reachable
    // from outside this machine must not be one bad tunnel config away from
    // handing a stranger a shell. `npm run set-password` writes them; the
    // password itself is never stored, only its scrypt hash.
    auth: {
      // Half of what the login asks for. Not a secret, but it is stored in the
      // clear and compared in constant time all the same, so a wrong username
      // and a wrong password are indistinguishable from the outside.
      // Named rather than assumed: `admin` was the default, and a default
      // username is half of a guessed login.
      username: req('AUTH_USERNAME'),
      // The two halves of the login itself. Empty is a real answer here (it is
      // how the login is switched off) so neither is required.
      passwordHash: env.AUTH_PASSWORD_HASH || '',
      secret: env.AUTH_SECRET || '',
      // How long a signed-in browser stays signed in. Behavior, not this
      // machine: it keeps its default.
      sessionDays: Math.max(1, Number(env.AUTH_SESSION_DAYS || 30)),
    },
    // Where session history is stored (the jobs / job_events mirror). Changing
    // these takes effect on server restart. Every one of them is this machine's
    // own answer, so none of them is guessed: the wrong database is a mistake
    // that only shows up as missing history.
    db: {
      host: req('DB_HOST'),
      port: reqNumber('DB_PORT'),
      database: req('DB_DATABASE'),
      user: req('DB_USERNAME'),
      password: reqAllowEmpty('DB_PASSWORD'),
    },
    // Each session can claim a database server of its own, so parallel
    // sessions never share a database. The servers themselves, host, port and
    // credentials per entry, are added on the settings page; a session waits
    // when all of them are claimed. Which projects get one is per project,
    // also on the settings page. Set DB_POOL_ENABLED=false to switch claiming
    // off and share the developer's own server again.
    dbPool: {
      enabled: (env.DB_POOL_ENABLED || 'true').toLowerCase() !== 'false',
      waitTimeoutMin: Number(env.DB_POOL_WAIT_TIMEOUT_MIN || 30),
      pollSeconds: Math.max(1, Number(env.DB_POOL_POLL_SECONDS || 10)),
    },
    claudeBin: claude ? claude.bin : null,
    claudeBinSource: claude ? claude.source : null,
    // Developer sessions. Each one claims a workspace clone and a MySQL
    // instance of its own and holds them while the conversation is open. Which
    // projects can be picked, and everything about how each is prepared, comes
    // from the `projects` table (/settings).
    dev: {
      // The fallback cap only, and only for the projects that claim a database
      // server: a project without one is capped at nothing. With claiming on,
      // the pool decides: one open session per entry, since a session holds its
      // server while it lives (dbpool.sessionCapacity). This applies when the
      // pool is switched off or still empty.
      maxSessions: Number(env.DEV_MAX_SESSIONS || 3),
      timeoutMin: Number(env.DEV_TIMEOUT_MIN || 60),
    },
    reviewLoop: {
      // How many review rounds one armed loop runs before it stops on its own.
      // The last round still reviews (its findings land on the pull request
      // and on the required-fixes checklist) it just does not start another
      // fix turn, so the loop cannot go on reviewing the scaffolding its own
      // fixes introduce. 0 removes the cap and leaves only the stall gate.
      maxRounds: Math.max(0, Number(env.REVIEW_LOOP_MAX_ROUNDS ?? 10)),
      // The round from which low findings stop re-opening the loop. They are
      // still reported and still listed; they just stop costing a fix turn and
      // another review each. 0 never tightens.
      lowFindingsUntilRound: Math.max(0, Number(env.REVIEW_LOOP_LOW_UNTIL_ROUND ?? 1)),
    },
    // Where the other CLIs are, when they are not on PATH. Empty means
    // "look for it the usual way", which is a real answer.
    codexBin: env.CODEX_BIN || '',
    grokBin: env.GROK_BIN || '',
    opencodeBin: env.OPENCODE_BIN || '',
    // What a claude session runs as when nothing else names a model. Model
    // names age out (one hardcoded here would keep being sent months after it
    // was retired) so this install says which one it means.
    claudeModel: req('CLAUDE_MODEL'),
    claudeEffort: req('CLAUDE_EFFORT'),
    // Where session clones live. Relative paths resolve against the app root;
    // `../worktrees` keeps them outside the repo, next to it, so a session never
    // has this app's own tree inside its workspace, and so `git status` here
    // stays clean. An absolute path works too.
    workspaceDir: path.resolve(ROOT, req('WORKSPACE_DIR') || '.'),
    // Where a test run drops its scenario videos. The server serves this
    // directory at /videos, and the links a run leaves on the PR point there,
    // so PUBLIC_BASE_URL is what those links start with (the proxy hostname
    // when the app sits behind one, e.g. https://reviewer.test).
    testVideosDir: path.resolve(ROOT, req('TEST_VIDEOS_DIR') || '.'),
    // What this install is called from outside. Every video link a test run
    // leaves on a pull request starts with it, and both webhook senders are
    // registered against it, so an assumed `http://localhost:<port>` is a
    // whole feature quietly pointing at a machine nobody else can reach.
    publicBaseUrl: req('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    // Where video links live instead, when the install has an R2 bucket:
    // recorded videos are mirrored there after each turn (lib/r2.js) and the
    // links a run leaves on the PR point at the bucket: public, outside the
    // dashboard's login, and alive when this machine is not.
    r2: r2Config(),
  };
}
