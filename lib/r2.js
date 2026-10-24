// @ts-check
// Mirrors recorded QA videos to an R2 bucket so PR links outlive this machine. After
// each owner's turn, its allocated runs are PUT at the same relative path, which is the URL
// lib/prtasks.js composed. Access control is the URL itself: each run's path
// carries a random 128-bit token, and the bucket cannot be listed.
//
// Hand-rolled SigV4 rather than @aws-sdk/client-s3: one PUT does not justify the
// biggest dependency in the tree.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getConfig } from './config.js';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// AWS canonical-URI encoding: RFC 3986 on every path segment, slashes kept.
// encodeURIComponent leaves `!'()*` alone, which the signature must not.
function encodeKey(key) {
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    )
    .join('/');
}

// Streamed so a long recording is never held in memory.
async function sha256File(file, signal) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash, { signal });
  return hash.digest('hex');
}

// One signed PUT streamed from disk, region "auto", signing only the SigV4 minimum
// headers. The explicit content-length keeps it un-chunked, as S3 PUTs require.
export async function putObject(key, file, size, contentType, timeoutMs, disposition = '', signal) {
  const bounded = AbortSignal.timeout(timeoutMs);
  signal = signal ? AbortSignal.any([signal, bounded]) : bounded;
  const { r2 } = getConfig();
  if (!r2) throw new Error('R2 is not configured');
  const url = new URL(`${r2.endpoint}/${r2.bucket}/${encodeKey(key)}`);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256File(file, signal);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    url.pathname,
    '',
    `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const stream = fs.createReadStream(file);
  try {
    // Cast: the fetch types know neither `duplex` nor a Node web stream body.
    const res = await fetch(
      url,
      /** @type {*} */ ({
        method: 'PUT',
        headers: {
          authorization: `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amzDate,
          'content-type': contentType,
          'content-length': String(size),
          ...(disposition ? { 'content-disposition': disposition } : {}),
        },
        body: Readable.toWeb(stream),
        // Node's fetch requires this for a streamed request body.
        duplex: 'half',
        // A stalled PUT must not wedge the sync chain; it is retried next sync.
        signal,
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${key}: ${res.status} ${text.slice(0, 200)}`.trim());
    }
  } finally {
    // Avoid leaking the descriptor on failure paths.
    stream.destroy();
  }
}

const TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4' };

// What has been uploaded, kept beside the videos so syncs skip old files across
// restarts. Size and mtime stand in for content since videos are never edited. It is
// tied to one destination: a new bucket or endpoint makes everything new again.
const MANIFEST = '.r2-manifest.json';

function destKey(r2) {
  return `${r2.endpoint}/${r2.bucket}`;
}

function loadManifest(root, dest) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    return m.dest === dest ? m.files : {};
  } catch {
    return {};
  }
}

// Every file under the videos directory, as bucket keys (relative,
// forward-slashed). Dotfiles are the manifest and friends, never evidence.
function* walk(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), childRel);
    else if (e.isFile()) yield childRel;
  }
}

// Only tokenized run directories are mirrored: older token-free paths
// (`<slug>/pr-12/…`) would be guessable once public.
const TOKENED_DIR = /-[0-9a-f]{32}$/;

function safeToPublish(rel) {
  const segments = rel.split('/');
  return segments.length >= 3 && TOKENED_DIR.test(segments[1]);
}

// One sync's total budget, since a bucket stalling on every file would otherwise
// cost PUT_TIMEOUT_MS per file with later syncs queued behind. Leftovers are
// deferred to the next sync.
const SYNC_BUDGET_MS = 10 * 60 * 1000;

// Per-PUT limit, shrunk to the budget's remainder so a late file cannot overrun it.
const PUT_TIMEOUT_MS = 5 * 60 * 1000;

// Last sync's failures go last, so chronically stalling files cannot starve newer
// videos of the budget.
const backOfLine = new Set();

function pendingVideos(runs) {
  const cfg = getConfig();
  if (!cfg.r2) return [];
  const root = cfg.testVideosDir;
  const manifest = loadManifest(root, destKey(cfg.r2));
  const fresh = [];
  const retries = [];
  for (const run of new Set(runs)) {
    // Runs are allocated with the prompt, before the agent learns the PR number.
    const match = /^([\w.-]+__[\w.-]+)\/pr-<pr-number>-([0-9a-f]{32})$/.exec(run);
    if (!match) continue;
    const [, slug, token] = match;
    const repoDir = path.join(root, slug);
    let dirs;
    try {
      dirs = fs.readdirSync(repoDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !/^pr-\d+-[0-9a-f]{32}$/.test(dir.name) || !dir.name.endsWith(`-${token}`))
        continue;
      for (const rel of walk(path.join(repoDir, dir.name), `${slug}/${dir.name}`)) {
        if (!safeToPublish(rel) || !TYPES[path.extname(rel).toLowerCase()]) continue;
        (backOfLine.has(rel) ? retries : fresh).push(rel);
      }
    }
  }
  return [...fresh, ...retries].filter((rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      const seen = manifest[rel];
      return !seen || seen.size !== st.size || seen.mtimeMs !== st.mtimeMs;
    } catch {
      return false;
    }
  });
}

async function doSync(runs, deadline, signal) {
  const cfg = getConfig();
  if (!cfg.r2) return { uploaded: [], failed: [], deferred: 0 };
  const root = cfg.testVideosDir;
  const dest = destKey(cfg.r2);
  const manifest = loadManifest(root, dest);
  const uploaded = [];
  const failed = [];
  let deferred = 0;
  for (const rel of pendingVideos(runs)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal.aborted) {
      deferred++;
      // Only an actual attempt earns a demoted file its place back.
      continue;
    }
    backOfLine.delete(rel);
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    const seen = manifest[rel];
    if (seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs) continue;
    try {
      const file = path.join(root, rel);
      await putObject(
        rel,
        file,
        st.size,
        TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream',
        Math.min(PUT_TIMEOUT_MS, remaining),
        '',
        signal,
      );
      manifest[rel] = { size: st.size, mtimeMs: st.mtimeMs };
      uploaded.push(rel);
    } catch (e) {
      // Stays out of the manifest, so the next turn's sync tries it again.
      const error = /** @type {Error & { cause?: { code?: unknown } }} */ (e);
      const code = error.cause?.code;
      // Network codes are useful; cause messages can contain hosts or credentials.
      const detail = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (${code})` : '';
      failed.push({ file: rel, error: `${error.message}${detail}` });
      backOfLine.add(rel);
    }
  }
  if (uploaded.length) {
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ dest, files: manifest }));
  }
  return { uploaded, failed, deferred };
}

