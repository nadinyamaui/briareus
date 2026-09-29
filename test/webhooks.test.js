import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import express from 'express';

const GITHUB_SECRET = 'gh-secret';

vi.mock('../lib/jobs.js', () => ({
  syncSessionsOn: vi.fn(),
  noteWebhookDelivery: vi.fn(),
  noteWebhookCurrent: vi.fn(),
  getJob: vi.fn(() => null),
  deliverToSession: vi.fn(() => ({ status: 'running', held: 0 })),
  instructSession: vi.fn(() => ({ status: 'running' })),
}));

// The public hostname is what decides whether a hook can be installed at all,
// so it is driven from state rather than pinned.
const hook = vi.hoisted(() => ({ url: 'https://reviewer.example.com/webhooks/github' }));

vi.mock('../lib/webhooksecrets.js', () => ({
  webhookSecrets: async () => ({ github: 'gh-secret' }),
  githubWebhookUrl: () => hook.url,
  sessionWebhookKey: async (id, epoch = 0, channel = 'messages') =>
    `${channel === 'instructions' ? 'ikey' : 'key'}-${id}${epoch ? `-e${epoch}` : ''}`,
}));

import { webhookRouter, ensureRepoWebhook, installRepoWebhooks } from '../lib/webhooks.js';
import {
  syncSessionsOn,
  noteWebhookDelivery,
  noteWebhookCurrent,
  getJob,
  deliverToSession,
  instructSession,
} from '../lib/jobs.js';
import { deliveryId, DELIVERY_MAX_CHARS } from '../lib/deliveries.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/webhooks', webhookRouter());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/webhooks`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.mocked(syncSessionsOn).mockClear();
  vi.mocked(noteWebhookDelivery).mockClear();
  vi.mocked(noteWebhookCurrent).mockClear();
  vi.mocked(getJob).mockReset();
  vi.mocked(getJob).mockReturnValue(null);
  vi.mocked(deliverToSession).mockReset();
  vi.mocked(deliverToSession).mockReturnValue({ status: 'running', held: 0 });
  vi.mocked(instructSession).mockReset();
  vi.mocked(instructSession).mockReturnValue({ status: 'running' });
  hook.url = 'https://reviewer.example.com/webhooks/github';
});

function sign(body, secret = GITHUB_SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function githubDelivery(event, payload, { secret } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return fetch(`${base}/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': sign(body, secret ?? GITHUB_SECRET),
    },
    body,
  });
}

