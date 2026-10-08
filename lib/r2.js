// @ts-check
// Mirrors recorded QA videos to an R2 bucket so PR links outlive this machine. After
// every turn, new files are PUT at the same relative path, which is the URL
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
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// One signed PUT streamed from disk, region "auto", signing only the SigV4 minimum
// headers. The explicit content-length keeps it un-chunked, as S3 PUTs require.
async function putObject(key, file, size, contentType, timeoutMs) {
  const { r2 } = getConfig();
  if (!r2) throw new Error('R2 is not configured');
  const url = new URL(`${r2.endpoint}/${r2.bucket}/${encodeKey(key)}`);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256File(file);
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
        },
        body: Readable.toWeb(stream),
        // Node's fetch requires this for a streamed request body.
        duplex: 'half',
        // A stalled PUT must not wedge the sync chain; it is retried next sync.
        signal: AbortSignal.timeout(timeoutMs),
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
let backOfLine = new Set();

async function doSync() {
  const cfg = getConfig();
  if (!cfg.r2) return { uploaded: [], failed: [], deferred: 0 };
  const root = cfg.testVideosDir;
  const dest = destKey(cfg.r2);
  const manifest = loadManifest(root, dest);
  const started = Date.now();
  const uploaded = [];
  const failed = [];
  let deferred = 0;
  const fresh = [];
  const retries = [];
  for (const rel of walk(root)) {
    if (!safeToPublish(rel)) continue;
    (backOfLine.has(rel) ? retries : fresh).push(rel);
  }
  const demote = new Set();
  for (const rel of [...fresh, ...retries]) {
    const remaining = SYNC_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      deferred++;
      // Only an actual attempt earns a demoted file its place back.
      if (backOfLine.has(rel)) demote.add(rel);
      continue;
    }
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
      );
      manifest[rel] = { size: st.size, mtimeMs: st.mtimeMs };
      uploaded.push(rel);
    } catch (e) {
      // Stays out of the manifest, so the next turn's sync tries it again.
      failed.push({ file: rel, error: /** @type {Error} */ (e).message });
      demote.add(rel);
    }
  }
  backOfLine = demote;
  if (uploaded.length) {
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ dest, files: manifest }));
  }
  return { uploaded, failed, deferred };
}

// Syncs run one at a time (interleaved ones race the manifest), a rejection must
// not jam the chain, and at most one waits, since a queued sync covers every file
// on disk when it starts.
let chain = Promise.resolve();
let queued = null;

/** @returns {Promise<{uploaded: string[], failed: {file: string, error: string}[], deferred: number}>} */
export function syncVideos() {
  if (queued) return queued;
  const run = chain.then(() => {
    queued = null;
    return doSync();
  });
  queued = run;
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}
