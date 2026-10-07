import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileAuth } from '../lib/mobile-auth.js';
import { apiV1Routes } from '../lib/api-v1.js';
import { createSlackService, createSlackApi } from '../lib/slack.js';
import { slackRoutes, slackEventsRouter } from '../lib/slack-routes.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

const TOKEN = 'xoxp-1111-2222-3333-abcdef';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OWNER = 'owner-secret';
const MESSAGE = { type: 'message', user: 'U1', text: 'A new customer', ts: '1700000001.000001' };
const CONVERSATIONS = [
  { id: 'C1', name: 'sales', is_channel: true },
  { id: 'D1', user: 'U1', is_im: true },
  { id: 'G1', name: 'mpdm-team', is_mpim: true },
];

async function setup({ signingSecret = SECRET } = {}) {
  const stored = {};
  const api = vi.fn(async (_token, method, params = {}) => {
    if (method === 'auth.test') return { team_id: 'T1', team: 'Business', user_id: 'U3', user: 'nadin' };
    if (method === 'conversations.list')
      return { channels: CONVERSATIONS, response_metadata: { next_cursor: 'next-page' } };
    if (method === 'conversations.info')
      return { channel: { ...CONVERSATIONS[0], last_read: '1700000000.000001', unread_count: 1 } };
    if (method === 'users.list')
      return { members: [{ id: 'U1', name: 'customer' }], response_metadata: { next_cursor: 'people-page' } };
    if (method === 'conversations.history' || method === 'conversations.replies')
      return { messages: [MESSAGE], has_more: true, response_metadata: { next_cursor: 'messages-page' } };
    if (method === 'conversations.open') return { channel: CONVERSATIONS[1] };
    if (method === 'chat.postMessage')
      return {
        channel: params.channel,
        ts: '1700000002.000001',
        message: { ...MESSAGE, user: 'U3', text: params.text, ts: '1700000002.000001' },
      };
    if (method === 'conversations.mark') return { ok: true };
    throw new Error(`Unexpected Slack method ${method}`);
  });
  const deliver = vi.fn();
  const s = createSlackService({
    load: async (key, fallback) => stored[key] || fallback,
    save: async (key, value) => {
      stored[key] = value;
    },
    api,
    getJob: () => null,
    deliver,
    log: () => {},
  });
  await s.init();
  const w = await s.create({ token: TOKEN, signingSecret, projects: [] });
  let devices = [];
  const auth = createMobileAuth({
    load: async () => structuredClone(devices),
    save: async (_key, value) => {
      devices = structuredClone(value);
    },
  });
  await auth.init();
  const tokens = {};
  for (const permission of ['read', 'manage', 'admin'])
    tokens[permission] = (
      await auth.create({ label: permission, permission, repos: ['o/a'], days: 30 }, OWNER)
    ).token;

  const handlers = slackRoutes({ service: s, agentSession: () => null, getProject: () => null });
  const app = express();
  app.use('/webhooks/slack', slackEventsRouter({ service: s, log: () => {} }));
  app.use(
    apiV1Routes({
      auth,
      apiEnabled: () => true,
      ownerSecret: () => OWNER,
      handlers,
      getJob: () => null,
      getProject: () => null,
      listSessions: () => [],
      bus: new EventEmitter(),
      recheckMs: 20,
    }),
  );
  app.use((_req, res) => res.sendStatus(404));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  servers.push(server);
  const request = (path, { method = 'GET', body, token = tokens.admin, signal } = {}) =>
    fetch(`${url}/api/v1/slack/workspaces${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  const json = async (path, opts) => (await request(path, opts)).json();
  return { s, w, api, deliver, stored, auth, tokens, url, request, json, at: `/${w.id}` };
}

const servers = [];
const controllers = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function signed(
  workspace,
  event,
  {
    team = 'T1',
    eventId = 'Ev1',
    secret = SECRET,
    authorizations = [{ team_id: 'T1', user_id: 'U3', is_bot: false }],
  } = {},
) {
  const raw = Buffer.from(
    JSON.stringify({ type: 'event_callback', team_id: team, event_id: eventId, event, authorizations }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  return { raw, headers: { timestamp, signature }, workspace };
}

function receive(ctx, event, opts) {
  const { raw, headers } = signed(ctx.w.id, event, opts);
  return ctx.s.receive(String(ctx.w.id), raw, headers);
}

async function stream(ctx) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await ctx.request(`${ctx.at}/events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(':')) continue;
        return { name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) };
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  }
  expect(await next()).toEqual({
    name: 'ready',
    data: { workspaceId: ctx.w.id, userId: 'U3', refresh: true },
  });
  return { next, reader, controller };
}

