import express from 'express';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { whatsappAgentRoutes, whatsappSessionAllowed } from '../lib/whatsapp-agent.js';

const CHAT = '34600000000@c.us';
const ROUTES = [
  ['/accounts', 'GET'],
  ['/accounts/default/conversations', 'GET'],
  [`/accounts/default/conversations/${CHAT}/messages`, 'GET'],
  [`/accounts/default/conversations/${CHAT}/messages`, 'POST'],
  [`/accounts/default/conversations/${CHAT}/read`, 'POST'],
];

let server, base, job, service, project;
beforeEach(async () => {
  job = { id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' };
  project = { repo: job.repo, enabled: true, whatsappToolsEnabled: true };
  service = {
    accounts: vi.fn(async () => ({ configured: true, accounts: [{ id: 'default', status: 'WORKING' }] })),
    conversations: vi.fn(async (_id, query) => ({ conversations: [], nextOffset: null, query })),
    messages: vi.fn(async () => ({ messages: [{ id: 'm1', text: 'Untrusted' }], nextOffset: 50 })),
    send: vi.fn(async (_id, _chat, input) => ({ message: { id: 'sent', text: input.text } })),
    markRead: vi.fn(async () => ({ ok: true })),
    start: vi.fn(),
    qr: vi.fn(),
    logout: vi.fn(),
    media: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use(
    whatsappAgentRoutes({
      service,
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

  it('exposes no pairing, logout or media route to sessions', async () => {
    for (const [path, method] of [
      ['/accounts/default', 'GET'],
      ['/accounts/default/start', 'POST'],
      ['/accounts/default/qr', 'GET'],
      ['/accounts/default/logout', 'POST'],
      [`/accounts/default/conversations/${CHAT}/messages/m1/media`, 'GET'],
    ])
      expect((await request(path, method)).status).toBe(404);
    for (const name of ['start', 'qr', 'logout', 'media']) expect(service[name]).not.toHaveBeenCalled();
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
      'whatsapp_send',
      'whatsapp_mark_read',
    ]);
    const accounts = await tool('whatsapp_accounts');
    expect(JSON.parse(accounts.result.content[0].text).accounts[0].id).toBe('default');
    await tool('whatsapp_conversations', { account: 'default', limit: 20, offset: 40 });
    expect(service.conversations).toHaveBeenCalledWith('default', { limit: '20', offset: '40' });
    await tool('whatsapp_messages', { account: 'default', chat: CHAT });
    expect(service.messages).toHaveBeenCalledWith('default', CHAT, {});
    const sent = await tool('whatsapp_send', { account: 'default', chat: CHAT, text: 'Hola', replyTo: 'm1' });
    expect(JSON.parse(sent.result.content[0].text).message.id).toBe('sent');
    expect(service.send).toHaveBeenCalledWith('default', CHAT, { text: 'Hola', replyTo: 'm1' });
    await tool('whatsapp_send', { account: 'default', chat: CHAT, text: 'Sin cita' });
    expect(service.send).toHaveBeenLastCalledWith('default', CHAT, { text: 'Sin cita' });
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
