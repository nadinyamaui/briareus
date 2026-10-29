// @ts-check
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseProcStat, readProcesses } from './session-stats.js';

// Killing a spawned CLI together with everything it started.

// Every process a CLI starts inherits this variable unless something clears its environment, so
// its value still names the CLI's processes after they have left its tree: a tool shell that
// backgrounded work and exited leaves that work reparented away, outside every group the CLI
// leads. The name stays clear of the KEY/TOKEN/SECRET/PASSWORD and DSH_ names dsh strips from
// its tools' environment.
const TREE_VAR = 'BRIAREUS_PROCESS_TREE';

// `env` for a spawn killTree should follow beyond its process tree; each spawn gets its own value,
// so a Stop reaches only what that one started.
/** @param {NodeJS.ProcessEnv} env */
export function treeEnv(env) {
  return { ...env, [TREE_VAR]: `${process.pid}-${randomUUID()}` };
}

// Each tracked spawn's tree value, kept apart from its leader: once the leader has exited and been
// reaped, its /proc entry is gone, while what it started (an MCP server's detached helper holding
// its stderr open, say) still carries the value.
/** @type {WeakMap<import('node:child_process').ChildProcess, string>} */
const trees = new WeakMap();

// Ties `proc` to the tree value of the treeEnv `env` it was spawned with, so killTree still finds
// its processes after it exits. Returns `proc`.
/** @param {import('node:child_process').ChildProcess} proc @param {NodeJS.ProcessEnv} env */
export function trackTree(proc, env) {
  if (env?.[TREE_VAR]) trees.set(proc, `${TREE_VAR}=${env[TREE_VAR]}`);
  return proc;
}

/** @param {number} pid */
function treeEntry(pid) {
  try {
    return (
      fs
        .readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((e) => e.startsWith(`${TREE_VAR}=`)) || null
    );
  } catch {
    return null; // gone, or another user's
  }
}

// The processes outside `pid`'s group that carry its tree value. Each is frozen as it is found, so
// none starts another while they are read, and the processes are read again until no new one turns
// up. Unlike strayDescendants, this finds them after the shell that started them exited.
/** @param {number} pid @param {string} entry */
function taggedStrays(pid, entry) {
  /** @type {Map<number, import('./session-stats.js').Proc>} */
  const found = new Map();
  for (let round = 0; round < 5; round++) {
    let fresh = 0;
    for (const p of readProcesses('/proc').values()) {
      if (p.pgrp === pid || p.pid === process.pid || found.has(p.pid) || treeEntry(p.pid) !== entry) continue;
      found.set(p.pid, p);
      fresh++;
      try {
        process.kill(p.pid, 'SIGSTOP');
      } catch {
        /* already gone */
      }
    }
    if (!fresh) break;
  }
  return [...found.values()];
}

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
// Strays are looked for only below this server's own child, and by the tree value
// it was spawned with (treeEnv), so nothing unrelated is signalled, and never by a value it only
// inherited from this process; its group is
// frozen first so it starts no new tool while they are read, and each stray then
// dies with the group it leads. A tracked spawn (trackTree) is still swept by its
// value after its leader exited, since that value is unique to the spawn and so
// cannot name a process that reused its pid.
/** @param {import('node:child_process').ChildProcess | null | undefined} proc */
export function killTree(proc) {
  if (!proc || !proc.pid) return;
  /** @type {import('./session-stats.js').Proc[]} */
  let strays = [];
  let entry = trees.get(proc) || null;
  if (isOwnChild(proc.pid)) {
    try {
      process.kill(-proc.pid, 'SIGSTOP');
    } catch {
      /* not a group leader */
    }
    strays = strayDescendants(proc.pid);
    entry ||= treeEntry(proc.pid);
  }
  // A child spawned without treeEnv inherits this process's own value, which every other process
  // started under it shares too: inside a session's tool shell (this repo's own test suite, say),
  // that names the session's CLI and its shells, so it is not followed.
  if (entry && process.env[TREE_VAR] && entry === `${TREE_VAR}=${process.env[TREE_VAR]}`) entry = null;
  if (entry) {
    const known = new Set(strays.map((p) => p.pid));
    strays.push(...taggedStrays(proc.pid, entry).filter((p) => !known.has(p.pid)));
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
