// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import entities from './markdown-entities.json' with { type: 'json' };
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
const eventUpdates = new Map();

async function writeSnapshot(file, bytes) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function publishSessionFile(job, name, bytes, uploadToR2 = true) {
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
  const pendingKey = JSON.stringify([id, uploadToR2]);
  if (pending.has(pendingKey)) return pending.get(pendingKey);
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
      else if (uploadToR2) {
        try {
          await putObject(
            `session-files/${id}/${name}`,
            file,
            bytes.length,
            'application/octet-stream',
            15_000,
            `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(
              /['()*]/g,
              (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
            )}`,
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
  pending.set(pendingKey, run);
  try {
    return await run;
  } finally {
    pending.delete(pendingKey);
  }
}

function codeSpanEnd(text, index) {
  const runs = /`+/g;
  runs.lastIndex = index;
  const opening = runs.exec(text);
  for (let closing; (closing = runs.exec(text));) {
    if (closing[0].length === opening[0].length) return runs.lastIndex;
  }
  return -1;
}

function labelEnd(text, index) {
  let depth = 1;
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') {
      const end = codeSpanEnd(text, i);
      if (end !== -1) i = end - 1;
    } else if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i + 1;
    else if (text[i] === '\n' && /^[ \t]*\n/.test(text.slice(i + 1))) return -1;
  }
  return -1;
}

// Preserve code verbatim while keeping whole link labels and destinations in prose.
function proseParts(text) {
  const parts = [];
  const listLines = new Set();
  const indents = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const prefix = line.match(/^[ \t]*/)[0];
    const indent = [...prefix].reduce((width, char) => width + (char === '\t' ? 4 - (width % 4) : 1), 0);
    if (line.trim()) {
      while (indents.length && indent < indents.at(-1)) indents.pop();
      const marker = line.slice(prefix.length).match(/^(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/);
      if (marker && indent < (indents.at(-1) ?? 0) + 4) indents.push(indent + marker[0].length);
      else if (indents.length && indent < indents.at(-1) + 4) listLines.add(offset);
    }
    offset += line.length + 1;
  }
  let start = 0;
  const code = /^(?: {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})[^\n]*|(?: {4}|\t)[^\n]*)(?:\n|$)|`+|\[/gm;
  for (let match; (match = code.exec(text));) {
    let end = code.lastIndex;
    if (match[0] === '[') {
      if (!escapedAt(text, match.index)) {
        const label = labelEnd(text, match.index);
        if (label !== -1) {
          const destination = inlineDestination.exec(text.slice(label));
          code.lastIndex = label + (destination?.[0].length || 0);
        }
      }
      continue;
    }
    if (match[1]) {
      const fence = match[1];
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*(?:\n|$)`, 'gm');
      closing.lastIndex = end;
      const found = closing.exec(text);
      end = found ? closing.lastIndex : text.length;
    } else if (match[0][0] === '`') {
      if (escapedAt(text, match.index)) continue;
      end = codeSpanEnd(text, match.index);
      if (end === -1) continue;
    } else if (listLines.has(match.index)) {
      code.lastIndex = match.index + match[0].match(/^[ \t]*/)[0].length;
      continue;
    }
    parts.push(text.slice(start, match.index), text.slice(match.index, end));
    start = end;
    code.lastIndex = end;
  }
  parts.push(text.slice(start));
  return parts;
}

// HTML5 names from Python's html.entities.html5; CommonMark requires the semicolon.
function markdownDestination(text) {
  return text.replace(
    /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])|&(#x[\da-f]{1,6}|#\d{1,7}|[a-z][a-z\d]*);/gi,
    (match, escaped, entity) => {
      if (escaped) return escaped;
      if (entity[0] !== '#') return Object.hasOwn(entities, entity) ? entities[entity] : match;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return String.fromCodePoint(
        !code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code,
      );
    },
  );
}

function escapedAt(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
}

const referenceLabel = (label) => label.trim().replace(/\s+/g, ' ').toUpperCase().toLowerCase();
const destinationPattern = String.raw`(<[^>\n]+>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)`;
const titlePattern = String.raw`([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?`;
const linkSpace = String.raw`[ \t]*(?:\n[ \t]*)?`;
const inlineDestination = new RegExp(
  String.raw`^\(${linkSpace}${destinationPattern}${titlePattern}${linkSpace}\)`,
);

function fileLinks(parts) {
  const definitions = new Map();
  const ranges = new Map();
  for (let i = 0; i < parts.length; i += 2) {
    const pattern = new RegExp(
      String.raw`^ {0,3}\[((?:\\.|[^\[\]\\\n]){1,999})\]:[ \t]*(?:\n[ \t]*)?${destinationPattern}${titlePattern}[ \t]*(?=\n|$)`,
      'gm',
    );
    const found = [...parts[i].matchAll(pattern)];
    ranges.set(
      i,
      found.map((match) => [match.index, match.index + match[0].length]),
    );
    for (const match of found) {
      const label = referenceLabel(match[1]);
      if (!definitions.has(label)) definitions.set(label, { target: match[2], title: match[3] || '' });
    }
  }
  const links = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    const scan = (start, limit) => {
      const found = [];
      const pattern = /`+|!?[[]/g;
      pattern.lastIndex = start;
      for (let match; (match = pattern.exec(text)) && match.index < limit;) {
        if (match[0][0] === '`') {
          if (!escapedAt(text, match.index)) {
            const end = codeSpanEnd(text, match.index);
            if (end !== -1) pattern.lastIndex = end;
          }
          continue;
        }
        const bracket = match.index + (match[0][0] === '!' ? 1 : 0);
        if (ranges.get(i).some(([start, end]) => match.index >= start && match.index < end)) continue;
        const end = labelEnd(text, bracket);
        if (end === -1 || end > limit) continue;
        const label = text.slice(match.index, end);
        const inline = inlineDestination.exec(text.slice(end));
        const reference = /^\[((?:\\.|[^\]\\[]){0,999})\]/.exec(text.slice(end));
        if (escapedAt(text, bracket)) {
          pattern.lastIndex = end + (inline?.[0].length || reference?.[0].length || 0);
          continue;
        }
        const inner = scan(bracket + 1, end - 1);
        const definition = inline
          ? null
          : definitions.get(referenceLabel(reference?.[1] || text.slice(bracket + 1, end - 1)));
        pattern.lastIndex = end;
        // An active inner link prevents an enclosing link, even when its destination is external.
        if (
          (!inline && !definition) ||
          (match[0][0] !== '!' && inner.some((link) => !link.label.startsWith('!')))
        ) {
          found.push(...inner);
          continue;
        }
        pattern.lastIndex += inline?.[0].length || reference?.[0].length || 0;
        found.push({
          part: i,
          index: match.index,
          length: pattern.lastIndex - match.index,
          label,
          target: inline?.[1] || definition.target,
          title: inline?.[2] || definition?.title || '',
        });
      }
      return found;
    };
    links.push(...scan(0, text.length));
  }
  return links.sort((a, b) => a.part - b.part || b.index - a.index);
}

