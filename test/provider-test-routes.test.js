import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));
vi.mock('../lib/db.js', () => ({
  loadProviderRows: async () => [],
  saveProviderRow: async (p) => p,
  deleteProviderRow: async () => true,
  getProviderRow: async () => null,
}));

import { providerTestRoutes } from '../lib/provider-test-routes.js';

// The Test button against a gateway with no model list route: /models answers 404, so the
// route falls back to a chat call with the model under test. Gateway and route are both real.
describe('POST /api/providers/test on a gateway with no model list', () => {
  const rows = [{ id: 7, binary: 'codex', baseUrl: 'x', apiKey: 'k', models: [], efforts: [] }];
  const cfg = { claudeModel: 'claude-opus-5-5' };
  let gateway;
  let app;
  let home;
  const chats = [];

  const listen = (server) =>
    new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
  const close = (server) => new Promise((resolve) => server.close(resolve));

  beforeAll(async () => {
    const g = express();
    g.use(express.json());
    g.get(['/models', '/v1/models'], (req, res) => res.status(404).send('Not Found'));
    g.post(['/responses', '/v1/messages'], (req, res) => {
      chats.push({ path: req.path, model: req.body.model });
      res.json({ id: 'resp_1', object: 'response', type: 'message' });
    });
    gateway = g.listen(0, '127.0.0.1');
    gateway.port = await listen(gateway);

    const a = express();
    a.use(express.json());
    a.use(
      providerTestRoutes({
        getProvider: (id) => rows.find((p) => p.id === Number(id)) || null,
        getConfig: () => cfg,
      }),
    );
    app = a.listen(0, '127.0.0.1');
    app.port = await listen(app);
  });

  afterAll(async () => {
    await close(app);
    await close(gateway);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    chats.length = 0;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  // A models cache in `dir` under a fresh home, naming `slugs`.
  function withCache(dir, slugs) {
    home = home || fs.mkdtempSync(path.join(os.tmpdir(), 'briareus-provider-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(
      path.join(home, dir, 'models_cache.json'),
      JSON.stringify({ models: slugs.map((slug) => ({ slug })) }),
    );
  }

  async function test(form) {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/providers/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${gateway.port}`, apiKey: 'sk-test', ...form }),
    });
    const body = await res.json();
    expect(res.status, body.error).toBe(200);
    expect(body.models).toEqual([]);
    expect(chats.map((c) => c.model)).toEqual([body.probedModel]);
    return body.probedModel;
  }

  it("probes a saved codex row as its own models cache's default", async () => {
    withCache('.codex-provider-7', ['proxy-a', 'proxy-b']);
    expect(await test({ binary: 'codex', id: 7, models: [] })).toBe('proxy-a');
  });

  it('never reads a models cache a crafted id points at', async () => {
    // Passed straight into codexHomeDir, this id would read <home>/evil.
    withCache('evil', ['evil-model']);
    expect(await test({ binary: 'codex', id: 'x/../evil', models: [] })).toBe('gpt-6-sol');
  });

  it('reads no per-row cache for a form not saved yet', async () => {
    withCache('.codex-provider-undefined', ['stray-model']);
    expect(await test({ binary: 'codex', models: [] })).toBe('gpt-6-sol');
  });

  it('parses a posted models string the way a saved row is parsed', async () => {
    // Unparsed, the list would be empty and the catalog would answer instead.
    withCache('.codex', ['gpt-6-sol']);
    expect(await test({ binary: 'codex', models: '\n proxy-x \nproxy-y\n' })).toBe('proxy-x');
  });

  it("probes a claude form as the picker's default, not its first model", async () => {
    expect(await test({ binary: 'claude', models: ['claude-haiku-x', 'claude-opus-5-5'] })).toBe(
      'claude-opus-5-5',
    );
    expect(chats[0].path).toBe('/v1/messages');
  });

  it("keeps a claude form's stored default", async () => {
    expect(
      await test({
        binary: 'claude',
        defaultModel: 'claude-haiku-x',
        models: ['claude-haiku-x', 'claude-opus-5-5'],
      }),
    ).toBe('claude-haiku-x');
  });
});