describe('the operator Slack inbox', () => {
  it('browses directories, channel history and threads without a project or session', async () => {
    const ctx = await setup();
    expect((await ctx.json('')).workspaces).toEqual([ctx.w]);
    expect(await ctx.json(`${ctx.at}/conversations?types=im,mpim&limit=2&cursor=previous`)).toEqual({
      conversations: CONVERSATIONS,
      nextCursor: 'next-page',
    });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.list', {
      types: 'im,mpim',
      limit: 2,
      cursor: 'previous',
      exclude_archived: true,
    });
    expect((await ctx.json(`${ctx.at}/conversations/C1`)).conversation).toMatchObject({
      id: 'C1',
      unread_count: 1,
    });
    expect(await ctx.json(`${ctx.at}/people?cursor=people&limit=5`)).toMatchObject({
      people: [{ id: 'U1' }],
      nextCursor: 'people-page',
    });
    const history = await ctx.json(
      `${ctx.at}/conversations/C1/messages?oldest=1700000000.000001&latest=1700000003.000001&cursor=older`,
    );
    expect(history).toEqual({ messages: [MESSAGE], hasMore: true, nextCursor: 'messages-page' });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.history', {
      channel: 'C1',
      limit: 15,
      cursor: 'older',
      oldest: '1700000000.000001',
      latest: '1700000003.000001',
    });
    await ctx.json(`${ctx.at}/conversations/C1/threads/${MESSAGE.ts}?cursor=replies&limit=10`);
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.replies', {
      channel: 'C1',
      ts: MESSAGE.ts,
      limit: 10,
      cursor: 'replies',
    });
    expect(ctx.deliver).not.toHaveBeenCalled();
  });

  it('opens a DM, sends a human reply immediately and syncs read positions', async () => {
    const ctx = await setup();
    const events = await stream(ctx);
    const opened = await ctx.request(`${ctx.at}/direct-messages`, { method: 'POST', body: { userId: 'U1' } });
    expect(opened.status).toBe(201);
    expect(await opened.json()).toEqual({ conversation: CONVERSATIONS[1] });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.open', { users: 'U1', return_im: true });
    const sent = await ctx.request(`${ctx.at}/conversations/D1/messages`, {
      method: 'POST',
      body: { text: '  I will look into it  ', threadTs: MESSAGE.ts },
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({
      channel: 'D1',
      ts: '1700000002.000001',
      message: { text: 'I will look into it', user: 'U3' },
    });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'chat.postMessage', {
      channel: 'D1',
      text: 'I will look into it',
      thread_ts: MESSAGE.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(ctx.s.pending()).toEqual([]);
    // This DM has no agent mapping to supersede: human sends must not
    // allocate routing entries for an unrelated conversation.
    expect(ctx.stored.slack_conversations).toBeUndefined();
    const read = await ctx.request(`${ctx.at}/conversations/D1/read`, {
      method: 'POST',
      body: { ts: MESSAGE.ts },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.mark', { channel: 'D1', ts: MESSAGE.ts });
    expect(await events.next()).toEqual({
      name: 'conversation.read',
      data: { workspaceId: ctx.w.id, channel: 'D1', ts: MESSAGE.ts },
    });
  });

  it('lists all conversation types by default and preserves empty-page pagination', async () => {
    const ctx = await setup();
    ctx.api.mockResolvedValueOnce({ channels: [], response_metadata: { next_cursor: 'keep-going' } });
    expect(await ctx.json(`${ctx.at}/conversations`)).toEqual({
      conversations: [],
      nextCursor: 'keep-going',
    });
    expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.list', {
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 100,
      cursor: '',
    });
    ctx.api.mockResolvedValueOnce({ messages: [], response_metadata: { next_cursor: 'keep-going' } });
    expect(await ctx.json(`${ctx.at}/conversations/C1/messages`)).toEqual({
      messages: [],
      nextCursor: 'keep-going',
      hasMore: true,
    });
  });

  it('rejects malformed requests before any Slack call', async () => {
    const ctx = await setup();
    const before = ctx.api.mock.calls.length;
    for (const [path, opts] of [
      ['/conversations?limit=0'],
      ['/conversations?limit=201'],
      ['/conversations?limit=1.5'],
      ['/conversations?limit=1&limit=2'],
      ['/conversations?types=unknown'],
      ['/people?cursor=a&cursor=b'],
      ['/conversations/wrong/messages'],
      ['/conversations/C1/messages?oldest=yesterday'],
      ['/conversations/C1/threads/invalid'],
      ['/direct-messages', { method: 'POST', body: { userId: 'customer' } }],
      ['/conversations/C1/messages', { method: 'POST', body: { text: ' ' } }],
      ['/conversations/C1/messages', { method: 'POST', body: { text: 'a'.repeat(8001) } }],
      ['/conversations/C1/messages', { method: 'POST', body: { text: 'hi', threadTs: 1.1 } }],
      ['/conversations/C1/read', { method: 'POST', body: {} }],
    ])
      expect((await ctx.request(`${ctx.at}${path}`, opts)).status, path).toBe(400);
    expect(ctx.api).toHaveBeenCalledTimes(before);
    expect((await ctx.request('/9999/conversations')).status).toBe(404);
  });

  it('keeps the entire inbox behind admin auth and out of agent endpoints', async () => {
    const ctx = await setup();
    const before = ctx.api.mock.calls.length;
    const paths = [
      ['', {}],
      [`${ctx.at}/conversations`, {}],
      [`${ctx.at}/people`, {}],
      [`${ctx.at}/conversations/C1`, {}],
      [`${ctx.at}/conversations/C1/messages`, {}],
      [`${ctx.at}/conversations/C1/threads/${MESSAGE.ts}`, {}],
      [`${ctx.at}/events`, {}],
      [`${ctx.at}/direct-messages`, { method: 'POST', body: { userId: 'U1' } }],
      [`${ctx.at}/conversations/C1/messages`, { method: 'POST', body: { text: 'hi' } }],
      [`${ctx.at}/conversations/C1/read`, { method: 'POST', body: { ts: MESSAGE.ts } }],
    ];
    for (const permission of ['read', 'manage'])
      for (const [path, opts] of paths)
        expect((await ctx.request(path, { ...opts, token: ctx.tokens[permission] })).status).toBe(403);
    expect((await ctx.request(`${ctx.at}/conversations`, { token: 'agent-session-token' })).status).toBe(401);
    expect((await fetch(`${ctx.url}/api/slack/inbox/${ctx.w.id}/conversations`)).status).toBe(404);
    expect((await fetch(`${ctx.url}/api/agent/slack/inbox`)).status).toBe(404);
    expect(ctx.api).toHaveBeenCalledTimes(before);
  });

  it('passes Slack missing-scope and rate-limit errors through without sending twice', async () => {
    const ctx = await setup();
    const wireApi = createSlackApi({
      fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
    });
    ctx.api.mockImplementationOnce(wireApi);
    const response = await ctx.request(`${ctx.at}/conversations/C1/messages`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    const missingScope = createSlackApi({
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed: 'im:read' })),
    });
    ctx.api.mockImplementationOnce(missingScope);
    const refused = await ctx.request(`${ctx.at}/conversations`);
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toContain('im:read');
    ctx.api.mockRejectedValueOnce(
      Object.assign(new Error('Slack could not be reached: timeout'), { status: 502 }),
    );
    const sent = await ctx.request(`${ctx.at}/conversations/C1/messages`, {
      method: 'POST',
      body: { text: 'hi' },
    });
    expect(sent.status).toBe(502);
    expect(ctx.api.mock.calls.filter(([, method]) => method === 'chat.postMessage')).toHaveLength(1);
  });

  it.each(['rotate', 'remove'])('returns a confirmed send receipt across workspace %s', async (change) => {
    const ctx = await setup();
    let finish;
    ctx.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sending = ctx.s.inbox.send(ctx.w.id, 'D1', { text: 'Human question' });
    if (change === 'rotate') await ctx.s.update(ctx.w.id, { token: `${TOKEN}-rotated` });
    else await ctx.s.remove(ctx.w.id);
    finish({ channel: 'D1', ts: MESSAGE.ts, message: MESSAGE });
    expect(await sending).toEqual({ channel: 'D1', ts: MESSAGE.ts, workspaceChanged: true });
    expect(ctx.api.mock.calls.filter(([, method]) => method === 'chat.postMessage')).toHaveLength(1);
  });

  it('refuses stale history when the workspace is removed during a Slack call', async () => {
    const ctx = await setup();
    let finish;
    ctx.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = ctx.s.inbox.messages(ctx.w.id, 'C1');
    const rejected = expect(reading).rejects.toMatchObject({ status: 409 });
    await ctx.s.remove(ctx.w.id);
    finish({ messages: [MESSAGE] });
    await rejected;
  });
});

