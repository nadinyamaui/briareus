import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { operationsRoutes } from '../lib/operations-routes.js';
import { setDraining } from '../lib/recovery.js';

afterEach(() => setDraining(false));

async function serve(deps) {
  const app = express();
  app.use(express.json());
  app.use(
    operationsRoutes({
      listSessions: () => [{ id: 's', status: 'failed' }],
      ssh: { pending: () => [], runningCount: () => 0 },
      getJob: () => null,
      sendMessage: () => null,
      ...deps,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { body, headers = {} } = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

it('only exposes operator projections to browser requests', async () => {
  const { call, close } = await serve();
  try {
    expect((await (await call('/api/operations/attention')).json()).items[0].kind).toBe('recovery');
    const bearer = { authorization: 'Bearer internal' };
    expect((await call('/api/operations/attention', { headers: bearer })).status).toBe(403);
    expect((await call('/api/operations/maintenance', { headers: bearer })).status).toBe(403);
    expect(
      (await call('/api/operations/maintenance', { body: { draining: true }, headers: bearer })).status,
    ).toBe(403);
    expect((await call('/api/operations/recovery/s', { headers: bearer })).status).toBe(403);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: 'x' }, headers: bearer })).status,
    ).toBe(403);
  } finally {
    await close();
  }
});

it('toggles draining only on a boolean', async () => {
  const { call, close } = await serve();
  try {
    expect((await call('/api/operations/maintenance', { body: { draining: 'yes' } })).status).toBe(400);
    expect((await (await call('/api/operations/maintenance')).json()).draining).toBe(false);
    const on = await (await call('/api/operations/maintenance', { body: { draining: true } })).json();
    expect(on).toMatchObject({ draining: true, ready: true });
    expect(on.active).toEqual([]);
  } finally {
    await close();
  }
});

it('resumes only the recovery report the operator saw, and never while draining', async () => {
  const job = { id: 's', kind: 'devchat', status: 'interrupted', orchestrator: true, chatStarted: true };
  const sendMessage = vi.fn(() => ({ id: 's' }));
  const { call, close } = await serve({ getJob: (id) => (id === 's' ? job : null), sendMessage });
  try {
    const report = await (await call('/api/operations/recovery/s')).json();
    expect(report.canResume).toBe(true);
    expect((await call('/api/operations/recovery/s', { body: { fingerprint: 'stale' } })).status).toBe(409);
    expect((await call('/api/operations/recovery/nope', { body: {} })).status).toBe(400);
    setDraining(true);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: report.fingerprint } })).status,
    ).toBe(400);
    setDraining(false);
    // A turn under way cannot be resumed, whatever fingerprint is sent.
    job.status = 'running';
    const busy = await (await call('/api/operations/recovery/s')).json();
    expect(busy.canResume).toBe(false);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: busy.fingerprint } })).status,
    ).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
    job.status = 'interrupted';
    // A conversation that never started has nothing a resume prompt could
    // point back to.
    job.chatStarted = false;
    const unstarted = await (await call('/api/operations/recovery/s')).json();
    expect(unstarted.canResume).toBe(false);
    expect(
      (await call('/api/operations/recovery/s', { body: { fingerprint: unstarted.fingerprint } })).status,
    ).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
    job.chatStarted = true;
    const ok = await call('/api/operations/recovery/s', { body: { fingerprint: report.fingerprint } });
    expect(ok.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('s', expect.stringContaining('Resume the interrupted task'));
  } finally {
    await close();
  }
});
