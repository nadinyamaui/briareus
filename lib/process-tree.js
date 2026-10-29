// @ts-check
import fs from 'node:fs';
import { parseProcStat, readProcesses } from './session-stats.js';

// Killing a spawned CLI together with everything it started.

/** @param {number} pid */
function isOwnChild(pid) {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))?.ppid === process.pid;
  } catch {
    return false;
  }
}

// The processes below `pid` that left its process group: dsh starts each tool in
// a group (or systemd scope) of its own, which the group kill misses. They are
// found by their parent links, so this reads them while `pid` still lives; once it
// dies they are reparented away. Linux only: empty where /proc is absent.
/** @param {number} pid */
function strayDescendants(pid) {
  const all = readProcesses('/proc');
  const children = new Map();
  for (const p of all.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const strays = [];
  const stack = [...(children.get(pid) || [])];
  while (stack.length) {
    const p = stack.pop();
    if (p.pgrp !== pid) strays.push(p);
    stack.push(...(children.get(p.pid) || []));
  }
  return strays;
}

// Kill a child and everything it spawned. Children are spawned detached (group
// leaders), so a negative pid reaches the shell's real work too; the single-pid
// fallback covers a non-leader. An exited leader may still have tools holding
// its pipes open, so exitCode alone does not mean its process group is gone.
// Strays are looked for only below this server's own child, so nothing unrelated
// is signalled; its group is frozen first so it starts no new tool while they are
// read, and each stray then dies with the group it leads.
/** @param {import('node:child_process').ChildProcess | null | undefined} proc */
export function killTree(proc) {
  if (!proc || !proc.pid) return;
  /** @type {import('./session-stats.js').Proc[]} */
  let strays = [];
  if (isOwnChild(proc.pid)) {
    try {
      process.kill(-proc.pid, 'SIGSTOP');
    } catch {
      /* not a group leader */
    }
    strays = strayDescendants(proc.pid);
  }
  const leaders = new Set(strays.map((p) => p.pid));
  for (const p of strays) {
    for (const target of leaders.has(p.pgrp) ? [-p.pgrp, p.pid] : [p.pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
