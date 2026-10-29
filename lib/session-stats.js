// @ts-check
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What each open session costs the machine: CPU, memory and processes of everything it
// spawned (the agent's turn, the ▶ Run server, the shared browser), and the disk its
// workspace takes. Alongside, the machine as a whole: its CPU and memory, the Briareus
// process itself and the disks sessions write to. Read from /proc and os rather than
// through a dependency, sampled on a timer so a client draws history without polling
// every few seconds itself. Session figures are Linux only: elsewhere /proc is absent and
// every session reads as no processes.

/**
 * @typedef {{ pid: number, role: string }} Root
 * @typedef {{ pid: number, ppid: number, pgrp: number, ticks: number, childTicks: number, start: number, rss: number }} Proc
 * @typedef {{ cpuPercent: number|null, memoryBytes: number, processes: number }} Usage
 * @typedef {Usage & { at: number }} Sample
 * @typedef {{ bytes: number, measuredAt: number }} Disk
 * @typedef {{ at: number, cpuPercent: number|null, memoryBytes: number, hostCpuPercent: number|null, freeMemoryBytes: number, loadAverage: number }} ServerSample
 */

/** @param {string} name @param {number} fallback */
function getconf(name, fallback) {
  try {
    const value = Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim());
    return value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The fields of /proc/<pid>/stat this module reads. The command name sits in parentheses
 * and may itself hold spaces or parentheses, so fields count from the last `)`.
 * @param {string} text
 * @returns {Omit<Proc, 'pid'>|null}
 */
export function parseProcStat(text) {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const f = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (f.length < 22) return null;
  return {
    ppid: Number(f[1]),
    pgrp: Number(f[2]),
    ticks: Number(f[11]) + Number(f[12]),
    // What its children spent, added when it waits for them: a compiler or test run that
    // exits between two samples leaves its time only here.
    childTicks: Number(f[13]) + Number(f[14]),
    start: Number(f[19]),
    rss: Number(f[21]),
  };
}

/** @param {string} procDir @returns {Map<number, Proc>} */
export function readProcesses(procDir) {
  const all = new Map();
  let names;
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return all;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(procDir, name, 'stat'), 'utf8');
    } catch {
      continue; // exited between the listing and the read
    }
    const stat = parseProcStat(text);
    if (stat) all.set(Number(name), { pid: Number(name), ...stat });
  }
  return all;
}

/**
 * Which process belongs to which root: its descendants, plus anything still in the
 * process group of a root that leads one. The second catches what a detached shell
 * backgrounded (`queue:listen &`) and then left to be reparented to init. A process two
 * roots could claim counts once, for the first.
 * @param {Map<number, Proc>} all
 * @param {Root[]} roots
 * @returns {Map<number, string>} pid -> role
 */
