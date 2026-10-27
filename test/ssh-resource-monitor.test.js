import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createSshResourceMonitor, RESOURCE_RETENTION_MS } from '../lib/ssh-resource-monitor.js';
import {
  parseResourceSnapshot,
  resourceMetrics,
  resourceTarget,
  RESOURCE_COMMAND,
  RESOURCE_COLLECTOR,
} from '../lib/ssh-resource-collector.js';
import { createSshService } from '../lib/ssh.js';

const snapshot = (overrides = {}) => ({
  bootId: 'boot-one',
  uptimeSeconds: 100,
  cpu: { cores: 2, counters: [10, 0, 10, 70, 10, 0, 0, 0], loadAverage: [1, 0.5, 0.2] },
  memory: {
    totalBytes: 1000,
    usedBytes: 400,
    availableBytes: 600,
    usedPercent: 40,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  },
  disks: [
    {
      mount: '/',
      device: '/dev/sda',
      filesystem: 'ext4',
      totalBytes: 2000,
      usedBytes: 1000,
      availableBytes: 900,
      usedPercent: 52.63,
    },
  ],
  network: [{ name: 'eth0', rxBytes: 1000, txBytes: 500 }],
  ...overrides,
});
const host = (id = 1) => ({
  id,
  host: 'server.example',
  repo: 'owner/repo',
  port: 22,
  username: 'deploy',
  label: 'Server',
  enabled: true,
  monitoringEnabled: true,
});
let clock, servers, records, ssh, monitor, store;
beforeEach(() => {
  clock = Date.UTC(2026, 9, 27, 12);
  servers = [host()];
  records = [];
  ssh = { list: () => structuredClone(servers), collectResources: vi.fn(async () => snapshot()) };
  const matching = (id, target, since) =>
    records.filter((row) => row.id === id && row.target === target && row.sample.at >= since);
  store = {
    history: vi.fn(async (id, target, since, until) =>
      matching(id, target, since)
        .map((row) => row.sample)
        .filter((sample) => sample.at <= until),
    ),
    latest: vi.fn(async (id, target, since) => matching(id, target, since).at(-1)?.sample ?? null),
    save: vi.fn(async (id, target, sample) => records.push({ id, target, sample })),
    prune: vi.fn(async (before) => {
      records = records.filter((row) => row.sample.at >= before);
    }),
    report: vi.fn(),
  };
  monitor = createSshResourceMonitor({ ssh, ...store, now: () => clock });
});
afterEach(async () => {
  await monitor.stop();
  vi.useRealTimers();
});

describe('resource samples and retention', () => {
  it('persists a minute sample, restores counter baselines after restart, and hides raw counters', async () => {
    await monitor.tick();
    expect(records[0].sample.metrics.cpu.usagePercent).toBeNull();
    expect(records[0].sample.metrics.network[0].rxBytesPerSecond).toBeNull();
    monitor = createSshResourceMonitor({ ssh, ...store, now: () => clock });
    clock += 60_000;
    ssh.collectResources.mockResolvedValue(
      snapshot({
        uptimeSeconds: 160,
        cpu: { ...snapshot().cpu, counters: [30, 0, 20, 130, 10, 0, 0, 10] },
        network: [{ name: 'eth0', rxBytes: 7000, txBytes: 3500 }],
      }),
    );
    await monitor.tick();
    const { samples } = await monitor.history(host());
    expect(samples).toHaveLength(2);
    expect(samples[1].metrics.cpu.usagePercent).toBe(40);
    expect(samples[1].metrics.network[0]).toMatchObject({ rxBytesPerSecond: 100, txBytesPerSecond: 50 });
    expect(samples[1]).not.toHaveProperty('raw');
    expect(samples[1].metrics.cpu).not.toHaveProperty('counters');
  });
  it('expires old samples even with no enabled hosts and clamps reads to 24 hours', async () => {
    await monitor.tick();
    clock += RESOURCE_RETENTION_MS + 1;
    servers = [];
    await monitor.tick();
    expect(records).toEqual([]);
    await monitor.history(host(), '0');
    expect(store.history).toHaveBeenLastCalledWith(
      1,
      resourceTarget(host()),
      clock - RESOURCE_RETENTION_MS,
      clock,
    );
    await expect(monitor.history(host(), ['1', '2'])).rejects.toMatchObject({ status: 400 });
    await expect(monitor.history(host(), 'NaN')).rejects.toMatchObject({ status: 400 });
  });
  it('retains explicit failures and retries next minute without exposing remote errors', async () => {
    ssh.collectResources.mockRejectedValue(new Error('ssh secret-password malicious-output'));
    await monitor.tick();
    const result = await monitor.summary(servers);
    expect(result[0]).toMatchObject({ stale: true, latest: { metrics: null } });
    expect(JSON.stringify(result)).not.toMatch(/secret-password|malicious-output/);
    clock += 60_000;
    ssh.collectResources.mockResolvedValue(snapshot());
    await monitor.tick();
    expect(records).toHaveLength(2);
    expect((await monitor.summary(servers))[0].stale).toBe(false);
    clock += 121_000;
    expect((await monitor.summary(servers))[0].stale).toBe(true);
  });
  it('skips disabled and unconsented hosts and prevents overlapping or duplicate minute polls', async () => {
    servers.push({ ...host(2), enabled: false }, { ...host(3), monitoringEnabled: false });
    let finish;
    ssh.collectResources.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = monitor.tick();
    expect(monitor.tick()).toBe(first);
    await vi.waitFor(() => expect(ssh.collectResources).toHaveBeenCalledTimes(1));
    finish(snapshot());
    await first;
    await monitor.tick();
    expect(ssh.collectResources).toHaveBeenCalledTimes(1);
  });
  it('isolates history after host/project changes and discards an in-flight result after disable', async () => {
    await monitor.tick();
    servers[0].repo = 'other/project';
    expect((await monitor.history(servers[0])).samples).toEqual([]);
    clock += 60_000;
    ssh.collectResources.mockImplementation(async () => {
      servers[0].monitoringEnabled = false;
      return snapshot();
    });
    await monitor.tick();
    expect(records).toHaveLength(1);
  });
  it('does not dial a host while storage is unavailable and limits SSH concurrency to four', async () => {
    store.prune.mockRejectedValueOnce(new Error('database down'));
    await monitor.tick();
    expect(ssh.collectResources).not.toHaveBeenCalled();
    servers = Array.from({ length: 7 }, (_, i) => host(i + 1));
    const finishes = [];
    ssh.collectResources.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const pending = monitor.tick();
    await vi.waitFor(() => expect(finishes).toHaveLength(4));
    finishes.splice(0).forEach((finish) => finish(snapshot()));
    await vi.waitFor(() => expect(finishes).toHaveLength(3));
    finishes.forEach((finish) => finish(snapshot()));
    await pending;
    expect(records).toHaveLength(7);
  });
  it('starts collection on boot and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    monitor.start();
    monitor.start();
    await monitor.tick();
    expect(ssh.collectResources).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ssh.collectResources).toHaveBeenCalledTimes(2);
    await monitor.stop();
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ssh.collectResources).toHaveBeenCalledTimes(2);
  });
});

