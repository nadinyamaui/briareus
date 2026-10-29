import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree, trackTree, treeEnv } from '../lib/process-tree.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A detached child, as lib/jobs.js spawns a CLI, that starts a grandchild in a process group of its
// own, as dsh starts its tools; that grandchild starts one more process in its group.
function spawnTree() {
  const script = `
    const { spawn } = require('node:child_process');
    const tool = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    tool.stdout.once('data', (d) => console.log(tool.pid, String(d).trim()));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pids = new Promise((resolve) =>
    createInterface({ input: child.stdout }).once('line', (line) => resolve(line.split(' ').map(Number))),
  );
  return { child, pids };
}

it.runIf(process.platform === 'linux')(
  'kills the descendants that left the child process group',
  async () => {
    const { child, pids } = spawnTree();
    const [tool, sleeper] = await pids;
    const closed = new Promise((r) => child.once('close', r));
    try {
      expect(alive(tool) && alive(sleeper)).toBe(true);
      killTree(child);
      await closed;
      await vi.waitFor(() => expect([alive(tool), alive(sleeper)]).toEqual([false, false]), {
        timeout: 2000,
      });
    } finally {
      for (const pid of [tool, sleeper]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  },
);

// A tool shell, in a group of its own, that backgrounds work and exits: that work is reparented away
// from the child, outside every group the child leads, so only its spawn environment ties it back.
it.runIf(process.platform === 'linux')(
  'kills work a finished tool left behind, and nothing spawned under another tree value',
  async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const tool = spawn('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      tool.stdout.once('data', (d) => tool.once('close', () => console.log(String(d).trim())));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      env: treeEnv(process.env),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const other = spawn('sleep', ['30'], { detached: true, env: treeEnv(process.env), stdio: 'ignore' });
    const orphan = await new Promise((resolve) =>
      createInterface({ input: child.stdout }).once('line', (line) => resolve(Number(line))),
    );
    const closed = new Promise((r) => child.once('close', r));
    try {
      expect(alive(orphan)).toBe(true);
      killTree(child);
      await closed;
      await vi.waitFor(() => expect(alive(orphan)).toBe(false), { timeout: 2000 });
      expect(alive(other.pid)).toBe(true);
    } finally {
      for (const pid of [orphan, other.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  },
);

// A stdio MCP server's detached helper inherits the CLI's stderr: the CLI exits and is reaped, but
// its pipes stay open, so `close` waits on the helper, which only the spawn's tracked value finds.
it.runIf(process.platform === 'linux')(
  'kills work holding the pipes of a tracked child that already exited',
  async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const helper = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
      helper.unref();
      console.log(helper.pid);
    `;
    const env = treeEnv(process.env);
    const child = trackTree(
      spawn(process.execPath, ['-e', script], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }),
      env,
    );
    let closed = false;
    child.once('close', () => (closed = true));
    const exited = new Promise((r) => child.once('exit', r));
    const helper = await new Promise((resolve) =>
      createInterface({ input: child.stdout }).once('line', (line) => resolve(Number(line))),
    );
    try {
      await exited;
      expect([alive(helper), closed]).toEqual([true, false]);
      killTree(child);
      await vi.waitFor(() => expect([alive(helper), closed]).toEqual([false, true]), { timeout: 2000 });
    } finally {
      if (alive(helper)) process.kill(helper, 'SIGKILL');
    }
  },
);

// Run inside a session's tool shell, this process carries the session's tree value, and so does a
// child spawned without treeEnv: following it would kill the session's CLI, here `sibling`.
it.runIf(process.platform === 'linux')(
  'does not follow a tree value the child only inherited from this process',
  async () => {
    const inherited = treeEnv(process.env).BRIAREUS_PROCESS_TREE;
    vi.stubEnv('BRIAREUS_PROCESS_TREE', inherited);
    const sibling = spawn('sleep', ['30'], { detached: true, env: { ...process.env }, stdio: 'ignore' });
    const child = spawn('sleep', ['30'], { detached: true, env: { ...process.env }, stdio: 'ignore' });
    const closed = new Promise((r) => child.once('close', r));
    try {
      killTree(child);
      await closed;
      expect(alive(sibling.pid)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      if (alive(sibling.pid)) process.kill(sibling.pid, 'SIGKILL');
    }
  },
);

it('signals only the process group of a pid that is not its own child', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    killTree(/** @type {any} */ ({ pid: process.ppid, kill: () => true }));
    expect(kill.mock.calls).toEqual([[-process.ppid, 'SIGKILL']]);
  } finally {
    kill.mockRestore();
  }
});
