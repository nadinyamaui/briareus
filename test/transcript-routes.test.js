import { EventEmitter } from 'events';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionTranscriptRoutes } from '../lib/transcript-routes.js';

// The routes over a session's transcript, with lib/jobs.js's side stood in
// for: which lines are hidden is a set here, and what is under test is where
// the routes apply it and where they do not.
let server, base, routes, job, log, hidden, bus, clearDevTranscript;
const ev = (seq, text) => ({ seq, kind: 'text', text });

beforeEach(async () => {
  job = { id: 'abc123', kind: 'devchat', status: 'idle' };
  log = [ev(1, 'old'), ev(2, 'older reply'), ev(3, 'new')];
  hidden = new Set([1, 2]);
  bus = new EventEmitter();
  clearDevTranscript = vi.fn(async (id) => {
    if (id !== job.id) throw new Error('Session not found');
    if (job.status === 'running') throw new Error('Wait until the session is idle to clear its transcript');
    return { session: { id }, hidden: 2 };
  });
  routes = sessionTranscriptRoutes({
    getJob: (id) => (id === job.id ? job : null),
    publicJob: (j) => ({ id: j.id, status: j.status }),
    jobEventsFor: async (j, since) => log.filter((e) => e.seq > since),
    jobEventsSince: (j, since) => log.filter((e) => e.seq > since),
    visibleEvents: (j, events) => events.filter((e) => !hidden.has(e.seq)),
    clearDevTranscript,
    currentEstimates: async () => null,
    jobUsageEstimates: async () => new Map(),
    estimateEventCosts: (events) => events,
    bus,
  });
  const app = express();
  app.use(express.json());
  app.get('/api/dev/sessions/:id', routes.read);
  app.get('/api/dev/sessions/:id/events', routes.stream);
  app.post('/api/dev/sessions/:id/clear', routes.clear);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/dev/sessions`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const seqs = (events) => events.map((e) => e.seq);

describe('the transcript a page opens with', () => {
  it('leaves hidden lines out, and ?all=1 brings them back', async () => {
    const shown = await (await fetch(`${base}/abc123`)).json();
    expect(shown.session).toEqual({ id: 'abc123', status: 'idle' });
    expect(seqs(shown.events)).toEqual([3]);
    expect(seqs((await (await fetch(`${base}/abc123?all=1`)).json()).events)).toEqual([1, 2, 3]);
    // Anything but 1 is not a request for all of it.
    expect(seqs((await (await fetch(`${base}/abc123?all=true`)).json()).events)).toEqual([3]);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('the stream that follows it', () => {
  // The frames an open stream has written so far, until `until` holds.
  async function frames(path, until) {
    const controller = new AbortController();
    const res = await fetch(`${base}/${path}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } finally {
      controller.abort();
    }
    return text
      .split('\n\n')
      .filter((f) => f.startsWith('id: '))
      .map((f) =>
        JSON.parse(
          f
            .split('\n')
            .find((l) => l.startsWith('data: '))
            .slice(6),
        ),
      );
  }

  it('replays only the lines on screen, then everything that comes', async () => {
    const got = frames('abc123/events', (text) => text.includes('"seq":4'));
    // The replay has been written once the listener is on the bus.
    await vi.waitFor(() => expect(bus.listenerCount('event')).toBe(1));
    bus.emit('event', 'abc123', ev(4, 'live'));
    expect(seqs(await got)).toEqual([3, 4]);
  });

  it('replays from the cursor it is given, still without the hidden lines', async () => {
    hidden = new Set([2]);
    const got = frames('abc123/events?since=1', (text) => text.includes('"seq":3'));
    expect(seqs(await got)).toEqual([3]);
  });
});

describe('✕ Clear', () => {
  it('answers what Clear did, and 400 with the reason when it refuses', async () => {
    const ok = await fetch(`${base}/abc123/clear`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ session: { id: 'abc123' }, hidden: 2 });
    job.status = 'running';
    const busy = await fetch(`${base}/abc123/clear`, { method: 'POST' });
    expect(busy.status).toBe(400);
    expect((await busy.json()).error).toMatch(/idle/);
    expect(clearDevTranscript).toHaveBeenCalledTimes(2);
  });
});
