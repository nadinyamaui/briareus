// @ts-check
import os from 'os';
import path from 'path';
import { loadProviderRows, saveProviderRow, deleteProviderRow, getProviderRow } from './db.js';
import { getConfig } from './config.js';
import {
  BINARIES,
  getBinary,
  ensureClaudeHome,
  readClaudeAuth,
  ensureCodexHome,
  codexWideVariants,
  resolveDefaultModel,
  readCodexAuth,
  ensureGrokHome,
  readGrokAuth,
  ensureOpencodeHome,
} from './providers.js';

// The providers a session can start on: each `providers` row pairs a label with one
// of the hardcoded binaries plus an optional custom endpoint, API key and
// model/effort overrides. Each row's login lives in a config dir derived from its
// id, mirrored into the row. Cached in memory and reloaded on every write.

let cache = [];

export const PROVIDER_DEFAULTS = {
  label: '',
  binary: 'claude',
  active: true,
  baseUrl: '',
  apiKey: '',
  models: [],
  efforts: [],
  defaultModel: '',
  defaultEffort: '',
  authData: null,
  sortOrder: 0,
};

export async function initProviders() {
  await reload();
  await adoptLogins();
  return cache;
}

// Imports the machine's own ~/.codex or ~/.grok login once into rows that have
// none, then ensures each row's derived config dir exists with its stored login.
async function adoptLogins() {
  let changed = false;
  for (const p of cache) {
    try {
      let update = null;
      if (p.binary === 'codex' && !p.baseUrl && !p.apiKey && !p.authData) {
        const machine = readCodexAuth(path.join(os.homedir(), '.codex'));
        if (machine) update = { authData: machine };
      } else if (p.binary === 'grok' && !p.authData) {
        const machine = readGrokAuth(path.join(os.homedir(), '.grok'));
        if (machine) update = { authData: machine };
      }
      if (!update) continue;
      await saveProviderRow({ ...p, ...update });
      changed = true;
      console.log(`Adopted ${p.binary} login for "${p.label}" into the database`);
    } catch (e) {
      console.error(`Could not adopt ${p.binary} login for "${p.label}":`, e.message);
    }
  }
  if (changed) await reload();
  for (const p of cache) {
    try {
      if (p.binary === 'claude') ensureClaudeHome(p);
      else if (p.binary === 'codex') ensureCodexHome(p);
      else if (p.binary === 'grok') ensureGrokHome(p);
      else if (p.binary === 'opencode') ensureOpencodeHome(p);
    } catch {
      /* an unwritable home shows up in the auth banner */
    }
  }
}

// Saves the login in the entry's config dir (fresh login, refreshed token) into the
// row. Custom-endpoint codex entries carry no login.
export async function captureProviderAuth(provider) {
  let auth;
  if (provider.binary === 'claude') auth = readClaudeAuth(ensureClaudeHome(provider));
  else if (provider.binary === 'codex' && !provider.baseUrl && !provider.apiKey)
    auth = readCodexAuth(ensureCodexHome(provider));
  else if (provider.binary === 'grok') auth = readGrokAuth(ensureGrokHome(provider));
  // opencode authenticates with the row's API key, so there is nothing to capture.
  else return provider;
  if (!auth || JSON.stringify(auth) === JSON.stringify(provider.authData)) return provider;
  const saved = await saveProviderRow({ ...provider, authData: auth });
  await reload();
  return saved;
}

async function reload() {
  try {
    cache = await loadProviderRows();
    groupKeys.clear();
  } catch (e) {
    console.error('Could not load providers:', e.message);
  }
  return cache;
}

// Every provider, active or not; pickers use providerGroups instead.
export function listProviders() {
  return cache;
}

export function getProvider(id) {
  return cache.find((p) => p.id === Number(id)) || null;
}

// ---------------------------------------------------------------------------
// interchangeable accounts
// ---------------------------------------------------------------------------

// Rows that are logins to the same service (same binary, endpoint and catalog) are
// interchangeable and form one group: a single picker entry that lib/balancer.js
// spreads sessions across. A row with its own API key is metered on it and stands
// alone. The model/effort catalog is in the key because codex logins on different
// plans offer different models, and a session must not land on a member that cannot
// run what was picked; the default model is not.
//
// Cached per row until reload: a codex catalog costs a disk read, and freezing it
// keeps groups stable if the CLI rewrites its cache mid-session.
const groupKeys = new Map(); // row id -> key

