// @ts-check
// Mirroring recorded QA videos to an R2 bucket, so the links a test run leaves
// on a pull request outlive this machine and skip the dashboard's login. The
// local videos directory stays the scratch space the run writes into; after
// every turn, whatever is new there is PUT to the bucket at the same relative
// path, which is exactly the URL lib/prtasks.js composed into the prompt.
// Access control is the URL itself: each run's path carries a random 128-bit
// token, so a bucket that cannot be listed gives away nothing.
//
// The client is hand-rolled SigV4 over fetch rather than @aws-sdk/client-s3:
// the app needs exactly one operation (PUT an object), and the SDK would be
// the biggest dependency in the tree for it.

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

// The payload hash SigV4 signs, computed without ever holding the file: a
// long recording read whole would sit in memory for the length of the upload
// and block the event loop while it loads.
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// One signed PUT, streamed from disk. Region is R2's own "auto"; the signed
// header set is the SigV4 minimum (host, payload hash, date); content-type
// travels unsigned, which S3-compatible stores accept. The explicit
// content-length keeps the request un-chunked, which S3-style PUTs require.
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
    // The cast: TypeScript's fetch types know neither `duplex` nor a Node
    // web stream as a body, and both are real here.
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
        // A PUT that stalls must never wedge the sync chain every later
        // turn's uploads queue behind; a timed-out file is retried next
        // sync. The caller sets the bound: its own per-file allowance, or
        // whatever is left of the whole sync's budget, whichever is less.
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${key}: ${res.status} ${text.slice(0, 200)}`.trim());
    }
  } finally {
    // Consumed fully on success; on any other path the open file must not
    // linger as a leaked descriptor.
    stream.destroy();
  }
}

const TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4' };

// What has already been uploaded, kept next to the videos themselves, so a
// sync after every turn is a walk and a few stats, not a re-upload of the
// whole history, and a restart forgets nothing. Size and mtime stand in for
// content: a run copies each video into place once and never edits it.
//
// The manifest remembers uploads into one destination. Point the install at
// another bucket (or another account's endpoint) and its memory is worthless
// (nothing it lists exists over there) so everything counts as new again,
// which is also what brings the historical links back to life when the public
// hostname moved to the new bucket with it.
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

// Only tokenized run directories are mirrored. An install that switches R2 on
// after months of local-only runs still has videos under predictable,
// token-free paths (`<slug>/pr-12/…`), protected by the dashboard login until
// now, and trivially guessable from the pull request itself the moment they
// are published. The 128-bit suffix lib/prtasks.js composes is what makes a
// path safe to make public, so its presence is the filter.
const TOKENED_DIR = /-[0-9a-f]{32}$/;

function safeToPublish(rel) {
  const segments = rel.split('/');
  return segments.length >= 3 && TOKENED_DIR.test(segments[1]);
}

// How long one sync may spend before handing the rest to the next one. The
// per-PUT abort bounds a single stalled upload at five minutes, but a bucket
// that stalls on every connection would still cost that per pending file,
// serially, with every later turn's sync queued behind the pile. What the
// budget leaves undone is reported, stays out of the manifest, and is picked
// up by the next sync.
const SYNC_BUDGET_MS = 10 * 60 * 1000;

// The most one PUT may take, generous for a single video on a slow uplink,
// shrunk to the sync budget's remainder as it runs out, so a file started
// late cannot carry the sync minutes past its advertised bound. Hashing is
// the only work left outside the bound, and that is local disk, not network.
const PUT_TIMEOUT_MS = 5 * 60 * 1000;

// What failed last sync goes to the back of the line this sync: a couple of
// chronically stalling files early in the walk would otherwise eat the whole
// budget every time, starving every video recorded after them, forever.
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
      // A demoted file the budget never reached is still the same stall risk
      // next time; only an actual attempt earns its place back in line.
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

// Turns of different sessions end whenever they end; two syncs interleaved
// would race the manifest and upload the same file twice. One at a time, in
// arrival order, and a failed sync must not jam the queue behind a rejection.
// At most one sync waits, too: every file on disk when a sync starts is that
// sync's to try, so ten turns ending against a stalled bucket share one
// queued retry instead of queueing ten passes over the same stuck files.
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
