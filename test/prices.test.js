import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));

const { priceFor, cacheShareOf, withEstimates, loadCatalog, resetCatalog, DEFAULT_CACHE_SHARE } =
  await import('../lib/prices.js');

// A catalog in the shape models.dev publishes, cut down to what the tests ask
// of it: a vendor, a reseller quoting the same models, and a model only the
// resellers sell.
const CATALOG = {
  anthropic: {
    models: {
      'claude-opus-5': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
    },
  },
  openai: {
    models: { 'gpt-5.6-sol': { cost: { input: 4, output: 20, cache_read: 0.4 } } },
  },
  xai: { models: { 'grok-4.6': { cost: { input: 2, output: 6, cache_read: 0.5 } } } },
  gatewayA: {
    models: {
      'claude-opus-5': { cost: { input: 50, output: 50 } },
      'gpt-5.6-sol': { cost: { input: 50, output: 50 } },
      'glm-5.3': { cost: { input: 1, output: 4, cache_read: 0.2 } },
    },
  },
  gatewayB: { models: { 'glm-5.3': { cost: { input: 2, output: 6, cache_read: 0.4 } } } },
  codingPlan: { models: { 'glm-5.3': { cost: { input: 0, output: 0 } } } },
};

describe('priceFor', () => {
  it('prices a binary’s model at its vendor, not at whichever reseller lists it', () => {
    expect(priceFor(CATALOG, 'claude', 'claude-opus-5')).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
    });
    expect(priceFor(CATALOG, 'codex', 'gpt-5.6-sol')).toEqual({ input: 4, output: 20, cacheRead: 0.4 });
    expect(priceFor(CATALOG, 'grok', 'grok-4.6')).toEqual({ input: 2, output: 6, cacheRead: 0.5 });
  });
  it('reads an opencode model reference as the service it names', () => {
    expect(priceFor(CATALOG, 'opencode', 'anthropic/claude-opus-5').input).toBe(5);
  });
  it('takes the median of the resellers for a model no vendor of ours sells', () => {
    // gatewayA and gatewayB, with the coding plan's $0 left out: a seat-billed
    // plan quotes nothing per token and would halve the estimate.
    const price = priceFor(CATALOG, 'codex', 'glm-5.3');
    expect(price.input).toBe(1.5);
    expect(price.output).toBe(5);
    expect(price.cacheRead).toBeCloseTo(0.3, 6);
  });
  it('has no price for a model nothing in the catalog sells', () => {
    expect(priceFor(CATALOG, 'codex', 'RadixArk/Qwen3.8-27B-NVFP4')).toBeNull();
    expect(priceFor(CATALOG, 'codex', '')).toBeNull();
    expect(priceFor({}, 'codex', 'gpt-5.6-sol')).toBeNull();
  });
  it('falls back to the input price when a model has no cache rate', () => {
    const catalog = { openai: { models: { 'gpt-x': { cost: { input: 3, output: 9 } } } } };
    expect(priceFor(catalog, 'codex', 'gpt-x').cacheRead).toBe(3);
  });
});

describe('cacheShareOf', () => {
  const price = { input: 5, output: 25, cacheRead: 0.5 };
  const priceOf = () => price;
  it('solves the share out of what the priced turns actually cost', () => {
    // 10M input at a 70% cache share is 10 * (0.7*0.5 + 0.3*5) = $18.50, plus
    // 1M output at $25.
    const rows = [{ inputTokens: 10e6, outputTokens: 1e6, costUsd: 18.5 + 25 }];
    expect(cacheShareOf(rows, priceOf)).toBeCloseTo(0.7, 6);
  });
  it('keeps the default when there is too little priced input to measure', () => {
    const rows = [{ inputTokens: 1000, outputTokens: 10, costUsd: 0.01 }];
    expect(cacheShareOf(rows, priceOf)).toBe(DEFAULT_CACHE_SHARE);
  });
  it('ignores the free turns, which would otherwise read as all cache', () => {
    const rows = [
      { inputTokens: 10e6, outputTokens: 1e6, costUsd: 18.5 + 25 },
      { inputTokens: 50e6, outputTokens: 1e6, costUsd: 0 },
    ];
    expect(cacheShareOf(rows, priceOf)).toBeCloseTo(0.7, 6);
  });
  it('stays inside 0..1 when the reported cost is nothing the list price explains', () => {
    expect(cacheShareOf([{ inputTokens: 10e6, outputTokens: 0, costUsd: 500 }], priceOf)).toBe(0);
    expect(cacheShareOf([{ inputTokens: 10e6, outputTokens: 0, costUsd: 0.01 }], priceOf)).toBe(1);
  });
});

describe('withEstimates', () => {
  it('prices the turns nobody priced and marks them as estimates', () => {
    const rows = [
      // The claude turns are what the share is measured from: 10M input and 1M
      // output for $43.50 is a 70% cache share.
      { provider: 'claude', model: 'claude-opus-5', inputTokens: 10e6, outputTokens: 1e6, costUsd: 43.5 },
      { provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 10e6, outputTokens: 1e6, costUsd: null },
    ];
    const [claude, codex] = withEstimates(rows, CATALOG);
    expect(claude).toBe(rows[0]); // a reported cost is never touched
    expect(codex.costEstimated).toBe(true);
    // 10M at 0.7*0.4 + 0.3*4 = $1.48/M, plus 1M of output at $20.
    expect(codex.costUsd).toBeCloseTo(14.8 + 20, 6);
  });
  it('leaves a turn the catalog cannot price alone', () => {
    const rows = [{ provider: 'codex', model: 'private-model', inputTokens: 100, costUsd: null }];
    expect(withEstimates(rows, CATALOG)[0]).toBe(rows[0]);
  });
  it('estimates nothing when there is no catalog at all', () => {
    const rows = [{ provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 100, costUsd: null }];
    expect(withEstimates(rows, {})[0].costUsd).toBeNull();
  });
});

describe('loadCatalog', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
    process.env.XDG_CACHE_HOME = dir;
    resetCatalog();
  });
  afterEach(() => {
    delete process.env.XDG_CACHE_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    resetCatalog();
  });

  it('fetches the catalog once and answers the rest from the cache', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => CATALOG }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadCatalog(1000)).toEqual(CATALOG);
    expect(await loadCatalog(2000)).toEqual(CATALOG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And a fresh process reads the copy on disk instead of the network.
    resetCatalog();
    expect(await loadCatalog(2000)).toEqual(CATALOG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stale copy when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => CATALOG })),
    );
    await loadCatalog(1000);
    resetCatalog();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const day = 24 * 60 * 60 * 1000;
    expect(await loadCatalog(1000 + day + 1)).toEqual(CATALOG);
  });

  it('falls back to the catalog the opencode CLI caches, then to nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadCatalog(1000)).toEqual({});
    resetCatalog();
    fs.mkdirSync(path.join(dir, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode', 'models.json'), JSON.stringify(CATALOG));
    expect(await loadCatalog(1000)).toEqual(CATALOG);
  });
});