describe('live Slack inbox events', () => {
  it.each([429, 502])(
    'recovers history by reconnecting after an access check fails with %s',
    async (status) => {
      const ctx = await setup();
      const events = await stream(ctx);
      ctx.api.mockRejectedValueOnce(Object.assign(new Error('Temporary Slack failure'), { status }));
      const missed = { ...MESSAGE, channel: 'C1' };
      expect(receive(ctx, missed, { authorizations: [] }).status).toBe(200);
      expect((await events.next()).name).toBe('workspace.changed');
      expect(await events.next()).toBeNull();
      // Retried webhooks remain deduplicated; reconnect/history recovers the gap.
      const replacement = await stream(ctx);
      const before = ctx.api.mock.calls.length;
      receive(ctx, missed, { authorizations: [] });
      expect(ctx.api.mock.calls).toHaveLength(before);
      expect((await ctx.json(`${ctx.at}/conversations/C1/messages`)).messages).toEqual([MESSAGE]);
      receive(ctx, missed, { eventId: 'recovered', authorizations: [] });
      expect((await replacement.next()).data.eventId).toBe('recovered');
    },
  );

  it('checks connected-account access when the reported installation belongs to another user', async () => {
    const ctx = await setup();
    const listener = vi.fn();
    ctx.s.inbox.subscribe(ctx.w.id, listener);
    const authorizations = [{ team_id: 'T1', user_id: 'U4', is_bot: false }];
    ctx.api.mockRejectedValueOnce(new Error('channel_not_found'));
    receive(ctx, { ...MESSAGE, channel: 'D4' }, { authorizations });
    await vi.waitFor(() =>
      expect(ctx.api).toHaveBeenCalledWith(TOKEN, 'conversations.info', { channel: 'D4' }),
    );
    expect(listener).not.toHaveBeenCalled();
    // The reported installation is truncated: U3 can still see this shared conversation.
    ctx.api.mockResolvedValueOnce({ channel: { id: 'C1' } });
    receive(ctx, { ...MESSAGE, channel: 'C1' }, { eventId: 'shared', authorizations });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(listener.mock.calls[0][1].event.channel).toBe('C1');
  });

  it('does not publish access-check results after credentials change', async () => {
    const ctx = await setup();
    const listener = vi.fn();
    let finish;
    ctx.s.inbox.subscribe(ctx.w.id, listener);
    ctx.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    receive(ctx, { ...MESSAGE, channel: 'D4' }, { authorizations: [] });
    await ctx.s.update(ctx.w.id, { token: `${TOKEN}-rotated` });
    listener.mockClear();
    ctx.s.inbox.subscribe(ctx.w.id, listener);
    finish({ channel: { id: 'D4' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(listener).not.toHaveBeenCalled();
  });

  it('accepts connected-user authorization anywhere in the installation list', async () => {
    const ctx = await setup();
    const listener = vi.fn();
    ctx.s.inbox.subscribe(ctx.w.id, listener);
    const before = ctx.api.mock.calls.length;
    receive(
      ctx,
      { ...MESSAGE, channel: 'D1' },
      {
        authorizations: [
          { team_id: 'T1', user_id: 'U4', is_bot: false },
          { team_id: 'T1', user_id: 'U3', is_bot: false },
        ],
      },
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(ctx.api).toHaveBeenCalledTimes(before);
  });

  it('streams signed new messages even without an agent conversation, including own messages and bots', async () => {
    const ctx = await setup();
    const events = await stream(ctx);
    const { raw, headers } = signed(ctx.w.id, { ...MESSAGE, channel: 'D1', channel_type: 'im' });
    const response = await fetch(`${ctx.url}/webhooks/slack/${ctx.w.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': headers.timestamp,
        'X-Slack-Signature': headers.signature,
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await events.next()).toEqual({
      name: 'message',
      data: {
        workspaceId: ctx.w.id,
        eventId: 'Ev1',
        event: { ...MESSAGE, channel: 'D1', channel_type: 'im' },
      },
    });
    receive(ctx, { ...MESSAGE, user: 'U3', channel: 'C1' }, { eventId: 'own' });
    expect((await events.next()).data.event.user).toBe('U3');
    receive(ctx, { ...MESSAGE, bot_id: 'B1', subtype: 'bot_message', channel: 'G1' }, { eventId: 'bot' });
    expect((await events.next()).data.event.bot_id).toBe('B1');
    expect(ctx.deliver).not.toHaveBeenCalled();
  });

  it('streams thread replies, edits and deletions, isolating workspaces and deduplicating retries', async () => {
    const ctx = await setup();
    const other = await ctx.s.create({ token: TOKEN, signingSecret: SECRET, projects: [] });
    const events = await stream(ctx);
    const observed = [];
    const second = ctx.s.inbox.subscribe(other.id, (name, data) => observed.push({ name, data }));
    const wrong = signed(other.id, { ...MESSAGE, channel: 'C1' });
    ctx.s.receive(String(other.id), wrong.raw, wrong.headers);
    expect(observed).toHaveLength(1);
    const reply = { ...MESSAGE, channel: 'C1', thread_ts: '1700000000.000001' };
    receive(ctx, reply); // Same Slack event ID in another installation is independent.
    expect((await events.next()).data.event.thread_ts).toBe(reply.thread_ts);
    receive(ctx, reply); // Slack retry.
    receive(ctx, reply, { eventId: 'bad-secret', secret: 'f'.repeat(32) });
    receive(ctx, reply, { eventId: 'wrong-team', team: 'T2' });
    receive(ctx, reply, { eventId: 'missing-team', team: null });
    const changed = {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      message: { ...MESSAGE, text: 'Updated' },
    };
    receive(ctx, changed, { eventId: 'edit' });
    expect(await events.next()).toEqual({
      name: 'message.changed',
      data: { workspaceId: ctx.w.id, eventId: 'edit', event: changed },
    });
    const parent = { ...changed, subtype: 'message_replied', message: { ...MESSAGE, reply_count: 1 } };
    receive(ctx, parent, { eventId: 'parent' });
    expect(await events.next()).toEqual({
      name: 'message.changed',
      data: { workspaceId: ctx.w.id, eventId: 'parent', event: parent },
    });
    const deleted = { type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: MESSAGE.ts };
    receive(ctx, deleted, { eventId: 'delete' });
    expect((await events.next()).name).toBe('message.deleted');
    expect(observed).toHaveLength(1);
    second.close();
    expect(ctx.deliver).not.toHaveBeenCalled();
  });

  it('requires an event secret but allows ordinary history reads without it', async () => {
    const ctx = await setup({ signingSecret: '' });
    expect((await ctx.request(`${ctx.at}/events`)).status).toBe(409);
    expect((await ctx.request(`${ctx.at}/conversations/C1/messages`)).status).toBe(200);
  });

  it('closes streams when their workspace is removed or its credentials change', async () => {
    const ctx = await setup();
    const events = await stream(ctx);
    await ctx.s.update(ctx.w.id, { token: `${TOKEN}-rotated` });
    expect((await events.next()).name).toBe('workspace.changed');
    expect(await events.next()).toBeNull();
    const replacement = await stream(ctx);
    await ctx.s.remove(ctx.w.id);
    expect((await replacement.next()).name).toBe('workspace.removed');
    expect(await replacement.next()).toBeNull();
  });

  it('cleans up closed subscriptions without removing newer listeners', async () => {
    const ctx = await setup();
    const first = vi.fn();
    const old = ctx.s.inbox.subscribe(ctx.w.id, first);
    ctx.s.inbox.disconnect(ctx.w.id, 'workspace.changed');
    const current = vi.fn();
    const active = ctx.s.inbox.subscribe(ctx.w.id, current);
    old.close();
    receive(ctx, { ...MESSAGE, channel: 'C1' });
    expect(current).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledTimes(1);
    active.close();
    receive(ctx, { ...MESSAGE, channel: 'C1' }, { eventId: 'later' });
    expect(current).toHaveBeenCalledOnce();
  });

  it('starts each reconnection with a refresh and recovers missed messages from Slack history', async () => {
    const ctx = await setup();
    const initial = await stream(ctx);
    await initial.reader.cancel();
    // No connected client when Slack emits this update; Slack's history
    // still holds it when the client returns.
    const missed = { ...MESSAGE, text: 'While you were away', ts: '1700000003.000001' };
    receive(ctx, { ...missed, channel: 'C1' });
    const reconnect = await stream(ctx); // Asserted ready.refresh on every connection.
    ctx.api.mockResolvedValueOnce({ messages: [missed] });
    expect(await ctx.json(`${ctx.at}/conversations/C1/messages`)).toEqual({
      messages: [missed],
      nextCursor: '',
      hasMore: false,
    });
    receive(ctx, { ...MESSAGE, channel: 'C1' }, { eventId: 'after-reconnect' });
    expect((await reconnect.next()).data.eventId).toBe('after-reconnect');
  });

  it('ends a live inbox connection when its admin client token is revoked', async () => {
    const ctx = await setup();
    const events = await stream(ctx);
    const client = ctx.auth.authenticate(`Bearer ${ctx.tokens.admin}`, OWNER);
    await ctx.auth.revoke(client.id);
    // Revocation destroys rather than cleanly ends an SSE socket.
    await expect(events.reader.read()).rejects.toThrow();
  });
});
