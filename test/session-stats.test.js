import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attribute, createSessionStats, parseProcStat } from '../lib/session-stats.js';
import { sessionStatsRoutes } from '../lib/session-stats-routes.js';

// A /proc/<pid>/stat line with the fields this module reads; the rest are zeros.
function statLine({
  pid,
  comm = 'x',
  ppid,
  pgrp,
  utime = 0,
  stime = 0,
  cutime = 0,
  cstime = 0,
  start = 1,
  rss = 0,
}) {
  const f = Array(50).fill('0');
  f[0] = String(pid);
  f[1] = `(${comm})`;
  f[2] = 'S';
  f[3] = String(ppid);
  f[4] = String(pgrp);
  f[13] = String(utime);
  f[14] = String(stime);
  f[15] = String(cutime);
  f[16] = String(cstime);
  f[21] = String(start);
  f[23] = String(rss);
  return f.join(' ');
}

let procDir;
const writeProc = (procs) => {
  fs.rmSync(procDir, { recursive: true, force: true });
  fs.mkdirSync(procDir);
  fs.writeFileSync(path.join(procDir, 'meminfo'), ''); // not a pid, skipped
  for (const p of procs) {
    fs.mkdirSync(path.join(procDir, String(p.pid)));
    fs.writeFileSync(path.join(procDir, String(p.pid), 'stat'), statLine(p));
  }
};

beforeEach(() => {
  procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-stats-'));
});
afterEach(() => fs.rmSync(procDir, { recursive: true, force: true }));

describe('parseProcStat', () => {
  it('counts fields from the last parenthesis, so a command name with spaces or parens parses', () => {
    const stat = parseProcStat(
      statLine({
        pid: 7,
        comm: 'a (b) c',
        ppid: 3,
        pgrp: 7,
        utime: 5,
        stime: 6,
        cutime: 2,
        cstime: 3,
        start: 9,
        rss: 11,
      }),
    );
    expect(stat).toEqual({ ppid: 3, pgrp: 7, ticks: 11, childTicks: 5, start: 9, rss: 11 });
  });
});

describe('attribute', () => {
  it('claims descendants and orphans left in a root’s process group, each once', () => {
    const all = new Map(
      [
        { pid: 1, ppid: 0, pgrp: 1 },
        { pid: 100, ppid: 50, pgrp: 100 }, // agent, leads its group
        { pid: 101, ppid: 100, pgrp: 100 },
        { pid: 102, ppid: 101, pgrp: 102 }, // left the group, still a descendant
        { pid: 103, ppid: 1, pgrp: 100 }, // reparented to init, still in the group
        { pid: 200, ppid: 50, pgrp: 50 }, // browser, not a group leader
        { pid: 201, ppid: 200, pgrp: 50 },
        { pid: 300, ppid: 50, pgrp: 50 }, // the server's own sibling: nobody's
      ].map((p) => [p.pid, { ticks: 0, start: 0, rss: 0, ...p }]),
    );
    const owner = attribute(all, [
      { pid: 100, role: 'agent' },
      { pid: 200, role: 'browser' },
      { pid: 999, role: 'serve' }, // exited
    ]);
    expect(Object.fromEntries(owner)).toEqual({
      100: 'agent',
      101: 'agent',
      102: 'agent',
      103: 'agent',
      200: 'browser',
      201: 'browser',
    });
  });
});

