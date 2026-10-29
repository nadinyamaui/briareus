import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from '../lib/process-tree.js';

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

it('signals only the process group of a pid that is not its own child', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    killTree(/** @type {any} */ ({ pid: process.ppid, kill: () => true }));
    expect(kill.mock.calls).toEqual([[-process.ppid, 'SIGKILL']]);
  } finally {
    kill.mockRestore();
  }
});