export function providerGroupKey(p, cfg = getConfig()) {
  const hit = p.id != null && groupKeys.get(p.id);
  if (hit) return hit;
  let key;
  if (p.apiKey) key = `key:${p.id}`;
  else {
    const models = providerModels(p, cfg);
    const catalog = [...models].sort().join(',');
    const efforts = [...providerEfforts(p)].sort().join(',');
    const modelEfforts = models
      .map((model) => `${model}:${[...providerEfforts(p, model)].sort().join(',')}`)
      .sort()
      .join(';');
    key = `${p.binary}|${p.baseUrl || ''}|${catalog}|${efforts}|${modelEfforts}`;
  }
  if (p.id != null) groupKeys.set(p.id, key);
  return key;
}

function byOrder(a, b) {
  return a.sortOrder - b.sortOrder || a.id - b.id;
}

// The active rows interchangeable with this one, in picker order. Inactive rows
// stay editable and resumable, but no new session or step is balanced onto one.
export function providerGroup(p, cfg = getConfig()) {
  const key = providerGroupKey(p, cfg);
  return cache.filter((row) => row.active && providerGroupKey(row, cfg) === key).sort(byOrder);
}

// The picker's list of active groups. A lone row keeps its label; a group of logins
// is named after the service.
export function providerGroups(cfg = getConfig()) {
  const groups = new Map();
  for (const p of cache.filter((row) => row.active).sort(byOrder)) {
    const key = providerGroupKey(p, cfg);
    const group = groups.get(key);
    if (group) group.members.push(p);
    else groups.set(key, { key, label: p.label, members: [p] });
  }
  for (const g of groups.values()) {
    const first = g.members[0];
    if (g.members.length > 1 && !first.baseUrl) g.label = getBinary(first.binary).label;
  }
  return [...groups.values()];
}

// The provider a stored session ran on. Old sessions stored a slug instead of a row
// id; map it to the closest row so they can still be resumed.
export function getProviderForJob(job) {
  if (job.providerId) return getProvider(job.providerId);
  const slug = String(job.provider || '');
  const binary = { claude: 'claude', claude2: 'claude', codex: 'codex', zai: 'codex', grok: 'grok' }[slug];
  if (!binary) return null;
  const rows = cache.filter((p) => p.binary === binary);
  if (slug === 'claude2') return rows.find((p) => p.authData) || rows[1] || null;
  if (slug === 'zai') return rows.find((p) => p.baseUrl) || null;
  return rows.find((p) => !p.baseUrl) || rows[0] || null;
}

// ---------------------------------------------------------------------------
// resolution against the binary
// ---------------------------------------------------------------------------

// A row's empty list/model/effort fields mean "the binary's own defaults".

export function providerModels(p, cfg) {
  // The row is passed because opencode's catalog depends on the service it names.
  if (!p.models.length) return getBinary(p.binary).models(cfg, p);
  // A curated codex login list still gets each model's wide-context twin; a custom
  // endpoint's catalog is written from this very list.
  if (p.binary !== 'codex' || p.baseUrl || p.apiKey) return p.models;
  return codexWideVariants(p.models, p);
}

export function providerEfforts(p, model = '') {
  const binary = getBinary(p.binary);
  const efforts = p.efforts.length ? p.efforts : binary.efforts;
  // Custom codex endpoints apply the row's effort list to every model; without
  // one, `max` stays opt-in since an arbitrary endpoint may not support it.
  // Login-backed entries use Codex's per-model metadata.
  if (p.binary === 'codex' && (p.baseUrl || p.apiKey)) {
    return p.efforts.length ? efforts : efforts.filter((effort) => effort !== 'max');
  }
  if (!model || p.binary !== 'codex' || !binary.effortsForModel) return efforts;
  const supported = new Set(binary.effortsForModel(model, p));
  const narrowed = efforts.filter((effort) => supported.has(effort));
  // If the row's overrides exclude everything this model runs, fall back to the
  // catalog rather than pass Codex an undefined effort.
  return narrowed.length ? narrowed : [...supported];
}

export function providerModelEfforts(p, cfg) {
  return Object.fromEntries(providerModels(p, cfg).map((model) => [model, providerEfforts(p, model)]));
}

// `models` and `efforts` may be passed when the caller already holds them: a
// codex login's lists are read from disk on every call.
export function providerDefaultModel(p, cfg, models = providerModels(p, cfg)) {
  // Falls back through the binary's older defaults when the newest is not offered.
  return resolveDefaultModel(getBinary(p.binary), p, models, cfg);
}