// The handler answers before it does the work, so give the started work a tick.
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('POST /webhooks/github', () => {
  it('rejects a delivery with no signature at all', async () => {
    const res = await fetch(`${base}/github`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects a delivery signed with the wrong secret', async () => {
    const res = await githubDelivery(
      'pull_request',
      { repository: { full_name: 'a/b' } },
      { secret: 'wrong' },
    );
    expect(res.status).toBe(401);
    await settle();
    expect(syncSessionsOn).not.toHaveBeenCalled();
  });

  it('rejects a well-signed body that is not JSON', async () => {
    const res = await githubDelivery('pull_request', 'not json');
    expect(res.status).toBe(400);
  });

  it('answers a ping in the request itself', async () => {
    const res = await githubDelivery('ping', { repository: { full_name: 'acme/shop' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pong: true });
  });

  it('stamps every signed delivery as proof the hook reaches this install', async () => {
    await githubDelivery('ping', { repository: { full_name: 'acme/shop' } });
    await githubDelivery('issue_comment', { repository: { full_name: 'acme/api' }, issue: { number: 1 } });
    expect(noteWebhookDelivery).toHaveBeenCalledWith('acme/shop');
    expect(noteWebhookDelivery).toHaveBeenCalledWith('acme/api');
  });

  it('stamps nothing for a delivery with a bad signature', async () => {
    await githubDelivery('ping', { repository: { full_name: 'acme/shop' } }, { secret: 'wrong' });
    expect(noteWebhookDelivery).not.toHaveBeenCalled();
  });

  it('accepts a pull_request event fast and syncs behind the response', async () => {
    const payload = {
      repository: { full_name: 'acme/shop' },
      action: 'synchronize',
      pull_request: { number: 7, head: { ref: 'feature/x' } },
    };
    const res = await githubDelivery('pull_request', payload);
    expect(res.status).toBe(202);
    await settle();
    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feature/x');
  });

  it('an issue_comment syncs by pull request number, not branch', async () => {
    await githubDelivery('issue_comment', {
      repository: { full_name: 'acme/shop' },
      issue: { number: 12 },
    });
    await settle();
    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', null, 12);
  });

  it('a push strips refs/heads/ off the ref', async () => {
    await githubDelivery('push', {
      repository: { full_name: 'acme/shop' },
      ref: 'refs/heads/feature/y',
    });
    await settle();
    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feature/y');
  });

  it('ignores a payload naming no repository', async () => {
    await githubDelivery('pull_request', { action: 'opened' });
    await settle();
    expect(syncSessionsOn).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/session/:id', () => {
  const seconds = () => Math.floor(Date.now() / 1000);
  const signed = (raw, key, stamp) =>
    `sha256=${crypto.createHmac('sha256', key).update(`${stamp}.`).update(raw).digest('hex')}`;

  function sessionDelivery(
    id,
    body,
    { headers = {}, key = `key-${id}`, sign: signIt = true, stamp = seconds(), path = '' } = {},
  ) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return fetch(`${base}/session/${id}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
        ...(signIt
          ? { 'X-Briareus-Timestamp': String(stamp), 'X-Briareus-Signature-256': signed(raw, key, stamp) }
          : {}),
        ...headers,
      },
      body: raw,
    });
  }
  // A header byte fetch would refuse to send, sent the way a stranger can.
  function rawPost(path, headers, body) {
    return new Promise((resolve, reject) => {
      const { port } = server.address();
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(Buffer.from(body));
    });
  }
  const delivered = () => vi.mocked(deliverToSession).mock.calls[0];

  it('hands a signed delivery to the session’s intake', async () => {
    const res = await sessionDelivery('abc123', {
      text: 'The nightly build failed',
      source: 'ci',
      id: 'run-1',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status: 'running', held: 0 });
    expect(delivered()).toEqual([
      'abc123',
      { text: 'The nightly build failed', source: 'ci', id: deliveryId('run-1') },
    ]);
  });

  it('says so when the session holds the delivery for later, or had taken it already', async () => {
    vi.mocked(deliverToSession).mockReturnValueOnce({ status: 'held', held: 2 });
    const held = await sessionDelivery('abc123', { text: 'hi' });
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({ ok: true, status: 'held', held: 2 });
    vi.mocked(deliverToSession).mockReturnValueOnce({ status: 'duplicate' });
    const again = await sessionDelivery('abc123', { text: 'hi' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: 'duplicate' });
  });

  it('rejects a signature made with another session’s key, and delivers nothing', async () => {
    const res = await sessionDelivery('abc123', { text: 'hi' }, { key: 'key-other' });
    expect(res.status).toBe(401);
    expect(deliverToSession).not.toHaveBeenCalled();
  });

  it('rejects a delivery with no proof at all', async () => {
    const res = await sessionDelivery('abc123', { text: 'hi' }, { sign: false });
    expect(res.status).toBe(401);
    expect(deliverToSession).not.toHaveBeenCalled();
  });

  it('a signature covers when it was made: one over the body alone is refused', async () => {
    const raw = JSON.stringify({ text: 'hi' });
    const bodyOnly = sign(raw, 'key-abc123');
    for (const headers of [
      { 'X-Briareus-Signature-256': bodyOnly },
      { 'X-Briareus-Signature-256': bodyOnly, 'X-Briareus-Timestamp': String(seconds()) },
      { 'X-Briareus-Signature-256': signed(raw, 'key-abc123', 'soon'), 'X-Briareus-Timestamp': 'soon' },
    ]) {
      const res = await sessionDelivery('abc123', { text: 'hi' }, { sign: false, headers });
      expect(res.status).toBe(401);
    }
    expect(deliverToSession).not.toHaveBeenCalled();
  });

  it('refuses a signed delivery made too long ago, or too far ahead, and tells its sender why', async () => {
    for (const stamp of [seconds() - 301, seconds() + 301]) {
      const res = await sessionDelivery('abc123', { text: 'hi' }, { stamp });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toMatch(/Timestamp too far/);
    }
    expect((await sessionDelivery('abc123', { text: 'hi' }, { stamp: seconds() - 200 })).status).toBe(202);
    expect(deliverToSession).toHaveBeenCalledTimes(1);
  });

  it('names an unnamed signed delivery after its signed bytes, so the same ones twice are one', async () => {
    const stamp = seconds();
    await sessionDelivery('abc123', { text: 'hi' }, { stamp });
    await sessionDelivery('abc123', { text: 'hi' }, { stamp });
    await sessionDelivery('abc123', { text: 'hi' }, { stamp: stamp - 1 });
    const ids = vi.mocked(deliverToSession).mock.calls.map(([, d]) => d.id);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('takes the key as a bearer token from senders that cannot sign', async () => {
    const ok = await sessionDelivery('abc123', 'deploy finished', {
      sign: false,
      headers: { Authorization: 'Bearer key-abc123', 'X-Briareus-Delivery': 'deploy-9' },
    });
    expect(ok.status).toBe(202);
    expect(delivered()[1]).toEqual({ text: 'deploy finished', source: '', id: deliveryId('deploy-9') });
    const bad = await sessionDelivery('abc123', 'deploy finished', {
      sign: false,
      headers: { Authorization: 'Bearer key-abc12' },
    });
    expect(bad.status).toBe(401);
    expect(deliverToSession).toHaveBeenCalledTimes(1);
  });

  it('a bearer delivery nobody named has no id to be deduplicated on', async () => {
    await sessionDelivery('abc123', 'x', { sign: false, headers: { Authorization: 'Bearer key-abc123' } });
    expect(delivered()[1].id).toBe(null);
  });

  it('checks against the key of the session’s epoch: a rotated key ends the old one', async () => {
    vi.mocked(getJob).mockReturnValue({ id: 'abc123', webhook: { armed: true, epoch: 2 } });
    expect((await sessionDelivery('abc123', { text: 'hi' })).status).toBe(401);
    expect((await sessionDelivery('abc123', { text: 'hi' }, { key: 'key-abc123-e2' })).status).toBe(202);
    expect(getJob).toHaveBeenCalledWith('abc123');
  });

  it('answers 401, never 500, to a key of the right length in characters and the wrong one in bytes', async () => {
    const sig = `sha256=${'a'.repeat(63)}é`;
    const stamp = String(seconds());
    expect(
      await rawPost(
        '/webhooks/session/abc123',
        { 'X-Briareus-Signature-256': sig, 'X-Briareus-Timestamp': stamp },
        'hi',
      ),
    ).toBe(401);
    expect(await rawPost('/webhooks/session/abc123', { Authorization: `Bearer key-abc12é` }, 'hi')).toBe(401);
    expect(await rawPost('/webhooks/github', { 'X-Hub-Signature-256': sig }, '{}')).toBe(401);
    expect(deliverToSession).not.toHaveBeenCalled();
  });

  it('answers an id no session could have like a wrong key, before it is read or logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const forged = 'x%0A2026-09-27T00:00:00.000Z%20webhooks:%20session%20abc%20%E2%86%90%20ci';
      for (const id of [forged, 'a%20b', 'a.b', 'x'.repeat(65)]) {
        const res = await fetch(`${base}/session/${id}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer key-x' },
          body: 'hi',
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Bad signature' });
      }
      expect(getJob).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      await sessionDelivery('abc123', { text: 'hi' }, { key: 'key-other' });
      expect(log.mock.calls.flat().join('')).not.toContain('\n');
    } finally {
      log.mockRestore();
    }
  });

  it('refuses an empty message, a body that is not JSON, and one too long to read', async () => {
    expect((await sessionDelivery('abc123', { text: '   ' })).status).toBe(400);
    expect(
      (await sessionDelivery('abc123', '{nope', { headers: { 'Content-Type': 'application/json' } })).status,
    ).toBe(400);
    expect((await sessionDelivery('abc123', 'x'.repeat(DELIVERY_MAX_CHARS + 1))).status).toBe(413);
    expect(deliverToSession).not.toHaveBeenCalled();
  });

  it('reads no more of a body than a delivery can be', async () => {
    const res = await sessionDelivery('abc123', 'x'.repeat(300 * 1024));
    expect(res.status).toBe(413);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('answers what the intake refused with: its status, and when to come back', async () => {
    const refuse = (status, message, retryAfter = 0) =>
      vi.mocked(deliverToSession).mockImplementationOnce(() => {
        throw Object.assign(new Error(message), { status, retryAfter });
      });
    refuse(404, 'Session not found');
    expect((await sessionDelivery('gone', { text: 'hi' })).status).toBe(404);
    refuse(409, 'This session’s webhook is off');
    const off = await sessionDelivery('abc123', { text: 'hi' });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toMatch(/webhook is off/);
    refuse(429, 'This session takes 30 deliveries an hour and has had them', 120);
    const capped = await sessionDelivery('abc123', { text: 'hi' });
    expect(capped.status).toBe(429);
    expect(capped.headers.get('Retry-After')).toBe('120');
    vi.mocked(deliverToSession).mockImplementationOnce(() => {
      throw new Error('The dashboard is draining for a restart');
    });
    const busy = await sessionDelivery('abc123', { text: 'hi' });
    expect(busy.status).toBe(409);
    expect(busy.headers.get('Retry-After')).toBe(null);
  });

  describe('/instructions', () => {
    const instruct = (body, opts = {}) =>
      sessionDelivery('abc123', body, { key: 'ikey-abc123', path: '/instructions', ...opts });

    it('hands an instruction signed with the instructions key to the instructions intake', async () => {
      const res = await instruct({ text: 'Yes, deploy it', source: 'whatsapp', id: 'wamid-1' });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, status: 'running' });
      expect(vi.mocked(instructSession).mock.calls[0]).toEqual([
        'abc123',
        { text: 'Yes, deploy it', source: 'whatsapp', id: deliveryId('wamid-1') },
      ]);
      expect(deliverToSession).not.toHaveBeenCalled();
    });

    it('never takes the messages key: whoever holds it cannot speak for the operator', async () => {
      expect((await instruct({ text: 'hi' }, { key: 'key-abc123' })).status).toBe(401);
      const bearer = await instruct('hi', { sign: false, headers: { Authorization: 'Bearer key-abc123' } });
      expect(bearer.status).toBe(401);
      expect(instructSession).not.toHaveBeenCalled();
      expect(deliverToSession).not.toHaveBeenCalled();
    });

    it('and the instructions key opens no messages route either', async () => {
      expect((await sessionDelivery('abc123', { text: 'hi' }, { key: 'ikey-abc123' })).status).toBe(401);
      expect(deliverToSession).not.toHaveBeenCalled();
    });

    it('takes a bearer and the key of the session’s epoch', async () => {
      vi.mocked(getJob).mockReturnValue({ id: 'abc123', webhook: { armed: true, epoch: 3 } });
      expect((await instruct({ text: 'hi' })).status).toBe(401);
      const ok = await instruct('go', { sign: false, headers: { Authorization: 'Bearer ikey-abc123-e3' } });
      expect(ok.status).toBe(202);
    });

    it('answers what the instructions intake refused with, and says when it queued', async () => {
      vi.mocked(instructSession).mockReturnValueOnce({ status: 'queued' });
      expect(await (await instruct({ text: 'hi' })).json()).toEqual({ ok: true, status: 'queued' });
      vi.mocked(instructSession).mockImplementationOnce(() => {
        throw Object.assign(new Error('This session’s instructions webhook is off'), { status: 409 });
      });
      const off = await instruct({ text: 'hi' });
      expect(off.status).toBe(409);
      expect((await off.json()).error).toMatch(/instructions webhook is off/);
    });
  });
});

describe('ensureRepoWebhook', () => {
  const cfg = { githubToken: 'tok' };
  const url = 'https://reviewer.example.com/webhooks/github';
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite', 'status'];

  function restServing(hooks, responses = {}) {
    return vi.fn(async (c, method, _path, _body) => {
      if (method === 'GET') return { ok: true, status: 200, json: async () => hooks };
      return responses[method] || { ok: true, status: 200, json: async () => ({}) };
    });
  }

  it('creates the hook when the repository has none of ours', async () => {
    const rest = restServing([{ id: 1, config: { url: 'https://deploy.example.com/hook' } }]);
    const res = await ensureRepoWebhook(cfg, 'acme/shop', rest);
    expect(res).toEqual({ ok: true, action: 'created', url });
    const [, method, path, body] = rest.mock.calls[1];
    expect(method).toBe('POST');
    expect(path).toBe('/repos/acme/shop/hooks');
    expect(body.events).toEqual(events);
    expect(body.config).toMatchObject({ url, secret: GITHUB_SECRET, content_type: 'json' });
  });

  it('leaves an up-to-date hook alone', async () => {
    const rest = restServing([{ id: 5, active: true, events, config: { url } }]);
    const res = await ensureRepoWebhook(cfg, 'acme/shop', rest);
    expect(res).toEqual({ ok: true, action: 'unchanged', url });
    expect(rest).toHaveBeenCalledTimes(1); // the GET only
  });

  it('rewrites our hook when the hostname moved, instead of adding a second one', async () => {
    const rest = restServing([
      {
        id: 5,
        active: true,
        events,
        config: { url: 'https://old-host.example.com/webhooks/github' },
      },
    ]);
    const res = await ensureRepoWebhook(cfg, 'acme/shop', rest);
    expect(res).toEqual({ ok: true, action: 'updated', url });
    const [, method, path] = rest.mock.calls[1];
    expect(method).toBe('PATCH');
    expect(path).toBe('/repos/acme/shop/hooks/5');
  });

  it('reports a token that cannot manage hooks instead of failing', async () => {
    const rest = vi.fn(async () => ({ ok: false, status: 403 }));
    const res = await ensureRepoWebhook(cfg, 'acme/shop', rest);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/403/);
  });
});