// Serialize manifest writes, but only coalesce calls for the same allocated runs.
let chain = Promise.resolve();
const queued = new Map();

/**
 * @param {string[]} [runs]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{uploaded: string[], failed: {file: string, error: string}[], deferred: number}>}
 */
export function syncVideos(runs = [], signal) {
  const scopes = [...new Set(runs)].sort();
  if (!scopes.length) return Promise.resolve({ uploaded: [], failed: [], deferred: 0 });
  const key = JSON.stringify(scopes);
  if (!signal && queued.has(key)) return queued.get(key);
  const deadline = Date.now() + SYNC_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_BUDGET_MS);
  const bounded = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve({ uploaded: [], failed: [], deferred: pendingVideos(scopes).length });
    bounded.addEventListener('abort', onAbort, { once: true });
    if (bounded.aborted) onAbort();
  });
  const run = chain.then(() => {
    if (!signal) queued.delete(key);
    return doSync(scopes, deadline, bounded);
  });
  // A queued owner can leave immediately; its eventual pass observes the abort.
  // Keep the actual pass on the chain so manifest writes stay serialized.
  const result = Promise.race([run, aborted]).finally(() => {
    clearTimeout(timer);
    bounded.removeEventListener('abort', onAbort);
  });
  if (!signal) queued.set(key, result);
  chain = run.then(
    () => {},
    () => {},
  );
  return result;
}
