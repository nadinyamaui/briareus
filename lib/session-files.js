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

// Preserve code verbatim, including arbitrary backtick spans and unclosed fences.
function proseParts(text) {
  const parts = [];
  let start = 0;
  const code = /^(?: {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})[^\n]*|(?: {4}|\t)[^\n]*)(?:\n|$)|`+/gm;
  for (let match; (match = code.exec(text));) {
    let end = code.lastIndex;
    if (match[1]) {
      const fence = match[1];
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*(?:\n|$)`, 'gm');
      closing.lastIndex = end;
      const found = closing.exec(text);
      end = found ? closing.lastIndex : text.length;
    } else if (match[0][0] === '`') {
      const runs = /`+/g;
      runs.lastIndex = end;
      let closing = runs.exec(text);
      while (closing && closing[0].length !== match[0].length) closing = runs.exec(text);
      if (!closing) continue;
      end = runs.lastIndex;
    }
    parts.push(text.slice(start, match.index), text.slice(match.index, end));
    start = end;
    code.lastIndex = end;
  }
  parts.push(text.slice(start));
  return parts;
}

async function readWorkspaceFile(workspace, relative) {
  let directory = await fs.open(
    workspace,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    // Linux descriptor paths pin traversal to opened directories even if names are swapped.
    if ((await fs.readlink(`/proc/self/fd/${directory.fd}`)) !== workspace) return null;
    const components = relative.split(path.sep);
    for (const component of components.slice(0, -1)) {
      const next = await fs.open(
        `/proc/self/fd/${directory.fd}/${component}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
    }
    const handle = await fs.open(
      `/proc/self/fd/${directory.fd}/${components.at(-1)}`,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return null;
      const chunks = [];
      let size = 0;
      while (size <= MAX_SESSION_FILE_BYTES) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_SESSION_FILE_BYTES + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) return Buffer.concat(chunks, size);
        size += bytesRead;
        if (size > MAX_SESSION_FILE_BYTES) return null;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return null;
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
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
  const source = cached ?? event.text;
  const ownsWorkspace = () =>
    job.local || job.orchestrator || (slotOwner(job.workDir) === job.id && slotPrepared(job.workDir, job.id));
  if (!ownsWorkspace()) return { ...event, text: source };
  const parts = proseParts(source);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const matches = [
      ...parts[i].matchAll(
        /(!?\[[^\]\n]*\])\((<[^>\n]+>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/g,
      ),
    ];
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
        const bytes = await readWorkspaceFile(workspace, relative);
        if (bytes === null) continue;
        if (!ownsWorkspace()) continue;
        const published = await publishSessionFile(job, path.basename(file), bytes);
        const replacement = `${match[1].replace(/^!/, '')}(<${published.url}>${match[3] || ''})`;
        parts[i] =
          parts[i].slice(0, match.index) + replacement + parts[i].slice(match.index + match[0].length);
        changed = true;
      } catch {
        // Missing or inaccessible files keep their citation; they never break the transcript.
      }
    }
  }
  if (!changed) return { ...event, text: source };
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
