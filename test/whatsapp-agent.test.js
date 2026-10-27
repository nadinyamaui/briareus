import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { whatsappAgentRoutes, whatsappMediaPath, whatsappSessionAllowed } from '../lib/whatsapp-agent.js';
import { createWhatsAppWatcher } from '../lib/whatsapp-watch.js';
import { createWhatsAppService } from '../lib/whatsapp.js';

const CHAT = '34600000000@c.us';
const OTHER = '34611111111@c.us';
const GROUP = '120363000000000000@g.us';
const ROUTES = [
  ['/accounts', 'GET'],
  ['/accounts/default/conversations', 'GET'],
  [`/accounts/default/conversations/${CHAT}/messages`, 'GET'],
  [`/accounts/default/conversations/${CHAT}/messages`, 'POST'],
  [`/accounts/default/conversations/${CHAT}/read`, 'POST'],
  [`/accounts/default/conversations/${CHAT}/voice`, 'POST'],
  [`/accounts/default/conversations/${CHAT}/media`, 'POST'],
  [`/accounts/default/conversations/${CHAT}/messages/m1/media`, 'GET'],
  [`/accounts/default/conversations/${CHAT}/messages/m1/transcript`, 'GET'],
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server, base, job, service, project, watcher, generateSpeech, transcribeVoice, mayUse;
const AUDIO = Buffer.from('OggSfake-opus');
beforeEach(async () => {
  job = { id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' };
  generateSpeech = vi.fn(async () => AUDIO);
  transcribeVoice = vi.fn(async () => 'Hola, ¿me escuchas?');
  project = { repo: job.repo, enabled: true, whatsappToolsEnabled: true };
  service = {
    accounts: vi.fn(async () => ({ configured: true, accounts: [{ id: 'default', status: 'WORKING' }] })),
    conversations: vi.fn(async (_id, query) => ({ conversations: [], nextOffset: null, query })),
    messages: vi.fn(async () => ({ messages: [{ id: 'm1', text: 'Untrusted' }], nextOffset: 50 })),
    send: vi.fn(async (_id, _chat, input) => ({ message: { id: 'sent', text: input.text } })),
    sendVoice: vi.fn(async () => ({ message: { id: 'voice-sent', hasMedia: true } })),
    sendMedia: vi.fn(async () => ({ message: { id: 'media-sent', hasMedia: true } })),
    markRead: vi.fn(async () => ({ ok: true })),
    start: vi.fn(),
    qr: vi.fn(),
    logout: vi.fn(),
    media: vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })),
    createGroup: vi.fn(async (_id, input) => ({ group: { id: GROUP, name: input.name } })),
    addParticipants: vi.fn(async (_id, group, input) => ({
      group: { id: group },
      participants: input.participants.map((id) => ({ id, code: 200, added: true, inviteSent: false })),
    })),
  };
  // The session's owner owns `default` and nothing else.
  mayUse = vi.fn((_job, account) => account === 'default');
  watcher = createWhatsAppWatcher({
    service,
    getJob: () => job,
    allowed: () => true,
    mayUse,
    deliver: () => {},
    load: async (_key, fallback) => fallback,
    save: async () => {},
    log: () => {},
  });
  const app = express();
  // As server.js does: media sends skip the app-wide 1 MB parser.
  const json = express.json({ limit: '1mb' });
  app.use((req, res, next) => (whatsappMediaPath(req.path) ? next() : json(req, res, next)));
  app.use(
    whatsappAgentRoutes({
      service,
      watcher,
      mayUse,
      generateSpeech,
      transcribeVoice,
      getProject: (repo) => (project?.repo === repo ? project : null),
      agentSession: (req, res) => {
        if (req.headers.authorization !== 'Bearer session-token') {
          res.status(401).json({ error: 'Unknown session token' });
          return null;
        }
        return job;
      },
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  watcher.stop();
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, method = 'GET', body = undefined, token = 'session-token') =>
  fetch(`${base}/api/agent/whatsapp${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('session WhatsApp authorization', () => {
  it.each([
    null,
    {},
    { whatsappToolsEnabled: false },
    { whatsappToolsEnabled: 'true' },
    { mailToolsEnabled: true },
    { whatsappToolsEnabled: true, enabled: false },
  ])('refuses projects without their own explicit opt-in: %j', async (settings) => {
    project = settings == null ? null : { repo: job.repo, ...settings };
    for (const [path, method] of ROUTES)
      expect((await request(path, method, method === 'POST' ? { text: 'hi' } : undefined)).status).toBe(403);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens', async () => {
    expect((await request('/accounts', 'GET', undefined, 'bad')).status).toBe(401);
    expect(service.accounts).not.toHaveBeenCalled();
  });

  it.each([
    'parentId',
    'loopParentId',
    'qaParentId',
    'loopFixParentId',
    'autoClose',
    'reviewBranch',
    'qaBranch',
    'readOnly',
    'preview',
    'unattendedTurn',
  ])('refuses %s sessions on every route', async (key) => {
    job[key] = true;
    expect(whatsappSessionAllowed(job, project)).toBe(false);
    for (const [path, method] of ROUTES)
      expect((await request(path, method, method === 'POST' ? { text: 'hi' } : undefined)).status).toBe(403);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([{ status: 'closed' }, { status: 'failed' }, { kind: 'review' }, { repo: '' }])(
    'refuses ineligible sessions %j',
    (fields) => {
      expect(whatsappSessionAllowed({ ...job, ...fields }, project)).toBe(false);
    },
  );

  it('rechecks the opt-in just before sending, after the request was admitted', async () => {
    service.send.mockImplementation(async () => {
      throw new Error('must not send');
    });
    const app = express();
    app.use(express.json());
    // Admitted by the gate, then revoked by the time the handler sends.
    let admitted = false;
    app.use(
      whatsappAgentRoutes({
        service,
        getProject: () => {
          if (!admitted) {
            admitted = true;
            return project;
          }
          return { ...project, whatsappToolsEnabled: false };
        },
        agentSession: () => job,
      }),
    );
    const other = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => other.once('listening', resolve));
    try {
      const res = await fetch(
        `http://127.0.0.1:${other.address().port}/api/agent/whatsapp/accounts/default/conversations/${CHAT}/messages`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi"}' },
      );
      expect(res.status).toBe(403);
      expect(service.send).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('passes service failures through with their status, and hides unexpected ones', async () => {
    service.messages.mockRejectedValueOnce(
      Object.assign(new Error('WhatsApp account, chat or message not found'), { status: 404 }),
    );
    let res = await request(`/accounts/default/conversations/${CHAT}/messages`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'WhatsApp account, chat or message not found' });
    service.accounts.mockRejectedValueOnce(new Error('secret upstream detail'));
    res = await request('/accounts');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'WhatsApp returned an unexpected response' });
  });

  it('exposes no pairing or logout route to sessions', async () => {
    for (const [path, method] of [
      ['/accounts/default', 'GET'],
      ['/accounts/default/start', 'POST'],
      ['/accounts/default/qr', 'GET'],
      ['/accounts/default/logout', 'POST'],
    ])
      expect((await request(path, method)).status).toBe(404);
    for (const name of ['start', 'qr', 'logout']) expect(service[name]).not.toHaveBeenCalled();
  });

  it('returns media as base64 JSON and refuses it past 25 MiB', async () => {
    let res = await request(`/accounts/default/conversations/${CHAT}/messages/m1/media`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mimetype: 'image/png',
      size: PNG.length,
      data: PNG.toString('base64'),
    });
    expect(service.media).toHaveBeenCalledWith('default', CHAT, 'm1', expect.any(AbortSignal));
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    service.media.mockImplementationOnce(async () => new Response(big));
    res = await request(`/accounts/default/conversations/${CHAT}/messages/m1/media`);
    expect(res.status).toBe(413);
    service.media.mockImplementationOnce(
      async () =>
        new Response(new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) }), {
          headers: { 'Content-Type': 'application/pdf' },
        }),
    );
    res = await request(`/accounts/default/conversations/${CHAT}/messages/m1/media`);
    expect(res.status).toBe(413);
  });

  it('transcribes a voice note on the server and refuses media that is not audio', async () => {
    const voiceNote = () => new Response(AUDIO, { headers: { 'Content-Type': 'audio/ogg; codecs=opus' } });
    service.media.mockImplementationOnce(async () => voiceNote());
    let res = await request(`/accounts/default/conversations/${CHAT}/messages/v1/transcript`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Hola, ¿me escuchas?' });
    expect(service.media).toHaveBeenCalledWith('default', CHAT, 'v1', expect.any(AbortSignal));
    expect(transcribeVoice).toHaveBeenCalledWith(AUDIO, {
      type: 'audio/ogg',
      signal: expect.any(AbortSignal),
    });
    service.media.mockImplementationOnce(async () => voiceNote());
    transcribeVoice.mockResolvedValueOnce('');
    res = await request(`/accounts/default/conversations/${CHAT}/messages/v1/transcript`);
    expect(await res.json()).toEqual({ text: '(no speech recognised)' });
    service.media.mockImplementationOnce(async () => voiceNote());
    transcribeVoice.mockRejectedValueOnce(
      Object.assign(new Error('Voice notes are off: set OPENAI_TRANSCRIBE_API_KEY'), { status: 503 }),
    );
    res = await request(`/accounts/default/conversations/${CHAT}/messages/v1/transcript`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Voice notes are off/);
    transcribeVoice.mockClear();
    res = await request(`/accounts/default/conversations/${CHAT}/messages/m1/transcript`);
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('This message is not a voice note (image/png)');
    expect(transcribeVoice).not.toHaveBeenCalled();
  });
});

