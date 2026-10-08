// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';

// Estimates the cost of turns whose CLI reported none (codex never does) from the
// models.dev catalog's list prices. Estimates are always marked (`costEstimated`,
// `estimatedTurns`, `~` on screen); a provider's own figure is never touched, and an
// unknown model stays null rather than guessed.

const CATALOG_URL = 'https://models.dev/api.json';
// Prices change a few times a year.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Session lists wait on a cold refresh, so a stalled models.dev must not hang them.
const CATALOG_TIMEOUT_MS = 3000;
// Retry soon after a failure; usually this machine was briefly offline.
const RETRY_MS = 10 * 60 * 1000;

// Each binary's vendor, so a model id resellers also list is priced at the vendor's
// rate. opencode's `<service>/<model>` ids name it themselves.
const HOME_SERVICE = { claude: 'anthropic', codex: 'openai', grok: 'xai' };

// A turn's `inputTokens` is the sum over every model call it made, so the
// context re-sent on each call is counted again every time; nearly all of it
// is a cache read, at a tenth of fresh input or less. Pricing all of it as
// fresh input would overstate a session several times over. New Codex rows
// carry the measured cache count. Older rows without it get the share the
// measured rows show (cacheShareOf), or this default, which is what Codex's
// own logs measured across its models: 0.957 to 0.975 of all input.
export const DEFAULT_CACHE_SHARE = 0.96;
// Below this much measured input the share is one session's accident, not a
// measurement, so the default stands.
const MIN_CALIBRATION_TOKENS = 1e6;

let memo = null; // { expires, catalog }
let inFlight = null;

function cacheDir() {
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The catalog from our fresh copy, else models.dev. A failed fetch falls back to the
// stale copy, then opencode's own, so an offline install keeps its prices.
async function refresh(now) {
  const file = path.join(cacheDir(), 'briareus', 'models.json');
  const cached = readJson(file);
  if (cached && cached.catalog && now - (cached.at || 0) < MAX_AGE_MS) {
    memo = { expires: (cached.at || 0) + MAX_AGE_MS, catalog: cached.catalog };
    return memo.catalog;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    if (!catalog || typeof catalog !== 'object') throw new Error('not a catalog');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: now, catalog }));
    } catch {
      /* a read-only cache dir costs the next boot a fetch, nothing more */
    }
    memo = { expires: now + MAX_AGE_MS, catalog };
    return catalog;
  } catch (e) {
    const fallback =
      (cached && cached.catalog) || readJson(path.join(cacheDir(), 'opencode', 'models.json')) || {};
    if (!Object.keys(fallback).length) console.error(`model prices unavailable: ${e.message}`);
    memo = { expires: now + RETRY_MS, catalog: fallback };
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadCatalog(now = Date.now()) {
  if (memo && now < memo.expires) return memo.catalog;
  // One fetch for however many requests arrive while it is in the air.
  if (!inFlight)
    inFlight = refresh(now).finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Only for the tests: the catalog is process-wide state.
export function resetCatalog() {
  memo = null;
  inFlight = null;
}

// A catalog entry's $ per million tokens, or null. An all-zero block is a
// subscription plan billing a seat, not tokens, so it is not a price.
function asPrice(entry) {
  const cost = entry && entry.cost;
  if (!cost) return null;
  const input = Number(cost.input);
  const output = Number(cost.output);
  if (!Number.isFinite(input) || !Number.isFinite(output) || (!input && !output)) return null;
  const cacheRead = Number(cost.cache_read);
  return { input, output, cacheRead: Number.isFinite(cacheRead) ? cacheRead : input };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A binary's model price per million tokens, or null when the catalog lacks it.
export function priceFor(catalog, binaryId, model) {
  // Strip codex's context-window suffix (`gpt-6-astra (872k)`); same rate card.
  const id = String(model || '').replace(/ \(\d+k\)$/, '');
  if (!id || !catalog) return null;
  const slash = id.indexOf('/');
  if (slash > 0) {
    const service = catalog[id.slice(0, slash)];
    const price = asPrice(service && service.models && service.models[id.slice(slash + 1)]);
    if (price) return price;
  }
  const home = catalog[HOME_SERVICE[binaryId]];
  const homePrice = asPrice(home && home.models && home.models[id]);
  if (homePrice) return homePrice;
  // Otherwise take the median over every service selling the id (custom endpoints
  // run models like glm or qwen); unlike the first match, it is order-independent.
  const prices = [];
  for (const service of Object.values(catalog)) {
    const price = asPrice(service && service.models && service.models[id]);
    if (price) prices.push(price);
  }
  if (!prices.length) return null;
  return {
    input: median(prices.map((p) => p.input)),
    output: median(prices.map((p) => p.output)),
    cacheRead: median(prices.map((p) => p.cacheRead)),
  };
}

// Blended input price per million tokens given the cache-read share.
function inputRate(price, cacheShare) {
  return cacheShare * price.cacheRead + (1 - cacheShare) * price.input;
}

// The share of input tokens that were cache reads, measured on catalog-known
// unpriced turns with measured cache counts: the same kind of turn the share
// is then applied to. It is measured over the same window it is applied to, so
// a month of long sessions (heavily cached) and a month of short ones do not
// share one number.
//
// It used to be solved from what the provider-priced turns cost, but those
// are claude's, and claude bills cache writes above fresh input and counts
// them in its input: the solved share came out near 0.8 while Codex really
// reads ~0.96 from cache, doubling every Codex estimate that leaned on it.
export function cacheShareOf(rows, priceOf) {
  let cached = 0;
  let tokens = 0;
  for (const r of rows) {
    if (r.costUsd != null || r.cacheMeasured !== true || !priceOf(r)) continue;
    const input = r.inputTokens || 0;
    const read = r.cachedInputTokens;
    if (!input || read == null || read < 0 || read > input) continue;
    cached += read;
    tokens += input;
  }
  return tokens < MIN_CALIBRATION_TOKENS ? DEFAULT_CACHE_SHARE : cached / tokens;
}

// The ledger rows with a cost on every turn the catalog can price. The pure
// half of the module, so the arithmetic is testable without a catalog on disk.
// `cacheShare` is for a caller that must reproduce estimates priced at a share
// it already knows.
export function withEstimates(rows, catalog, calibrationRows = rows, cacheShare = null) {
  const prices = new Map(); // "binary\nmodel" -> price | null
  const priceOf = (r) => {
    const key = `${r.provider || ''}\n${r.model || ''}`;
    if (!prices.has(key)) prices.set(key, priceFor(catalog, r.provider, r.model));
    return prices.get(key);
  };
  cacheShare ??= cacheShareOf(calibrationRows, priceOf);
  return rows.map((r) => {
    if (r.costUsd != null) return r;
    const price = priceOf(r);
    if (!price) return r;
    const input = r.inputTokens || 0;
    const cached = r.cachedInputTokens;
    const inputCost =
      cached == null || cached < 0 || cached > input
        ? input * inputRate(price, cacheShare)
        : (input - cached) * price.input + cached * price.cacheRead;
    const costUsd = (inputCost + (r.outputTokens || 0) * price.output) / 1e6;
    return { ...r, costUsd, costEstimated: true };
  });
}

export async function estimateCosts(rows, now = Date.now(), calibrationRows = rows) {
  return withEstimates(rows, await loadCatalog(now), calibrationRows);
}
