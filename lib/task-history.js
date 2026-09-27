// @ts-check
import { aggregateUsage } from './usage.js';
export function taskFamily(id, snapshots) {
  let root = snapshots.find((s) => s.id === id);
  if (!root) throw new Error('Task not found');
  const visited = new Set();
  while (root.parentId && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = snapshots.find((s) => s.id === root.parentId && s.repo === root.repo);
    if (!parent || parent.activity === 'orchestrator') break;
    root = parent;
  }
  const included = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of snapshots)
      if (
        s.repo === root.repo &&
        !included.has(s.id) &&
        (included.has(s.parentId) || (root.prNumber && root.prNumber === s.prNumber))
      ) {
        included.add(s.id);
        changed = true;
      }
  }
  return {
    root,
    sessions: snapshots
      .filter((s) => included.has(s.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  };
}
export function taskReport(family, rows, liveIds = []) {
  const ids = new Set(family.sessions.map((s) => s.id));
  return {
    ...family,
    sessions: family.sessions.map((s) => ({ ...s, conversationAvailable: liveIds.includes(s.id) })),
    usage: aggregateUsage(rows.filter((r) => ids.has(r.jobId))),
    prUrl: family.root.prNumber
      ? `https://github.com/${family.root.repo}/pull/${family.root.prNumber}`
      : null,
  };
}
