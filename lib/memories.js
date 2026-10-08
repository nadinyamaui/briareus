// @ts-check
import { selectMemories } from './memory-selection.js';
import { loadMemoryRows, saveMemory, deleteMemory, getMemoryRow } from './db.js';

// Project memory: what an agent learns about a project and should know next session.
// Headless runs never get Claude Code's own memory directory (each session is a fresh
// clone and config dir), so the dashboard keeps memories in the database per repository
// and puts them in every turn's briefing. The shape mirrors the CLI's convention (one fact
// per entry, slug name, one-line description, type). Memories are never shared across
// projects. Cached at boot and refreshed on every write, since every briefing reads them.

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const NAME_MAX = 120;
const DESCRIPTION_MAX = 255;
// A memory is a fact, not a document.
export const BODY_MAX = 8000;
// How much memory a briefing carries. Past this the newest stay whole and the oldest are
// listed by name and description only, so a large memory does not eat the context.
export const BRIEFING_BUDGET = 24000;

let cache = [];

export async function initMemories() {
  return reload();
}

async function reload() {
  try {
    cache = await loadMemoryRows();
  } catch (e) {
    console.error('Could not load project memories:', e.message);
  }
  return cache;
}

// Every memory (settings page), or one project's (a turn).
export function listMemories(repo = null) {
  if (!repo) return cache;
  return cache.filter((m) => m.repo === repo);
}

export function findMemory(repo, name) {
  const slug = slugify(name);
  return cache.find((m) => m.repo === repo && m.name === slug) || null;
}

// A name is a slug of lower-case hyphenated words; whatever was typed is folded into it,
// so "DB Naming Rules" and "db-naming-rules" are the same memory.
export function slugify(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeMemory(input, existing = null) {
  const base = existing || { repo: '', name: '', type: 'project', description: '', body: '', jobId: null };
  const m = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('repo')) m.repo = String(input.repo ?? '').trim();
  if (!m.repo) throw new Error('A memory belongs to a project');
  if (has('name')) m.name = slugify(input.name);
  if (!m.name) throw new Error('A memory needs a name');
  if (m.name.length > NAME_MAX) throw new Error(`The name is over ${NAME_MAX} characters`);
  if (has('type'))
    m.type =
      String(input.type ?? '')
        .trim()
        .toLowerCase() || 'project';
  if (!MEMORY_TYPES.includes(m.type)) throw new Error(`The type must be one of ${MEMORY_TYPES.join(', ')}`);
  if (has('description')) m.description = String(input.description ?? '').trim();
  if (m.description.length > DESCRIPTION_MAX)
    throw new Error(`The description is over ${DESCRIPTION_MAX} characters`);
  if (has('body')) m.body = String(input.body ?? '').replace(/^\s*\n|\s+$/g, '');
  if (!m.body.trim()) throw new Error('A memory needs a body');
  if (m.body.length > BODY_MAX) throw new Error(`The body is over ${BODY_MAX} characters`);
  if (has('jobId')) m.jobId = input.jobId ? String(input.jobId) : null;
  return m;
}

export async function createMemory(input) {
  const memory = normalizeMemory(input || {});
  if (findMemory(memory.repo, memory.name)) {
    throw Object.assign(new Error(`A memory named ${memory.name} already exists on ${memory.repo}`), {
      status: 409,
    });
  }
  const saved = await saveMemory(memory);
  await reload();
  return saved;
}

export async function updateMemory(id, input) {
  const existing = await getMemoryRow(id);
  if (!existing) throw Object.assign(new Error('Memory not found'), { status: 404 });
  const memory = normalizeMemory(input || {}, existing);
  const clash = findMemory(memory.repo, memory.name);
  if (clash && clash.id !== existing.id) {
    throw Object.assign(new Error(`A memory named ${memory.name} already exists on ${memory.repo}`), {
      status: 409,
    });
  }
  const saved = await saveMemory({ ...memory, id: existing.id });
  await reload();
  return saved;
}

// The agent's tool: write the memory by name, creating or replacing it like a memory file.
export async function upsertMemory(repo, input) {
  const existing = findMemory(repo, input && input.name);
  if (existing) return updateMemory(existing.id, { ...input, repo });
  return createMemory({ ...input, repo });
}

export async function removeMemory(id) {
  const removed = await deleteMemory(id);
  await reload();
  return removed;
}

export async function removeMemoryByName(repo, name) {
  const existing = findMemory(repo, name);
  if (!existing) return 0;
  return removeMemory(existing.id);
}

// The briefing's memory section: newest first, whole while the budget lasts, headline
// after.
export function memoryBriefing(repo, query = '') {
  const all = selectMemories(listMemories(repo), query);
  if (!all.length) return '';
  const full = [];
  const headlines = [];
  let used = 0;
  for (const m of all) {
    const text = `### ${m.name} (${m.type})\n${m.description ? `${m.description}\n\n` : ''}${m.body}`;
    if (used + text.length <= BRIEFING_BUDGET) {
      full.push(text);
      used += text.length;
    } else {
      headlines.push(`- ${m.name} (${m.type})${m.description ? `: ${m.description}` : ''}`);
    }
  }
  const parts = [full.join('\n\n')];
  if (headlines.length) {
    parts.push(
      `The following memories are listed by headline only; read one with the memory tool when it matters:\n${headlines.join('\n')}`,
    );
  }
  return parts.join('\n\n');
}
