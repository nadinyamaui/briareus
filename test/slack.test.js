import crypto from 'node:crypto';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createSlackService, createSlackApi, verifySlackSignature } from '../lib/slack.js';
import { slackRoutes, slackEventsRouter } from '../lib/slack-routes.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

const TOKEN = 'xoxp-1111-2222-3333-abcdef';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PEOPLE = [
  { id: 'U1', name: 'andres', real_name: 'Andrés Pérez', profile: { display_name: 'Andres' } },
  { id: 'U2', name: 'andrea', real_name: 'Andrea Gómez', profile: { display_name: '' } },
  { id: 'U3', name: 'nadin', real_name: 'Nadin Yamaui', profile: {} },
  { id: 'U4', name: 'gone', real_name: 'Andres Old', deleted: true, profile: {} },
  { id: 'B1', name: 'deploybot', real_name: 'Andres Bot', is_bot: true, profile: {} },
];
const CHANNELS = [
  { id: 'C1', name: 'dev' },
  { id: 'C2', name: 'general' },
];

// Slack, as far as the service talks to it: who a token is, the directory,
// and a record of what was opened and posted.
function fakeSlack() {
  const calls = [];
  const api = vi.fn(async (token, method, params = {}) => {
    calls.push({ token, method, params });
    if (method === 'auth.test')
      return {
        ok: true,
        team: 'Okanet',
        team_id: 'T1',
        user: 'nadin',
        user_id: 'U3',
        url: 'https://okanet.slack.com/',
      };
    if (method === 'users.list') return { ok: true, members: PEOPLE };
    if (method === 'conversations.list') return { ok: true, channels: CHANNELS };
    if (method === 'conversations.open') return { ok: true, channel: { id: `D-${params.users}` } };
    if (method === 'chat.postMessage') return { ok: true, ts: '1700000000.000100' };
    throw new Error(`unexpected ${method}`);
  });
  return { api, calls, posted: () => calls.filter((c) => c.method === 'chat.postMessage') };
}

const job = (over = {}) => ({ id: 'j1', repo: 'o/a', status: 'running', title: 'Fix the importer', ...over });

async function service({ project = {}, unfit = () => null, jobs = { j1: job() } } = {}) {
  const slack = fakeSlack();
  const stored = {};
  const save = vi.fn(async (key, value) => {
    stored[key] = value;
  });
  const deliver = vi.fn(() => ({ status: 'running' }));
  const note = vi.fn();
  const s = createSlackService({
    load: async (key, fallback) => stored[key] ?? fallback,
    save,
    api: slack.api,
    getJob: (id) => jobs[id] || null,
    deliver,
    note,
    unfit,
    eventsUrl: (id) => `https://briareus.example/webhooks/slack/${id}`,
    log: () => {},
  });
  await s.init();
  const w = await s.create({
    token: TOKEN,
    signingSecret: SECRET,
    projects: [{ repo: 'o/a', channels: ['#dev'], ...project }],
  });
  return { s, w, slack, stored, save, deliver, note, jobs };
}

function signed(body, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${at}:`).update(raw).digest('hex')}`;
  return { raw, headers: { timestamp: String(at), signature } };
}

