import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import contentDisposition from 'content-disposition';
import crypto from 'node:crypto';
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
  vi.restoreAllMocks();
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

  it.each([
    ['/api/agent/files', 'agent'],
    ['/api/v1/sessions/session1/files', 'admin'],
  ])('publishes and downloads a file larger than 25 MiB through %s', async (route, token) => {
    const bytes = Buffer.alloc(26 * 1024 * 1024, 65);
    const response = await upload(route, token, bytes, 'video.mp4');
    expect(response.status).toBe(200);
    const file = await response.json();
    expect(file.size).toBe(bytes.length);
    const downloaded = Buffer.from(await (await fetch(file.url)).arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);
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

  it.each([
    [' .env', 'env'],
    [' .r2-url', 'r2-url'],
    [' . .env ', 'env'],
    ['\u00a0.\u00a0.env', 'env'],
    [' . ', 'file'],
    [' .. ', 'file'],
    [' report.csv ', 'report.csv'],
  ])('normalizes %j into a stable downloadable name', async (name, expected) => {
    const response = await upload('/api/agent/files', 'agent', 'original bytes', name);
    expect(response.status).toBe(200);
    const file = await response.json();
    expect(file.name).toBe(expected);
    const downloaded = await fetch(file.url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('original bytes');
    expect((await publishSessionFile(job, file.name, Buffer.from('original bytes'))).url).toBe(file.url);
  });

  it('keeps a whitespace-prefixed marker filename separate from R2 completion metadata', async () => {
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
    const remote = await publishSessionFile(job, ' .r2-url', Buffer.from('original bytes'));
    expect(put).toHaveBeenCalledTimes(1);
    cfg.r2 = null;
    vi.unstubAllGlobals();
    const local = await publishSessionFile(job, ' .r2-url', Buffer.from('original bytes'));
    const downloaded = await fetch(local.url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('original bytes');
    expect(remote.name).toBe('r2-url');
  });

  it.each([
    ['ordinary.csv', 'ordinary.csv'],
    ["Bob's report.csv", 'Bob%27s%20report.csv'],
    ['report(1).csv', 'report%281%29.csv'],
    ["résumé! (final)'100%.csv", 'r%C3%A9sum%C3%A9!%20%28final%29%27100%25.csv'],
  ])('uploads a valid extended download filename for %s', async (name, encoded) => {
    cfg.r2 = {
      endpoint: 'https://r2.example.com',
      bucket: 'files',
      publicBaseUrl: 'https://cdn.example.com',
      accessKeyId: 'TEST',
      secretAccessKey: 'TEST_SECRET',
    };
    const put = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', put);
    const remote = await publishSessionFile(job, name, Buffer.from('report'));
    expect(remote.url.startsWith(cfg.r2.publicBaseUrl)).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    const header = put.mock.calls[0][1].headers['content-disposition'];
    expect(header).toBe(`attachment; filename*=UTF-8''${encoded}`);
    expect(contentDisposition.parse(header)).toMatchObject({
      type: 'attachment',
      parameters: { filename: name },
    });
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
  it.each([0, 2, 4])(
    'shares an R2 failure budget across a transcript read after %i successes',
    async (successes) => {
      cfg.r2 = {
        endpoint: 'https://r2.example.com',
        bucket: 'files',
        publicBaseUrl: 'https://cdn.example.com',
        accessKeyId: 'TEST',
        secretAccessKey: 'TEST_SECRET',
      };
      for (let i = 0; i < 4; i++) {
        await fs.writeFile(path.join(job.workDir, `${i}.csv`), `report ${i}`);
        log.push({ seq: i + 1, kind: 'text', text: `[Report ${i}](${i}.csv)` });
      }
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const realFetch = globalThis.fetch;
      let attempts = 0;
      const put = vi.fn(async () => {
        if (attempts++ < successes) return { ok: true };
        started.resolve();
        await release.promise;
        throw new Error('R2 unavailable');
      });
      vi.stubGlobal('fetch', (url, options) =>
        String(url).startsWith(cfg.r2.endpoint) ? put(url, options) : realFetch(url, options),
      );
      let delivered = false;
      const reading = request('/api/v1/sessions/session1', {
        headers: { authorization: 'Bearer read' },
      }).then(async (response) => {
        const body = await response.json();
        delivered = true;
        return body;
      });
      if (successes < 4) {
        await started.promise;
        expect(delivered).toBe(false);
        release.resolve();
      }
      const body = await reading;
      expect(body.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(put).toHaveBeenCalledTimes(Math.min(successes + 1, 4));
      const urls = body.events.map((event) => event.text.match(/\(<([^>]+)>/)[1]);
      expect(urls.filter((url) => url.startsWith(cfg.r2.publicBaseUrl))).toHaveLength(successes);
      for (let i = successes; i < 4; i++) {
        const downloaded = await fetch(urls[i]);
        expect(downloaded.status).toBe(200);
        expect(await downloaded.text()).toBe(`report ${i}`);
      }
      await fs.writeFile(path.join(job.workDir, 'later.csv'), 'later report');
      log.push({ seq: 5, kind: 'text', text: '[Later](later.csv)' });
      put.mockResolvedValue({ ok: true });
      const later = await (
        await request('/api/v1/sessions/session1', {
          headers: { authorization: 'Bearer read' },
        })
      ).json();
      expect(put).toHaveBeenCalledTimes(Math.min(successes + 1, 4) + 1);
      expect(later.events[4].text).toContain('https://cdn.example.com/session-files/');
    },
  );

  it('shares an R2 failure budget for repeated files across transcript events', async () => {
    cfg.r2 = {
      endpoint: 'https://r2.example.com',
      bucket: 'files',
      publicBaseUrl: 'https://cdn.example.com',
      accessKeyId: 'TEST',
      secretAccessKey: 'TEST_SECRET',
    };
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'same report');
    log = [1, 2, 3].map((seq) => ({ seq, kind: 'text', text: '[Report](report.csv)' }));
    const realFetch = globalThis.fetch;
    const put = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });
    vi.stubGlobal('fetch', (url, options) =>
      String(url).startsWith(cfg.r2.endpoint) ? put(url, options) : realFetch(url, options),
    );
    const body = await (
      await request('/api/v1/sessions/session1', {
        headers: { authorization: 'Bearer read' },
      })
    ).json();
    expect(put).toHaveBeenCalledTimes(1);
    expect(body.events).toHaveLength(3);
    for (const event of body.events) {
      const downloaded = await fetch(event.text.match(/\(<([^>]+)>/)[1]);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe('same report');
    }
  });

  it.each([
    ['[See [Report](report.csv)]', '[See [Report](<URL>)]'],
    ['[See [Report](report.csv)](other.csv)', '[See [Report](<URL>)](other.csv)'],
    [
      '[See [Report][ref]](other.csv)\n\n[ref]: report.csv',
      '[See [Report](<URL>)](other.csv)\n\n[ref]: report.csv',
    ],
    ['[See [deep [Report](report.csv)]](other.csv)', '[See [deep [Report](<URL>)]](other.csv)'],
    [
      '['.repeat(32) + '[Report](report.csv)' + ']'.repeat(32),
      '['.repeat(32) + '[Report](<URL>)' + ']'.repeat(32),
    ],
  ])('publishes only the active inner link in %s', async (text, expected) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'active report');
    await fs.writeFile(path.join(job.workDir, 'other.csv'), 'unrelated bytes');
    const rewritten = await sessionFileEvent(job, { seq: 70, kind: 'text', text });
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    expect(rewritten.text).toBe(expected.replace('URL', url));
    const downloaded = await fetch(url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('active report');
    const snapshots = await fs.readdir(path.join(cfg.testVideosDir, '.session-files'));
    expect(snapshots.filter((name) => !name.startsWith('.'))).toHaveLength(1);
  });

  it.each([64, 128, 10_000])(
    'preserves labels nested %i levels without publishing their destinations',
    async (depth) => {
      await fs.writeFile(path.join(job.workDir, 'report.csv'), 'private bytes');
      const text = '['.repeat(depth) + 'x' + ']'.repeat(depth) + '(report.csv)';
      const event = { seq: 74, kind: 'text', text };
      expect(await sessionFileEvent(job, event)).toEqual(event);
      expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
    },
  );

  it('still publishes ordinary links before and after an over-nested label', async () => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'ordinary report');
    const nested = '['.repeat(128) + '[Report](report.csv)' + ']'.repeat(128) + '(report.csv)';
    const text = `[Before](report.csv) ${nested} [After](report.csv)`;
    const rewritten = await sessionFileEvent(job, { seq: 75, kind: 'text', text });
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    expect(rewritten.text).toBe(`[Before](<${url}>) ${nested} [After](<${url}>)`);
    expect(await (await fetch(url)).text()).toBe('ordinary report');
  });

  it('reads and replays deeply nested assistant text without interrupting later events', async () => {
    log = [
      { seq: 1, kind: 'text', text: '['.repeat(10_000) + 'x' + ']'.repeat(10_000) },
      { seq: 2, kind: 'text', text: 'following event' },
    ];
    const headers = { authorization: 'Bearer read' };
    const response = await request('/api/v1/sessions/session1', { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).events).toEqual(log);
    const controller = new AbortController();
    try {
      const replay = await request('/api/v1/sessions/session1/events', {
        headers,
        signal: controller.signal,
      });
      const reader = replay.body.getReader();
      let frames = '';
      while (!frames.includes('"seq":2')) {
        frames += new TextDecoder().decode((await reader.read()).value);
      }
      expect(
        frames
          .split('\n\n')
          .filter(Boolean)
          .map((frame) => JSON.parse(frame.split('\ndata: ')[1])),
      ).toEqual(log);
    } finally {
      controller.abort();
    }
  });

  it.each([
    '[See `[Report](other.csv)`](report.csv)',
    '[See \\[Report\\](other.csv)](report.csv)',
    '[See ![Preview](other.csv)](report.csv)',
  ])('keeps the outer link active when its inner brackets are not links in %s', async (text) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'outer report');
    await fs.writeFile(path.join(job.workDir, 'other.csv'), 'inner bytes');
    const rewritten = await sessionFileEvent(job, { seq: 73, kind: 'text', text });
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    expect(rewritten.text).toBe(text.slice(0, text.lastIndexOf('](')) + `](<${url}>)`);
    const downloaded = await fetch(url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('outer report');
  });

  it('does not publish an outer destination enclosing an active external link', async () => {
    await fs.writeFile(path.join(job.workDir, 'other.csv'), 'unrelated bytes');
    const event = { seq: 71, kind: 'text', text: '[See [Report](https://example.com)](other.csv)' };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it.each(['//', '&#47;&#47;'])('does not publish a network-path URL starting with %s', async (prefix) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'private bytes');
    const event = {
      seq: 72,
      kind: 'text',
      text: `[Report](${prefix}${path.join(job.workDir, 'report.csv').slice(1)})`,
    };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it.each([0, 2, 10])(
    'stops R2 attempts after failure following %i successful uploads',
    async (successes) => {
      cfg.r2 = {
        endpoint: 'https://r2.example.com',
        bucket: 'files',
        publicBaseUrl: 'https://cdn.example.com',
        accessKeyId: 'TEST',
        secretAccessKey: 'TEST_SECRET',
      };
      for (let i = 0; i < 10; i++) await fs.writeFile(path.join(job.workDir, `${i}.csv`), `report ${i}`);
      const realFetch = globalThis.fetch;
      let attempts = 0;
      const put = vi.fn(async () => {
        if (attempts++ >= successes) throw new Error('R2 unavailable');
        return { ok: true };
      });
      vi.stubGlobal('fetch', (url, options) =>
        String(url).startsWith(cfg.r2.endpoint) ? put(url, options) : realFetch(url, options),
      );
      const event = {
        seq: 50,
        kind: 'text',
        text: Array.from({ length: 10 }, (_, i) => `[Report ${i}](${i}.csv)`).join(' '),
      };
      const rewritten = await sessionFileEvent(job, event);
      const urls = [...rewritten.text.matchAll(/\(<([^>]+)>/g)].map((match) => match[1]);
      expect(urls).toHaveLength(10);
      expect(put).toHaveBeenCalledTimes(Math.min(successes + 1, 10));
      expect(urls.filter((url) => url.startsWith(cfg.r2.publicBaseUrl))).toHaveLength(successes);
      for (let i = 0; i < 10; i++) {
        if (urls[i].startsWith(cfg.publicBaseUrl))
          expect(await (await fetch(urls[i])).text()).toBe(`report ${i}`);
      }
      if (successes < 10) {
        await sessionFileEvent(job, { ...event, seq: 51 });
        expect(put).toHaveBeenCalledTimes(successes + 2);
        put.mockResolvedValue({ ok: true });
        const remote = await publishSessionFile(job, '0.csv', Buffer.from('report 0'));
        expect(remote.url.startsWith(cfg.r2.publicBaseUrl)).toBe(true);
        expect(put).toHaveBeenCalledTimes(successes + 3);
      }
      await fs.rm(job.workDir, { recursive: true });
      expect(await sessionFileEvent(job, event)).toEqual(rewritten);
    },
  );

  it.each(['/api/v1/sessions/session1/events?since=1', '/api/v1/events?transcripts=1'])(
    'delivers ten local fallbacks and following text in order after one stalled PUT on %s',
    async (url) => {
      cfg.r2 = {
        endpoint: 'https://r2.example.com',
        bucket: 'files',
        publicBaseUrl: 'https://cdn.example.com',
        accessKeyId: 'TEST',
        secretAccessKey: 'TEST_SECRET',
      };
      for (let i = 0; i < 10; i++) await fs.writeFile(path.join(job.workDir, `${i}.csv`), `report ${i}`);
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const realFetch = globalThis.fetch;
      const put = vi.fn(async () => {
        started.resolve();
        await release.promise;
        throw new Error('R2 timeout');
      });
      vi.stubGlobal('fetch', (target, options) =>
        String(target).startsWith(cfg.r2.endpoint) ? put(target, options) : realFetch(target, options),
      );
      const controller = new AbortController();
      const opened = request(url, { headers: { authorization: 'Bearer admin' }, signal: controller.signal });
      const first = {
        seq: 50,
        kind: 'text',
        text: Array.from({ length: 10 }, (_, i) => `[Report ${i}](${i}.csv)`).join(' '),
      };
      const next = { seq: 51, kind: 'text', text: 'Finished' };
      try {
        await vi.waitFor(() => expect(bus.listenerCount('event')).toBe(1));
        bus.emit('event', job.id, first);
        await started.promise;
        bus.emit('event', job.id, next);
        release.resolve();
        const reader = (await opened).body.getReader();
        let frames = '';
        while (frames.split('data: ').length < 3) {
          frames += new TextDecoder().decode((await reader.read()).value);
        }
        const events = [...frames.matchAll(/^data: (.+)$/gm)].map((match) => {
          const payload = JSON.parse(match[1]);
          return payload.event ?? payload;
        });
        expect(events.map((event) => event.seq)).toEqual([50, 51]);
        expect(events[1]).toEqual(next);
        expect(put).toHaveBeenCalledTimes(1);
        const urls = [...events[0].text.matchAll(/\(<([^>]+)>/g)].map((match) => match[1]);
        expect(urls).toHaveLength(10);
        await fs.rm(job.workDir, { recursive: true });
        for (let i = 0; i < 10; i++) expect(await (await fetch(urls[i])).text()).toBe(`report ${i}`);
      } finally {
        release.resolve();
        controller.abort();
        await opened.catch(() => {});
        await vi.waitFor(() => expect(bus.listenerCount('event')).toBe(0));
      }
    },
  );

  it('reuses fallback publications within an event and retries on later requests', async () => {
    cfg.r2 = {
      endpoint: 'https://r2.example.com',
      bucket: 'files',
      publicBaseUrl: 'https://cdn.example.com',
      accessKeyId: 'TEST',
      secretAccessKey: 'TEST_SECRET',
    };
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'fallback report');
    const realFetch = globalThis.fetch;
    const put = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }));
    vi.stubGlobal('fetch', (url, options) =>
      String(url).startsWith(cfg.r2.endpoint) ? put(url, options) : realFetch(url, options),
    );
    const event = {
      seq: 40,
      kind: 'text',
      text: Array.from({ length: 10 }, (_, i) => `[Report ${i}](report.csv#section${i})`).join(' '),
    };
    const rewritten = await sessionFileEvent(job, event);
    const urls = [...rewritten.text.matchAll(/\(<([^>]+)>/g)].map((match) => match[1]);
    expect(urls).toHaveLength(10);
    expect(new Set(urls.map((url) => url.split('#')[0])).size).toBe(1);
    expect(urls.map((url) => new URL(url).hash)).toEqual(
      Array.from({ length: 10 }, (_, i) => `#section${i}`),
    );
    expect(await (await fetch(urls[0])).text()).toBe('fallback report');
    expect(put).toHaveBeenCalledTimes(1);

    await sessionFileEvent(job, { ...event, seq: 41 });
    expect(put).toHaveBeenCalledTimes(2);
    put.mockResolvedValue({ ok: true });
    const remote = await publishSessionFile(job, 'report.csv', Buffer.from('fallback report'));
    expect(remote.url).toMatch(/^https:\/\/cdn.example.com\/session-files\//);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['report.csv#&#62;', '#%3E'],
    ['<report.csv#a&gt;b>', '#a%3Eb'],
    ['report.csv#&#10;', '#%0A'],
    ['report.csv#&#13;&#9;', '#%0D%09'],
    ['report.csv#&lt;&quot;&#92;&#96;', '#%3C%22%5C%60'],
    ['report.csv#&amp;gt;', '#%26gt;'],
    ['report.csv#section%202/%3e', '#section%202/%3e'],
    ['report.csv#details', '#details'],
  ])('serializes decoded fragments safely in %s', async (destination, fragment) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'fragment report');
    const rewritten = await sessionFileEvent(job, {
      seq: 42,
      kind: 'text',
      text: `[Report](${destination})`,
    });
    const url = rewritten.text.match(/^\[Report\]\(<([^>\s]+)>\)$/)?.[1];
    expect(url).toBeDefined();
    expect(url.endsWith(`/report.csv${fragment}`)).toBe(true);
    expect(await (await fetch(url)).text()).toBe('fragment report');
  });

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

  it.each(['', 'localhost'])(
    'publishes local file URLs with authority "%s" and encoded filenames',
    async (authority) => {
      const file = path.join(job.workDir, 'decision #report.csv');
      await fs.writeFile(file, 'local file report');
      const target = pathToFileURL(file).href.replace('file://', `file://${authority}`);
      const rewritten = await sessionFileEvent(job, {
        seq: 27,
        kind: 'text',
        text: `[Report](${target}#details)`,
      });
      expect(rewritten.text).toMatch(
        /^\[Report\]\(<http:\/\/127\.0\.0\.1:\d+\/files\/[a-f0-9]{64}\/decision%20%23report\.csv#details>\)$/,
      );
      const downloaded = await fetch(rewritten.text.slice('[Report](<'.length, -2));
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe('local file report');
    },
  );

  it('rejects nonlocal file authorities and excluded or external localhost paths', async () => {
    const visible = path.join(job.workDir, 'report.csv');
    const hidden = path.join(job.workDir, '.env');
    const external = path.join(scratch, 'outside.csv');
    for (const file of [visible, hidden, external]) await fs.writeFile(file, 'private bytes');
    const localUrl = (file) => pathToFileURL(file).href.replace('file://', 'file://localhost');
    const remote = pathToFileURL(visible).href.replace('file://', 'file://remote.example');
    const mistakenPath = path.join(job.workDir, 'remote.example', visible);
    await fs.mkdir(path.dirname(mistakenPath), { recursive: true });
    await fs.writeFile(mistakenPath, 'must not publish');
    for (const target of [remote, localUrl(hidden), localUrl(external)]) {
      const event = { seq: 28, kind: 'text', text: `[Report](${target})` };
      expect(await sessionFileEvent(job, event)).toEqual(event);
    }
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
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

  it.each([
    ['report(1).csv', String.raw`report\(1\).csv`],
    ['report(1).csv', String.raw`<report\(1\).csv>`],
    ['report!_#.csv', String.raw`report\!\_\#.csv`],
    ['report(1).csv', String.raw`report\%281\%29.csv`],
    [String.raw`report\q.csv`, String.raw`report\q.csv`],
  ])('unescapes Markdown punctuation in destination %s spelled %s', async (name, destination) => {
    await fs.writeFile(path.join(job.workDir, name), 'escaped report');
    const rewritten = await sessionFileEvent(job, {
      seq: 15,
      kind: 'text',
      text: `[Report](${destination} "Title")`,
    });
    expect(rewritten.text).toMatch(/^\[Report\]\(<http:\/\/127\.0\.0\.1:\d+\/files\/[^>]+> "Title"\)$/);
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    expect(await (await fetch(url)).text()).toBe('escaped report');
  });

  it.each([
    ['a&b.csv', 'a&amp;b.csv'],
    ['a&b.csv', 'a&#38;b.csv'],
    ['a&b.csv', 'a&#x26;b.csv'],
    ['a©b.csv', 'a&copy;b.csv'],
    ['a≂̸b.csv', 'a&NotEqualTilde;b.csv'],
    ['a&b.csv', 'a&#37;26b.csv'],
    ['a&amp;b.csv', String.raw`a\&amp;b.csv`],
    ['a&amp;b.csv', 'a&amp;amp;b.csv'],
    ['a&amp;b.csv', 'a%26amp;b.csv'],
    [String.raw`a\!b.csv`, 'a&#92;!b.csv'],
    ['a&unknown;b.csv', 'a&unknown;b.csv'],
    ['a&ampb.csv', 'a&ampb.csv'],
    ['a�b.csv', 'a&#0;b.csv'],
    ['a�b.csv', 'a&#xD800;b.csv'],
    ['a�b.csv', 'a&#x110000;b.csv'],
  ])('resolves Markdown destination %s spelled %s without double decoding', async (name, destination) => {
    await fs.writeFile(path.join(job.workDir, name), 'entity report');
    const rewritten = await sessionFileEvent(job, {
      seq: 16,
      kind: 'text',
      text: `[Report](${destination})`,
    });
    const url = rewritten.text.match(/\(<([^>]+)>\)/)?.[1];
    expect(url).toBeDefined();
    expect(await (await fetch(url)).text()).toBe('entity report');
  });

  it.each([1, 3, 5])('preserves a bracket escaped by %i backslashes without publication', async (count) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'private example');
    const event = { seq: 17, kind: 'text', text: '\\'.repeat(count) + '[example](report.csv)' };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it.each([0, 2, 4])('publishes a bracket preceded by %i backslashes', async (count) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'actual link');
    const prefix = '\\'.repeat(count);
    const rewritten = await sessionFileEvent(job, {
      seq: 18,
      kind: 'text',
      text: prefix + '[Report](report.csv)',
    });
    expect(rewritten.text.startsWith(prefix + '[Report](<')).toBe(true);
    expect(await (await fetch(rewritten.text.match(/\(<([^>]+)>\)/)[1])).text()).toBe('actual link');
  });

  it.each([
    ['[Report][ref]', '[ref]: report.csv'],
    ['[Report][]', '[report]: report.csv'],
    ['[Report]', '[REPORT]: report.csv'],
    ['![Report][ref]', '[ref]: report.csv'],
    ['[Report][  The   REF ]', '[the ref]: report.csv'],
    ['[Report][ref]', '[ref]:\n  <report.csv> "Title"'],
    ['[Report][ref]', '[ref]: report.csv\n[REF]: missing.csv'],
    ['[Report][ref]', '[ref]: report.csv\n\n`[code][ref]`'],
  ])('converts reference link %s using %s', async (link, definition) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'reference report');
    const event = { seq: 19, kind: 'text', text: `${link}\n\n${definition}` };
    const rewritten = await sessionFileEvent(job, event);
    expect(rewritten.text.startsWith('[Report](<')).toBe(true);
    expect(rewritten.text.slice(rewritten.text.indexOf('\n'))).toBe('\n\n' + definition);
    expect(await (await fetch(rewritten.text.match(/\(<([^>]+)>/)[1])).text()).toBe('reference report');
    await fs.rm(job.workDir, { recursive: true });
    expect(await sessionFileEvent(job, event)).toEqual(rewritten);
  });

  it('keeps escaped references and code-only definitions from publishing files', async () => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'private example');
    for (const text of [
      String.raw`\[Report][ref]` + '\n\n[ref]: report.csv',
      '[Report][ref]\n\n```md\n[ref]: report.csv\n```',
      '[missing]\n\n[ref]: report.csv',
    ]) {
      const event = { seq: 20, kind: 'text', text };
      expect(await sessionFileEvent(job, event)).toEqual(event);
    }
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it('decodes reference destinations and applies workspace containment', async () => {
    await fs.writeFile(path.join(job.workDir, 'a&b.csv'), 'reference entity');
    await fs.writeFile(path.join(job.workDir, '.env'), 'private');
    const event = {
      seq: 21,
      kind: 'text',
      text: '[Report][ref] [private][secret]\n\n[ref]: a&amp;b.csv\n[secret]: &#46;env',
    };
    const rewritten = await sessionFileEvent(job, event);
    expect(await (await fetch(rewritten.text.match(/\(<([^>]+)>/)[1])).text()).toBe('reference entity');
    expect(rewritten.text).toContain('[private][secret]');
  });

  it('retains cached downloads through secret rotation, module reload and workspace removal', async () => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'original snapshot');
    const event = { seq: 22, kind: 'text', text: '[Report](report.csv)' };
    const rewritten = await sessionFileEvent(job, event);
    await fs.rm(job.workDir, { recursive: true });
    cfg.auth.secret = 'rotated-secret';
    vi.resetModules();
    const reloaded = await import('../lib/session-files.js');
    expect(await reloaded.sessionFileEvent(job, event)).toEqual(rewritten);
    expect(await (await fetch(rewritten.text.match(/\(<([^>]+)>/)[1])).text()).toBe('original snapshot');
    cfg.auth.secret = '';
    expect(await reloaded.sessionFileEvent(job, event)).toEqual(rewritten);
  });

  it('adopts legacy keyed caches before rotation even when the workspace is gone', async () => {
    const event = { seq: 23, kind: 'text', text: '[Report](report.csv)' };
    const file = await publishSessionFile(job, 'report.csv', Buffer.from('legacy snapshot'));
    const text = `[Report](<${file.url}>)`;
    const legacyId = crypto
      .createHmac('sha256', cfg.auth.secret)
      .update(JSON.stringify([job.id, event.seq, event.text]))
      .digest('hex');
    const dir = path.join(cfg.testVideosDir, '.session-files', '.events');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, legacyId), text);
    await fs.rm(job.workDir, { recursive: true });
    expect(await sessionFileEvent(job, event)).toEqual({ ...event, text });
    await fs.rm(path.join(dir, legacyId));
    cfg.auth.secret = 'rotated-secret';
    expect(await sessionFileEvent(job, event)).toEqual({ ...event, text });
    expect(await (await fetch(file.url)).text()).toBe('legacy snapshot');
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

  it.each(['.env', '.hidden/config.txt', 'node_modules/config.txt', 'vendor/config.txt'])(
    'does not publish excluded source symlink %s pointing to a visible workspace file',
    async (source) => {
      const file = path.join(job.workDir, 'private-config.txt');
      const alias = path.join(job.workDir, source);
      await fs.writeFile(file, 'private bytes');
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(file, alias);
      for (const target of [source, encodeURIComponent(source), alias, `file://${alias}`]) {
        const event = { seq: 24, kind: 'text', text: `[Configuration](<${target}>)` };
        expect(await sessionFileEvent(job, event)).toEqual(event);
      }
      expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
    },
  );

  it.each(['.env', '.hidden/config.txt', 'node_modules/config.txt', 'vendor/config.txt'])(
    'does not publish a visible symlink pointing to excluded target %s',
    async (target) => {
      const file = path.join(job.workDir, target);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'private bytes');
      await fs.symlink(file, path.join(job.workDir, 'config.txt'));
      const event = { seq: 25, kind: 'text', text: '[Configuration](config.txt)' };
      expect(await sessionFileEvent(job, event)).toEqual(event);
      expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
    },
  );

  it('publishes visible inward symlinks through normalized workspace paths', async () => {
    const file = path.join(job.workDir, 'report.csv');
    await fs.writeFile(file, 'visible report');
    await fs.symlink(file, path.join(job.workDir, 'download.csv'));
    for (const target of ['./download.csv', 'output/../download.csv']) {
      const rewritten = await sessionFileEvent(job, {
        seq: 26,
        kind: 'text',
        text: `[Report](${target})`,
      });
      const url = rewritten.text.match(/\(<([^>]+)>\)/)[1];
      expect(await (await fetch(url)).text()).toBe('visible report');
    }
  });

  it('rejects an ancestor swapped for a symlink immediately before opening', async () => {
    const output = path.join(job.workDir, 'output');
    const outside = path.join(scratch, 'other-session');
    await fs.mkdir(output);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(output, 'report.csv'), 'safe');
    await fs.writeFile(path.join(outside, 'report.csv'), 'other session secret');
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
      if (!swapped) {
        swapped = true;
        await fs.rename(output, `${output}-original`);
        await fs.symlink(outside, output);
      }
      return open(file, ...args);
    });
    const event = { seq: 10, kind: 'text', text: '[Report](output/report.csv)' };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(swapped).toBe(true);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it('keeps reading the pinned directory when its name is swapped before the final open', async () => {
    const output = path.join(job.workDir, 'output');
    const outside = path.join(scratch, 'other-session');
    await fs.mkdir(output);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(output, 'report.csv'), 'safe original');
    await fs.writeFile(path.join(outside, 'report.csv'), 'other session secret');
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
      if (!swapped && String(file).endsWith('/report.csv')) {
        swapped = true;
        await fs.rename(output, `${output}-original`);
        await fs.symlink(outside, output);
      }
      return open(file, ...args);
    });
    const rewritten = await sessionFileEvent(job, {
      seq: 15,
      kind: 'text',
      text: '[Report](output/report.csv)',
    });
    expect(swapped).toBe(true);
    const url = rewritten.text.match(/\(<([^>]+)>\)/)[1];
    expect(await (await fetch(url)).text()).toBe('safe original');
  });

  it('publishes empty files and files at exactly the size limit', async () => {
    for (const size of [0, MAX_SESSION_FILE_BYTES]) {
      const file = path.join(job.workDir, 'boundary.csv');
      await fs.writeFile(file, '');
      await fs.truncate(file, size);
      const rewritten = await sessionFileEvent(job, {
        seq: size,
        kind: 'text',
        text: '[Boundary](boundary.csv)',
      });
      const url = rewritten.text.match(/\(<([^>]+)>\)/)[1];
      let downloaded = 0;
      let lastByte;
      for await (const chunk of (await fetch(url)).body) {
        downloaded += chunk.length;
        lastByte = chunk.at(-1);
      }
      expect(downloaded).toBe(size);
      if (size) expect(lastByte).toBe(0);
    }
  }, 15_000);

  it('caps reads when a file grows after descriptor stat', async () => {
    const file = path.join(job.workDir, 'report.csv');
    await fs.writeFile(file, 'small');
    const open = fs.open.bind(fs);
    let readBytes = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
      const handle = await open(name, ...args);
      if (String(name).endsWith('/report.csv')) {
        const stat = handle.stat.bind(handle);
        handle.stat = async () => {
          const result = await stat();
          await fs.truncate(file, MAX_SESSION_FILE_BYTES * 4);
          return result;
        };
        const read = handle.read.bind(handle);
        handle.read = async (...args) => {
          const result = await read(...args);
          readBytes += result.bytesRead;
          return result;
        };
      }
      return handle;
    });
    const event = { seq: 11, kind: 'text', text: '[Report](report.csv)' };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(readBytes).toBe(MAX_SESSION_FILE_BYTES + 1);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it.each([
    '[`report.csv`](report.csv)',
    '[Download `report.csv`](report.csv)',
    '[Download ``report[1].csv``](report.csv)',
    '- Item\n    [Report](report.csv)',
    '- Item\n\n    [Report](report.csv)',
    '1. Item\n    [Report](report.csv)',
    '- Item\n  - Nested\n    [Report](report.csv)',
    '\\` [Report](report.csv) \\`',
    '[Report [draft]](report.csv)',
    '[Report [draft [v2]]](report.csv)',
    '[Report](\nreport.csv\n)',
    '[Report](\n    <report.csv>\n)',
    '[Report](\nreport.csv "Title"\n)',
    '[Report [draft]][ref]\n\n[ref]: report.csv',
    '[`report.csv`][ref]\n\n[ref]: report.csv',
  ])('publishes the rendered Markdown link %s', async (text) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'rendered report');
    const event = { seq: 30, kind: 'text', text };
    const rewritten = await sessionFileEvent(job, event);
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    const labelEnd = text.includes('](') ? text.lastIndexOf('](') : text.indexOf('][ref]');
    expect(rewritten.text.split('](<')[0]).toBe(text.slice(0, labelEnd));
    if (text.includes('"Title"')) expect(rewritten.text).toContain('> "Title")');
    expect(await (await fetch(url)).text()).toBe('rendered report');
    await fs.rm(job.workDir, { recursive: true });
    expect(await sessionFileEvent(job, event)).toEqual(rewritten);
  });

  it.each([
    '    - Item\n      [Report](report.csv)',
    '- Item\n\n      [Report](report.csv)',
    '1. Item\n\n       [Report](report.csv)',
    '- Item\n  - Nested\n\n        [Report](report.csv)',
    '- Item\n  - Nested\n\n\t\t[Report](report.csv)',
    '`[Report [draft]](report.csv)`',
    '``[Download `report.csv`](report.csv)``',
    '[Report](\n\nreport.csv\n)',
  ])('preserves code or invalid link boundaries in %s', async (text) => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'example contents');
    const event = { seq: 31, kind: 'text', text };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it.each([
    ['report.csv#details', 'report.csv', '#details'],
    ['report.csv#section%202', 'report.csv', '#section%202'],
    ['report.csv#', 'report.csv', '#'],
    ['report.csv:12#details', 'report.csv', '#details'],
    ['report%23draft.csv', 'report#draft.csv', ''],
    ['report%23draft.csv#details', 'report#draft.csv', '#details'],
    ['report.csv&#35;details', 'report.csv#details', ''],
  ])('separates the fragment in %s from file %s', async (destination, name, fragment) => {
    await fs.writeFile(path.join(job.workDir, name), 'fragment report');
    if (fragment) await fs.writeFile(path.join(job.workDir, `${name}${fragment}`), 'wrong file');
    const event = { seq: 32, kind: 'text', text: `[Report](${destination})` };
    const rewritten = await sessionFileEvent(job, event);
    const url = rewritten.text.match(/\(<([^>]+)>/)[1];
    expect(url.slice(cfg.publicBaseUrl.length)).toMatch(/^\/files\/[a-f0-9]{64}\//);
    expect(url.endsWith(`/${encodeURIComponent(name)}${fragment}`)).toBe(true);
    expect(await (await fetch(url)).text()).toBe('fragment report');
  });

  it.each([
    ['100%.csv', '100%.csv'],
    ['100%25.csv', '100%.csv'],
    ['100%done.csv', '100%done.csv'],
    ['100%25%20done.csv', '100% done.csv'],
    ['100%2525.csv', '100%25.csv'],
  ])('publishes literal percents and decodes valid escapes once in %s', async (destination, name) => {
    const file = path.join(job.workDir, name);
    await fs.writeFile(file, 'percent report');
    for (const target of [destination, `file://${job.workDir}/${destination}`]) {
      const event = { seq: 43, kind: 'text', text: `[Report](<${target}>)` };
      const rewritten = await sessionFileEvent(job, event);
      const url = rewritten.text.match(/^\[Report\]\(<([^>]+)>\)$/)?.[1];
      expect(url).toBeDefined();
      expect(url.endsWith(`/${encodeURIComponent(name)}`)).toBe(true);
      const downloaded = await fetch(url);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe('percent report');
    }
  });

  it.each([
    ['report.csv?download=1', 'report.csv', ''],
    ['report.csv?download=1#details', 'report.csv', '#details'],
    ['report.csv:12?download=1', 'report.csv', ''],
    ['report%3Fdraft.csv?download=1', 'report?draft.csv', ''],
  ])('separates the query in %s from the workspace pathname', async (destination, name, fragment) => {
    await fs.writeFile(path.join(job.workDir, name), 'query report');
    const targets = [destination, `file://${job.workDir}/${destination}`];
    for (const competing of [false, true]) {
      if (competing) {
        await fs.writeFile(path.join(job.workDir, `${name}?download=1`), 'wrong query bytes');
      }
      for (const target of targets) {
        const event = { seq: competing ? 45 : 44, kind: 'text', text: `[Report](<${target}>)` };
        const rewritten = await sessionFileEvent(job, event);
        const url = rewritten.text.match(/^\[Report\]\(<([^>]+)>\)$/)?.[1];
        expect(url).toBeDefined();
        expect(new URL(url).search).toBe('');
        expect(new URL(url).hash).toBe(fragment);
        const downloaded = await fetch(url);
        expect(downloaded.status).toBe(200);
        expect(await downloaded.text()).toBe('query report');
      }
    }
  });

  it('converts compact adjacent links and retains optional titles and balanced parentheses', async () => {
    await fs.writeFile(path.join(job.workDir, 'a.csv'), 'A');
    await fs.writeFile(path.join(job.workDir, 'b.csv'), 'B');
    await fs.writeFile(path.join(job.workDir, 'report(1).csv'), 'parentheses');
    const event = {
      seq: 12,
      kind: 'text',
      text: `|[A](a.csv)|[B](b.csv)|\n[A](a.csv),[B](b.csv)\n[A](a.csv "Report") [B](b.csv 'Title') [R](report(1).csv)`,
    };
    const rewritten = await sessionFileEvent(job, event);
    const urls = [...rewritten.text.matchAll(/\(<([^>]+)>/g)].map((match) => match[1]);
    expect(urls).toHaveLength(7);
    expect(rewritten.text).toContain('> "Report")');
    expect(rewritten.text).toContain("> 'Title')");
    expect(await Promise.all(urls.map(async (url) => (await fetch(url)).text()))).toEqual([
      'A',
      'B',
      'A',
      'B',
      'A',
      'B',
      'parentheses',
    ]);
  });

  it('preserves multi-backtick spans, indented blocks and fences without publishing examples', async () => {
    await fs.writeFile(path.join(job.workDir, 'report.csv'), 'example contents');
    const text = [
      '``[Report](report.csv) `nested` ``',
      '```[Report](report.csv)````` still code ```',
      '    [Report](report.csv)',
      '\t[Report](report.csv)',
      '~~~~md',
      '[Report](report.csv)',
      '~~~',
      '[Report](report.csv)',
      '~~~~',
      '````md',
      '[Report](report.csv)',
      '```',
      '[Report](report.csv)',
    ].join('\n');
    const event = { seq: 13, kind: 'text', text };
    expect(await sessionFileEvent(job, event)).toEqual(event);
    expect(await fs.stat(path.join(cfg.testVideosDir, '.session-files')).catch(() => null)).toBe(null);
  });

  it('retries missing links while keeping the original published snapshot', async () => {
    const file = path.join(job.workDir, 'report.csv');
    await fs.writeFile(file, 'original report');
    const event = { seq: 14, kind: 'text', text: '[First](report.csv) [Later](later.csv)' };
    const first = await sessionFileEvent(job, event);
    expect(first.text).toContain('[Later](later.csv)');
    const firstUrl = first.text.match(/\(<([^>]+)>\)/)[1];
    await fs.writeFile(file, 'changed report');
    await fs.writeFile(path.join(job.workDir, 'later.csv'), 'later report');
    const retried = await sessionFileEvent(job, event);
    const urls = [...retried.text.matchAll(/\(<([^>]+)>\)/g)].map((match) => match[1]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(firstUrl);
    expect(await (await fetch(urls[0])).text()).toBe('original report');
    expect(await (await fetch(urls[1])).text()).toBe('later report');
    await fs.rm(job.workDir, { recursive: true });
    expect(await sessionFileEvent(job, event)).toEqual(retried);
  });

  it('serializes overlapping event updates and retains every snapshot after workspace reuse', async () => {
    await fs.writeFile(path.join(job.workDir, 'a.csv'), 'original A');
    await fs.writeFile(path.join(job.workDir, 'unrelated.csv'), 'unrelated');
    const event = { seq: 16, kind: 'text', text: '[A](a.csv) [B](b.csv)' };
    const paused = Promise.withResolvers();
    const release = Promise.withResolvers();
    const open = fs.open.bind(fs);
    let blocked = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).endsWith('/a.csv') && !blocked) {
        blocked = true;
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          paused.resolve();
          await release.promise;
          return read(...readArgs);
        };
      }
      return handle;
    });
    const first = sessionFileEvent(job, event);
    await paused.promise;
    await fs.writeFile(path.join(job.workDir, 'b.csv'), 'original B');
    const second = sessionFileEvent(job, event);
    let completedWhilePaused;
    try {
      const unrelated = await sessionFileEvent(job, {
        seq: 17,
        kind: 'text',
        text: '[Other](unrelated.csv)',
      });
      expect(await (await fetch(unrelated.text.match(/\(<([^>]+)>/)[1])).text()).toBe('unrelated');
      completedWhilePaused = await Promise.race([
        second.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
    } finally {
      release.resolve();
      await first;
      await second;
    }
    expect(completedWhilePaused).toBe(false);
    const partial = await first;
    expect(partial.text).toContain('[B](b.csv)');
    const complete = await second;
    const urls = [...complete.text.matchAll(/\(<([^>]+)>/g)].map((match) => match[1]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(partial.text.match(/\(<([^>]+)>/)[1]);
    await fs.writeFile(path.join(job.workDir, '.git', 'briareus-owner'), 'another-session');
    await fs.rm(path.join(job.workDir, 'a.csv'));
    await fs.rm(path.join(job.workDir, 'b.csv'));
    expect(await sessionFileEvent(job, event)).toEqual(complete);
    expect(await Promise.all(urls.map(async (url) => (await fetch(url)).text()))).toEqual([
      'original A',
      'original B',
    ]);
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