export function attribute(all, roots) {
  const children = new Map();
  for (const p of all.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const owner = new Map();
  for (const root of roots) {
    if (!all.has(root.pid)) continue;
    const stack = [root.pid];
    for (const p of all.values()) if (p.pgrp === root.pid) stack.push(p.pid);
    while (stack.length) {
      const pid = /** @type {number} */ (stack.pop());
      if (owner.has(pid)) continue;
      owner.set(pid, root.role);
      stack.push(...(children.get(pid) || []));
    }
  }
  return owner;
}

/** @param {string} dir @returns {Promise<number>} */
function duBytes(dir) {
  return new Promise((resolve, reject) => {
    // -x stays on the workspace's filesystem; a mount inside it is not its disk.
    execFile('nice', ['-n', '19', 'du', '-skx', dir], { timeout: 120_000 }, (err, stdout) => {
      const kb = Number(String(stdout).split(/\s/)[0]);
      // du exits 1 over a file that vanished mid-walk and still prints a total.
      if (Number.isFinite(kb) && String(stdout).trim()) resolve(kb * 1024);
      else reject(err || new Error('du printed no total'));
    });
  });
}

const emptyUsage = () => ({ cpuPercent: null, memoryBytes: 0, processes: 0 });

// Busy and total CPU time across every core since boot, in milliseconds.
function hostCpuTimes() {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/**
 * Each disk once: two folders on one filesystem would report it twice.
 * @param {Array<{ label: string, dir: string }>} dirs
 */
function diskSpace(dirs) {
  const seen = new Set();
  const disks = [];
  for (const { label, dir } of dirs) {
    try {
      const dev = fs.statSync(dir).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const fsStat = fs.statfsSync(dir);
      const totalBytes = fsStat.blocks * fsStat.bsize;
      // bavail, not bfree: the blocks reserved for root are not this server's to fill.
      const freeBytes = fsStat.bavail * fsStat.bsize;
      disks.push({ label, totalBytes, freeBytes, usedBytes: totalBytes - fsStat.bfree * fsStat.bsize });
    } catch {
      // A folder not created yet has no disk to report.
    }
  }
  return disks;
}

/**
 * @param {{
 *   listSessions: () => Array<{ id: string, workDir?: string|null }>,
 *   rootsOf: (session: any) => Root[],
 *   disks?: Array<{ label: string, dir: string }>,
 *   procDir?: string,
 *   intervalMs?: number,
 *   historySize?: number,
 *   diskEveryMs?: number,
 *   measureDisk?: (dir: string) => Promise<number>,
 *   clockTicks?: number,
 *   pageSize?: number,
 *   now?: () => number,
 * }} options
 */
export function createSessionStats({
  listSessions,
  rootsOf,
  disks = [],
  procDir = '/proc',
  intervalMs = 10_000,
  // An hour at the default interval.
  historySize = 360,
  // du walks every file, and a workspace with node_modules or vendor/ holds a lot of
  // them; its size moves slowly next to CPU and memory.
  diskEveryMs = 5 * 60_000,
  measureDisk = duBytes,
  clockTicks = getconf('CLK_TCK', 100),
  // Not always 4 KiB: arm64 kernels may use 16 or 64 KiB pages.
  pageSize = getconf('PAGESIZE', 4096),
  now = Date.now,
}) {
  /** @type {Map<string, { current: Usage & { at: number, roles: Record<string, Usage> }, history: Sample[], disk: Disk|null, workDir?: string|null }>} */
  const sessions = new Map();
  /** @type {Map<number, { ticks: number, childTicks: number, start: number, ppid: number }>} */
  let lastTicks = new Map();
  let lastAt = 0;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {Map<string, number>} */
  const diskDue = new Map();
  let measuring = false;
  /** @type {ServerSample[]} */
  const serverHistory = [];
  /** @type {ServerSample|null} */
  let serverCurrent = null;
  let lastProcessCpu = process.cpuUsage();
  let lastHostCpu = hostCpuTimes();

  /** @param {number} at @param {number} seconds */
  function sampleServer(at, seconds) {
    const processCpu = process.cpuUsage();
    const hostCpu = hostCpuTimes();
    const hostTotal = hostCpu.total - lastHostCpu.total;
    const processMicros = processCpu.user - lastProcessCpu.user + (processCpu.system - lastProcessCpu.system);
    serverCurrent = {
      at,
      cpuPercent: seconds ? round(processMicros / 1e4 / seconds) : null,
      memoryBytes: process.memoryUsage.rss(),
      hostCpuPercent:
        seconds && hostTotal > 0 ? round((100 * (hostCpu.busy - lastHostCpu.busy)) / hostTotal) : null,
      freeMemoryBytes: os.freemem(),
      loadAverage: round(os.loadavg()[0]),
    };
    lastProcessCpu = processCpu;
    lastHostCpu = hostCpu;
    serverHistory.push(serverCurrent);
    if (serverHistory.length > historySize) serverHistory.splice(0, serverHistory.length - historySize);
  }

  function sample() {
    const at = now();
    const open = listSessions();
    const rootsBySession = open.map((s) => /** @type {[any, Root[]]} */ ([s, rootsOf(s)]));
    const anyRoots = rootsBySession.some(([, roots]) => roots.length);
    // A machine with nothing running skips the /proc walk entirely.
    const all = anyRoots ? readProcesses(procDir) : new Map();
    const seconds = lastAt ? (at - lastAt) / 1000 : 0;

    sampleServer(at, seconds);
    const ticks = new Map();
    for (const p of all.values())
      ticks.set(p.pid, {
        ticks: p.ticks + p.childTicks,
        childTicks: p.childTicks,
        start: p.start,
        ppid: p.ppid,
      });

    for (const [session, roots] of rootsBySession) {
      /** @type {Record<string, Usage>} */
      const roles = {};
      for (const root of roots) roles[root.role] ||= emptyUsage();
      const owner = attribute(all, roots);
      /** @type {Record<string, number>} */
      const spent = {};
      for (const [pid, role] of owner) {
        const p = /** @type {Proc} */ (all.get(pid));
        const usage = roles[role];
        usage.memoryBytes += p.rss * pageSize;
        usage.processes += 1;
        // A pid not seen last time started since, so all its time is this interval's;
        // one seen with another start time is a reused pid, the same.
        const before = lastTicks.get(pid);
        spent[role] =
          (spent[role] || 0) +
          p.ticks +
          p.childTicks -
          (before && before.start === p.start ? before.ticks : 0);
      }
      // A process seen last time that has since exited and been waited for: its time rolls
      // up into the childTicks of the nearest ancestor still alive (a shell that waited for
      // its compiler and was then waited for itself passes both on), so take the part the
      // last samples already counted off that ancestor's role. The walk follows ancestors
      // that exited too, and stops at one whose pid was reused or that was never seen.
      // A descendant orphaned and reaped outside (by init or a subreaper) never reached
      // that ancestor, so the discount is capped at how much its childTicks actually grew.
      /** @type {Map<number, number>} */
      const counted = new Map();
      for (const [pid, before] of lastTicks) {
        if (all.get(pid)?.start === before.start) continue;
        let ppid = before.ppid;
        for (let hops = 0; hops < 64; hops++) {
          const parent = lastTicks.get(ppid);
          if (!parent || all.get(ppid)) break;
          ppid = parent.ppid;
        }
        const alive = all.get(ppid);
        if (alive && alive.start === lastTicks.get(ppid)?.start && owner.has(ppid))
          counted.set(ppid, (counted.get(ppid) || 0) + before.ticks);
      }
      for (const [ppid, ticks] of counted) {
        const role = /** @type {string} */ (owner.get(ppid));
        const grown =
          /** @type {Proc} */ (all.get(ppid)).childTicks -
          /** @type {any} */ (lastTicks.get(ppid)).childTicks;
        spent[role] = (spent[role] || 0) - Math.max(0, Math.min(ticks, grown));
      }
      const total = emptyUsage();
      for (const [role, usage] of Object.entries(roles)) {
        usage.cpuPercent = seconds
          ? round((100 * Math.max(0, spent[role] || 0)) / clockTicks / seconds)
          : null;
        total.memoryBytes += usage.memoryBytes;
        total.processes += usage.processes;
        if (usage.cpuPercent != null) total.cpuPercent = round((total.cpuPercent || 0) + usage.cpuPercent);
      }
      // No process at all is an idle session, 0% rather than unknown.
      if (seconds && total.cpuPercent == null) total.cpuPercent = 0;

      let entry = sessions.get(session.id);
      if (!entry) {
        entry = { current: { ...total, at, roles }, history: [], disk: null, workDir: session.workDir };
        sessions.set(session.id, entry);
      }
      // Reopened onto another workspace: the last size was the old one's.
      if (entry.workDir !== session.workDir) {
        entry.workDir = session.workDir;
        entry.disk = null;
        diskDue.delete(session.id);
      }
      entry.current = { ...total, at, roles };
      entry.history.push({ at, ...total });
      if (entry.history.length > historySize) entry.history.splice(0, entry.history.length - historySize);
    }

    const openIds = new Set(open.map((s) => s.id));
    for (const id of sessions.keys()) if (!openIds.has(id)) sessions.delete(id);
    for (const id of diskDue.keys()) if (!openIds.has(id)) diskDue.delete(id);
    lastTicks = ticks;
    lastAt = at;
    void measureNextDisk(open, at);
  }

  // One du at a time, oldest due first, so many sessions do not walk the disk at once.
  async function measureNextDisk(open, at) {
    if (measuring) return;
    let next = null;
    for (const s of open) {
      const due = diskDue.get(s.id) ?? 0;
      if (s.workDir && due <= at && (!next || due < (diskDue.get(next.id) ?? 0))) next = s;
    }
    if (!next) return;
    measuring = true;
    diskDue.set(next.id, at + diskEveryMs);
    // The session may close and reopen onto another workspace while du walks this one;
    // its size then belongs to nobody.
    const entry = sessions.get(next.id);
    const dir = /** @type {string} */ (next.workDir);
    try {
      const bytes = await measureDisk(dir);
      if (entry && sessions.get(next.id) === entry && entry.workDir === dir)
        entry.disk = { bytes, measuredAt: now() };
    } catch {
      // A workspace removed mid-walk or a du that timed out: keep the last size.
    } finally {
      measuring = false;
    }
  }

  function host() {
    return {
      cpus: os.cpus().length,
      loadAverage: os.loadavg().map(round),
      memoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      intervalMs,
    };
  }

  /** @param {string} id */
  function stats(id) {
    const entry = sessions.get(id);
    if (!entry) return null;
    return { sessionId: id, ...entry.current, disk: entry.disk };
  }

  return {
    sample,
    /** @param {string} id */
    get: stats,
    /** @param {string} id */
    history: (id) => [...(sessions.get(id)?.history || [])],
    /** @param {(id: string) => boolean} [keep] */
    list: (keep = () => true) =>
      [...sessions.keys()].filter(keep).map((id) => /** @type {object} */ (stats(id))),
    host,
    /** @param {(id: string) => boolean} [keep] which sessions the totals count */
    server(keep = () => true) {
      const sessionTotal = { open: 0, cpuPercent: 0, memoryBytes: 0, processes: 0, diskBytes: 0 };
      for (const id of sessions.keys()) {
        if (!keep(id)) continue;
        const entry = /** @type {any} */ (sessions.get(id));
        sessionTotal.open += 1;
        sessionTotal.cpuPercent = round(sessionTotal.cpuPercent + (entry.current.cpuPercent || 0));
        sessionTotal.memoryBytes += entry.current.memoryBytes;
        sessionTotal.processes += entry.current.processes;
        sessionTotal.diskBytes += entry.disk?.bytes || 0;
      }
      const memory = process.memoryUsage();
      return {
        host: {
          ...host(),
          cpuPercent: serverCurrent?.hostCpuPercent ?? null,
          uptimeSeconds: Math.round(os.uptime()),
        },
        process: {
          cpuPercent: serverCurrent?.cpuPercent ?? null,
          memoryBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
        },
        disks: diskSpace(disks),
        sessions: sessionTotal,
        history: [...serverHistory],
      };
    },
    start() {
      if (timer) return;
      sample();
      timer = setInterval(sample, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** @param {number} n */
const round = (n) => Math.round(n * 10) / 10;
