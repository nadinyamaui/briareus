import express from 'express';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mailAgentRoutes, mailSessionAllowed } from '../lib/mail-agent.js';

let server, base, job, service, project;
const interactive = () => ({ id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' });
beforeEach(async () => {
  job = interactive();
  project = { repo: job.repo, enabled: true, mailToolsEnabled: true };
  service = {
    connectStart: vi.fn(async (input) => ({ url: 'https://signin.test', input })),
    connectFinish: vi.fn(async () => ({ id: 7 })),
    list: vi.fn(async () => [{ id: 7, email: 'me@example.com', access: 'read' }]),
    messages: vi.fn(async (query) => ({ messages: [], nextCursor: 'next', query })),
    message: vi.fn(async (account, id) => ({ accountId: account, id, bodyText: 'Untrusted email' })),
    sync: vi.fn(async () => ({ syncing: true })),
    action: vi.fn(async () => ({ status: 'accepted' })),
    trashMessage: vi.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  app.use(
    mailAgentRoutes({
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

const get = (path, token = 'session-token') =>
  fetch(`${base}/api/agent/mail${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('session mailbox authorization', () => {
  it.each([
    null,
    {},
    { mailToolsEnabled: false },
    { mailToolsEnabled: 'true' },
    { mailToolsEnabled: true, enabled: false },
  ])('refuses projects without explicit opt-in: %j', async (settings) => {
    project = settings == null ? null : { repo: job.repo, ...settings };
    const res = await get('/accounts');
    expect(res.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });
  it('revokes every endpoint immediately when the project opt-in is disabled', async () => {
    expect((await get('/accounts')).status).toBe(200);
    project.mailToolsEnabled = false;
    for (const [path, method] of [
      ['/accounts', 'GET'],
      ['/messages', 'GET'],
      ['/accounts/7/messages/id', 'GET'],
      ['/accounts/7/action', 'POST'],
      ['/accounts/7/messages/id/trash', 'POST'],
      ['/accounts/7/sync', 'POST'],
      ['/connect', 'POST'],
      ['/connect/finish', 'POST'],
    ]) {
      const res = await fetch(`${base}/api/agent/mail${path}`, {
        method,
        headers: { Authorization: 'Bearer session-token' },
      });
      expect(res.status).toBe(403);
    }
    expect(service.list).toHaveBeenCalledTimes(1);
    for (const [name, fn] of Object.entries(service)) if (name !== 'list') expect(fn).not.toHaveBeenCalled();
  });
  it('rejects unknown tokens', async () => {
    expect((await get('/accounts', 'bad')).status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
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
    expect(mailSessionAllowed(job, project)).toBe(false);
    for (const path of [
      '/accounts',
      '/messages',
      '/accounts/7/messages/id',
      '/accounts/7/action',
      '/accounts/7/messages/id/trash',
      '/accounts/7/sync',
      '/connect',
      '/connect/finish',
    ]) {
      const res = await fetch(`${base}/api/agent/mail${path}`, {
        method:
          path.endsWith('/action') ||
          path.endsWith('/trash') ||
          path.endsWith('/sync') ||
          path.startsWith('/connect')
            ? 'POST'
            : 'GET',
        headers: { Authorization: 'Bearer session-token' },
      });
      expect(res.status).toBe(403);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
  it.each([{ status: 'closed' }, { status: 'failed' }, { kind: 'review' }, { repo: '' }])(
    'refuses ineligible sessions %j',
    (fields) => {
      expect(mailSessionAllowed({ ...job, ...fields }, project)).toBe(false);
    },
  );
  it('handles service failures with their status', async () => {
    service.message.mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));
    const res = await get('/accounts/7/messages/missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Message not found' });
  });
});

it('drives the actual stdio MCP through authenticated HTTP for every tool', async () => {
  const child = spawn(process.execPath, ['lib/mail-mcp.js'], {
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
    expect((await rpc('initialize')).result.serverInfo.name).toBe('reviewer-mail');
    expect((await rpc('tools/list')).result.tools).toHaveLength(9);
    await tool('mail_connect', { provider: 'gmail', accountId: 7, access: 'manage' });
    expect(service.connectStart).toHaveBeenCalledWith({ provider: 'gmail', accountId: 7, access: 'manage' });
    await tool('mail_finish_connect', { url: 'http://localhost/?state=s&code=c' });
    expect(service.connectFinish).toHaveBeenCalledWith({ url: 'http://localhost/?state=s&code=c' });
    const accounts = await tool('mail_accounts');
    expect(JSON.parse(accounts.result.content[0].text).accounts[0].id).toBe(7);
    await tool('mail_search', { account: 7, q: 'a&b', unread: false, cursor: 'cursor/+=' });
    expect(service.messages).toHaveBeenCalledWith({
      account: '7',
      q: 'a&b',
      unread: 'false',
      cursor: 'cursor/+=',
    });
    await tool('mail_read', { account: 7, id: 'message/+=' });
    expect(service.message).toHaveBeenCalledWith(7, 'message/+=');
    await tool('mail_sync', { account: 7 });
    expect(service.sync).toHaveBeenCalledWith(7);
    await tool('mail_send', { account: 7, to: ['you@example.com'], subject: 's', text: 'body' });
    expect(service.action).toHaveBeenLastCalledWith(
      7,
      {
        action: 'send',
        to: ['you@example.com'],
        subject: 's',
        text: 'body',
      },
      expect.any(Function),
    );
    await tool('mail_reply', { account: 7, id: 'message', text: 'yes' });
    expect(service.action).toHaveBeenLastCalledWith(
      7,
      { action: 'reply', id: 'message', text: 'yes' },
      expect.any(Function),
    );
    await tool('mail_update', { account: 7, id: 'message', action: 'archive' });
    expect(service.action).toHaveBeenLastCalledWith(
      7,
      { action: 'archive', id: 'message' },
      expect.any(Function),
    );
    await tool('mail_update', { account: 7, id: 'message/+=', action: 'trash' });
    expect(service.trashMessage).toHaveBeenCalledWith(7, 'message/+=', expect.any(Function));
    expect(service.action).toHaveBeenCalledTimes(3);
    job.unattendedTurn = true;
    expect((await tool('mail_accounts')).result.isError).toBe(true);
    expect((await tool('mail_update', { account: 7, id: 'm', action: 'send' })).result.isError).toBe(true);
  } finally {
    child.kill();
    lines.close();
    await new Promise((resolve) => child.once('close', resolve));
  }
});
