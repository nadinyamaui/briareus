// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { getConfig } from './config.js';
import { putObject } from './r2.js';
import { slotOwner, slotPrepared } from './recovery.js';

export const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const nameOf = (name) =>
  String(name || 'file')
    .split(/[\\/]/)
    .pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim() || 'file';

// Kept on the videos volume, outside the workspace pool; video sync skips dot directories.
const root = () => path.join(getConfig().testVideosDir, '.session-files');
const pending = new Map();

async function writeSnapshot(file, bytes) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function publishSessionFile(job, name, bytes) {
  if (!Buffer.isBuffer(bytes)) throw fail(400, 'Send the file as raw bytes');
  if (bytes.length > MAX_SESSION_FILE_BYTES) throw fail(413, 'Session files are limited to 25 MiB');
  name = nameOf(name);
  if (Buffer.byteLength(name) > 180) throw fail(400, 'Invalid file name');
  const cfg = getConfig();
  if (!cfg.auth.secret) throw fail(503, 'Set AUTH_SECRET before publishing files');
  // A stable, unguessable capability per session, filename and content. Replays reuse the snapshot.
  const id = crypto
    .createHmac('sha256', cfg.auth.secret)
    .update(JSON.stringify([job.id, name]))
    .update(bytes)
    .digest('hex');
  if (pending.has(id)) return pending.get(id);
  const run = (async () => {
    const dir = path.join(root(), id);
    const file = path.join(dir, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await fs.stat(file).catch(() => null))) await writeSnapshot(file, bytes);
    let url = `${cfg.publicBaseUrl}/files/${id}/${encodeURIComponent(name)}`;
    if (cfg.r2) {
      const key = `session-files/${id}/${encodeURIComponent(name)}`;
      const remote = `${cfg.r2.publicBaseUrl}/${key}`;
      const marker = path.join(dir, '.r2-url');
      const completion = JSON.stringify([cfg.r2.endpoint, cfg.r2.bucket, remote]);
      const prior = await fs.readFile(marker, 'utf8').catch(() => '');
      if (prior === completion) url = remote;
      else {
        try {
          await putObject(
            `session-files/${id}/${name}`,
            file,
            bytes.length,
            'application/octet-stream',
            15_000,
            `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          );
          await fs.writeFile(marker, completion, { mode: 0o600 });
          url = remote;
        } catch {
          // The durable local copy is downloadable even when R2 is unavailable.
        }
      }
    }
    return { name, size: bytes.length, url };
  })();
  pending.set(id, run);
  try {
    return await run;
  } finally {
    pending.delete(id);
  }
}

// Only assistant links within this session's real workspace are exported automatically.
// Other paths need an explicit byte upload; quoting /etc or another session never exports it.
export async function sessionFileEvent(job, event) {
  if (event.kind !== 'text' || typeof event.text !== 'string' || !job.workDir) return event;
  if (!event.text.includes('](')) return event;
  const cfg = getConfig();
  if (!cfg.auth.secret) return event;
  const eventId = crypto
    .createHmac('sha256', cfg.auth.secret)
    .update(JSON.stringify([job.id, event.seq, event.text]))
    .digest('hex');
  const cachedFile = path.join(root(), '.events', eventId);
  const cached = await fs.readFile(cachedFile, 'utf8').catch(() => null);
  if (cached !== null) return { ...event, text: cached };
  const ownsWorkspace = () =>
    job.local || job.orchestrator || (slotOwner(job.workDir) === job.id && slotPrepared(job.workDir, job.id));
  if (!ownsWorkspace()) return event;
  const parts = event.text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const matches = [...parts[i].matchAll(/(!?\[[^\]\n]*\])\((<[^>\n]+>|[^\s\n]+)\)/g)];
    for (const match of matches.reverse()) {
      let target = match[2].replace(/^<|>$/g, '').replace(/:\d+(?::\d+)?$/, '');
      if (/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('file://')) continue;
      try {
        target = decodeURIComponent(target.replace(/^file:\/\//, ''));
        const workspace = await fs.realpath(job.workDir);
        const file = await fs.realpath(path.resolve(workspace, target));
        const relative = path.relative(workspace, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (
          relative
            .split(path.sep)
            .some((part) => part.startsWith('.') || part === 'node_modules' || part === 'vendor')
        )
          continue;
        const handle = await fs.open(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        let bytes;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) continue;
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (!ownsWorkspace()) continue;
        const published = await publishSessionFile(job, path.basename(file), bytes);
        const replacement = `${match[1].replace(/^!/, '')}(<${published.url}>)`;
        parts[i] =
          parts[i].slice(0, match.index) + replacement + parts[i].slice(match.index + match[0].length);
        changed = true;
      } catch {
        // Missing or inaccessible files keep their citation; they never break the transcript.
      }
    }
  }
  if (!changed) return event;
  const text = parts.join('');
  try {
    await fs.mkdir(path.dirname(cachedFile), { recursive: true, mode: 0o700 });
    await writeSnapshot(cachedFile, text);
  } catch {
    // The download is already durable; a failed cache write must not hide the answer.
  }
  return { ...event, text };
}

export function sessionFileRoutes({ agentSession, getJob }) {
  const router = express.Router();
  const raw = express.raw({ type: () => true, limit: MAX_SESSION_FILE_BYTES });
  const upload = async (req, res, job) => {
    if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
    res.json(await publishSessionFile(job, req.query.name, req.body));
  };
  router.post(
    '/api/agent/files',
    (req, res, next) => {
      const job = agentSession(req, res);
      if (!job) return;
      res.locals.fileSession = job;
      next();
    },
    raw,
    async (req, res) => upload(req, res, res.locals.fileSession),
  );
  router.post('/api/dev/sessions/:id/files', raw, async (req, res) =>
    upload(req, res, getJob(req.params.id)),
  );
  return router;
}

// The URL itself grants download access, like the existing R2 video URLs. Never list files.
export function sessionFileDownloads() {
  const router = express.Router();
  router.get('/files/:id/:name', async (req, res) => {
    const { id, name } = req.params;
    if (!/^[a-f0-9]{64}$/.test(id) || name !== nameOf(name) || name === '.' || name === '..')
      return res.status(404).end();
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream' });
    res.download(path.join(root(), id, name), name, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
  return router;
}
