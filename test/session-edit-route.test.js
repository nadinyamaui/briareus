import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionEditRoute } from '../lib/session-edit-route.js';

// PATCH /api/dev/sessions/:id with lib/jobs.js's edits stood in for: what is
// under test is which one a body reaches, and that a mixed body reaches none.
let server, base, edits;

beforeEach(async () => {
  const found = (fn) =>
    vi.fn((id, value) => {
      if (id !== 'abc123') throw new Error('Session not found');
      return fn(value);
    });
  edits = {
    renameDevSession: found((title) => ({ id: 'abc123', title })),
    setDevSessionAutoCompact: found((autoCompact) => ({ id: 'abc123', autoCompact })),
    setDevSessionCompactInstructions: found((text) => {
      if (typeof text !== 'string') throw new Error('compactInstructions must be text');
      return { id: 'abc123', compactInstructions: text };
    }),
  };
  const app = express();
  app.use(express.json());
  app.patch('/api/dev/sessions/:id', sessionEditRoute(edits));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/dev/sessions`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const patch = async (id, body) => {
  const res = await fetch(`${base}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const called = () =>
  Object.fromEntries(Object.entries(edits).map(([name, fn]) => [name, fn.mock.calls.length]));

it('sends each field to its own edit', async () => {
  expect(await patch('abc123', { title: 'New name' })).toEqual({
    status: 200,
    body: { session: { id: 'abc123', title: 'New name' } },
  });
  expect(await patch('abc123', { autoCompact: true })).toEqual({
    status: 200,
    body: { session: { id: 'abc123', autoCompact: true } },
  });
  expect(await patch('abc123', { compactInstructions: 'Keep the findings' })).toEqual({
    status: 200,
    body: { session: { id: 'abc123', compactInstructions: 'Keep the findings' } },
  });
  // An empty string is still a compactInstructions edit (it clears them).
  expect((await patch('abc123', { compactInstructions: '' })).body.session).toEqual({
    id: 'abc123',
    compactInstructions: '',
  });
  expect(called()).toEqual({
    renameDevSession: 1,
    setDevSessionAutoCompact: 1,
    setDevSessionCompactInstructions: 2,
  });
});

it('refuses a body that mixes fields, and applies none of them', async () => {
  expect(await patch('abc123', { title: 'New name', autoCompact: true })).toEqual({
    status: 400,
    body: { error: 'Send one of title, autoCompact per request' },
  });
  expect(await patch('abc123', { autoCompact: true, compactInstructions: 'Keep it' })).toEqual({
    status: 400,
    body: { error: 'Send one of autoCompact, compactInstructions per request' },
  });
  expect(called()).toEqual({
    renameDevSession: 0,
    setDevSessionAutoCompact: 0,
    setDevSessionCompactInstructions: 0,
  });
});

it('answers a refused edit with a 400 and its reason', async () => {
  expect(await patch('abc123', { compactInstructions: 5 })).toEqual({
    status: 400,
    body: { error: 'compactInstructions must be text' },
  });
  expect(await patch('missing', { autoCompact: true })).toEqual({
    status: 400,
    body: { error: 'Session not found' },
  });
});
