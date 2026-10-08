import { readFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ githubToken: 'token' }) }));
import { repoArchive } from '../lib/repofiles.js';

// Exercise the actual route without booting the dashboard and its workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(
  source.indexOf("api.get('/api/repo/archive'"),
  source.indexOf("api.get('/api/pr/findings'"),
);
const servers = [];
const clients = [];
const nativeFetch = globalThis.fetch;

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(upstreamHandler) {
  const upstream = await listen(upstreamHandler);
  vi.stubGlobal('fetch', (url, options) => {
    expect(String(url)).toBe('https://api.github.com/repos/owner/repo/tarball/main');
    return nativeFetch(upstream, options);
  });
  const api = express();
  new Function('api', 'getProject', 'repoArchive', route)(api, () => ({ repo: 'owner/repo' }), repoArchive);
  return `${await listen(api)}/api/repo/archive?repo=owner/repo&ref=main`;
}

afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
  vi.unstubAllGlobals();
});

describe('archive response cancellation', () => {
  it.each(['before headers', 'during delivery'])('closes the upstream connection %s', async (phase) => {
    let upstreamResponse;
    const url = await setup((_req, res) => {
      upstreamResponse = res;
      if (phase === 'during delivery') res.write('gz');
    });
    const client = get(url);
    clients.push(client);
    client.on('error', () => {});
    const receiving = new Promise((resolve) => client.once('response', resolve));
    await vi.waitFor(() => expect(upstreamResponse).toBeDefined());
    if (phase === 'during delivery') await receiving;
    client.destroy();
    // The upstream never sends headers in the first case: cancellation must
    // reach the pending fetch, rather than wait for repoArchive to return.
    await vi.waitFor(() => expect(upstreamResponse.destroyed).toBe(true));
  });

  it('delivers a complete archive normally', async () => {
    const url = await setup((_req, res) => {
      res.setHeader('Content-Length', '2');
      res.end('gz');
    });
    const response = await nativeFetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(await response.text()).toBe('gz');
  });
});