describe('the Slack workspaces', () => {
  it('checks the token with Slack, stores it and the secret sealed, and never hands them back', async () => {
    const { w, stored } = await service();
    expect(w).toEqual({
      id: expect.any(Number),
      label: 'Okanet',
      projects: [{ repo: 'o/a', channels: ['dev'], directMessages: true, permissionMode: 'ask' }],
      team: 'Okanet',
      teamId: 'T1',
      user: 'nadin',
      userId: 'U3',
      url: 'https://okanet.slack.com/',
      hasToken: true,
      hasSigningSecret: true,
      eventsUrl: `https://briareus.example/webhooks/slack/${w.id}`,
    });
    const row = stored.slack_workspaces[0];
    expect(row.token).toMatch(/^v1:/);
    expect(row.signingSecret).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('keeps the stored token when an edit leaves it blank, and asks Slack nothing then', async () => {
    const { s, w, slack } = await service();
    const before = slack.calls.length;
    const updated = await s.update(w.id, { label: 'Work', token: '', projects: [{ repo: 'o/a' }] });
    expect(updated).toMatchObject({
      label: 'Work',
      hasToken: true,
      projects: [{ repo: 'o/a', channels: [] }],
    });
    expect(slack.calls.length).toBe(before);
  });

  it.each([{ projects: [] }, { projects: [{ repo: 'o/a', directMessages: false, permissionMode: 'ask' }] }])(
    'rejects a token update if concurrent restrictions were saved: %j',
    async (restrictions) => {
      const { s, w, slack, stored } = await service({ project: { permissionMode: 'allow' } });
      const originalToken = stored.slack_workspaces[0].token;
      const auth = await slack.api(TOKEN, 'auth.test');
      let finishValidation;
      const validating = new Promise((resolve) => {
        slack.api.mockImplementationOnce(() => {
          resolve();
          return new Promise((done) => {
            finishValidation = () => done(auth);
          });
        });
      });
      const rotation = s.update(w.id, { token: `${TOKEN}-rotated` });
      const rejected = expect(rotation).rejects.toMatchObject({ status: 409 });
      await validating;
      const restricted = await s.update(w.id, restrictions);
      finishValidation();
      await rejected;

      expect(s.list()).toEqual([restricted]);
      expect(stored.slack_workspaces[0].projects).toEqual(restricted.projects);
      expect(stored.slack_workspaces[0].token).toBe(originalToken);
      await expect(s.request(job(), { to: 'U1', text: 'Hi' })).rejects.toThrow(
        restrictions.projects.length ? 'may not send direct messages' : 'no Slack workspace',
      );
      expect(slack.posted()).toHaveLength(0);
    },
  );

  it('refuses a bot token, a project in two workspaces and settings it cannot use', async () => {
    const { s } = await service();
    await expect(s.create({ token: 'xoxb-1-2-abcdefghijkl', projects: [] })).rejects.toThrow('user token');
    await expect(s.create({ token: TOKEN, projects: [{ repo: 'o/a' }] })).rejects.toThrow(
      'o/a already sends through the Okanet workspace',
    );
    await expect(
      s.create({ token: TOKEN, projects: [{ repo: 'o/b', permissionMode: 'yolo' }] }),
    ).rejects.toThrow('permission mode');
    await expect(s.create({ token: TOKEN, projects: [{ repo: 'o/b', channels: ['a b'] }] })).rejects.toThrow(
      'not a Slack channel',
    );
    await expect(s.create({ projects: [] })).rejects.toThrow('Enter a Slack user token');
    expect(s.list()).toHaveLength(1);
  });

  it('lists the workspace a project sends through', async () => {
    const { s } = await service();
    expect(s.list('o/a')).toHaveLength(1);
    expect(s.list('o/b')).toEqual([]);
    expect(s.briefing('o/a')).toEqual({
      team: 'Okanet',
      user: 'nadin',
      permissionMode: 'ask',
      directMessages: true,
      channels: ['dev'],
      replies: true,
    });
    expect(s.briefing('o/b')).toBeNull();
  });
});

describe('a session sending', () => {
  it('finds people by any of their names, the closest first, and never the deleted or the bots', async () => {
    const { s } = await service();
    const found = await s.findPeople(job(), 'andres');
    expect(found.map((p) => p.id)).toEqual(['U1']);
    expect(found[0]).toEqual({
      id: 'U1',
      handle: 'andres',
      realName: 'Andrés Pérez',
      displayName: 'Andres',
      title: '',
    });
    expect((await s.findPeople(job(), 'andr')).map((p) => p.id)).toEqual(['U2', 'U1']);
    expect((await s.findPeople(job(), 'Pérez')).map((p) => p.id)).toEqual(['U1']);
  });

  it('holds a message for approval in ask mode, and approving it opens the DM and sends it', async () => {
    const { s, slack, stored, note } = await service();
    const r = await s.request(job(), { to: 'U1', text: 'The importer is fixed' });
    expect(r).toMatchObject({
      status: 'pending',
      to: { kind: 'user', id: 'U1', label: '@andres (Andrés Pérez)' },
      sendsAs: 'nadin',
      unattended: false,
    });
    expect(slack.posted()).toHaveLength(0);
    expect(s.pending().map((p) => p.id)).toEqual([r.id]);
    expect(s.pending()[0].snapshot).toBeUndefined();

    const sent = await s.decide(r.id, 'approve');
    expect(sent).toMatchObject({ status: 'sent', result: { channel: 'D-U1', ts: '1700000000.000100' } });
    expect(slack.posted()[0].params).toMatchObject({ channel: 'D-U1', text: 'The importer is fixed' });
    expect(stored.slack_conversations).toEqual([
      expect.objectContaining({
        channel: 'D-U1',
        ts: '1700000000.000100',
        jobId: 'j1',
        to: '@andres (Andrés Pérez)',
      }),
    ]);
    expect(note).toHaveBeenCalledWith('j1', expect.stringContaining('approved message to @andres'));
    await expect(s.decide(r.id, 'approve')).rejects.toThrow('no longer waiting');
    expect(s.result(job(), r.id).status).toBe('sent');
    expect(() => s.result(job({ id: 'other' }), r.id)).toThrow('not found');
  });

  it('sends at once in allow mode, except in a turn nobody is watching', async () => {
    const { s, slack } = await service({ project: { permissionMode: 'allow' } });
    expect(await s.request(job(), { to: '#dev', text: 'Deployed' })).toMatchObject({
      status: 'sent',
      to: { kind: 'channel', id: 'C1', label: '#dev' },
    });
    expect(slack.posted()[0].params.channel).toBe('C1');
    const unwatched = await s.request(job({ unattendedTurn: true }), { to: '@andres', text: 'Hi' });
    expect(unwatched).toMatchObject({ status: 'pending', unattended: true });
    expect(slack.posted()).toHaveLength(1);
  });

  it('refuses channels the project does not list, people when direct messages are off, and the wrong sessions', async () => {
    const { s } = await service({ project: { directMessages: false } });
    await expect(s.request(job(), { to: '#general', text: 'x' })).rejects.toThrow(
      '#general is not one of this project’s Slack channels (#dev)',
    );
    await expect(s.request(job(), { to: 'U1', text: 'x' })).rejects.toThrow('may not send direct messages');
    await expect(s.findPeople(job(), 'andres')).rejects.toThrow('may not send direct messages');
    await expect(s.request(job({ repo: 'o/b' }), { to: '#dev', text: 'x' })).rejects.toThrow(
      'no Slack workspace',
    );
    await expect(s.request(job({ status: 'idle' }), { to: '#dev', text: 'x' })).rejects.toThrow('running');
    await expect(s.request(job(), { to: '#dev', text: '  ' })).rejects.toThrow('Write a message');
    const { s: picky } = await service({ unfit: () => 'A worker takes its work from its orchestrator' });
    await expect(picky.request(job(), { to: '#dev', text: 'x' })).rejects.toThrow('not for this session');
  });

  it('cancels what waits when the settings change, and a denial is said in the session', async () => {
    const { s, w, note } = await service();
    const a = await s.request(job(), { to: 'U1', text: 'one' });
    const b = await s.request(job(), { to: 'U1', text: 'two' });
    await s.decide(b.id, 'deny');
    expect(note).toHaveBeenCalledWith('j1', 'Slack: you denied the message to @andres (Andrés Pérez).');
    await s.update(w.id, { projects: [{ repo: 'o/a', channels: ['dev', 'general'] }] });
    expect(s.result(job(), a.id)).toMatchObject({
      status: 'cancelled',
      error: expect.stringMatching(/changed/),
    });
    expect(s.result(job(), b.id).status).toBe('denied');
  });

  it.each([
    ['U1', 'users.list', { repo: 'o/a', directMessages: false, permissionMode: 'ask' }],
    ['U1', 'users.list', { repo: 'o/a', permissionMode: 'ask' }],
    ['#dev', 'conversations.list', { repo: 'o/a', channels: [], permissionMode: 'allow' }],
    ['U1', 'users.list', null],
  ])('rejects %s when settings change during %s', async (to, method, project) => {
    const { s, w, slack } = await service({ project: { permissionMode: 'allow' } });
    const original = slack.api.getMockImplementation();
    let resume;
    let started;
    const paused = new Promise((resolve) => {
      started = resolve;
    });
    slack.api.mockImplementation(async (...args) => {
      if (args[1] === method) {
        started();
        await new Promise((resolve) => {
          resume = resolve;
        });
      }
      return original(...args);
    });
    const pending = s.request(job(), { to, text: 'Hi' });
    const rejected = expect(pending).rejects.toThrow('Slack settings changed');
    await paused;
    await s.update(w.id, { projects: project ? [project] : [] });
    resume();
    await rejected;
    expect(s.pending()).toEqual([]);
    expect(slack.posted()).toEqual([]);
    expect(slack.calls.some((c) => c.method === 'conversations.open')).toBe(false);
  });

  it('does not post a DM if settings change while opening it', async () => {
    const { s, w, slack } = await service({ project: { permissionMode: 'allow' } });
    const original = slack.api.getMockImplementation();
    slack.api.mockImplementation(async (...args) => {
      if (args[1] === 'conversations.open') await s.update(w.id, { projects: [] });
      return original(...args);
    });
    expect(await s.request(job(), { to: 'U1', text: 'Hi' })).toMatchObject({
      status: 'failed',
      error: 'Slack settings changed; send the message again',
    });
    expect(slack.posted()).toEqual([]);
  });

  it('tells the agent where it may send', async () => {
    const { s } = await service({ project: { channels: ['dev', 'nowhere'] } });
    expect(await s.destinations(job())).toEqual({
      workspace: 'Okanet',
      sendsAs: 'nadin',
      permissionMode: 'ask',
      directMessages: true,
      channels: [{ id: 'C1', name: 'dev' }],
      unknownChannels: ['nowhere'],
    });
  });
});

describe('replies through the Events API', () => {
  async function sentTo(to = 'U1', over = {}) {
    const ctx = await service({ project: { permissionMode: 'allow' }, ...over });
    await ctx.s.request(job(), { to, text: 'Can you review #42?' });
    return ctx;
  }
  const event = (e, id = 'Ev1') => ({
    type: 'event_callback',
    team_id: 'T1',
    event_id: id,
    event: { type: 'message', ...e },
  });

  it('answers Slack’s URL check, and refuses what is not signed with the workspace’s secret', async () => {
    const { s, w } = await service();
    const check = signed({ type: 'url_verification', challenge: 'abc' });
    expect(s.receive(String(w.id), check.raw, check.headers)).toEqual({
      status: 200,
      body: { challenge: 'abc' },
    });
    const forged = signed({ type: 'url_verification', challenge: 'abc' }, 'f'.repeat(32));
    expect(s.receive(String(w.id), forged.raw, forged.headers).status).toBe(401);
    expect(s.receive('999', check.raw, check.headers).status).toBe(401);
  });

  it('hands an answer in the direct message to the session that wrote there, once', async () => {
    const { s, w, deliver } = await sentTo();
    const reply = signed(
      event({
        channel: 'D-U1',
        channel_type: 'im',
        user: 'U1',
        text: 'Sure, <@U3> &amp; I will look',
        ts: '1700000001.0001',
      }),
    );
    const outcome = s.receive(String(w.id), reply.raw, reply.headers);
    expect(outcome).toMatchObject({ status: 200, body: { ok: true } });
    await outcome.then();
    expect(deliver).toHaveBeenCalledWith('j1', {
      text: 'Slack reply from Andrés Pérez (@andres, U1) in a direct message, answering this session’s message to @andres (Andrés Pérez):\n\nSure, @nadin & I will look',
      source: 'Slack @andres',
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    // Slack's retry of the same event.
    expect(s.receive(String(w.id), reply.raw, reply.headers).then).toBeUndefined();
  });

  it('persists human DM supersession, preserves agent threads, and lets a later agent send reclaim replies', async () => {
    const { s, w, deliver, slack } = await service({ project: { permissionMode: 'allow' } });
    const original = slack.api.getMockImplementation();
    slack.api.mockImplementation((token, method, params) =>
      method === 'conversations.open'
        ? Promise.resolve({ channel: { id: 'D1' } })
        : original(token, method, params),
    );
    await s.request(job(), { to: 'U1', text: 'Agent question' });
    await s.inbox.send(w.id, 'D1', { text: 'Human question' });
    await s.init(); // Ownership survives a restart.
    const reply = (id, thread_ts) =>
      signed(
        event(
          {
            channel: 'D1',
            channel_type: 'im',
            user: 'U1',
            text: 'Private answer',
            ts: '1.2',
            thread_ts,
          },
          id,
        ),
      );
    const human = reply('human');
    expect(s.receive(String(w.id), human.raw, human.headers).then).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    const thread = reply('thread', '1700000000.000100');
    await s.receive(String(w.id), thread.raw, thread.headers).then();
    expect(deliver).toHaveBeenCalledOnce();
    // A human reply in the agent thread must also preserve explicit routing.
    await s.inbox.send(w.id, 'D1', { text: 'Human thread reply', threadTs: '1700000000.000100' });
    const nextThread = reply('thread2', '1700000000.000100');
    await s.receive(String(w.id), nextThread.raw, nextThread.headers).then();
    expect(deliver).toHaveBeenCalledTimes(2);
    await s.request(job(), { to: 'U1', text: 'Agent follow-up' });
    const agent = reply('agent');
    await s.receive(String(w.id), agent.raw, agent.headers).then();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('routes a thread reply in a channel, and nothing else said there', async () => {
    const { s, w, deliver } = await sentTo('#dev');
    const elsewhere = signed(
      event(
        { channel: 'C1', channel_type: 'channel', user: 'U2', text: 'lunch?', ts: '1700000002.0001' },
        'Ev2',
      ),
    );
    expect(s.receive(String(w.id), elsewhere.raw, elsewhere.headers).then).toBeUndefined();
    const inThread = signed(
      event(
        {
          channel: 'C1',
          channel_type: 'channel',
          user: 'U2',
          text: 'On it',
          thread_ts: '1700000000.000100',
          ts: '1700000003.0001',
        },
        'Ev3',
      ),
    );
    await s.receive(String(w.id), inThread.raw, inThread.headers).then();
    expect(deliver.mock.calls[0][1].text).toMatch(
      /^Slack reply from Andrea Gómez \(@andrea, U2\) in #dev, thread 1700000000\.000100/,
    );
  });

  it('ignores the operator’s own messages, bots, edits and sessions that are gone', async () => {
    const { s, w, deliver, jobs } = await sentTo();
    const dm = (e, id) => signed(event({ channel: 'D-U1', channel_type: 'im', ts: '1.1', ...e }, id));
    for (const [e, id] of [
      [{ user: 'U3', text: 'me' }, 'a'],
      [{ user: 'U1', bot_id: 'B1', text: 'bot' }, 'b'],
      [{ user: 'U1', subtype: 'message_changed', text: 'edit' }, 'c'],
    ]) {
      const r = dm(e, id);
      expect(s.receive(String(w.id), r.raw, r.headers).then).toBeUndefined();
    }
    delete jobs.j1;
    const late = dm({ user: 'U1', text: 'hello?' }, 'd');
    expect(s.receive(String(w.id), late.raw, late.headers).then).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(['U1', '#dev'])('ignores replies to %s after the project is removed', async (to) => {
    const { s, w, deliver } = await sentTo(to);
    await s.update(w.id, { projects: [] });
    const reply = signed(
      event({
        channel: to === 'U1' ? 'D-U1' : 'C1',
        channel_type: to === 'U1' ? 'im' : 'channel',
        thread_ts: '1700000000.000100',
        user: 'U1',
        text: 'ok',
        ts: '1.2',
      }),
    );
    expect(s.briefing('o/a')).toBeNull();
    expect(s.receive(String(w.id), reply.raw, reply.headers).then).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rechecks project access after looking up the reply sender', async () => {
    const { s, w, deliver, slack } = await sentTo();
    // Replacing the token clears the cached directory, so the reply lookup awaits Slack.
    await s.update(w.id, { token: TOKEN });
    const original = slack.api.getMockImplementation();
    let resume;
    let started;
    const paused = new Promise((resolve) => {
      started = resolve;
    });
    slack.api.mockImplementation(async (...args) => {
      if (args[1] === 'users.list') {
        started();
        await new Promise((resolve) => {
          resume = resolve;
        });
      }
      return original(...args);
    });
    const reply = signed(event({ channel: 'D-U1', channel_type: 'im', user: 'U1', text: 'ok', ts: '1.2' }));
    const outcome = s.receive(String(w.id), reply.raw, reply.headers);
    const delivering = outcome.then();
    await paused;
    await s.update(w.id, { projects: [] });
    resume();
    await delivering;
    expect(deliver).not.toHaveBeenCalled();
  });

  it('says in the session when a reply could not reach the agent', async () => {
    const { s, w, deliver, note } = await sentTo();
    deliver.mockImplementationOnce(() => {
      throw new Error('This session failed');
    });
    const r = signed(event({ channel: 'D-U1', channel_type: 'im', user: 'U1', text: 'ok', ts: '1.2' }));
    await s.receive(String(w.id), r.raw, r.headers).then();
    expect(note).toHaveBeenCalledWith(
      'j1',
      'Slack: a reply from @andres could not reach the agent: This session failed',
    );
  });
});

describe('the wire', () => {
  it('checks a signature’s age as well as its bytes', () => {
    const raw = Buffer.from('{}');
    const at = 1_700_000_000;
    const sig = `v0=${crypto.createHmac('sha256', SECRET).update(`v0:${at}:`).update(raw).digest('hex')}`;
    expect(verifySlackSignature(raw, String(at), sig, SECRET, at * 1000)).toBe(true);
    expect(verifySlackSignature(raw, String(at), sig, SECRET, (at + 301) * 1000)).toBe(false);
    expect(verifySlackSignature(Buffer.from('{ }'), String(at), sig, SECRET, at * 1000)).toBe(false);
    expect(verifySlackSignature(raw, String(at), `${sig}é`, SECRET, at * 1000)).toBe(false);
  });

  it('turns Slack’s errors into ones that say what to do', async () => {
    const answer = (status, body, headers = {}) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
    await expect(
      createSlackApi({ fetchImpl: answer(200, { ok: false, error: 'missing_scope', needed: 'im:write' }) })(
        TOKEN,
        'conversations.open',
      ),
    ).rejects.toThrow('lacks the im:write scope');
    await expect(
      createSlackApi({ fetchImpl: answer(200, { ok: false, error: 'token_revoked' }) })(TOKEN, 'auth.test'),
    ).rejects.toThrow('refused the workspace’s token');
    await expect(
      createSlackApi({ fetchImpl: answer(429, {}, { 'retry-after': '7' }) })(TOKEN, 'users.list'),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('7 s'),
    });
    const fetchImpl = answer(200, { ok: true, ts: '1.1' });
    await createSlackApi({ fetchImpl })(TOKEN, 'chat.postMessage', {
      channel: 'C1',
      text: 'hi',
      thread_ts: '',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(init.body)).toBe('channel=C1&text=hi');
  });

  it('serves the agent’s calls on its session token, and the events route on the raw body', async () => {
    const { s, w, deliver } = await service();
    const app = express();
    app.use('/webhooks/slack', slackEventsRouter({ service: s, log: () => {} }));
    app.use(express.json());
    const agentSession = (req, res) => {
      if (req.headers.authorization === 'Bearer agent') return job();
      res.status(401).json({ error: 'Unknown session token' });
      return null;
    };
    app.use(slackRoutes({ service: s, agentSession, getProject: (r) => (r === 'o/a' ? {} : null) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const people = await fetch(`${base}/api/agent/slack/people?q=andres`, {
        headers: { Authorization: 'Bearer agent' },
      });
      expect((await people.json()).people.map((p) => p.id)).toEqual(['U1']);
      expect((await fetch(`${base}/api/agent/slack/destinations`)).status).toBe(401);
      const sent = await fetch(`${base}/api/agent/slack/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer agent', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'U1', text: 'hi' }),
      });
      const { request } = await sent.json();
      expect(request.status).toBe('pending');
      // The operator's routes are not the agent's.
      const forbidden = await fetch(`${base}/api/slack/requests/${request.id}/decision`, {
        method: 'POST',
        headers: { Authorization: 'Bearer agent', 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(forbidden.status).toBe(403);
      const approved = await fetch(`${base}/api/slack/requests/${request.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(approved.status).toBe(200);
      expect((await approved.json()).request.status).toBe('sent');
      const unknown = await fetch(`${base}/api/slack/workspaces/${w.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [{ repo: 'o/zzz' }] }),
      });
      expect((await unknown.json()).error).toBe('o/zzz is not a project');

      const { raw, headers } = signed({
        type: 'event_callback',
        team_id: 'T1',
        event_id: 'EvW',
        event: {
          type: 'message',
          channel: 'D-U1',
          channel_type: 'im',
          user: 'U1',
          text: 'thanks',
          ts: '2.1',
        },
      });
      const res = await fetch(`${base}/webhooks/slack/${w.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': headers.timestamp,
          'X-Slack-Signature': headers.signature,
        },
        body: raw,
      });
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
