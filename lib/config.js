// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

// Also parses a checkout's .env for ▶ Run, so it accepts Laravel forms (`export KEY=`,
// spaces around `=`). Trailing ` # comment` is only cut with `inlineComments`: this app's
// own .env treats ` #` as part of an unquoted value (a password, a token).
/**
 * @param {string} text
 * @param {{ inlineComments?: boolean }} [opts]
 */
export function parseEnvFile(text, { inlineComments = false } = {}) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (inlineComments) {
      const quoted = value.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
      value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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

// Every claude on PATH, minus anything on a mounted Windows drive: under WSL the
// host's npm shim (/mnt/c/...) comes first and points at JS no Linux node can load.
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

// The copy of @anthropic-ai/claude-code that package.json pulls in, which
// `npm start` puts first on PATH through node_modules/.bin.
const BUNDLED = /\/node_modules\/\.bin\/claude$/;

function findClaudeBin(envOverride) {
  const candidates = [];
  if (envOverride) candidates.push({ bin: envOverride, source: 'CLAUDE_BIN' });

  // The bundled copy is last resort: it only updates on `npm ci`, and in PATH order it
  // would shadow a `claude update`d install, failing new models with "does not support".
  const bundled = [];
  for (const f of claudeOnPath()) {
    if (BUNDLED.test(f)) bundled.push({ bin: f, source: 'bundled dependency' });
    else candidates.push({ bin: f, source: 'PATH' });
  }

  // Per-user npm prefix lets the CLI self-update without sudo; /usr/local is system-wide.
  candidates.push({ bin: path.join(os.homedir(), '.npm-global', 'bin', 'claude'), source: 'npm global' });
  candidates.push({ bin: '/usr/local/bin/claude', source: 'npm global (system)' });
  candidates.push({ bin: path.join(os.homedir(), '.local', 'bin', 'claude'), source: 'native installer' });
  candidates.push(...bundled);

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
// Keys that describe this machine (database, port, public URL, model) have no
// default: a wrong guess fails quietly, so a missing key stops the boot by name.
// Only machine-neutral behavior (idle timeouts, poll intervals) gets a default.

const missing = [];

// Present and not empty.
function req(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) missing.push(key);
  return value;
}

// Present but may be empty (a MySQL user without a password); the key must exist.
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

// An optional integration's settings, all or nothing: null when none is set, else a
// reader that records each empty key. process.env wins over .env (see R2 below).
// `required` forces the group for one another group depends on.
/**
 * @param {string[]} keys
 * @param {{ required?: boolean }} [opts]
 */
function optionalGroup(keys, { required = false } = {}) {
  const read = (k) => String(process.env[k] ?? '').trim() || String(env[k] ?? '').trim();
  if (!required && !keys.some(read)) return null;
  return (k) => {
    const value = read(k);
    if (!value) missing.push(k);
    return value;
  };
}

// The optional R2 video bucket: any key present makes all required, since a partial
// setup leaves PR links to videos that never arrive. Absent, videos stay local.
//
// These may come from process.env, which childEnv (lib/childenv.js) strips of R2_*,
// whereas .env is readable by every session's shell; the container's entrypoint relies
// on this. The environment wins so a stale or blank .env entry cannot shadow it.
function r2Config() {
  const reqR2 = optionalGroup([
    'R2_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ]);
  if (!reqR2) return null;
  return {
    endpoint: reqR2('R2_ENDPOINT').replace(/\/+$/, ''),
    accessKeyId: reqR2('R2_ACCESS_KEY_ID'),
    secretAccessKey: reqR2('R2_SECRET_ACCESS_KEY'),
    bucket: reqR2('R2_BUCKET'),
    publicBaseUrl: reqR2('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  };
}

// The optional Cloudflare tunnel ▶ Run publishes app ports through, for viewers off
// this machine. All-or-nothing like R2 (a token without Access emails would publish
// unguarded previews), and best kept in process.env since childEnv strips CLOUDFLARE_*.
//
// The optional service token lets a client past Access without the emailed code. Both
// halves or neither, and only with the tunnel; it opens every preview, so childEnv
// strips PREVIEW_ACCESS_CLIENT_* too and only its key names reach an error.
function previewTunnelConfig() {
  const reqToken = optionalGroup(['PREVIEW_ACCESS_CLIENT_ID', 'PREVIEW_ACCESS_CLIENT_SECRET']);
  const reqCf = optionalGroup(
    [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_ZONE_ID',
      'CLOUDFLARE_TUNNEL_ID',
      'PREVIEW_HOSTNAME',
      'PREVIEW_ACCESS_EMAILS',
    ],
    { required: !!reqToken },
  );
  if (!reqCf) return null;
  // One hostname per port (and per tenant), so {port} and any {tenant} must share the
  // first label: Cloudflare's universal certificate only covers one level under the zone.
  const hostname = reqCf('PREVIEW_HOSTNAME').toLowerCase();
  const shape = hostname.includes('{tenant}')
    ? /^[a-z0-9-]*(?:\{tenant\}[a-z0-9-]*\{port\}|\{port\}[a-z0-9-]*\{tenant\})[a-z0-9-]*(?:\.[a-z0-9-]+)*$/
    : /^[a-z0-9.-]*\{port\}[a-z0-9.-]*$/;
  if (hostname && !shape.test(hostname)) {
    missing.push(
      `PREVIEW_HOSTNAME (a hostname with {port} in it, and {tenant} if any beside it in its first label: ${hostname})`,
    );
  }
  const accessEmails = reqCf('PREVIEW_ACCESS_EMAILS')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return {
    apiToken: reqCf('CLOUDFLARE_API_TOKEN'),
    accountId: reqCf('CLOUDFLARE_ACCOUNT_ID'),
    zoneId: reqCf('CLOUDFLARE_ZONE_ID'),
    tunnelId: reqCf('CLOUDFLARE_TUNNEL_ID'),
    hostname,
    accessEmails,
    serviceToken: reqToken
      ? {
          clientId: reqToken('PREVIEW_ACCESS_CLIENT_ID'),
          clientSecret: reqToken('PREVIEW_ACCESS_CLIENT_SECRET'),
        }
      : null,
  };
}

// Optional voice-note transcription via OpenAI, server-side so the key never reaches
// the page. All-or-nothing; the model is named since hardcoded ones get retired. Like
// R2_*, best kept in process.env, which childEnv strips of OPENAI_TRANSCRIBE_*.
function transcribeConfig() {
  const reqKey = optionalGroup(['OPENAI_TRANSCRIBE_API_KEY', 'OPENAI_TRANSCRIBE_MODEL']);
  if (!reqKey) return null;
  return { apiKey: reqKey('OPENAI_TRANSCRIBE_API_KEY'), model: reqKey('OPENAI_TRANSCRIBE_MODEL') };
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
    // Loopback by default since exposure goes through a tunnel; a container overrides
    // it, as loopback there would hide the app from its own published port.
    bindHost: env.BIND_HOST || '127.0.0.1',
    // Sessions' gh CLI and the PR/CI sync. Required: without it the board is silently empty.
    githubToken: req('GITHUB_TOKEN'),
    // Client API signing secret (tokens are HMACs, lib/mobile-auth.js). Empty until
    // `npm run create-token` writes one; changing it revokes every token.
    auth: {
      secret: env.AUTH_SECRET || '',
    },
    // Encrypts stored shared credentials (lib/secretbox.js). Optional, but storing one is
    // refused until set; changing it makes every stored one unreadable.
    credentialsKey: env.CREDENTIALS_KEY || '',
    // Session history (jobs / job_events mirror). Read at server start.
    db: {
      host: req('DB_HOST'),
      port: reqNumber('DB_PORT'),
      database: req('DB_DATABASE'),
      user: req('DB_USERNAME'),
      password: reqAllowEmpty('DB_PASSWORD'),
    },
    // Per-session database servers so parallel sessions never share one; servers and
    // which projects claim them are set in /settings, and a session waits when all are
    // claimed. DB_POOL_ENABLED=false shares the developer's own server instead.
    dbPool: {
      enabled: (env.DB_POOL_ENABLED || 'true').toLowerCase() !== 'false',
      waitTimeoutMin: Number(env.DB_POOL_WAIT_TIMEOUT_MIN || 30),
      pollSeconds: Math.max(1, Number(env.DB_POOL_POLL_SECONDS || 10)),
    },
    claudeBin: claude ? claude.bin : null,
    claudeBinSource: claude ? claude.source : null,
    // Developer sessions; projects and their preparation come from the `projects` table.
    dev: {
      // Fallback cap for database-claiming projects when the pool is off or empty;
      // otherwise the pool's size decides (dbpool.sessionCapacity).
      maxSessions: Number(env.DEV_MAX_SESSIONS || 3),
      timeoutMin: Number(env.DEV_TIMEOUT_MIN || 60),
      // Context size past which auto-compacting sessions get summarized after the turn.
      // 0 disables it for all sessions; an empty key means unset, not 0.
      autoCompactTokens: Math.max(0, Number(env.DEV_AUTO_COMPACT_TOKENS || 250000)),
    },
    reviewLoop: {
      // Review rounds per armed loop. The last round still reviews but starts no fix
      // turn, so the loop cannot keep reviewing its own fixes. 0 leaves only the stall gate.
      maxRounds: Math.max(0, Number(env.REVIEW_LOOP_MAX_ROUNDS ?? 10)),
      // Round from which low findings are still reported but no longer re-open the loop.
      // 0 never tightens.
      lowFindingsUntilRound: Math.max(0, Number(env.REVIEW_LOOP_LOW_UNTIL_ROUND ?? 1)),
    },
    // Other CLIs when not on PATH; empty means look the usual way.
    codexBin: env.CODEX_BIN || '',
    grokBin: env.GROK_BIN || '',
    opencodeBin: env.OPENCODE_BIN || '',
    // The Chromium a session's shared browser runs on (lib/browser.js). Empty
    // looks for Playwright's own download, then PATH.
    browserBin: env.BROWSER_BIN || '',
    // Default model; required because hardcoded model names outlive their retirement.
    claudeModel: req('CLAUDE_MODEL'),
    claudeEffort: req('CLAUDE_EFFORT'),
    // Session clones, relative to the app root. Keep it outside this repo (e.g.
    // `../worktrees`) so a workspace never contains this app and `git status` stays clean.
    workspaceDir: path.resolve(ROOT, req('WORKSPACE_DIR') || '.'),
    // Scenario videos, served at /api/v1/videos; without R2, PR video links point here.
    testVideosDir: path.resolve(ROOT, req('TEST_VIDEOS_DIR') || '.'),
    // This install's external URL: video links and webhook registrations use it.
    publicBaseUrl: req('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    // With R2, videos are mirrored there after each turn (lib/r2.js) and PR links point
    // at the public bucket, alive even when this machine is not.
    r2: r2Config(),
    previewTunnel: previewTunnelConfig(),
    transcribe: transcribeConfig(),
  };
}
