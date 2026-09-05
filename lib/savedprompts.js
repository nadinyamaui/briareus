// @ts-check
import { loadSavedPromptRows, saveSavedPrompt, deleteSavedPrompt, getSavedPromptRow } from './db.js';

// The kickoff library: prompts the operator types once and picks from the
// composer's Prompts menu after. Deliberately simpler than the review
// templates in templates.js: no tokens, no fallback chain, no per-project
// override, since a saved prompt is just text with a title. Its only scoping is
// the optional repo: a prompt bound to one is offered on that project alone,
// an unbound one everywhere.
//
// Read into memory at boot and refreshed on every write, like the projects and
// the database pool: the composer asks for the list on every project switch,
// and the rows change rarely.

export const TITLE_MAX = 120;
// Generous, but bounded: the column is LONGTEXT and a prompt longer than this
// is a document, not a kickoff.
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

// What the composer shows for one project: its own prompts first, then the
// ones shared by every project, each group in its stored order. Without a repo
// it is the whole library, which is what the settings page edits.
export function listSavedPrompts(repo = null) {
  if (!repo) return cache;
  const own = cache.filter((p) => p.repo === repo);
  const shared = cache.filter((p) => !p.repo);
  return [...own, ...shared];
}

export function getSavedPrompt(id) {
  return cache.find((p) => p.id === Number(id)) || null;
}

function normalizePrompt(input, existing = null) {
  const base = existing || { title: '', body: '', repo: null, sortOrder: 0 };
  const p = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('title')) p.title = String(input.title ?? '').trim();
  if (!p.title) throw new Error('A saved prompt needs a title');
  if (p.title.length > TITLE_MAX) throw new Error(`The title is over ${TITLE_MAX} characters`);
  // Only the surrounding blank lines go: the body's inner whitespace is prose
  // the operator laid out on purpose.
  if (has('body')) p.body = String(input.body ?? '').replace(/^\s*\n|\s+$/g, '');
  if (!p.body.trim()) throw new Error('A saved prompt needs a body');
  if (p.body.length > BODY_MAX) throw new Error(`The body is over ${BODY_MAX} characters`);
  if (has('repo')) p.repo = String(input.repo ?? '').trim() || null;
  // An empty Order box sends `null`: that means "unplaced", not "first", so it
  // keeps the prompt where it is (and lets create auto-append it). `0` is a
  // real place and is honoured.
  if (has('sortOrder') && input.sortOrder != null && input.sortOrder !== '')
    p.sortOrder = Number(input.sortOrder) || 0;
  return p;
}

export async function createSavedPrompt(input) {
  const prompt = normalizePrompt(input || {});
  // A new prompt lands at the end of the list unless the caller placed it.
  // `0` is a real place (first in the list); only omit/null/empty auto-assign.
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
