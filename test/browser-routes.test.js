import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionBrowserRoutes } from '../lib/browser-routes.js';

// The shared browser's routes with lib/browser.js and lib/jobs.js stood in for:
// what is under test is the HTTP side (which session, which status, what the
// stream sends) rather than Chromium.
let server, base, deps, listener, running;

beforeEach(async () => {
  running = true;
  listener = null;
  const busy = (status, message) => Object.assign(new Error(message), { status });
  deps = {
    getJob: (id) => (id === 'abc123' ? { id, kind: 'devchat', browser: true } : null),
    openSessionBrowser: vi.fn(async (id) => ({ id, browser: { running: true } })),
    closeSessionBrowser: vi.fn((id) => ({ id, browser: null })),
    browserState: () =>
      running
        ? { running: true, tabs: [{ id: 't1', url: 'about:blank', title: '' }], active: 't1' }
        : { running: false, tabs: [], active: null },
    watchBrowser: vi.fn((id, fn) => {
      listener = fn;
      fn({ type: 'tabs', tabs: [{ id: 't1', url: 'about:blank', title: '' }], active: 't1' });
      return () => (listener = null);
    }),
    browserInput: vi.fn(async (id, action) => {
      if (action.type === 'nope') throw busy(400, '`type` must be one of …');
    }),
    browserScreenshot: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  };
  const r = sessionBrowserRoutes(deps);
  const app = express();
  app.use(express.json());
  app.get('/api/dev/sessions/:id/browser', r.state);
  app.post('/api/dev/sessions/:id/browser', r.open);
  app.delete('/api/dev/sessions/:id/browser', r.close);
  app.get('/api/dev/sessions/:id/browser/stream', r.stream);
  app.get('/api/dev/sessions/:id/browser/screenshot', r.screenshot);
  app.post('/api/dev/sessions/:id/browser/input', r.input);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/dev/sessions`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

it('answers 404 for a session that is not there, on every route', async () => {
  expect((await fetch(`${base}/zzz/browser`)).status).toBe(404);
  expect((await post('/zzz/browser')).status).toBe(404);
  expect((await fetch(`${base}/zzz/browser`, { method: 'DELETE' })).status).toBe(404);
  expect((await fetch(`${base}/zzz/browser/stream`)).status).toBe(404);
  expect((await fetch(`${base}/zzz/browser/screenshot`)).status).toBe(404);
  expect((await post('/zzz/browser/input', { type: 'reload' })).status).toBe(404);
});

it('reads the state with whether the browser is switched on', async () => {
  const res = await fetch(`${base}/abc123/browser`);
  expect(await res.json()).toEqual({
    browser: { on: true, running: true, tabs: [{ id: 't1', url: 'about:blank', title: '' }], active: 't1' },
  });
});

it('opens and closes through the session layer', async () => {
  const opened = await (await post('/abc123/browser')).json();
  expect(deps.openSessionBrowser).toHaveBeenCalledWith('abc123');
  expect(opened.session.browser).toEqual({ running: true });
  expect(opened.browser.on).toBe(true);

  const closed = await (await fetch(`${base}/abc123/browser`, { method: 'DELETE' })).json();
  expect(deps.closeSessionBrowser).toHaveBeenCalledWith('abc123');
  expect(closed).toEqual({ session: { id: 'abc123', browser: null } });
});

it('passes an open the session layer refuses back with its status', async () => {
  deps.openSessionBrowser.mockRejectedValueOnce(
    Object.assign(new Error('Reopen the session before opening its browser'), { status: 409 }),
  );
  const res = await post('/abc123/browser');
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/Reopen/);
});

it('refuses a stream when the browser is not running, as JSON rather than an empty stream', async () => {
  running = false;
  const res = await fetch(`${base}/abc123/browser/stream`);
  expect(res.status).toBe(409);
  expect(res.headers.get('content-type')).toMatch(/json/);
});

it('streams the tabs at once, then frames, and ends on closed', async () => {
  const res = await fetch(`${base}/abc123/browser/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  await until('event: tabs');
  expect(text).toContain('"active":"t1"');
  listener({ type: 'frame', frame: { data: 'AAAA', width: 1280, height: 720, tab: 't1' } });
  await until('event: frame');
  expect(text).toContain('{"data":"AAAA","width":1280,"height":720,"tab":"t1"}');
  listener({ type: 'closed' });
  await until('event: closed');
  const { done } = await reader.read();
  expect(done).toBe(true);
});

it('stops watching when the client goes away', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/abc123/browser/stream`, { signal: controller.signal });
  await res.body.getReader().read();
  expect(listener).not.toBeNull();
  controller.abort();
  await vi.waitFor(() => expect(listener).toBeNull());
});

it('sends a screenshot as a PNG', async () => {
  const res = await fetch(`${base}/abc123/browser/screenshot`);
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

it('hands input to the browser and passes its refusals back with their status', async () => {
  const ok = await post('/abc123/browser/input', { type: 'click', x: 10, y: 20 });
  expect(await ok.json()).toEqual({ ok: true });
  expect(deps.browserInput).toHaveBeenCalledWith('abc123', { type: 'click', x: 10, y: 20 });
  const bad = await post('/abc123/browser/input', { type: 'nope' });
  expect(bad.status).toBe(400);
});
