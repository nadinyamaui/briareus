import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionWebhookRoutes } from '../lib/webhook-routes.js';
import { normalizeWebhookSettings, publicWebhook, WEBHOOK_DEFAULTS } from '../lib/deliveries.js';
import { sameOriginWrites } from '../lib/security.js';
import { requireAuth } from '../lib/auth.js';

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ auth: { username: 'admin', passwordHash: 'configured', secret: 'secret' } }),
}));

// The session's side of it, as lib/jobs.js keeps it: the routes are what is
// under test here.
let server, base, hook, key;
const found = (id) => {
  if (id !== 'abc123') throw new Error('Session not found');
};
const state = (id) => {
  found(id);
  return { ...publicWebhook(hook), held: 0, paused: null, unfit: null };
};

beforeEach(async () => {
  hook = { ...WEBHOOK_DEFAULTS };
  key = vi.fn(
    async (id, epoch, channel = 'messages') =>
      `${channel === 'instructions' ? 'ikey' : 'key'}-${id}-e${epoch}`,
  );
  const app = express();
  app.use(express.json());
  app.use(sameOriginWrites);
  app.use((req, res, next) => {
    // A test-only stand-in for the signed-in browser; everything else uses the real auth gate.
    if (req.headers.cookie === 'test-browser') return next();
    return requireAuth(req, res, next);
  });
  app.use(
    sessionWebhookRoutes({
      state,
      update: (id, input) => {
        found(id);
        hook = normalizeWebhookSettings(input, hook);
        return state(id);
      },
      rotate: (id) => {
        found(id);
        hook = { ...hook, epoch: hook.epoch + 1 };
        return state(id);
      },
      url: (id, channel) =>
        `https://reviewer.example.com/webhooks/session/${id}${channel === 'instructions' ? '/instructions' : ''}`,
      key,
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, { browser = true, token = '', method = 'GET', body, origin } = {}) =>
  fetch(`${base}/api/dev/sessions/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(browser ? { cookie: 'test-browser' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

describe('a session’s webhook in the dashboard', () => {
  it('shows where to post and the settings, and no key before the webhook is armed', async () => {
    const res = await request('abc123/webhook');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      armed: false,
      perHour: 30,
      maxTurns: 10,
      held: 0,
      url: 'https://reviewer.example.com/webhooks/session/abc123',
      key: null,
    });
    expect(key).not.toHaveBeenCalled();
  });

  it('arms it with the operator’s caps and hands over the key', async () => {
    const res = await request('abc123/webhook', {
      method: 'PUT',
      body: { armed: true, perHour: 120, maxTurns: 50, budgetUsd: 20, sshUnattended: false },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      armed: true,
      perHour: 120,
      maxTurns: 50,
      budgetUsd: 20,
      key: 'key-abc123-e0',
    });
    expect((await (await request('abc123/webhook')).json()).key).toBe('key-abc123-e0');
  });

  it('hands over the instructions key only once instructions are on as well', async () => {
    const armed = await (await request('abc123/webhook', { method: 'PUT', body: { armed: true } })).json();
    expect(armed).toMatchObject({
      instructions: false,
      instructionsUrl: 'https://reviewer.example.com/webhooks/session/abc123/instructions',
      instructionsKey: null,
    });
    const on = await (
      await request('abc123/webhook', { method: 'PUT', body: { armed: true, instructions: true } })
    ).json();
    expect(on).toMatchObject({ instructions: true, key: 'key-abc123-e0', instructionsKey: 'ikey-abc123-e0' });
    // Rotating ends both keys.
    const rotated = await (await request('abc123/webhook/rotate', { method: 'POST' })).json();
    expect(rotated).toMatchObject({ key: 'key-abc123-e1', instructionsKey: 'ikey-abc123-e1' });
    // Disarmed, neither key is handed out, whatever the instructions setting.
    const off = await (await request('abc123/webhook', { method: 'PUT', body: { armed: false } })).json();
    expect(off).toMatchObject({ instructions: true, key: null, instructionsKey: null });
  });

  it('rotating hands over the key of the next epoch', async () => {
    await request('abc123/webhook', { method: 'PUT', body: { armed: true } });
    const res = await request('abc123/webhook/rotate', { method: 'POST' });
    expect(await res.json()).toMatchObject({ armed: true, epoch: 1, key: 'key-abc123-e1' });
  });

  it('says what is wrong with settings it refuses, and changes nothing', async () => {
    const res = await request('abc123/webhook', { method: 'PUT', body: { armed: true, perHour: 0 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/perHour/);
    expect(hook.armed).toBe(false);
  });

  it('answers 404 for a session that is not there', async () => {
    expect((await request('nope/webhook')).status).toBe(404);
    expect((await request('nope/webhook', { method: 'PUT', body: { armed: true } })).status).toBe(404);
    expect((await request('nope/webhook/rotate', { method: 'POST' })).status).toBe(404);
  });

  it('is the signed-in browser’s alone: no agent token reads a key or arms a webhook', async () => {
    for (const [path, method] of [
      ['abc123/webhook', 'GET'],
      ['abc123/webhook', 'PUT'],
      ['abc123/webhook/rotate', 'POST'],
    ]) {
      const body = method === 'GET' ? undefined : { armed: true };
      const agent = await request(path, { method, token: 'session-token', body });
      expect(agent.status).toBe(403);
      const stranger = await request(path, { method, browser: false, body });
      expect(stranger.status).toBe(401);
    }
    expect(hook.armed).toBe(false);
    expect(key).not.toHaveBeenCalled();
  });

  it('takes no write from another origin', async () => {
    const res = await request('abc123/webhook', {
      method: 'PUT',
      body: { armed: true },
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(hook.armed).toBe(false);
  });
});