describe('createSessionStats', () => {
  const make = (opts = {}) => {
    let t = 1_000_000;
    const clock = { advance: (ms) => (t += ms) };
    const sessions = [{ id: 's1', workDir: '/w/s1' }];
    const roots = { s1: [{ pid: 100, role: 'agent' }] };
    const stats = createSessionStats({
      listSessions: () => sessions,
      rootsOf: (s) => roots[s.id] || [],
      procDir,
      clockTicks: 100,
      pageSize: 4096,
      historySize: 3,
      measureDisk: async () => 5000,
      now: () => t,
      ...opts,
    });
    return { stats, clock, sessions, roots };
  };

  it('reports memory and processes at once and CPU from the second sample', async () => {
    writeProc([
      { pid: 100, ppid: 1, pgrp: 100, utime: 100, rss: 10, start: 5 },
      { pid: 101, ppid: 100, pgrp: 100, utime: 50, rss: 5, start: 6 },
    ]);
    const { stats, clock } = make();
    stats.sample();
    expect(stats.get('s1')).toMatchObject({ cpuPercent: null, memoryBytes: 15 * 4096, processes: 2 });

    // 10 s later: pid 100 spent 2 s more, 101 exited (spending nothing more, so 100 waited
    // for the 50 ticks already counted), 102 started and spent 1 s.
    clock.advance(10_000);
    writeProc([
      { pid: 100, ppid: 1, pgrp: 100, utime: 300, cutime: 50, rss: 10, start: 5 },
      { pid: 102, ppid: 100, pgrp: 100, utime: 100, rss: 1, start: 9 },
    ]);
    stats.sample();
    expect(stats.get('s1')).toMatchObject({
      cpuPercent: 30,
      memoryBytes: 11 * 4096,
      processes: 2,
      roles: { agent: { cpuPercent: 30, memoryBytes: 11 * 4096, processes: 2 } },
    });
    await new Promise((r) => setImmediate(r));
    expect(stats.get('s1').disk).toEqual({ bytes: 5000, measuredAt: expect.any(Number) });
  });

  it('counts a child that ran and exited between samples, once', () => {
    writeProc([
      { pid: 100, ppid: 1, pgrp: 100, utime: 100, start: 5 },
      { pid: 101, ppid: 100, pgrp: 100, utime: 40, start: 6 },
    ]);
    const { stats, clock } = make();
    stats.sample();
    // 10 s later: 101 spent 20 more ticks and exited; 102 started, spent 300 and exited.
    // 100 waited for both: its children's time is 60 + 300.
    clock.advance(10_000);
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, utime: 100, cutime: 360, start: 5 }]);
    stats.sample();
    expect(stats.get('s1').cpuPercent).toBe(32);
  });

  it('does not count again the time of a shell and its child that both exited', () => {
    writeProc([
      { pid: 100, ppid: 1, pgrp: 100, utime: 100, start: 5 },
      { pid: 101, ppid: 100, pgrp: 100, utime: 40, start: 6 },
      { pid: 102, ppid: 101, pgrp: 100, utime: 60, start: 7 },
    ]);
    const { stats, clock } = make();
    stats.sample();
    // 10 s later, nothing more was spent: 101 waited for 102, then 100 waited for 101,
    // so 100's children's time is 40 + 60, all of it counted last time.
    clock.advance(10_000);
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, utime: 100, cutime: 100, start: 5 }]);
    stats.sample();
    expect(stats.get('s1').cpuPercent).toBe(0);
  });

  it('does not take off the time of a background child reaped outside the session', () => {
    writeProc([
      { pid: 100, ppid: 1, pgrp: 100, start: 5 },
      { pid: 101, ppid: 100, pgrp: 100, utime: 40, start: 6 },
      { pid: 102, ppid: 101, pgrp: 100, utime: 59, start: 7 },
    ]);
    const { stats, clock } = make();
    stats.sample();
    // 10 s later: 101 exited without waiting for 102, 100 waited for 101, and 102 was
    // reparented and reaped by init. 100 spent 50 ticks itself; its children's time is
    // only 101's 40, so 102's 59 must not come off.
    clock.advance(10_000);
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, utime: 50, cutime: 40, start: 5 }]);
    stats.sample();
    expect(stats.get('s1').cpuPercent).toBe(5);
  });

  it('counts a reused pid’s whole time as new', () => {
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, utime: 1000, start: 5 }]);
    const { stats, clock } = make();
    stats.sample();
    clock.advance(10_000);
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, utime: 200, start: 77 }]);
    stats.sample();
    expect(stats.get('s1').cpuPercent).toBe(20);
  });

  it('reads an idle session as 0% and keeps only the last historySize samples', () => {
    const { stats, clock, roots } = make();
    roots.s1 = [];
    for (let i = 0; i < 5; i++) {
      stats.sample();
      clock.advance(10_000);
    }
    expect(stats.get('s1')).toMatchObject({ cpuPercent: 0, memoryBytes: 0, processes: 0, roles: {} });
    expect(stats.history('s1')).toHaveLength(3);
    expect(stats.server().history).toHaveLength(3);
  });

  it('forgets a session that is no longer open', () => {
    writeProc([]);
    const { stats, sessions } = make();
    stats.sample();
    expect(stats.list()).toHaveLength(1);
    sessions.length = 0;
    stats.sample();
    expect(stats.get('s1')).toBeNull();
    expect(stats.history('s1')).toEqual([]);
  });

  it('measures the workspace that has waited longest first', async () => {
    writeProc([]);
    const measured = [];
    const { stats, clock, sessions } = make({
      diskEveryMs: 15_000,
      measureDisk: async (dir) => (measured.push(dir), 1),
    });
    sessions.push({ id: 's2', workDir: '/w/s2' }, { id: 's3', workDir: '/w/s3' });
    for (let i = 0; i < 6; i++) {
      stats.sample();
      await new Promise((r) => setImmediate(r));
      clock.advance(10_000);
    }
    // s1 falls due again before s3 has had a turn, but s3 has waited longer.
    expect(measured).toEqual(['/w/s1', '/w/s2', '/w/s3', '/w/s1', '/w/s2', '/w/s3']);
  });

  it('drops a size measured for the workspace a session has since left', async () => {
    writeProc([]);
    let finish;
    const { stats, sessions } = make({ measureDisk: () => new Promise((r) => (finish = r)) });
    stats.sample();
    sessions[0] = { id: 's1', workDir: '/w/other' };
    stats.sample();
    finish(5000);
    await new Promise((r) => setImmediate(r));
    expect(stats.get('s1').disk).toBeNull();
  });

  it('totals the sessions it is asked about and lists each disk once', async () => {
    writeProc([{ pid: 100, ppid: 1, pgrp: 100, rss: 10 }]);
    const { stats } = make({
      disks: [
        { label: 'workspaces', dir: procDir },
        { label: 'files', dir: procDir },
        { label: 'missing', dir: path.join(procDir, 'nope') },
      ],
    });
    stats.sample();
    await new Promise((r) => setImmediate(r));
    const server = stats.server();
    expect(server.sessions).toEqual({
      open: 1,
      cpuPercent: 0,
      memoryBytes: 40960,
      processes: 1,
      diskBytes: 5000,
    });
    expect(stats.server(() => false).sessions.open).toBe(0);
    expect(server.disks.map((d) => d.label)).toEqual(['workspaces']);
    expect(server.disks[0].totalBytes).toBeGreaterThan(0);
    expect(server.process).toMatchObject({ memoryBytes: expect.any(Number), nodeVersion: process.version });
    expect(server.host).toMatchObject({ cpus: os.cpus().length, intervalMs: 10_000 });
  });
});