export function providerDefaultEffort(p, cfg, model = '', efforts = providerEfforts(p, model)) {
  if (p.defaultEffort && efforts.includes(p.defaultEffort)) return p.defaultEffort;
  const d = getBinary(p.binary).defaultEffort(cfg);
  return efforts.includes(d) ? d : efforts[efforts.length - 1];
}

// Resolves a stored {providerId, model, effort} against the current rows. A model
// or effort no longer listed falls back to the provider's default rather than
// failing every run; a missing or inactive provider answers null.
export function resolveRuntime(runtime, cfg) {
  const provider = runtime && getProvider(runtime.providerId);
  if (!provider || !provider.active) return null;
  const models = providerModels(provider, cfg);
  const model = models.includes(runtime.model) ? runtime.model : providerDefaultModel(provider, cfg);
  const efforts = providerEfforts(provider, model);
  return {
    provider,
    model,
    effort: efforts.includes(runtime.effort) ? runtime.effort : providerDefaultEffort(provider, cfg, model),
  };
}

// GET /api/dev/runtimes: each active group once (by the id /api/dev/providers uses)
// with its models and efforts, but nothing about the accounts behind it.
// `available` is false when the CLI is missing or every login probed signed out.
export function runtimeCatalog(fallback, cfg = getConfig(), loggedInOf = (_p) => null) {
  const providers = providerGroups(cfg).map(({ label, members }) => {
    const p = members[0];
    const models = providerModels(p, cfg);
    return {
      id: p.id,
      label,
      available: !!getBinary(p.binary).bin(cfg) && members.some((m) => loggedInOf(m) !== false),
      models: models.map((model) => {
        const efforts = providerEfforts(p, model);
        return {
          id: model,
          label: model,
          efforts,
          defaultEffort: providerDefaultEffort(p, cfg, model, efforts),
        };
      }),
      defaultModel: providerDefaultModel(p, cfg, models),
    };
  });
  // An inactive fallback row still starts on an active group member
  // (createDevSession), so resolve against that member.
  const row = fallback && getProvider(fallback.providerId);
  const [first] = row ? providerGroup(row, cfg) : [];
  const base = row && row.active ? row : first;
  const resolved = base && resolveRuntime({ ...fallback, providerId: base.id }, cfg);
  return {
    default: resolved ? { providerId: first.id, model: resolved.model, effort: resolved.effort } : null,
    providers,
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

function normalizeProvider(input, existing = null) {
  const base = existing || PROVIDER_DEFAULTS;
  const p = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('binary')) p.binary = String(input.binary || '').trim();
  if (!BINARIES[p.binary]) {
    throw new Error(
      `"${p.binary}" is not one of the binaries this machine can run (${Object.keys(BINARIES).join(', ')})`,
    );
  }
  if (has('label')) p.label = String(input.label || '').trim();
  if (!p.label) p.label = getBinary(p.binary).label;
  if (has('active')) p.active = !!input.active;

  for (const key of ['baseUrl', 'apiKey', 'defaultModel', 'defaultEffort']) {
    if (has(key)) p[key] = String(input[key] ?? '').trim();
  }
  if (has('models')) p.models = asList(input.models);
  if (has('efforts')) p.efforts = asList(input.efforts);
  if (p.baseUrl && p.binary === 'grok') {
    throw new Error(
      'A custom endpoint only works on the claude, codex and opencode binaries; grok has no endpoint override',
    );
  }
  if (p.baseUrl && !/^https?:\/\//i.test(p.baseUrl)) {
    throw new Error(`"${p.baseUrl}" is not an http(s) URL`);
  }
  if (has('sortOrder')) p.sortOrder = Number(input.sortOrder) || 0;
  return p;
}

export async function createProvider(input) {
  const provider = normalizeProvider(input);
  if (!input.sortOrder) {
    provider.sortOrder = cache.reduce((max, p) => Math.max(max, p.sortOrder), 0) + 1;
  }
  const saved = await saveProviderRow(provider);
  await reload();
  return saved;
}

export async function updateProvider(id, input) {
  const existing = await getProviderRow(id);
  if (!existing) throw new Error('Provider not found');
  const provider = normalizeProvider(input, existing);
  const saved = await saveProviderRow({ ...provider, id: existing.id });
  await reload();
  return saved;
}

export async function removeProvider(id) {
  const removed = await deleteProviderRow(id);
  await reload();
  return removed;
}