describe('session WhatsApp watches', () => {
  const json = async (res) => ({ status: res.status, body: await res.json() });

  it('watches the chat a send went to, unless told not to', async () => {
    const sent = await json(
      await request(`/accounts/default/conversations/${CHAT}/messages`, 'POST', { text: 'Hola' }),
    );
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ message: { id: 'sent' }, watch: { chat: CHAT, group: false } });
    expect(service.send).toHaveBeenCalledWith('default', CHAT, { text: 'Hola' });
    const quiet = await json(
      await request(`/accounts/default/conversations/${OTHER}/messages`, 'POST', {
        text: 'FYI',
        watch: false,
      }),
    );
    expect(quiet.body).not.toHaveProperty('watch');
    expect((await json(await request('/watches'))).body.watches.map((w) => w.chat)).toEqual([CHAT]);
    expect(
      (await request(`/accounts/default/conversations/${CHAT}/messages`, 'POST', { text: 'x', watch: 'no' }))
        .status,
    ).toBe(400);
  });

  it('starts the watch from the sent message’s own stamp', async () => {
    const stamp = Math.floor(Date.now() / 1000) - 30;
    service.send.mockResolvedValueOnce({ message: { id: 'sent', text: 'Hola', timestamp: stamp } });
    const sent = await json(
      await request(`/accounts/default/conversations/${CHAT}/messages`, 'POST', { text: 'Hola' }),
    );
    expect(sent.body.watch.since).toBe(new Date(stamp * 1000).toISOString());
  });

  it('opens a group with the given contacts and watches it', async () => {
    const res = await json(
      await request('/accounts/default/groups', 'POST', { name: 'OMD dudas', participants: [CHAT, OTHER] }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      group: { id: GROUP, name: 'OMD dudas' },
      watch: { chat: GROUP, group: true },
    });
    expect(service.createGroup).toHaveBeenCalledWith('default', {
      name: 'OMD dudas',
      participants: [CHAT, OTHER],
    });
  });

  it('adds contacts to an existing group', async () => {
    const res = await json(
      await request(`/accounts/default/conversations/${GROUP}/participants`, 'POST', {
        participants: [OTHER],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.participants).toEqual([{ id: OTHER, code: 200, added: true, inviteSent: false }]);
    expect(service.addParticipants).toHaveBeenCalledWith('default', GROUP, { participants: [OTHER] });
  });

  it('starts, extends and ends a watch by hand', async () => {
    let res = await json(await request(`/accounts/default/conversations/${CHAT}/watch`, 'PUT', { hours: 2 }));
    expect(res.body.watch).toMatchObject({ chat: CHAT });
    res = await json(await request(`/accounts/default/conversations/${CHAT}/watch`, 'PUT', { hours: 99 }));
    expect(res.status).toBe(400);
    res = await json(await request(`/accounts/default/conversations/${CHAT}/watch`, 'DELETE'));
    expect(res.body).toEqual({ removed: true });
    expect((await json(await request('/watches'))).body.watches).toEqual([]);
  });

  it('limits a turn nobody watches to the chats this session watches', async () => {
    job.unattendedTurn = true;
    expect((await request(`/accounts/default/conversations/${CHAT}/messages`)).status).toBe(403);
    expect(service.messages).not.toHaveBeenCalled();
    await watcher.watch(job.id, { account: 'default', chat: CHAT });
    expect((await request(`/accounts/default/conversations/${CHAT}/messages`)).status).toBe(200);
    expect((await request(`/accounts/default/conversations/${CHAT}/messages/m1/media`)).status).toBe(200);
    expect((await request(`/accounts/default/conversations/${CHAT}/read`, 'POST')).status).toBe(200);
    expect(
      (await request(`/accounts/default/conversations/${CHAT}/messages`, 'POST', { text: 'Ok' })).status,
    ).toBe(201);
    for (const [path, method, body] of [
      [`/accounts/default/conversations/${OTHER}/messages`, 'GET'],
      [`/accounts/default/conversations/${OTHER}/messages`, 'POST', { text: 'x' }],
      [`/accounts/default/conversations/${OTHER}/voice`, 'POST', { text: 'x' }],
      [`/accounts/default/conversations/${OTHER}/media`, 'POST', { data: 'eA==' }],
      [`/accounts/default/conversations/${OTHER}/messages/m1/media`, 'GET'],
      [`/accounts/default/conversations/${OTHER}/messages/m1/transcript`, 'GET'],
      [`/accounts/default/conversations/${OTHER}/read`, 'POST'],
      [`/accounts/default/conversations/${OTHER}/watch`, 'PUT', {}],
      ['/accounts', 'GET'],
      ['/accounts/default/conversations', 'GET'],
      ['/accounts/default/groups', 'POST', { name: 'x', participants: [OTHER] }],
      [`/accounts/default/conversations/${CHAT}/participants`, 'POST', { participants: [OTHER] }],
    ]) {
      const res = await request(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error).toMatch(
        /only the chats this session is watching.*adds people to them/,
      );
    }
    expect(service.send).toHaveBeenCalledTimes(1);
    expect(service.accounts).not.toHaveBeenCalled();
    expect(service.conversations).not.toHaveBeenCalled();
    expect(service.createGroup).not.toHaveBeenCalled();
    expect(service.addParticipants).not.toHaveBeenCalled();
    // The project's opt-in still governs it.
    project.whatsappToolsEnabled = false;
    expect((await request(`/accounts/default/conversations/${CHAT}/messages`)).status).toBe(403);
  });
});

