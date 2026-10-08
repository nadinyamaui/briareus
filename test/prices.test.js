import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));

const { priceFor, cacheShareOf, withEstimates, loadCatalog, resetCatalog, DEFAULT_CACHE_SHARE } =
  await import('../lib/prices.js');

// A models.dev-shaped catalog cut down to a vendor, a reseller quoting the same models, and a
// model only the resellers sell.
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
    expect(priceFor(CATALOG, 'codex', 'gpt-5.6-sol (872k)')).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.4,
    });
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
  it('measures the share on the unpriced turns that recorded their cache reads', () => {
    const rows = [
      { inputTokens: 6e6, cacheMeasured: true, cachedInputTokens: 5.7e6, costUsd: null },
      { inputTokens: 4e6, cacheMeasured: true, cachedInputTokens: 3.9e6, costUsd: null },
    ];
    expect(cacheShareOf(rows, () => priceFor(CATALOG, 'codex', 'gpt-5.6-sol'))).toBeCloseTo(0.96, 6);
  });
  it('keeps the default when there is too little measured input', () => {
    expect(
      cacheShareOf([{ inputTokens: 1000, cacheMeasured: true, cachedInputTokens: 10, costUsd: null }], () =>
        priceFor(CATALOG, 'codex', 'gpt-5.6-sol'),
      ),
    ).toBe(DEFAULT_CACHE_SHARE);
  });
  it('does not solve the share from what the priced turns cost', () => {
    // claude's turns bill cache writes above fresh input; read as a Codex cache
    // share, $43.50 here would have said 0.7 and doubled every estimate.
    const rows = [{ provider: 'claude', inputTokens: 10e6, outputTokens: 1e6, costUsd: 43.5 }];
    expect(cacheShareOf(rows, () => priceFor(CATALOG, 'codex', 'gpt-5.6-sol'))).toBe(DEFAULT_CACHE_SHARE);
  });
  it('skips counts that cannot be a share of the input', () => {
    const rows = [
      { inputTokens: 10e6, cacheMeasured: true, cachedInputTokens: 9e6, costUsd: null },
      { inputTokens: 10e6, cacheMeasured: true, cachedInputTokens: 20e6, costUsd: null },
      { inputTokens: 10e6, cacheMeasured: true, cachedInputTokens: -1, costUsd: null },
      { inputTokens: 10e6, costUsd: null },
    ];
    expect(cacheShareOf(rows, () => priceFor(CATALOG, 'codex', 'gpt-5.6-sol'))).toBeCloseTo(0.9, 6);
  });
});

describe('withEstimates', () => {
  it('prices the turns nobody priced and marks them as estimates', () => {
    const rows = [
      { provider: 'claude', model: 'claude-opus-5', inputTokens: 10e6, outputTokens: 1e6, costUsd: 43.5 },
      // The share is measured from this turn, which recorded its cache reads:
      // 70% of 10M.
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 10e6,
        cacheMeasured: true,
        cachedInputTokens: 7e6,
        outputTokens: 0,
        costUsd: null,
      },
      { provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 10e6, outputTokens: 1e6, costUsd: null },
    ];
    const [claude, , codex] = withEstimates(rows, CATALOG);
    expect(claude).toBe(rows[0]); // a reported cost is never touched
    expect(codex.costEstimated).toBe(true);
    // 10M at 0.7*0.4 + 0.3*4 = $1.48/M, plus 1M of output at $20.
    expect(codex.costUsd).toBeCloseTo(14.8 + 20, 6);
  });
  it('uses measured cache reads when the CLI reports them', () => {
    const rows = [
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 10e6,
        cacheMeasured: true,
        cachedInputTokens: 9e6,
        outputTokens: 1e6,
        costUsd: null,
      },
    ];
    expect(withEstimates(rows, CATALOG)[0].costUsd).toBeCloseTo(1 * 4 + 9 * 0.4 + 20, 6);
  });
  it('leaves a turn the catalog cannot price alone', () => {
    const rows = [{ provider: 'codex', model: 'private-model', inputTokens: 100, costUsd: null }];
    expect(withEstimates(rows, CATALOG)[0]).toBe(rows[0]);
  });
  it('estimates nothing when there is no catalog at all', () => {
    const rows = [{ provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 100, costUsd: null }];
    expect(withEstimates(rows, {})[0].costUsd).toBeNull();
  });
  it('excludes unknown models from dashboard and lifetime calibration', () => {
    const measured = {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      inputTokens: 1e6,
      cachedInputTokens: 960000,
      cacheMeasured: true,
      costUsd: null,
    };
    const unknown = { ...measured, model: 'private-model', inputTokens: 1e9, cachedInputTokens: 0 };
    const fallback = { ...measured, inputTokens: 10e6, cachedInputTokens: null };
    expect(withEstimates([measured, unknown, fallback], CATALOG)[2].costUsd).toBeCloseTo(5.44);
    expect(withEstimates([fallback], CATALOG, [measured, unknown])[0].costUsd).toBeCloseTo(5.44);
    expect(withEstimates([unknown], CATALOG)[0]).toBe(unknown);
  });
  it('excludes inferred and ambiguous cache counts from calibration without repricing them', () => {
    const measured = {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      inputTokens: 1e6,
      cachedInputTokens: 960000,
      cacheMeasured: true,
      costUsd: null,
    };
    const inferred = { ...measured, inputTokens: 1e9, cachedInputTokens: 5e8, cacheMeasured: false };
    const ambiguous = { ...inferred, cacheMeasured: undefined };
    const fallback = { ...measured, inputTokens: 10e6, cachedInputTokens: null };
    expect(withEstimates([measured, inferred, ambiguous, fallback], CATALOG)[3].costUsd).toBeCloseTo(5.44);
    expect(withEstimates([fallback], CATALOG, [measured, inferred])[0].costUsd).toBeCloseTo(5.44);
    expect(withEstimates([inferred], CATALOG)[0].costUsd).toBeCloseTo(2200);
  });
  it('can calibrate requested rows from a separate lifetime aggregate', () => {
    const rows = [
      { provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 10e6, outputTokens: 1e6, costUsd: null },
    ];
    const calibration = [
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 10e6,
        cacheMeasured: true,
        cachedInputTokens: 5e6,
        costUsd: null,
      },
    ];
    // 10M at 0.5*0.4 + 0.5*4 = $2.20/M, plus 1M of output at $20.
    expect(withEstimates(rows, CATALOG, calibration)[0].costUsd).toBeCloseTo(22 + 20, 6);
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

  it('bounds a stalled catalog refresh', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = loadCatalog(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({});
    vi.useRealTimers();
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
