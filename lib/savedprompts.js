// @ts-check
import { loadSavedPromptRows, saveSavedPrompt, deleteSavedPrompt, getSavedPromptRow } from './db.js';

// The kickoff library: prompts typed once and picked from the composer's Prompts menu.
// Simpler than templates.js on purpose (no tokens, fallbacks or per-project overrides);
// the only scoping is an optional repo, outside which the prompt is not offered. Cached
// at boot and refreshed on write, since the composer asks on every project switch.

export const TITLE_MAX = 120;
// Bounded though the column is LONGTEXT: a prompt longer than this is a document.
export const BODY_MAX = 20000;

let cache = [];

export async function initSavedPrompts() {
  return reload();
}

async function reload() {
  try {
    cache = await loadSavedPromptRows();
  } catch (e) {
    console.error('Could not load saved prompts:', e.message);
  }
  return cache;
}

// For one project: its own prompts, then shared ones, each in stored order. Without a
// repo, the whole library (what the settings page edits).
export function listSavedPrompts(repo = null) {
  if (!repo) return cache;
  const own = cache.filter((p) => p.repo === repo);
  const shared = cache.filter((p) => !p.repo);
  return [...own, ...shared];
}

function normalizePrompt(input, existing = null) {
  const base = existing || { title: '', body: '', repo: null, sortOrder: 0 };
  const p = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('title')) p.title = String(input.title ?? '').trim();
  if (!p.title) throw new Error('A saved prompt needs a title');
  if (p.title.length > TITLE_MAX) throw new Error(`The title is over ${TITLE_MAX} characters`);
  // Only surrounding blank lines go: inner whitespace is deliberate layout.
  if (has('body')) p.body = String(input.body ?? '').replace(/^\s*\n|\s+$/g, '');
  if (!p.body.trim()) throw new Error('A saved prompt needs a body');
  if (p.body.length > BODY_MAX) throw new Error(`The body is over ${BODY_MAX} characters`);
  if (has('repo')) p.repo = String(input.repo ?? '').trim() || null;
  // An empty Order box sends `null`, meaning "unplaced" not "first": the prompt stays put
  // (and create auto-appends). `0` is a real place and is honoured.
  if (has('sortOrder') && input.sortOrder != null && input.sortOrder !== '')
    p.sortOrder = Number(input.sortOrder) || 0;
  return p;
}

export async function createSavedPrompt(input) {
  const prompt = normalizePrompt(input || {});
  // A new prompt goes last unless placed; only omit/null/empty auto-assign, `0` is first.
  const raw = input && input.sortOrder;
  const placed = raw != null && raw !== '';
  if (!placed) prompt.sortOrder = cache.reduce((max, p) => Math.max(max, p.sortOrder), 0) + 1;
  const saved = await saveSavedPrompt(prompt);
  await reload();
  return saved;
}

export async function updateSavedPrompt(id, input) {
  const existing = await getSavedPromptRow(id);
  if (!existing) throw Object.assign(new Error('Saved prompt not found'), { status: 404 });
  const prompt = normalizePrompt(input || {}, existing);
  const saved = await saveSavedPrompt({ ...prompt, id: existing.id });
  await reload();
  return saved;
}

export async function removeSavedPrompt(id) {
  const removed = await deleteSavedPrompt(id);
  await reload();
  return removed;
}