it('drives the actual stdio MCP through authenticated HTTP for every tool', async () => {
  const child = spawn(process.execPath, ['lib/whatsapp-mcp.js'], {
    env: { ...process.env, REVIEWER_MEMORY_URL: base, REVIEWER_MEMORY_TOKEN: 'session-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on('line', (line) => {
    const frame = JSON.parse(line);
    waiting.get(frame.id)?.(frame);
  });
  let seq = 0;
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  try {
    expect((await rpc('initialize')).result.serverInfo.name).toBe('reviewer-whatsapp');
    expect((await rpc('tools/list')).result.tools.map((t) => t.name)).toEqual([
      'whatsapp_accounts',
      'whatsapp_conversations',
      'whatsapp_messages',
      'whatsapp_transcribe',
      'whatsapp_media',
      'whatsapp_send',
      'whatsapp_send_voice',
      'whatsapp_send_media',
      'whatsapp_create_group',
      'whatsapp_add_participants',
      'whatsapp_watches',
      'whatsapp_watch',
      'whatsapp_unwatch',
      'whatsapp_mark_read',
    ]);
    const accounts = await tool('whatsapp_accounts');
    expect(JSON.parse(accounts.result.content[0].text).accounts[0].id).toBe('default');
    await tool('whatsapp_conversations', { account: 'default', limit: 20, offset: 40 });
    expect(service.conversations).toHaveBeenCalledWith('default', { limit: '20', offset: '40' });
    await tool('whatsapp_messages', { account: 'default', chat: CHAT });
    expect(service.messages).toHaveBeenCalledWith('default', CHAT, {});
    const media = JSON.parse(
      (await tool('whatsapp_media', { account: 'default', chat: CHAT, message: 'm1' })).result.content[0]
        .text,
    );
    expect(media).toMatchObject({ mimetype: 'image/png', size: PNG.length });
    expect(media.path).toMatch(/whatsapp-media-[^/]+\/media\.png$/);
    expect(fs.readFileSync(media.path)).toEqual(PNG);
    fs.rmSync(path.dirname(media.path), { recursive: true });
    service.media.mockImplementationOnce(
      async () => new Response(AUDIO, { headers: { 'Content-Type': 'audio/ogg; codecs=opus' } }),
    );
    const transcript = await tool('whatsapp_transcribe', { account: 'default', chat: CHAT, message: 'v1' });
    expect(JSON.parse(transcript.result.content[0].text)).toEqual({ text: 'Hola, ¿me escuchas?' });
    const sent = await tool('whatsapp_send', { account: 'default', chat: CHAT, text: 'Hola', replyTo: 'm1' });
    expect(JSON.parse(sent.result.content[0].text).message.id).toBe('sent');
    expect(service.send).toHaveBeenCalledWith('default', CHAT, { text: 'Hola', replyTo: 'm1' });
    await tool('whatsapp_send', { account: 'default', chat: CHAT, text: 'Sin cita' });
    expect(service.send).toHaveBeenLastCalledWith('default', CHAT, { text: 'Sin cita' });
    await tool('whatsapp_send', { account: 'default', chat: OTHER, text: 'Sin respuesta', watch: false });
    const voice = await tool('whatsapp_send_voice', {
      account: 'default',
      chat: CHAT,
      text: 'Hola de voz',
      voice: 'coral',
      replyTo: 'm1',
    });
    expect(JSON.parse(voice.result.content[0].text).message.id).toBe('voice-sent');
    expect(generateSpeech).toHaveBeenCalledWith(
      { text: 'Hola de voz', voice: 'coral' },
      expect.any(AbortSignal),
    );
    expect(service.sendVoice).toHaveBeenCalledWith('default', CHAT, AUDIO, 'm1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-send-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'Floor.JPG'), PNG);
      const media = await tool('whatsapp_send_media', {
        account: 'default',
        chat: CHAT,
        path: path.join(dir, 'Floor.JPG'),
        caption: 'Piso',
        replyTo: 'm1',
      });
      expect(JSON.parse(media.result.content[0].text).message.id).toBe('media-sent');
      expect(service.sendMedia).toHaveBeenCalledWith('default', CHAT, {
        data: PNG,
        mimetype: 'image/jpeg',
        filename: 'Floor.JPG',
        caption: 'Piso',
        replyTo: 'm1',
      });
      const relative = await tool('whatsapp_send_media', { account: 'default', chat: CHAT, path: 'a.jpg' });
      expect(relative.result.isError).toBe(true);
      expect(service.sendMedia).toHaveBeenCalledTimes(1);
      for (const extension of ['unknown', 'constructor', '__proto__']) {
        const filename = `file.${extension}`;
        fs.writeFileSync(path.join(dir, filename), PNG);
        const sent = await tool('whatsapp_send_media', {
          account: 'default',
          chat: CHAT,
          path: path.join(dir, filename),
        });
        expect(sent.result.isError).not.toBe(true);
        expect(service.sendMedia).toHaveBeenLastCalledWith('default', CHAT, {
          data: PNG,
          mimetype: 'application/octet-stream',
          filename,
        });
      }
      const waha = vi.fn(async () => Response.json({ id: 'media-sent', hasMedia: true }));
      service.sendMedia.mockImplementation(
        createWhatsAppService({
          config: () => ({ url: 'http://waha.test', apiKey: 'test-key' }),
          fetcher: waha,
        }).sendMedia,
      );
      for (const [extension, mimetype] of [
        ['mpeg', 'video/mpeg'],
        ['mpg', 'video/mpeg'],
        ['ogv', 'video/ogg'],
        ['wmv', 'video/x-ms-wmv'],
        ['flv', 'video/x-flv'],
        ['m2ts', 'video/mp2t'],
        ['3g2', 'video/3gpp2'],
      ]) {
        const filename = `video.${extension}`;
        fs.writeFileSync(path.join(dir, filename), PNG);
        const sent = await tool('whatsapp_send_media', {
          account: 'default',
          chat: CHAT,
          path: path.join(dir, filename),
          watch: false,
        });
        expect(sent.result.isError).not.toBe(true);
        expect(waha.mock.lastCall[0]).toBe('http://waha.test/api/sendVideo');
        expect(JSON.parse(waha.mock.lastCall[1].body)).toMatchObject({
          convert: true,
          file: { mimetype, filename, data: PNG.toString('base64') },
        });
      }
      for (const [mimetype, extension] of [
        ['video/mp4', 'mp4'],
        ['video/quicktime', 'mov'],
        ['video/QuickTime', 'mov'],
        ['video/x-m4v', 'm4v'],
        ['video/webm', 'webm'],
        ['video/3gpp', '3gp'],
        ['video/3gpp2', '3g2'],
        ['video/x-matroska', 'mkv'],
        ['video/x-msvideo', 'avi'],
        ['video/mpeg', 'mpeg'],
        ['video/ogg', 'ogv'],
        ['video/x-ms-wmv', 'wmv'],
        ['video/x-flv', 'flv'],
        ['video/mp2t', 'm2ts'],
        ['audio/ogg', 'ogg'],
      ]) {
        service.media.mockImplementationOnce(
          async () => new Response(PNG, { headers: { 'Content-Type': mimetype } }),
        );
        const downloaded = JSON.parse(
          (await tool('whatsapp_media', { account: 'default', chat: CHAT, message: 'm1' })).result.content[0]
            .text,
        );
        try {
          expect(path.basename(downloaded.path)).toBe(`media.${extension}`);
          expect(downloaded.mimetype).toBe(mimetype);
          const forwarded = await tool('whatsapp_send_media', {
            account: 'default',
            chat: CHAT,
            path: downloaded.path,
          });
          expect(forwarded.result.isError).not.toBe(true);
          expect(service.sendMedia).toHaveBeenLastCalledWith('default', CHAT, {
            data: PNG,
            mimetype: mimetype.toLowerCase(),
            filename: `media.${extension}`,
          });
          const video = mimetype.startsWith('video/');
          expect(waha.mock.lastCall[0]).toBe(`http://waha.test/api/send${video ? 'Video' : 'File'}`);
          const body = JSON.parse(waha.mock.lastCall[1].body);
          expect(body.file).toEqual({
            mimetype: mimetype.toLowerCase(),
            filename: `media.${extension}`,
            data: PNG.toString('base64'),
          });
          expect(body.convert).toBe(video ? true : undefined);
        } finally {
          fs.rmSync(path.dirname(downloaded.path), { recursive: true });
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
    const group = JSON.parse(
      (await tool('whatsapp_create_group', { account: 'default', name: 'Dudas', participants: [CHAT] }))
        .result.content[0].text,
    );
    expect(group.group.id).toBe(GROUP);
    expect(service.createGroup).toHaveBeenCalledWith('default', { name: 'Dudas', participants: [CHAT] });
    const added = JSON.parse(
      (await tool('whatsapp_add_participants', { account: 'default', chat: GROUP, participants: [OTHER] }))
        .result.content[0].text,
    );
    expect(added.participants[0]).toMatchObject({ id: OTHER, added: true });
    expect(service.addParticipants).toHaveBeenCalledWith('default', GROUP, { participants: [OTHER] });
    let watches = JSON.parse((await tool('whatsapp_watches')).result.content[0].text).watches;
    expect(watches.map((w) => w.chat)).toEqual([CHAT, GROUP]);
    await tool('whatsapp_watch', { account: 'default', chat: OTHER, hours: 1 });
    await tool('whatsapp_unwatch', { account: 'default', chat: CHAT });
    watches = JSON.parse((await tool('whatsapp_watches')).result.content[0].text).watches;
    expect(watches.map((w) => w.chat)).toEqual([GROUP, OTHER]);
    await tool('whatsapp_mark_read', { account: 'default', chat: CHAT });
    expect(service.markRead).toHaveBeenCalledWith('default', CHAT);
    expect((await tool('whatsapp_logout', { account: 'default' })).result.isError).toBe(true);
    project.whatsappToolsEnabled = false;
    const revoked = await tool('whatsapp_accounts');
    expect(revoked.result.isError).toBe(true);
    expect(revoked.result.content[0].text).toMatch(/WhatsApp tools enabled/);
  } finally {
    child.kill();
    lines.close();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

describe('voice note sends', () => {
  const endpoint = `/accounts/default/conversations/${CHAT}/voice`;
  it('watches a successful voice send and accepts watch false', async () => {
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(201);
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(true);
    await watcher.unwatch(job.id, 'default', CHAT);
    expect((await request(endpoint, 'POST', { text: 'Hola', watch: false })).status).toBe(201);
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
  });
  it('rechecks permission after generation', async () => {
    generateSpeech.mockImplementationOnce(async () => {
      project.whatsappToolsEnabled = false;
      return AUDIO;
    });
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(403);
    expect(service.sendVoice).not.toHaveBeenCalled();
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
  });
  it('allows voice replies only while an unattended session still watches the chat', async () => {
    await watcher.watch(job.id, { account: 'default', chat: CHAT });
    job.unattendedTurn = true;
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(201);
    expect(service.sendVoice).toHaveBeenCalledTimes(1);
    generateSpeech.mockImplementationOnce(async () => {
      await watcher.unwatch(job.id, 'default', CHAT);
      return AUDIO;
    });
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(403);
    expect(service.sendVoice).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid watch and reply ids before generation', async () => {
    for (const body of [
      { text: 'Hola', watch: 'true' },
      { text: 'Hola', replyTo: '' },
    ])
      expect((await request(endpoint, 'POST', body)).status).toBe(400);
    expect(generateSpeech).not.toHaveBeenCalled();
    expect(service.sendVoice).not.toHaveBeenCalled();
  });
  it('does not send on a synthesis failure, or retry an uncertain send', async () => {
    generateSpeech.mockRejectedValueOnce(Object.assign(new Error('Speech disabled'), { status: 503 }));
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(503);
    expect(service.sendVoice).not.toHaveBeenCalled();
    service.sendVoice.mockRejectedValueOnce(
      Object.assign(new Error('WAHA did not confirm'), { status: 502 }),
    );
    expect((await request(endpoint, 'POST', { text: 'Hola' })).status).toBe(502);
    expect(service.sendVoice).toHaveBeenCalledTimes(1);
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
  });
});

describe('media sends', () => {
  const endpoint = `/accounts/default/conversations/${CHAT}/media`;
  const file = { mimetype: 'video/mp4', filename: 'floor.mp4' };
  it.each(['media', 'Media'])(
    'takes a file larger than the app-wide JSON limit at /%s and watches the chat',
    async (route) => {
      const video = Buffer.alloc(3 * 1024 * 1024, 7);
      const res = await request(endpoint.replace(/media$/, route), 'POST', {
        ...file,
        data: video.toString('base64'),
      });
      expect(res.status).toBe(201);
      const [, , input] = service.sendMedia.mock.calls[0];
      // Buffer.equals: a deep comparison of megabytes is too slow for the test.
      expect(input.data.equals(video)).toBe(true);
      expect({ ...input, data: null }).toEqual({ ...file, data: null });
      expect(watcher.watching(job.id, 'default', CHAT)).toBe(true);
    },
  );
  it('rejects bad data or watch before sending, and never retries an uncertain send', async () => {
    for (const body of [
      { ...file },
      { ...file, data: 'not base64!' },
      { ...file, data: 'eA==', watch: 'no' },
    ])
      expect((await request(endpoint, 'POST', body)).status).toBe(400);
    expect(service.sendMedia).not.toHaveBeenCalled();
    service.sendMedia.mockRejectedValueOnce(
      Object.assign(new Error('WAHA did not confirm'), { status: 502 }),
    );
    expect((await request(endpoint, 'POST', { ...file, data: 'eA==' })).status).toBe(502);
    expect(service.sendMedia).toHaveBeenCalledTimes(1);
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
  });
  it.each(['', 'A', 'eAAxA', 'AAAAA==', 'eA=', 'eAA==', 'AAAA=', '=eA=', 'eA==='])(
    'rejects malformed base64 %j without sending or watching',
    async (data) => {
      expect((await request(endpoint, 'POST', { ...file, data })).status).toBe(400);
      expect(service.sendMedia).not.toHaveBeenCalled();
      expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
    },
  );
  it.each([
    ['eA==', 'x'],
    ['eA', 'x'],
    ['eHk=', 'xy'],
    ['eHk', 'xy'],
    ['eHl6', 'xyz'],
    ['+/8=', Buffer.from([0xfb, 0xff])],
  ])('preserves valid padded or unpadded base64 %j', async (data, bytes) => {
    const res = await request(endpoint, 'POST', { ...file, data, watch: false });
    expect(res.status).toBe(201);
    expect(service.sendMedia).toHaveBeenCalledExactlyOnceWith('default', CHAT, {
      ...file,
      data: Buffer.from(bytes),
    });
    expect(watcher.watching(job.id, 'default', CHAT)).toBe(false);
  });
  it('parses no body for a session that may not send', async () => {
    project.whatsappToolsEnabled = false;
    const res = await request(endpoint, 'POST', { ...file, data: 'eA==' });
    expect(res.status).toBe(403);
    expect(service.sendMedia).not.toHaveBeenCalled();
  });
});

describe('another user’s WhatsApp', () => {
  it('is left out of the account list and answers as missing on every account route', async () => {
    service.accounts.mockResolvedValue({
      configured: true,
      accounts: [
        { id: 'default', status: 'WORKING' },
        { id: 'bob', status: 'WORKING' },
      ],
    });
    const headers = { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' };
    const listed = await (await fetch(`${base}/api/agent/whatsapp/accounts`, { headers })).json();
    expect(listed.accounts.map((a) => a.id)).toEqual(['default']);
    const read = await fetch(`${base}/api/agent/whatsapp/accounts/bob/conversations`, { headers });
    expect(read.status).toBe(404);
    const sent = await fetch(`${base}/api/agent/whatsapp/accounts/bob/conversations/${CHAT}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(sent.status).toBe(404);
    expect(service.conversations).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });
});
