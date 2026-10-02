import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createForgeClient } from '../lib/forge.js';
import { forgeRoutes } from '../lib/forge-routes.js';

const FORGE = { token: 'forge-secret', organization: 'okanet' };

function forge(...answers) {
  const request = vi.fn(async () => {
    const [status, body, headers] = answers.shift();
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  });
  const client = createForgeClient({ config: () => ({ forge: FORGE }), request });
  return { client, request };
}

describe('the Forge client', () => {
  it('refuses with 503 and calls nothing when the server has no Forge token', async () => {
    const request = vi.fn();
    const client = createForgeClient({ config: () => ({ forge: null }), request });
    await expect(client.servers()).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });

  it('lists servers under the organization with its token, flattened, with the next cursor', async () => {
    const { client, request } = forge([
      200,
      {
        data: [{ id: '7', type: 'servers', attributes: { id: 7, name: 'web-1', ip_address: '10.0.0.1' } }],
        meta: { next_cursor: 'abc' },
      },
    ]);
    expect(await client.servers('prev')).toEqual({
      servers: [{ id: 7, name: 'web-1', ip_address: '10.0.0.1' }],
      nextCursor: 'abc',
    });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      'https://forge.laravel.com/api/orgs/okanet/servers?page%5Bsize%5D=100&page%5Bcursor%5D=prev',
    );
    expect(init.headers.Authorization).toBe('Bearer forge-secret');
  });

  it('lists a server’s sites and reads one, refusing a site that belongs to another server', async () => {
    const site = (server) => ({
      data: {
        id: '9',
        attributes: { name: 'okanet.net' },
        relationships: { server: { data: { id: server } } },
      },
    });
    const { client, request } = forge(
      [200, { data: [{ id: '9', attributes: { name: 'okanet.net' } }], meta: { next_cursor: null } }],
      [200, site('7')],
      [200, site('8')],
    );
    expect(await client.sites('7')).toEqual({ sites: [{ id: 9, name: 'okanet.net' }], nextCursor: null });
    expect(request.mock.calls[0][0]).toContain('/orgs/okanet/servers/7/sites?');
    expect(await client.site('7', '9')).toEqual({ site: { id: 9, name: 'okanet.net' } });
    expect(request.mock.calls[1][0]).toBe('https://forge.laravel.com/api/orgs/okanet/sites/9');
    await expect(client.site('7', '9')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an id that is not a plain number before calling Forge', async () => {
    const { client, request } = forge();
    await expect(client.environment('7', '../../servers')).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads and replaces a deployment script', async () => {
    const script = (content, auto) => [
      200,
      { data: { id: '1', attributes: { content, auto_source: auto } } },
    ];
    const { client, request } = forge(script('git pull', false), script('git pull\nnpm ci', true));
    expect(await client.deploymentScript('7', '9')).toEqual({ content: 'git pull', autoSource: false });
    expect(
      await client.setDeploymentScript('7', '9', { content: 'git pull\nnpm ci', autoSource: true }),
    ).toEqual({ content: 'git pull\nnpm ci', autoSource: true });
    const [url, init] = request.mock.calls[1];
    expect(url).toBe('https://forge.laravel.com/api/orgs/okanet/servers/7/sites/9/deployments/script');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ content: 'git pull\nnpm ci', auto_source: true });
  });

  it('reads and replaces a site’s .env', async () => {
    const { client, request } = forge(
      [200, { data: { id: '1', attributes: { content: 'APP_ENV=prod' } } }],
      [202],
    );
    expect(await client.environment('7', '9')).toEqual({ content: 'APP_ENV=prod' });
    expect(await client.setEnvironment('7', '9', { content: 'APP_ENV=staging' })).toEqual({ ok: true });
    const [url, init] = request.mock.calls[1];
    expect(url).toBe('https://forge.laravel.com/api/orgs/okanet/servers/7/sites/9/environment');
    expect(JSON.parse(init.body)).toEqual({ environment: 'APP_ENV=staging' });
    await expect(client.setEnvironment('7', '9', {})).rejects.toMatchObject({ status: 400 });
  });

  it('turns Forge’s refusal of its own token into a 502, never the client’s 401', async () => {
    const { client } = forge([401, { message: 'Unauthenticated.' }]);
    await expect(client.servers()).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('FORGE_API_TOKEN'),
    });
  });

  it('passes on rate limiting and validation errors with Forge’s message', async () => {
    const { client } = forge(
      [429, {}, { 'x-ratelimit-reset': '1790000000' }],
      [422, { message: 'The content field is required.' }],
    );
    await expect(client.servers()).rejects.toMatchObject({ status: 429 });
    await expect(client.setDeploymentScript('7', '9', { content: '' })).rejects.toMatchObject({
      status: 422,
      message: 'The content field is required.',
    });
  });
});

describe('the Forge routes', () => {
  async function serve(client, fn) {
    const app = express();
    app.use(express.json());
    app.use(forgeRoutes({ client }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it('hands the path and body to the client and answers with its status on failure', async () => {
    const setEnvironment = vi.fn(async () => ({ ok: true }));
    const sites = vi.fn(async () => {
      throw Object.assign(new Error('Not found on Forge'), { status: 404 });
    });
    await serve({ setEnvironment, sites }, async (base) => {
      const put = await fetch(`${base}/api/forge/servers/7/sites/9/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'A=1' }),
      });
      expect(await put.json()).toEqual({ ok: true });
      expect(setEnvironment).toHaveBeenCalledWith('7', '9', { content: 'A=1' });
      const missing = await fetch(`${base}/api/forge/servers/7/sites`);
      expect(missing.status).toBe(404);
    });
  });

  it('turns away a request still carrying an agent’s token', async () => {
    const servers = vi.fn();
    await serve({ servers }, async (base) => {
      const res = await fetch(`${base}/api/forge/servers`, { headers: { Authorization: 'Bearer agent' } });
      expect(res.status).toBe(403);
      expect(servers).not.toHaveBeenCalled();
    });
  });
});