describe('the events a delivery can carry', () => {
  it.each([
    ['pull_request_review', { pull_request: { head: { ref: 'feat' } } }],
    ['pull_request_review_comment', { pull_request: { head: { ref: 'feat' } } }],
  ])('%s syncs the pull request head branch', async (event, extra) => {
    await githubDelivery(event, { repository: { full_name: 'acme/shop' }, ...extra });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feat');
  });

  it('syncs on no branch when the pull request payload carries no head', async () => {
    await githubDelivery('pull_request', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', null);
  });

  it('a check_suite syncs the branch it ran on', async () => {
    await githubDelivery('check_suite', {
      repository: { full_name: 'acme/shop' },
      check_suite: { head_branch: 'feat' },
    });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feat');
  });

  it('a check_suite with no suite body syncs on no branch rather than throwing', async () => {
    await githubDelivery('check_suite', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', undefined);
  });

  it('a check_run reaches through to its suite for the branch', async () => {
    await githubDelivery('check_run', {
      repository: { full_name: 'acme/shop' },
      check_run: { check_suite: { head_branch: 'feat' } },
    });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feat');
  });

  it('a check_run with no suite syncs on no branch rather than throwing', async () => {
    await githubDelivery('check_run', { repository: { full_name: 'acme/shop' }, check_run: {} });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', undefined);
  });

  it('a status syncs every branch the commit belongs to', async () => {
    // A commit status names no branch of its own.
    await githubDelivery('status', {
      repository: { full_name: 'acme/shop' },
      state: 'success',
      branches: [{ name: 'main' }, { name: 'feat' }],
    });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'main');
    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feat');
  });

  it('a pending status syncs nothing: only one reaching a result is worth a read', async () => {
    await githubDelivery('status', {
      repository: { full_name: 'acme/shop' },
      state: 'pending',
      branches: [{ name: 'feat' }],
    });
    await settle();

    expect(syncSessionsOn).not.toHaveBeenCalled();
  });

  it('a status naming no branches syncs nothing', async () => {
    await githubDelivery('status', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).not.toHaveBeenCalled();
  });

  it('an issue_comment with no issue syncs on no number rather than throwing', async () => {
    await githubDelivery('issue_comment', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', null, undefined);
  });

  it('a push with no ref syncs on the empty branch rather than throwing', async () => {
    await githubDelivery('push', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', '');
  });

  it('ignores an event nobody here subscribes to', async () => {
    await githubDelivery('star', { repository: { full_name: 'acme/shop' } });
    await settle();

    expect(syncSessionsOn).not.toHaveBeenCalled();
  });

  it('ignores a delivery with no event header at all', async () => {
    const body = JSON.stringify({ repository: { full_name: 'acme/shop' } });
    await fetch(`${base}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
      body,
    });
    await settle();

    expect(syncSessionsOn).not.toHaveBeenCalled();
  });

  it('answers a ping even when it names no repository', async () => {
    const res = await githubDelivery('ping', {});

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, pong: true });
  });

  it('swallows a sync that throws rather than crashing the delivery', async () => {
    // The response has already gone out; there is nobody left to tell.
    vi.mocked(syncSessionsOn).mockImplementationOnce(() => {
      throw new Error('database is down');
    });

    const res = await githubDelivery('check_suite', {
      repository: { full_name: 'acme/shop' },
      check_suite: { head_branch: 'feat' },
    });
    await settle();

    expect(res.status).toBe(202);
  });

  it('rejects a signature of the right shape but the wrong length', async () => {
    const body = JSON.stringify({ repository: { full_name: 'acme/shop' } });
    const res = await fetch(`${base}/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': 'sha256=abc',
      },
      body,
    });

    expect(res.status).toBe(401);
  });
});

describe('ensureRepoWebhook without a hostname to point at', () => {
  it('refuses rather than installing a hook nobody can reach', async () => {
    hook.url = '';

    await expect(ensureRepoWebhook({ githubToken: 't' }, 'acme/shop', vi.fn())).resolves.toEqual({
      ok: false,
      reason: 'no public https hostname (PUBLIC_BASE_URL)',
    });
  });
});

describe('ensureRepoWebhook when GitHub refuses the write', () => {
  const cfg = { githubToken: 'tok' };
  const url = 'https://reviewer.example.com/webhooks/github';
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite', 'status'];

  const restServing = (hooks, responses = {}) =>
    vi.fn(async (c, method) => {
      if (method === 'GET') return { ok: true, status: 200, json: async () => hooks };
      return responses[method] || { ok: true, status: 200, json: async () => ({}) };
    });

  it('reports a create it was not allowed to make', async () => {
    const rest = restServing([], { POST: { ok: false, status: 422 } });

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toEqual({
      ok: false,
      reason: 'GitHub answered 422 creating the hook',
    });
  });

  it('reports an update it was not allowed to make', async () => {
    const rest = restServing(
      [{ id: 5, active: true, events, config: { url: 'https://old/webhooks/github' } }],
      {
        PATCH: { ok: false, status: 422 },
      },
    );

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toEqual({
      ok: false,
      reason: 'GitHub answered 422 updating the hook',
    });
  });

  it('reactivates our hook when somebody switched it off', async () => {
    const rest = restServing([{ id: 5, active: false, events, config: { url } }]);

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toMatchObject({ action: 'updated' });
  });

  it('rewrites our hook when its event list has drifted', async () => {
    const rest = restServing([{ id: 5, active: true, events: ['pull_request'], config: { url } }]);

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toMatchObject({ action: 'updated' });
  });

  it('rewrites our hook when it carries an event too many', async () => {
    const rest = restServing([{ id: 5, active: true, events: [...events, 'push'], config: { url } }]);

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toMatchObject({ action: 'updated' });
  });

  it('treats a hook with no config or events as ours to rewrite', async () => {
    const rest = restServing([{ id: 5, config: { url } }]);

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toMatchObject({ action: 'updated' });
  });

  it('never touches somebody else deploy hook on the same repository', async () => {
    const rest = restServing([{ id: 1, config: {} }, { id: 2 }]);

    await expect(ensureRepoWebhook(cfg, 'acme/shop', rest)).resolves.toMatchObject({ action: 'created' });
  });
});

describe('installRepoWebhooks', () => {
  const projects = [{ repo: 'acme/shop' }, { repo: 'acme/api' }];
  let logged;

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((m) => logged.push(m));
  });

  afterEach(() => vi.mocked(console.log).mockRestore());

  it('does nothing but say so when there is no public hostname', async () => {
    hook.url = '';

    await installRepoWebhooks(projects, { githubToken: 't' }, vi.fn());

    expect(logged).toEqual([
      'webhooks: no public https hostname configured (PUBLIC_BASE_URL); sessions sync on the timer alone',
    ]);
  });

  it('does nothing but say so when there is no token', async () => {
    const rest = vi.fn();

    await installRepoWebhooks(projects, { githubToken: '' }, rest);

    expect(logged).toEqual(['webhooks: no GitHub token; sessions sync on the timer alone']);
    expect(rest).not.toHaveBeenCalled();
  });

  it('says what it did to each repository', async () => {
    const rest = vi.fn(async (c, method) =>
      method === 'GET' ? { ok: true, json: async () => [] } : { ok: true, json: async () => ({}) },
    );

    await installRepoWebhooks(projects, { githubToken: 't' }, rest);

    expect(logged).toEqual([
      'webhooks: acme/shop: hook created → https://reviewer.example.com/webhooks/github',
      'webhooks: acme/api: hook created → https://reviewer.example.com/webhooks/github',
    ]);
    expect(noteWebhookCurrent).toHaveBeenCalledWith('acme/shop');
    expect(noteWebhookCurrent).toHaveBeenCalledWith('acme/api');
  });

  it('stays quiet about a hook that was already right', async () => {
    const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite', 'status'];
    const url = 'https://reviewer.example.com/webhooks/github';
    const rest = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 5, active: true, events, config: { url } }],
    }));

    await installRepoWebhooks(projects, { githubToken: 't' }, rest);

    expect(logged).toEqual([]);
    expect(noteWebhookCurrent).toHaveBeenCalledWith('acme/shop');
  });

  it('does not count a hook it could not bring up to date as carrying every event', async () => {
    // An older hook without `status` still delivers, so a delivery alone must
    // not slow the timer down for this repository.
    const url = 'https://reviewer.example.com/webhooks/github';
    const rest = vi.fn(async (c, method) =>
      method === 'GET'
        ? { ok: true, json: async () => [{ id: 5, active: true, events: ['pull_request'], config: { url } }] }
        : { ok: false, status: 502 },
    );

    await installRepoWebhooks([projects[0]], { githubToken: 't' }, rest);

    expect(logged[0]).toMatch(
      /acme\/shop: GitHub answered 502 updating the hook.*falling back to the sync timer/,
    );
    expect(noteWebhookCurrent).not.toHaveBeenCalled();
  });

  it('falls back to the sync timer for a repository it cannot manage', async () => {
    const rest = vi.fn(async () => ({ ok: false, status: 403 }));

    await installRepoWebhooks([projects[0]], { githubToken: 't' }, rest);

    expect(logged[0]).toMatch(
      /acme\/shop: GitHub answered 403 listing hooks.*falling back to the sync timer/,
    );
  });

  it('falls back to the sync timer when the call throws outright', async () => {
    const rest = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    await installRepoWebhooks([projects[0]], { githubToken: 't' }, rest);

    expect(logged).toEqual(['webhooks: acme/shop: ECONNRESET, falling back to the sync timer']);
  });
});
