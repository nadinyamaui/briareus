import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvoyerService } from '../lib/envoyer.js';
import { envoyerRoutes } from '../lib/envoyer-routes.js';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ credentialsKey: 'k'.repeat(32) }) }));

const REPO = 'okanet/buddy';

async function envoyer(...answers) {
  let stored = [];
  const save = vi.fn(async (_key, rows) => {
    stored = rows;
  });
  const request = vi.fn(async () => {
    const [status, body] = answers.shift();
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  const service = createEnvoyerService({ load: async () => [], save, request });
  await service.init();
  const account = await service.create({ label: 'Okanet', repo: REPO, token: 'envoyer-secret' });
  return { service, request, account, stored: () => stored };
}

describe('the Envoyer accounts', () => {
  it('keeps the token sealed and never hands it back', async () => {
    const { service, account, stored } = await envoyer();
    expect(account).toEqual({ id: account.id, label: 'Okanet', repo: REPO });
    expect(stored()[0].token).toMatch(/^v1:/);
    expect(JSON.stringify(stored())).not.toContain('envoyer-secret');
    expect(service.list()).toEqual([account]);
  });

  it('lists only the accounts available to a project', async () => {
    const { service, account } = await envoyer();
    await service.create({ label: 'Other', repo: 'okanet/other', token: 't2' });
    expect(service.list(REPO)).toEqual([account]);
  });

  it('moves an account to another project without its token, and refuses one without a token', async () => {
    const { service, account, request } = await envoyer([200, { projects: [] }]);
    const moved = await service.update(account.id, { repo: 'okanet/other' });
    expect(moved.repo).toBe('okanet/other');
    await expect(service.create({ label: 'No token', repo: REPO })).rejects.toThrow(/token/);
    await expect(service.create({ label: 'x', repo: 'nope', token: 't' })).rejects.toThrow(/project/);
    await service.projects(account.id, 'okanet/other');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer envoyer-secret');
  });
});

describe('the Envoyer proxy', () => {
  it('lists the account’s projects with its token', async () => {
    const { service, account, request } = await envoyer([200, { projects: [{ id: 3, name: 'Buddy' }] }]);
    expect(await service.projects(account.id, REPO)).toEqual({ projects: [{ id: 3, name: 'Buddy' }] });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://envoyer.io/api/projects');
    expect(init.headers.Authorization).toBe('Bearer envoyer-secret');
  });

  it('answers 404 for an account not available to the project named, and calls nothing', async () => {
    const { service, account, request } = await envoyer();
    await expect(service.projects(account.id, 'okanet/other')).rejects.toMatchObject({ status: 404 });
    await expect(service.projects(account.id, undefined)).rejects.toMatchObject({ status: 404 });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses ids that are not plain numbers before calling Envoyer', async () => {
    const { service, account, request } = await envoyer();
    await expect(service.servers(account.id, REPO, '../hooks')).rejects.toMatchObject({ status: 400 });
    await expect(service.deployment(account.id, REPO, '3', 'x')).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads servers, deployments and one deployment under the project', async () => {
    const { service, account, request } = await envoyer(
      [200, { servers: [{ id: 1 }] }],
      [200, { deployments: [{ id: 9 }] }],
      [200, { deployment: { id: 9, status: 'finished' } }],
    );
    expect(await service.servers(account.id, REPO, '3')).toEqual({ servers: [{ id: 1 }] });
    expect(await service.deployments(account.id, REPO, '3')).toEqual({ deployments: [{ id: 9 }] });
    expect(await service.deployment(account.id, REPO, '3', '9')).toEqual({
      deployment: { id: 9, status: 'finished' },
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://envoyer.io/api/projects/3/servers',
      'https://envoyer.io/api/projects/3/deployments',
      'https://envoyer.io/api/projects/3/deployments/9',
    ]);
  });

  it('deploys a branch or a tag, or the default branch when neither is named', async () => {
    const { service, account, request } = await envoyer([200], [200], [200]);
    expect(await service.deploy(account.id, { repo: REPO, branch: 'main' }, '3')).toEqual({ ok: true });
    await service.deploy(account.id, { repo: REPO, tag: 'v1.2.0' }, '3');
    await service.deploy(account.id, { repo: REPO }, '3');
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toEqual([{ from: 'branch', branch: 'main' }, { from: 'tag', tag: 'v1.2.0' }, {}]);
    expect(request.mock.calls[0][1].method).toBe('POST');
    await expect(
      service.deploy(account.id, { repo: REPO, branch: 'main', tag: 'v1' }, '3'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('turns Envoyer refusing the stored token into a 502 naming the account', async () => {
    const { service, account } = await envoyer([401, { message: 'Unauthenticated.' }], [404, {}]);
    await expect(service.projects(account.id, REPO)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('Okanet'),
    });
    await expect(service.project(account.id, REPO, '3')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the Envoyer routes', () => {
  let server;
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  async function serve(service) {
    const app = express();
    app.use(express.json());
    app.use(envoyerRoutes({ service, getProject: (repo) => (repo === REPO ? { repo } : null) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('refuses an agent token, rejects an unknown project and lists what a project may use', async () => {
    const { service, account } = await envoyer();
    const base = await serve(service);
    const agent = await fetch(`${base}/api/envoyer/available?repo=${REPO}`, {
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(agent.status).toBe(403);
    const bad = await fetch(`${base}/api/envoyer/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x', repo: 'okanet/nope', token: 't' }),
    });
    expect(bad.status).toBe(400);
    const listed = await fetch(`${base}/api/envoyer/available?repo=${REPO}`);
    expect(await listed.json()).toEqual({ accounts: [account] });
  });
});
