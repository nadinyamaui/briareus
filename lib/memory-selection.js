// @ts-check
import { createHash } from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';
let policies = {};
let writes = Promise.resolve();
const key = (m) => `${m.repo}:${m.name}`;
export const memoryRevision = (m) => createHash('sha256').update(`${m.description}\n${m.body}`).digest('hex');
export async function initMemorySelection() {
  policies = await loadAppSetting('memory_selection', {});
}
export function memoryPolicy(m) {
  const p = policies[key(m)] || {};
  return {
    archived: p.archived === true,
    verifiedAt: p.revision === memoryRevision(m) ? p.verifiedAt || null : null,
  };
}
export function setMemoryPolicy(memory, action) {
  if (!['verify', 'archive', 'restore'].includes(action)) throw new Error('Unknown memory action');
  const task = writes.then(async () => {
    const p = { ...(policies[key(memory)] || {}) };
    if (action === 'verify')
      Object.assign(p, { verifiedAt: new Date().toISOString(), revision: memoryRevision(memory) });
    else p.archived = action === 'archive';
    const next = { ...policies, [key(memory)]: p };
    await saveAppSetting('memory_selection', next);
    policies = next;
    return memoryPolicy(memory);
  });
  writes = task.then(
    () => {},
    () => {},
  );
  return task;
}
const STOP = new Set(
  'the and for with this that from have para como una los las del que con por esta este'.split(' '),
);
const words = (text) =>
  new Set(
    (
      String(text || '')
        .toLowerCase()
        .match(/[\p{L}\p{N}_]{3,}/gu) || []
    ).filter((w) => !STOP.has(w)),
  );
export function selectMemories(memories, query = '') {
  const wanted = words(query);
  const score = (m) => {
    const title = words(`${m.name.replaceAll('-', ' ')} ${m.description}`);
    const body = words(m.body);
    let n = ['user', 'feedback'].includes(m.type) ? 1000 : 0;
    for (const word of wanted) n += title.has(word) ? 8 : body.has(word) ? 1 : 0;
    return n;
  };
  return memories
    .filter((m) => !memoryPolicy(m).archived)
    .slice()
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
        a.name.localeCompare(b.name),
    );
}
export function memoryHealth(memories, now = Date.now()) {
  const rows = memories.map((m) => {
    const policy = memoryPolicy(m);
    return {
      ...m,
      ...policy,
      revision: memoryRevision(m),
      needsVerification: !policy.verifiedAt || now - Date.parse(policy.verifiedAt) > 90 * 86400000,
    };
  });
  const duplicates = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i],
        b = rows[j];
      if (a.repo !== b.repo || a.archived || b.archived) continue;
      const x = words(a.body),
        y = words(b.body);
      const intersection = [...x].filter((w) => y.has(w)).length;
      const similarity = intersection / (x.size + y.size - intersection || 1);
      if (a.body === b.body || (x.size >= 8 && similarity >= 0.65))
        duplicates.push({ ids: [a.id, b.id], similarity });
    }
  return { memories: rows, duplicates };
}
