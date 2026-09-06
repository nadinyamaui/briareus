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
  readCodexAuth,
  ensureGrokHome,
  readGrokAuth,
  ensureOpencodeHome,
} from './providers.js';

// The providers a session can be started on: each row links a label to one of
// the four hardcoded binaries (claude / codex / grok / opencode) plus whatever
// that entry needs beyond the binary itself: a custom endpoint with its API key,
// model and effort overrides. Each entry's login lives in a config dir
// derived from its id, mirrored into the row.
// Rows live in the `providers` table and are edited from /settings.
//
// Like projects and the database pool, the table is read into memory at boot
// and refreshed on every write: the call sites (spawning a turn, building the
// picker) read far more often than the rows change.

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

// Every claude and codex entry registers a config dir of its own
// (~/.claude-provider-<id> / ~/.codex-provider-<id>) with the login mirrored
// into the row. Legacy codex rows pointed at nothing instead, meaning the
// developer's own ~/.codex: import that login into the database once, then
// let the derived dir take over. Also makes sure each entry's dir exists
// (with the stored login written into it) so it can be logged in.
async function adoptLogins() {
  let changed = false;
  for (const p of cache) {
    try {
      let update = null;
      if (p.binary === 'codex' && !p.baseUrl && !p.apiKey && !p.authData) {
        const machine = readCodexAuth(path.join(os.homedir(), '.codex'));
        if (machine) update = { authData: machine };
      } else if (p.binary === 'grok' && !p.authData) {
        // grok rows used to run on the machine's own ~/.grok, so import that
        // login once, then the derived dir takes over.
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

// Disk → database: whatever login currently sits in the entry's config dir
// (a fresh login, a refreshed OAuth token) is saved into the row. Custom-
// endpoint codex entries carry no login; their dir holds only the
// server-written config.toml.
export async function captureProviderAuth(provider) {
  let auth;
  if (provider.binary === 'claude') auth = readClaudeAuth(ensureClaudeHome(provider));
  else if (provider.binary === 'codex' && !provider.baseUrl && !provider.apiKey)
    auth = readCodexAuth(ensureCodexHome(provider));
  else if (provider.binary === 'grok') auth = readGrokAuth(ensureGrokHome(provider));
  // An opencode entry has no login to capture: it authenticates with the API
  // key on the row, which never lands on disk.
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

// Every provider, active or not: what /settings edits. The pickers ask
// providerGroups below, which leaves inactive rows out.
export function listProviders() {
  return cache;
}

export function getProvider(id) {
  return cache.find((p) => p.id === Number(id)) || null;
}

// ---------------------------------------------------------------------------
// interchangeable accounts
// ---------------------------------------------------------------------------

// Several rows can be logins to the same service (three claude.ai accounts,
// say). For a session they are interchangeable: same binary, same endpoint,
// same catalog, only the quota differs. Those rows form one group, which is
// what every picker offers as a single entry and what lib/balancer.js spreads
// sessions across. A row with its own API key is metered on that key, so it
// stands alone even when it points at the same endpoint as another.
//
// The catalog is part of what makes two rows interchangeable, not a detail:
// each codex login reads its models from its own CODEX_HOME cache, so two
// accounts on different plans (or one whose cache is missing and falls back to
// the baked list) offer different models, and either row's efforts can be
// overridden in /settings. A picker shows one member's lists, so rows whose
// lists differ must not be merged, or the session would land on a member that
// cannot run what was picked. The default model is not in the key: it only
// names a starting point inside a catalog both members share.
//
// Computed once per row and kept until the rows are reloaded. Resolving a
// codex login's catalog parses its models_cache.json from disk, and the key is
// wanted for every row on every session start and every step turn, so it must
// not cost a disk read each time. Holding it also keeps a group together when
// the codex CLI rewrites that cache mid-session: which rows are
// interchangeable is settled by the rows as loaded, and changes when they do.
const groupKeys = new Map(); // row id -> key

export function providerGroupKey(p, cfg = getConfig()) {
  const hit = p.id != null && groupKeys.get(p.id);
  if (hit) return hit;
  let key;
  if (p.apiKey) key = `key:${p.id}`;
  else {
    const catalog = [...providerModels(p, cfg)].sort().join(',');
    const efforts = [...providerEfforts(p)].sort().join(',');
    key = `${p.binary}|${p.baseUrl || ''}|${catalog}|${efforts}`;
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

// Every active group, in the order of its first active member: the picker's
// list. A lone row keeps its own label; a group of logins is named after the
// service, since "Claude 1 / 2 / 3" collapsed into one entry is just "Claude".
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

// The provider a stored session ran on. Sessions from before providers moved
// into the database stored a slug ('claude', 'claude2', 'codex', 'zai',
// 'grok') instead of a row id, so map those onto the closest surviving row so
// their conversations can still be resumed.
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
  // The row goes in as well as the config: opencode's catalog is per service,
  // and which service an entry is for is on the row. The others ignore it.
  if (!p.models.length) return getBinary(p.binary).models(cfg, p);
  // A curated list is the operator's choice of models, not of window sizes: a
  // codex row that names a model the catalog sells at two sizes gets the wide
  // twin alongside it, the same as a row that lists nothing and reads the
  // catalog wholesale. A login row is the only one whose catalog knows about
  // ceilings; a custom endpoint's is written from this very list.
  if (p.binary !== 'codex' || p.baseUrl || p.apiKey) return p.models;
  return codexWideVariants(p.models, p);
}

export function providerEfforts(p) {
  return p.efforts.length ? p.efforts : getBinary(p.binary).efforts;
}

export function providerDefaultModel(p, cfg) {
  const models = providerModels(p, cfg);
  if (p.defaultModel && models.includes(p.defaultModel)) return p.defaultModel;
  const d = getBinary(p.binary).defaultModel(cfg);
  return models.includes(d) ? d : models[0];
}

export function providerDefaultEffort(p, cfg) {
  const efforts = providerEfforts(p);
  if (p.defaultEffort && efforts.includes(p.defaultEffort)) return p.defaultEffort;
  const d = getBinary(p.binary).defaultEffort(cfg);
  return efforts.includes(d) ? d : efforts[efforts.length - 1];
}

// A stored {providerId, model, effort}, a project's reviewer runtime or
// one of its per-step overrides, resolved against the rows as they stand now.
// A model or effort renamed out of the provider's list falls back to that
// provider's default rather than failing every run until someone notices; a
// provider row that is gone or inactive answers null, which the caller reports
// and falls back from.
export function resolveRuntime(runtime, cfg) {
  const provider = runtime && getProvider(runtime.providerId);
  if (!provider || !provider.active) return null;
  const models = providerModels(provider, cfg);
  const efforts = providerEfforts(provider);
  return {
    provider,
    model: models.includes(runtime.model) ? runtime.model : providerDefaultModel(provider, cfg),
    effort: efforts.includes(runtime.effort) ? runtime.effort : providerDefaultEffort(provider, cfg),
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function asList(value) {
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
