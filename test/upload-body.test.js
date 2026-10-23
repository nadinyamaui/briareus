import express from 'express';
import { request as httpRequest } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiV1Routes } from '../lib/api-v1.js';
import { uploadBody, uploadHandler } from '../lib/upload-body.js';
import { MAX_UPLOAD_BYTES } from '../lib/uploads.js';

let server, url, receive, storage, entered, closed, recordUsage;
beforeEach(async () => {
  storage = null;
  recordUsage = async () => {};
  entered = Promise.withResolvers();
  closed = Promise.withResolvers();
  const handlers = express.Router();
  const handle = uploadHandler(async (req, res) => {
    entered.resolve({ req, res });
    if (storage) await storage.promise;
    if (req.query.fail) throw Object.assign(new Error('Storage failed'), { status: 500 });
    res.json({ bytes: req.body?.length });
  });
  handlers.post('/api/dev/uploads', uploadBody, handle);
  handlers.post('/api/agent/files', uploadBody, handle);
  handlers.post('/api/dev/sessions/:id/files', uploadBody, handle);
  const app = express();
  app.use((req, res, next) => {
    const parsing = (event) => {
      if (event !== 'data') return;
      req.removeListener('newListener', parsing);
      receive?.();
    };
    req.on('newListener', parsing);
    res.once('close', () => closed.resolve());
    next();
  });
  app.use(
    apiV1Routes({
      users: { get: () => ({ id: 1, name: 'Owner', role: 'admin', disabledAt: null }), list: () => [] },
      auth: {
        authenticate: () => ({ id: 'client', permission: 'admin' }),
        recordUsage: () => recordUsage(),
        list: () => [],
      },
      apiEnabled: () => true,
      ownerSecret: () => 'secret',
      handlers,
      getJob: () => ({ kind: 'devchat' }),
      getProject: () => null,
      listSessions: () => [],
      bus: null,
    }),
  );
  app.use(handlers);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  storage?.resolve();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const post = (route = '/api/dev/uploads', body = 'hello', headers = {}) =>
  fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });

// A real request that reserves capacity while its body is still arriving.
async function stall(route = '/api/agent/files', headers = {}, body = 'x') {
  const received = new Promise((resolve) => (receive = resolve));
  const result = Promise.withResolvers();
  const req = httpRequest(
    `${url}${route}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers } },
    (res) => {
      res.resume();
      res.on('end', () => result.resolve(res.statusCode));
    },
  );
  req.on('error', () => result.resolve(null));
  req.write(body);
  await received;
  return { req, result: result.promise };
}

async function expectAvailable() {
  const res = await post();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ bytes: 5 });
}

describe('shared upload memory budget', () => {
  it.each(['identity', 'gzip'])(
    'skips %s admission after a disconnect during authentication',
    async (encoding) => {
      const recording = Promise.withResolvers();
      const recorded = Promise.withResolvers();
      recordUsage = async () => {
        recording.resolve();
        await recorded.promise;
      };
      const req = httpRequest(`${url}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': MAX_UPLOAD_BYTES,
          'Content-Encoding': encoding,
        },
      });
      req.on('error', () => {});
      req.write('x');
      await recording.promise;
      req.destroy();
      await closed.promise;
      recorded.resolve();
      await expectAvailable();
      expect((await post('/api/v1/uploads')).status).toBe(200);
    },
  );

  it('shares capacity across agent, dashboard and native upload routes before reading bodies', async () => {
    const active = await stall(); // Chunked bodies reserve the full decoded limit.
    for (const route of ['/api/dev/uploads', '/api/v1/uploads', '/api/v1/sessions/one/files']) {
      const res = await post(route);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toEqual({ error: 'Upload capacity is busy; retry shortly' });
    }
    active.req.end();
    expect(await active.result).toBe(200);
    await expectAvailable();
  });

  it('allows small uploads alongside a declared body when their combined size fits', async () => {
    const active = await stall('/api/agent/files', { 'Content-Length': MAX_UPLOAD_BYTES - 5 });
    await expectAvailable();
    expect((await post('/api/v1/uploads', '123456')).status).toBe(503);
    active.req.destroy();
    await closed.promise;
    await expectAvailable();
  });

  it('does not double charge a native request passing through the gateway and destination', async () => {
    const active = await stall('/api/v1/sessions/one/files');
    active.req.end();
    expect(await active.result).toBe(200);
    await expectAvailable();
  });

  it('accepts exactly 500 MiB through the native gateway and releases its reservation', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${url}/api/v1/uploads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': MAX_UPLOAD_BYTES },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024);
      Readable.from(
        (function* () {
          for (let i = 0; i < 500; i++) yield chunk;
        })(),
      ).pipe(req);
    });
    expect(status).toEqual({ status: 200, body: { bytes: MAX_UPLOAD_BYTES } });
    await expectAvailable();
  }, 20_000);

  it('reserves the decoded limit for compressed bodies rather than their wire size', async () => {
    const active = await stall('/api/agent/files', { 'Content-Length': MAX_UPLOAD_BYTES - 5 });
    const res = await post('/api/v1/uploads', gzipSync('hello'), { 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(503);
    active.req.destroy();
    await closed.promise;
    const accepted = await post('/api/v1/uploads', gzipSync('hello'), { 'Content-Encoding': 'gzip' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ bytes: 5 });
    await expectAvailable();
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ])('preserves %s decoding', async (encoding, compress) => {
    const accepted = await post('/api/v1/uploads', compress('hello'), { 'Content-Encoding': encoding });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ bytes: 5 });
    await expectAvailable();
  });

  it('enforces the decoded limit for compressed bodies and releases capacity', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${url}/api/agent/files`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024);
      Readable.from(
        (function* () {
          for (let i = 0; i < 500; i++) yield chunk;
          yield Buffer.from('x');
        })(),
      )
        .pipe(createGzip())
        .pipe(req);
    });
    expect(status).toBe(413);
    await expectAvailable();
  }, 20_000);

  it('releases capacity on parser errors and handler failures', async () => {
    expect((await post('/api/agent/files', 'bad gzip', { 'Content-Encoding': 'gzip' })).status).toBe(400);
    expect((await post('/api/agent/files', 'body', { 'Content-Encoding': 'constructor' })).status).toBe(415);
    expect((await post('/api/agent/files?fail=1')).status).toBe(500);
    const active = await stall();
    expect((await post()).status).toBe(503);
    active.req.end();
    expect(await active.result).toBe(200);
    await expectAvailable();
  });

  it('releases an aborted body exactly once', async () => {
    const active = await stall();
    active.req.destroy();
    await closed.promise;
    const replacement = await stall();
    expect((await post()).status).toBe(503);
    replacement.req.end();
    expect(await replacement.result).toBe(200);
    await expectAvailable();
  });

  it('releases capacity when a compressed body disconnects', async () => {
    const active = await stall(
      '/api/agent/files',
      { 'Content-Encoding': 'gzip' },
      gzipSync('hello').subarray(0, -1),
    );
    active.req.destroy();
    await closed.promise;
    await expectAvailable();
  });

  it('keeps capacity through asynchronous storage after the client disconnects', async () => {
    storage = Promise.withResolvers();
    const active = await stall();
    active.req.end();
    const { req } = await entered.promise;
    active.req.destroy();
    await closed.promise;
    expect((await post()).status).toBe(503);
    expect(req.body.toString()).toBe('x');
    storage.resolve();
    // The async handler's finally runs before the next HTTP request is dispatched.
    await expectAvailable();
    expect(req.body).toBeUndefined();
  });
});
