// @ts-check
import fs from 'fs';
import os from 'os';
import path from 'path';

// What a turn cost when its CLI never said. claude, grok and opencode price
// their turns; codex prices nothing at all, so whole months of the ledger read
// "—" no matter how much they burned. This module puts a number on those turns
// from the models.dev catalog: published list prices per million tokens,
// applied to the tokens the ledger already holds.
//
// Everything it produces is an estimate and travels marked as one
// (`costEstimated` on the row, `estimatedTurns` in every total, `~` on screen).
// A provider's own figure is never touched or second-guessed: a row that
// carries a price keeps it, and a model the catalog does not know stays null
// rather than being guessed at.

const CATALOG_URL = 'https://models.dev/api.json';
// The catalog moves when a vendor changes a price, which is a handful of times
// a year; a day-old copy is the same catalog.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// After a failed fetch, though, retry soon: the usual cause is that this
// machine was offline for a minute, not that models.dev is gone.
const RETRY_MS = 10 * 60 * 1000;

// The service that actually sells each binary's models, so a model id every
// reseller also lists is priced by its vendor rather than by whichever
// gateway happens to be first in the catalog. opencode names its models
// `<service>/<model>` and so answers this question itself.
const HOME_SERVICE = { claude: 'anthropic', codex: 'openai', grok: 'xai' };

// A turn's `inputTokens` is the sum over every model call it made, so the
// context re-sent on each call is counted again every time; nearly all of it
// is a cache read, at a tenth of fresh input. Pricing all of it as fresh input
// would overstate a session several times over. The ledger keeps no cache
// breakdown, so the share is measured from the turns whose provider did report
// a cost (cacheShareOf); this is what those turns imply, and it stands in only
// until a window has enough of them to measure.
export const DEFAULT_CACHE_SHARE = 0.7;
// Below this much priced input the solved share is one session's accident, not
// a measurement, so the default stands.
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

// The catalog, from this app's own copy while it is fresh, else from
// models.dev. A fetch that fails falls back through the stale copy to the one
// opencode's CLI keeps for its model picker: an install with no network keeps
// the prices it already had instead of losing the column.
async function refresh(now) {
  const file = path.join(cacheDir(), 'briareus', 'models.json');
  const cached = readJson(file);
  if (cached && cached.catalog && now - (cached.at || 0) < MAX_AGE_MS) {
    memo = { expires: (cached.at || 0) + MAX_AGE_MS, catalog: cached.catalog };
    return memo.catalog;
  }
  try {
    const res = await fetch(CATALOG_URL);
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

// One catalog entry's cost block as $ per million tokens, or null when it
// carries no usable price. An all-zero block is a subscription plan (a coding
// plan bills a seat, not tokens), which is a real answer for the person on
// that plan and a useless one for everybody else, so it is not a price here.
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

// What a binary's model costs per million tokens, or null when nothing in the
// catalog sells it (a private endpoint's own model, say) and the turn stays
// unpriced.
export function priceFor(catalog, binaryId, model) {
  const id = String(model || '');
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
  // Otherwise every service that sells the same model id has a say: a codex
  // entry pointed at a custom endpoint runs models openai never sold (glm,
  // qwen), and the dozen gateways that do sell them quote prices a few percent
  // apart. The median is the honest middle of that spread, and unlike "the
  // first one found" it does not move when the catalog reorders.
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

// What one million input tokens cost once the cache reads among them are
// priced as cache reads.
function inputRate(price, cacheShare) {
  return cacheShare * price.cacheRead + (1 - cacheShare) * price.input;
}

// The share of input tokens that were cache reads, solved from the rows that
// carry both a reported cost and a catalog price: with the output priced and
// the two input rates known, the reported total leaves exactly one unknown.
// Measuring it beats assuming it, and it is measured over the same window it
// is applied to, so a month of long sessions (heavily cached) and a month of
// short ones do not share one number.
//
// Free turns sit this out: a coding-plan turn reports $0 whatever it consumed,
// and reading that as "all cache" would drag every estimate down with it.
export function cacheShareOf(rows, priceOf) {
  let reported = 0;
  let atFullPrice = 0;
  let spread = 0;
  let tokens = 0;
  for (const r of rows) {
    if (!(r.costUsd > 0)) continue;
    const price = priceOf(r);
    const input = r.inputTokens || 0;
    if (!price || !input) continue;
    reported += r.costUsd - ((r.outputTokens || 0) * price.output) / 1e6;
    atFullPrice += (input * price.input) / 1e6;
    spread += (input * (price.cacheRead - price.input)) / 1e6;
    tokens += input;
  }
  if (tokens < MIN_CALIBRATION_TOKENS || spread >= 0) return DEFAULT_CACHE_SHARE;
  return Math.min(1, Math.max(0, (reported - atFullPrice) / spread));
}

// The ledger rows with a cost on every turn the catalog can price. The pure
// half of the module, so the arithmetic is testable without a catalog on disk.
export function withEstimates(rows, catalog) {
  const prices = new Map(); // "binary\nmodel" -> price | null
  const priceOf = (r) => {
    const key = `${r.provider || ''}\n${r.model || ''}`;
    if (!prices.has(key)) prices.set(key, priceFor(catalog, r.provider, r.model));
    return prices.get(key);
  };
  const cacheShare = cacheShareOf(rows, priceOf);
  return rows.map((r) => {
    if (r.costUsd != null) return r;
    const price = priceOf(r);
    if (!price) return r;
    const costUsd =
      ((r.inputTokens || 0) * inputRate(price, cacheShare) + (r.outputTokens || 0) * price.output) / 1e6;
    return { ...r, costUsd, costEstimated: true };
  });
}

export async function estimateCosts(rows, now = Date.now()) {
  return withEstimates(rows, await loadCatalog(now));
}