describe('counter validity and SSH consent', () => {
  it('uses null rates after reboots, CPU hotplug and interface counter resets', () => {
    const old = snapshot();
    const rebooted = resourceMetrics(snapshot({ bootId: 'boot-two', uptimeSeconds: 160 }), old);
    expect(rebooted.cpu.usagePercent).toBeNull();
    expect(rebooted.network[0].rxBytesPerSecond).toBeNull();
    const reset = resourceMetrics(
      snapshot({
        uptimeSeconds: 160,
        cpu: { ...old.cpu, cores: 4 },
        network: [
          { name: 'eth0', rxBytes: 1, txBytes: 1 },
          { name: 'new0', rxBytes: 100, txBytes: 100 },
        ],
      }),
      old,
    );
    expect(reset.cpu.usagePercent).toBeNull();
    expect(reset.network.every((item) => item.rxBytesPerSecond === null)).toBe(true);
  });
  it('validates remote payloads and drops unrecognized remote properties', () => {
    expect(() => parseResourceSnapshot('{}')).toThrow();
    expect(() => parseResourceSnapshot(JSON.stringify(snapshot({ uptimeSeconds: -1 })))).toThrow();
    expect(parseResourceSnapshot(JSON.stringify({ ...snapshot(), secret: 'malicious' }))).not.toHaveProperty(
      'secret',
    );
  });
  it('requires explicit operator opt-in and runs only the fixed collector without sudo', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot()) }));
    const service = createSshService({ load: async () => [], save: async () => {}, execute });
    await service.init();
    const row = await service.create(host());
    await service.update(row.id, { monitoringEnabled: false });
    await expect(service.collectResources(row.id)).rejects.toThrow(/disabled/);
    await expect(service.update(row.id, { monitoringEnabled: 'true' })).rejects.toThrow(/boolean/);
    await service.update(row.id, { monitoringEnabled: true });
    expect(await service.collectResources(row.id)).toEqual(snapshot());
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
      RESOURCE_COMMAND,
      30,
      false,
      RESOURCE_COLLECTOR,
    );
    expect(service.pending()).toEqual([]);
    await service.update(row.id, { enabled: false });
    await expect(service.collectResources(row.id)).rejects.toThrow(/disabled/);
  });
});

it('installs and runs the real Python collector without root, and leaves no background service', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'briareus-monitor-test-'));
  const run = () =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'sh',
        ['-c', RESOURCE_COMMAND],
        { env: { ...process.env, HOME: directory }, timeout: 10_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin.end(RESOURCE_COLLECTOR);
    });
  try {
    const raw = parseResourceSnapshot(await run());
    expect(raw.cpu.cores).toBeGreaterThan(0);
    expect(raw.memory.totalBytes).toBeGreaterThan(0);
    expect(raw.disks.some((disk) => disk.mount === '/')).toBe(true);
    const file = path.join(directory, '.local/share/briareus/resource-monitor-v1.py');
    expect(await fs.readFile(file)).toEqual(RESOURCE_COLLECTOR);
    const before = await fs.stat(file);
    expect(before.mode & 0o777).toBe(0o600);
    await run();
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
