import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { EventEmitter } from 'node:events';
import {
  sessionFileDownloads,
  sessionFileEvent,
  sessionFileRoutes,
  publishSessionFile,
  MAX_SESSION_FILE_BYTES,
} from '../lib/session-files.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { sessionTranscriptRoutes } from '../lib/transcript-routes.js';
import { securityHeaders } from '../lib/security.js';

const cfg = vi.hoisted(() => ({
  testVideosDir: '',
  publicBaseUrl: '',
  auth: { secret: 'test-only-secret' },
  r2: null,
}));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
let scratch, server, job, bus, log;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'session-files-'));
  cfg.testVideosDir = path.join(scratch, 'videos');
  cfg.r2 = null;
  cfg.auth.secret = 'test-only-secret';
  job = { id: 'session1', kind: 'devchat', repo: 'owner/repo', workDir: path.join(scratch, 'workspace') };
  await fs.mkdir(job.workDir);
  await fs.mkdir(path.join(job.workDir, '.git'));
  await fs.writeFile(path.join(job.workDir, '.git', 'briareus-owner'), job.id);
  bus = new EventEmitter();
  log = [];
  const handlers = express.Router();
  handlers.use(
    sessionFileRoutes({
      getJob: (id) => (id === job.id ? job : null),
      agentSession: (req, res) => {
        if (req.headers.authorization === 'Bearer agent') return job;
        res.status(401).end();
        return null;
      },
    }),
  );
  const transcript = sessionTranscriptRoutes({
    getJob: (id) => (id === job.id ? job : null),
    publicJob: (j) => ({ id: j.id }),
    jobEventsFor: async () => log,
    jobEventsSince: () => log,
    visibleEvents: (_job, events) => events,
    clearDevTranscript: async () => ({}),
    currentEstimates: async () => null,
    jobUsageEstimates: async () => new Map(),
    estimateEventCosts: (events) => events,
    bus,
    presentEvent: sessionFileEvent,
  });
  handlers.get('/api/dev/sessions/:id', transcript.read);
  handlers.get('/api/dev/sessions/:id/events', transcript.stream);
  const auth = {
    authenticate: (header) => {
      if (!['Bearer admin', 'Bearer read', 'Bearer other'].includes(header))
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return {
        id: 'client',
        label: 'test',
        permission: header === 'Bearer admin' ? 'admin' : 'read',
        repos: header === 'Bearer other' ? ['other/repo'] : [job.repo],
      };
    },
    recordUsage: async () => {},
    list: () => [],
  };
  const app = express();
  app.use(securityHeaders);
  app.use(sessionFileDownloads());
  app.use(
    apiV1Routes({
      auth,
      apiEnabled: () => true,
      ownerSecret: () => cfg.auth.secret,
      handlers,
      getJob: (id) => (id === job.id ? job : null),
      getProject: () => null,
      listSessions: () => [],
      bus,
      presentEvent: sessionFileEvent,
    }),
  );
  app.use('/api/agent', (req, res, next) => {
    req.url = `/api/agent${req.url}`;
    handlers(req, res, next);
  });
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cfg.publicBaseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true });
});
const request = (url, options = {}) => fetch(`${cfg.publicBaseUrl}${url}`, options);
const upload = (url, token, body = 'report contents', name = 'decisiones.csv') =>
  request(`${url}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  });

describe('published session files', () => {
  it('uploads through the authenticated agent route and downloads without a client token', async () => {
    expect((await upload('/api/agent/files', 'invalid')).status).toBe(401);
    const response = await upload('/api/agent/files', 'agent');
    expect(response.status).toBe(200);
    const file = await response.json();
    expect(file).toMatchObject({ name: 'decisiones.csv', size: 15 });
    expect(file.url).toMatch(/\/files\/[a-f0-9]{64}\/decisiones.csv$/);
    await fs.rm(job.workDir, { recursive: true });
    const downloaded = await fetch(file.url);
    expect(await downloaded.text()).toBe('report contents');
    expect(downloaded.headers.get('content-disposition')).toContain('attachment');
    expect(downloaded.headers.get('content-type')).toBe('application/octet-stream');
    expect(downloaded.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
    expect((await request('/files/' + '0'.repeat(64) + '/decisiones.csv')).status).toBe(404);
  });

  it('limits client publication to manage permission and the session scope', async () => {
    expect((await upload('/api/v1/sessions/session1/files', 'read')).status).toBe(403);
    expect((await upload('/api/v1/sessions/missing/files', 'admin')).status).toBe(404);
    expect((await upload('/api/v1/sessions/session1/files', 'admin')).status).toBe(200);
    expect(
      (await request('/api/v1/sessions/session1', { headers: { authorization: 'Bearer other' } })).status,
    ).toBe(404);
  });

  it('keeps snapshots separate by session and content, and sanitizes names', async () => {
    const a = await publishSessionFile(job, '../.r2-url', Buffer.from('first'));
    expect(a.name).toBe('r2-url');
    expect(await (await fetch(a.url)).text()).toBe('first');
    expect((await publishSessionFile(job, '../.r2-url', Buffer.from('first'))).url).toBe(a.url);
    const b = await publishSessionFile(job, a.name, Buffer.from('second'));
    expect(b.url).not.toBe(a.url);
    expect((await publishSessionFile({ id: 'different' }, a.name, Buffer.from('first'))).url).not.toBe(a.url);
    expect(await (await fetch(a.url)).text()).toBe('first');
    await expect(
      publishSessionFile(job, 'big', Buffer.alloc(MAX_SESSION_FILE_BYTES + 1)),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('uploads to R2 with download headers and falls back to a working local URL on failure', async () => {
    cfg.r2 = {
      endpoint: 'https://r2.example.com',
      bucket: 'files',
      publicBaseUrl: 'https://cdn.example.com',
      accessKeyId: 'TEST',
      secretAccessKey: 'TEST_SECRET',
    };
    const realFetch = globalThis.fetch;
    const put = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', (url, options) =>
      String(url).startsWith(cfg.r2.endpoint) ? put(url, options) : realFetch(url, options),
    );
    const remote = await publishSessionFile(job, 'report.csv', Buffer.from('report'));
    expect(remote.url).toMatch(/^https:\/\/cdn.example.com\/session-files\/[a-f0-9]{64}\/report.csv$/);
    expect(put.mock.calls[0][1].headers['content-disposition']).toContain('attachment');
    await publishSessionFile(job, 'report.csv', Buffer.from('report'));
    expect(put).toHaveBeenCalledTimes(1);
    cfg.r2.bucket = 'new-files';
    expect((await publishSessionFile(job, 'report.csv', Buffer.from('report'))).url).toBe(remote.url);
    expect(put).toHaveBeenCalledTimes(2);
    expect(String(put.mock.calls[1][0])).toContain('/new-files/');
    cfg.r2.endpoint = 'https://new-r2.example.com';
    expect((await publishSessionFile(job, 'report.csv', Buffer.from('report'))).url).toBe(remote.url);
    expect(put).toHaveBeenCalledTimes(3);
    expect(String(put.mock.calls[2][0])).toContain('https://new-r2.example.com/new-files/');
    await publishSessionFile(job, 'report.csv', Buffer.from('report'));
    expect(put).toHaveBeenCalledTimes(3);
    put.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    const local = await publishSessionFile(job, 'other.csv', Buffer.from('fallback'));
    expect(local.url.startsWith(cfg.publicBaseUrl)).toBe(true);
    expect(await (await fetch(local.url)).text()).toBe('fallback');
  });
});

describe('local links in the transcript', () => {
  it('does not read another session after the workspace slot is reused', async () => {
    await fs.writeFile(path.join(job.workDir, 'other.txt'), 'another session');
    await fs.writeFile(path.join(job.workDir, '.git', 'briareus-owner'), 'other-session');
    const event = { seq: 3, kind: 'text', text: '[Private](other.txt)' };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });
  it('rewrites file citations and space-containing names while preserving code and web links', async () => {
    const file = path.join(job.workDir, 'decision report.csv');
    await fs.writeFile(file, '155 decisions');
    const event = {
      seq: 1,
      kind: 'text',
      text: `[Detalle](<${file}:12>)\n[web](https://example.com)\n\`[code](<${file}>)\`\n\`\`\`md\n[code](<${file}>)\n\`\`\``,
    };
    const rewritten = await sessionFileEvent(job, event);
    expect(rewritten.text).toContain('[Detalle](<http://127.0.0.1:');
    expect(rewritten.text.slice(rewritten.text.indexOf('\n'))).toBe(
      event.text.slice(event.text.indexOf('\n')),
    );
    const url = rewritten.text.match(/\[Detalle\]\(<([^>]+)>\)/)[1];
    expect(await (await fetch(url)).text()).toBe('155 decisions');
    await fs.rm(job.workDir, { recursive: true });
    expect(await sessionFileEvent(job, event)).toEqual(rewritten);
    expect(event.text).toContain(file);
  });

  it('preserves the Markdown destination boundary for filenames containing parentheses', async () => {
    await fs.writeFile(path.join(job.workDir, 'report).csv'), 'parenthesized report');
    const rewritten = await sessionFileEvent(job, {
      seq: 4,
      kind: 'text',
      text: '[Report](<report).csv>)',
    });
    expect(rewritten.text).toMatch(
      /^\[Report\]\(<http:\/\/127\.0\.0\.1:\d+\/files\/[a-f0-9]{64}\/report\)\.csv>\)$/,
    );
    const destination = rewritten.text.slice('[Report](<'.length, -2);
    const downloaded = await fetch(destination);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('parenthesized report');
  });

  it('does not export user messages, hidden config, external paths or escaping symlinks', async () => {
    await fs.writeFile(path.join(scratch, 'secret'), 'outside');
    await fs.writeFile(path.join(job.workDir, '.env'), 'credentials');
    await fs.symlink(path.join(scratch, 'secret'), path.join(job.workDir, 'escape'));
    const event = { seq: 2, kind: 'text', text: `[env](.env) [outside](${scratch}/secret) [escape](escape)` };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await sessionFileEvent(job, { ...event, kind: 'user' })).toEqual({ ...event, kind: 'user' });
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it('returns downloadable links on a transcript read and on both live streams', async () => {
    await fs.writeFile(path.join(job.workDir, 'report.txt'), 'downloaded from chat');
    log = [{ seq: 1, kind: 'text', text: '[Report](report.txt)' }];
    const headers = { authorization: 'Bearer admin' };
    const read = await (await request('/api/v1/sessions/session1', { headers })).json();
    const first = read.events[0].text.match(/\(<([^>]+)>\)/)[1];
    expect(await (await fetch(first)).text()).toBe('downloaded from chat');
    for (const url of ['/api/v1/sessions/session1/events?since=1', '/api/v1/events?transcripts=1']) {
      log = [];
      const controller = new AbortController();
      const opened = request(url, { headers, signal: controller.signal });
      await vi.waitFor(() => expect(bus.listenerCount('event')).toBe(1));
      const live = { seq: 2, kind: 'text', text: '[Report](report.txt)' };
      bus.emit('event', job.id, live);
      const response = await opened;
      const reader = response.body.getReader();
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain(first);
      controller.abort();
      await vi.waitFor(() => expect(bus.listenerCount('event')).toBe(0));
    }
  });
});
