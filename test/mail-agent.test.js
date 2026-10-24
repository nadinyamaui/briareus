import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mailActionPath, mailAgentRoutes, mailSessionAllowed } from '../lib/mail-agent.js';

let server, base, job, service, project, wakeState, wakeUpdate, inboxOwner;
const interactive = () => ({ id: 'chat', kind: 'devchat', repo: 'owner/repo', status: 'running' });
beforeEach(async () => {
  job = interactive();
  project = { repo: job.repo, enabled: true, mailToolsEnabled: true };
  service = {
    connectStart: vi.fn(async (input) => ({ url: 'https://signin.test', input })),
    connectFinish: vi.fn(async () => ({ id: 7 })),
    list: vi.fn(async () => [
      { id: 7, email: 'me@example.com', access: 'read', enabled: true, status: 'connected' },
    ]),
    messages: vi.fn(async (query) => ({ messages: [], nextCursor: 'next', query })),
    message: vi.fn(async (account, id) => ({ accountId: account, id, bodyText: 'Untrusted email' })),
    sync: vi.fn(async () => ({ syncing: true })),
    action: vi.fn(async () => ({ status: 'accepted' })),
    trashMessage: vi.fn(async () => {}),
    attachment: vi.fn(async () => ({
      name: '../../evil name.pdf',
      mimeType: 'application/pdf',
      size: 3,
      data: Buffer.from('PDF').toString('base64'),
    })),
  };
  // The session reaches its inbox owner's mailboxes; here that view is the fake itself.
  service.forUser = vi.fn(() => service);
  inboxOwner = vi.fn(() => 1);
  wakeState = vi.fn(() => ({ rules: [] }));
  wakeUpdate = vi.fn((id, input) => input);
  const app = express();
  // As server.js: the small app-wide parser skips a send, whose attachments can be large.
  const json = express.json();
  app.use((req, res, next) => (mailActionPath(req.path) ? next() : json(req, res, next)));
  app.use(
    mailAgentRoutes({
      service,
      inboxOwner: (session) => inboxOwner(session),
      wakeState,
      wakeUpdate,
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
      ['/wake-rules', 'GET'],
      ['/wake-rules', 'PUT'],
    ]) {
      const res = await fetch(`${base}/api/agent/mail${path}`, {
        method,
        headers: { Authorization: 'Bearer session-token' },
      });
      expect(res.status).toBe(403);
    }
    expect(service.list).toHaveBeenCalledTimes(1);
    for (const [name, fn] of Object.entries(service))
      if (!['list', 'forUser'].includes(name)) expect(fn).not.toHaveBeenCalled();
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
      '/wake-rules',
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
  it('scopes wake rules to the authenticated session and rejects unknown mailboxes', async () => {
    const send = (body) =>
      fetch(`${base}/api/agent/mail/wake-rules`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const body = { session: 'another-session', rules: [{ account: 7 }] };
    expect((await send(body)).status).toBe(200);
    expect(wakeUpdate).toHaveBeenCalledWith('chat', body);
    expect((await send({ rules: [{ account: 999 }] })).status).toBe(400);
    expect(wakeUpdate).toHaveBeenCalledTimes(1);
  });

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
    expect((await rpc('tools/list')).result.tools).toHaveLength(12);
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
    const saved = JSON.parse(
      (await tool('mail_attachment', { account: 7, id: 'message/+=', attachmentId: 'a/1' })).result.content[0]
        .text,
    );
    expect(service.attachment).toHaveBeenCalledWith(7, 'message/+=', 'a/1', expect.any(Function));
    expect(path.basename(saved.path)).toBe('evil name.pdf');
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('PDF');
    fs.rmSync(path.dirname(saved.path), { recursive: true });
    service.attachment.mockResolvedValueOnce({
      name: `${'a'.repeat(300)}.pdf`,
      mimeType: 'application/pdf',
      size: 3,
      data: 'UERG',
    });
    const long = JSON.parse(
      (await tool('mail_attachment', { account: 7, id: 'm', attachmentId: 'a/1' })).result.content[0].text,
    );
    expect(path.basename(long.path)).toBe(`${'a'.repeat(150)}.pdf`);
    expect(fs.readFileSync(long.path, 'utf8')).toBe('PDF');
    fs.rmSync(path.dirname(long.path), { recursive: true });
    await tool('mail_wake_rules');
    expect(wakeState).toHaveBeenCalledWith('chat');
    await tool('mail_set_wake_rules', { rules: [{ account: 7, from: 'sender@example.com' }] });
    expect(wakeUpdate).toHaveBeenCalledWith('chat', { rules: [{ account: 7, from: 'sender@example.com' }] });
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-send-'));
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    fs.writeFileSync(path.join(dir, 'Informe ñ.pdf'), big);
    fs.writeFileSync(path.join(dir, 'notes'), 'hi');
    try {
      const sent = await tool('mail_send', {
        account: 7,
        to: ['you@example.com'],
        subject: 's',
        text: 'body',
        attachments: [path.join(dir, 'Informe ñ.pdf'), path.join(dir, 'notes')],
      });
      expect(sent.result.isError).toBeUndefined();
      expect(service.action).toHaveBeenLastCalledWith(
        7,
        {
          action: 'send',
          to: ['you@example.com'],
          subject: 's',
          text: 'body',
          attachments: [
            { name: 'Informe ñ.pdf', mimeType: 'application/pdf', data: big.toString('base64') },
            {
              name: 'notes',
              mimeType: 'application/octet-stream',
              data: Buffer.from('hi').toString('base64'),
            },
          ],
        },
        expect.any(Function),
      );
      const relative = await tool('mail_send', {
        account: 7,
        to: ['you@example.com'],
        subject: 's',
        text: 'body',
        attachments: ['notes'],
      });
      expect(relative.result.isError).toBe(true);
      const folder = await tool('mail_send', {
        account: 7,
        to: ['you@example.com'],
        subject: 's',
        text: 'body',
        attachments: [dir],
      });
      expect(folder.result.content[0].text).toMatch(/is not a file/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
    await tool('mail_reply', { account: 7, id: 'message', text: 'yes' });
    expect(service.action).toHaveBeenLastCalledWith(
      7,
      { action: 'reply', id: 'message', text: 'yes' },
      expect.any(Function),
    );
    const replyCalls = service.action.mock.calls.length;
    const attachedReply = await tool('mail_reply', {
      account: 7,
      id: 'message',
      text: 'yes',
      attachments: ['/etc/hostname'],
    });
    expect(attachedReply.result.isError).toBe(true);
    expect(attachedReply.result.content[0].text).toMatch(
      /Only a new email \(mail_send\) can carry attachments/,
    );
    expect(service.action).toHaveBeenCalledTimes(replyCalls);
    await tool('mail_update', { account: 7, id: 'message', action: 'archive' });
    expect(service.action).toHaveBeenLastCalledWith(
      7,
      { action: 'archive', id: 'message' },
      expect.any(Function),
    );
    await tool('mail_update', { account: 7, id: 'message/+=', action: 'trash' });
    expect(service.trashMessage).toHaveBeenCalledWith(7, 'message/+=', expect.any(Function));
    expect(service.action).toHaveBeenCalledTimes(4);
    job.unattendedTurn = true;
    expect((await tool('mail_accounts')).result.isError).toBe(true);
    expect((await tool('mail_update', { account: 7, id: 'm', action: 'send' })).result.isError).toBe(true);
  } finally {
    child.kill();
    lines.close();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

describe('whose mail a session reaches', () => {
  it.each([
    ['action', '/accounts/7/action', 'POST', null],
    ['trashMessage', '/accounts/7/messages/id/trash', 'POST', null],
    ['attachment', '/accounts/7/messages/id/attachments/file', 'GET', null],
    ['action', '/accounts/7/action', 'POST', 2],
  ])(
    'rechecks the owner before delayed %s executes (%s, %s, owner %s)',
    async (name, path, method, owner) => {
      const started = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const execute = vi.fn();
      service[name].mockImplementation(async (...args) => {
        started.resolve();
        await resume.promise;
        args.at(-1)();
        execute();
        return {};
      });
      const response = fetch(`${base}/api/agent/mail${path}`, {
        method,
        headers: { Authorization: 'Bearer session-token' },
      });
      await started.promise;
      inboxOwner.mockReturnValue(owner);
      resume.resolve();
      expect((await response).status).toBe(403);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('reaches its inbox owner’s mailboxes, and none when it has no owner', async () => {
    const headers = { Authorization: 'Bearer session-token' };
    expect((await fetch(`${base}/api/agent/mail/accounts`, { headers })).status).toBe(200);
    expect(service.forUser).toHaveBeenCalledWith(1);
    inboxOwner.mockReturnValue(null);
    const refused = await fetch(`${base}/api/agent/mail/accounts`, { headers });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'This session has no user whose mail it could reach' });
  });
});