describe('sessionStatsRoutes', () => {
  it('answers per session and holds lists and totals to the token’s projects', async () => {
    const jobs = {
      a: { id: 'a', kind: 'devchat', repo: 'o/a', status: 'idle' },
      b: { id: 'b', kind: 'devchat', repo: 'o/b', status: 'idle' },
      r: { id: 'r', kind: 'review', repo: 'o/a' },
    };
    const sample = (id) => ({ sessionId: id, cpuPercent: 1, memoryBytes: 1, processes: 1, disk: null });
    const stats = {
      get: (id) => (id === 'a' ? sample(id) : null),
      history: (id) => (id === 'a' ? [{ at: 1 }] : []),
      host: () => ({ cpus: 4 }),
      list: (keep) => ['a', 'b'].filter(keep).map(sample),
      server: (keep) => ({ sessions: { open: ['a', 'b'].filter(keep).length } }),
    };
    let repos = null;
    const app = express();
    app.use((_req, res, next) => {
      res.locals.apiRepos = repos;
      next();
    });
    app.use(
      sessionStatsRoutes({
        stats,
        getJob: (id) => jobs[id] || null,
        isOpen: (job) => job.status !== 'closed',
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const get = async (p) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      return { status: res.status, body: await res.json() };
    };
    try {
      expect(await get('/api/dev/sessions/a/stats')).toEqual({
        status: 200,
        body: { stats: sample('a'), history: [{ at: 1 }], host: { cpus: 4 } },
      });
      expect((await get('/api/dev/sessions/b/stats')).body.stats).toBeNull();
      expect((await get('/api/dev/sessions/r/stats')).status).toBe(404);
      expect((await get('/api/dev/stats/sessions')).body.sessions.map((s) => s.sessionId)).toEqual([
        'a',
        'b',
      ]);
      repos = ['o/b'];
      expect((await get('/api/dev/stats/sessions')).body.sessions.map((s) => s.sessionId)).toEqual(['b']);
      expect((await get('/api/dev/stats/server')).body.sessions.open).toBe(1);
      // Closed since the last sample, which still holds it: answered as closed at once.
      repos = null;
      jobs.a.status = 'closed';
      expect((await get('/api/dev/sessions/a/stats')).body).toMatchObject({ stats: null, history: [] });
      expect((await get('/api/dev/stats/sessions')).body.sessions.map((s) => s.sessionId)).toEqual(['b']);
      expect((await get('/api/dev/stats/server')).body.sessions.open).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