function publishableWorkspacePath(relative) {
  return (
    relative &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative
      .split(path.sep)
      .some((part) => part.startsWith('.') || part === 'node_modules' || part === 'vendor')
  );
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
export async function sessionFileEvent(job, event, publication = { uploadToR2: true }) {
  if (event.kind !== 'text' || typeof event.text !== 'string' || !job.workDir) return event;
  if (!event.text.includes('[')) return event;
  const cfg = getConfig();
  const identity = JSON.stringify([job.id, event.seq, event.text]);
  const eventId = crypto.createHash('sha256').update(identity).digest('hex');
  const cachedFile = path.join(root(), '.events', eventId);
  const prior = eventUpdates.get(cachedFile) ?? Promise.resolve();
  const run = prior
    .catch(() => {})
    .then(() => updateSessionFileEvent(job, event, cachedFile, cfg.auth.secret, identity, publication));
  eventUpdates.set(cachedFile, run);
  try {
    return await run;
  } finally {
    if (eventUpdates.get(cachedFile) === run) eventUpdates.delete(cachedFile);
  }
}

async function updateSessionFileEvent(job, event, cachedFile, secret, identity, publication) {
  let cached = await fs.readFile(cachedFile, 'utf8').catch(() => null);
  if (cached === null && secret) {
    // Adopt existing caches while their signing key is still available.
    const legacyId = crypto.createHmac('sha256', secret).update(identity).digest('hex');
    cached = await fs.readFile(path.join(root(), '.events', legacyId), 'utf8').catch(() => null);
    if (cached !== null) await writeSnapshot(cachedFile, cached).catch(() => {});
  }
  const source = cached ?? event.text;
  const ownsWorkspace = () =>
    job.local || job.orchestrator || (slotOwner(job.workDir) === job.id && slotPrepared(job.workDir, job.id));
  if (!secret || !ownsWorkspace()) return { ...event, text: source };
  const parts = proseParts(source);
  const publications = new Map();
  let changed = false;
  for (const link of fileLinks(parts)) {
    const i = link.part;
    let target = link.target.replace(/^<|>$/g, '');
    const tokens = /\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|&(?:#x[\da-f]{1,6}|#\d{1,7}|[a-z][a-z\d]*);|#/gi;
    const fragmentIndex = [...target.matchAll(tokens)].find((match) => match[0] === '#')?.index ?? -1;
    const fragment =
      fragmentIndex === -1
        ? ''
        : markdownDestination(target.slice(fragmentIndex)).replace(
            /[\s\x00-\x1f\x7f<>"`\\&]/gu,
            encodeURIComponent,
          );
    if (fragmentIndex !== -1) target = target.slice(0, fragmentIndex);
    target = markdownDestination(target)
      .split('?')[0]
      .replace(/:\d+(?::\d+)?$/, '');
    if (target.startsWith('//')) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('file://')) continue;
    try {
      target = target.replace(/%(?![\da-f]{2})/gi, '%25');
      target = target.startsWith('file://') ? fileURLToPath(target) : decodeURIComponent(target);
      const workspace = await fs.realpath(job.workDir);
      const requested = path.resolve(workspace, target);
      if (!publishableWorkspacePath(path.relative(workspace, requested))) continue;
      const file = await fs.realpath(requested);
      const relative = path.relative(workspace, file);
      if (!publishableWorkspacePath(relative)) continue;
      const bytes = await readWorkspaceFile(workspace, relative);
      if (bytes === null) continue;
      if (!ownsWorkspace()) continue;
      const name = path.basename(file);
      const publicationKey = JSON.stringify([name, crypto.hash('sha256', bytes)]);
      let published = publications.get(publicationKey);
      if (!published) {
        published = await publishSessionFile(job, name, bytes, publication.uploadToR2);
        publications.set(publicationKey, published);
        // Share the outage budget with the rest of this event or transcript read.
        if (published.url.startsWith(`${getConfig().publicBaseUrl}/files/`)) publication.uploadToR2 = false;
      }
      const replacement = `${link.label.replace(/^!/, '')}(<${published.url}${fragment}>${link.title})`;
      parts[i] = parts[i].slice(0, link.index) + replacement + parts[i].slice(link.index + link.length);
      changed = true;
    } catch {
      // Missing or inaccessible files keep their citation; they never break the transcript.
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
