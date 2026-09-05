import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';

const GITHUB_SECRET = 'gh-secret';

vi.mock('../lib/jobs.js', () => ({ syncSessionsOn: vi.fn() }));

// The public hostname is what decides whether a hook can be installed at all,
// so it is driven from state rather than pinned.
const hook = vi.hoisted(() => ({ url: 'https://reviewer.example.com/webhooks/github' }));

vi.mock('../lib/webhooksecrets.js', () => ({
  webhookSecrets: async () => ({ github: 'gh-secret' }),
  githubWebhookUrl: () => hook.url,
}));

import { webhookRouter, ensureRepoWebhook, installRepoWebhooks } from '../lib/webhooks.js';
import { syncSessionsOn } from '../lib/jobs.js';

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

describe('ensureRepoWebhook', () => {
  const cfg = { githubToken: 'tok' };
  const url = 'https://reviewer.example.com/webhooks/github';
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite'];

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
      branches: [{ name: 'main' }, { name: 'feat' }],
    });
    await settle();

    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'main');
    expect(syncSessionsOn).toHaveBeenCalledWith('acme/shop', 'feat');
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
  const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite'];

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
  });

  it('stays quiet about a hook that was already right', async () => {
    const events = ['pull_request', 'pull_request_review', 'issue_comment', 'check_suite'];
    const url = 'https://reviewer.example.com/webhooks/github';
    const rest = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 5, active: true, events, config: { url } }],
    }));

    await installRepoWebhooks(projects, { githubToken: 't' }, rest);

    expect(logged).toEqual([]);
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
