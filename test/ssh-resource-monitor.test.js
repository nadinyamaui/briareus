import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createSshResourceMonitor, RESOURCE_RETENTION_MS } from '../lib/ssh-resource-monitor.js';
import { parseResourceSnapshot, resourceMetrics, resourceTarget } from '../lib/ssh-resource-collector.js';
import { createSshService } from '../lib/ssh.js';
import { sshTelemetryRoutes } from '../lib/ssh-telemetry-routes.js';

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
const token = 'brm_' + 'a'.repeat(43);
beforeEach(() => {
  clock = Date.UTC(2026, 9, 27, 12);
  servers = [host()];
  records = [];
  ssh = {
    list: () => structuredClone(servers),
    authorizeMonitor: (id, value) =>
      value === token && servers.find((s) => s.id === id && s.enabled && s.monitoringEnabled),
    execute: vi.fn(),
  };
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
const sample = (at, raw = snapshot()) => ({ at, raw });

describe('pushed resources and retention', () => {
  it('accepts buffered samples in order, computes rates and idempotently acknowledges retries', async () => {
    const first = sample(clock - 60_000);
    const second = sample(
      clock,
      snapshot({
        uptimeSeconds: 160,
        cpu: { ...snapshot().cpu, counters: [30, 0, 20, 130, 10, 0, 0, 10] },
        network: [{ name: 'eth0', rxBytes: 7000, txBytes: 3500 }],
      }),
    );
    expect(await monitor.ingest(1, token, [second, first])).toEqual({ received: 2, accepted: 2 });
    expect(await monitor.ingest(1, token, [second, first])).toEqual({ received: 2, accepted: 0 });
    expect(records).toHaveLength(2);
    const samples = (await monitor.history(host())).samples;
    expect(samples[0].metrics.cpu.usagePercent).toBeNull();
    expect(samples[1].metrics.cpu.usagePercent).toBe(40);
    expect(samples[1].metrics.network[0]).toMatchObject({ rxBytesPerSecond: 100, txBytesPerSecond: 50 });
    expect(samples[1]).not.toHaveProperty('raw');
    expect(samples[1].metrics.cpu).not.toHaveProperty('counters');
    expect(ssh.execute).not.toHaveBeenCalled();
  });
  it('restores persisted counter baselines after core restart', async () => {
    await monitor.ingest(1, token, [sample(clock)]);
    monitor = createSshResourceMonitor({ ssh, ...store, now: () => clock });
    clock += 60_000;
    await monitor.ingest(1, token, [
      sample(
        clock,
        snapshot({ uptimeSeconds: 160, network: [{ name: 'eth0', rxBytes: 7000, txBytes: 3500 }] }),
      ),
    ]);
    expect(records[1].sample.metrics.network[0].rxBytesPerSecond).toBe(100);
  });
  it('prunes all expired samples with no hosts, clamps history and acknowledges expired backlog', async () => {
    await monitor.ingest(1, token, [sample(clock)]);
    expect(await monitor.ingest(1, token, [sample(clock - RESOURCE_RETENTION_MS - 60_000)])).toEqual({
      received: 1,
      accepted: 0,
    });
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
  });
  it('rejects wrong credentials, disabled targets, malformed snapshots and future clocks', async () => {
    for (const [id, credential] of [
      [1, 'operator-token'],
      [2, token],
    ])
      await expect(monitor.ingest(id, credential, [sample(clock)])).rejects.toMatchObject({ status: 401 });
    await expect(monitor.ingest(1, token, [sample(clock + 31_000)])).rejects.toMatchObject({ status: 400 });
    await expect(monitor.ingest(1, token, [sample(clock, {})])).rejects.toMatchObject({ status: 400 });
    await expect(monitor.ingest(1, token, Array(11).fill(sample(clock)))).rejects.toMatchObject({
      status: 400,
    });
    servers[0].monitoringEnabled = false;
    await expect(monitor.ingest(1, token, [sample(clock)])).rejects.toMatchObject({ status: 401 });
    expect(records).toEqual([]);
  });
  it('does not mix target history and refuses revoked access after an asynchronous read', async () => {
    await monitor.ingest(1, token, [sample(clock)]);
    servers[0].repo = 'other/repo';
    expect((await monitor.history(servers[0])).samples).toEqual([]);
    store.latest.mockImplementationOnce(async () => {
      servers[0].monitoringEnabled = false;
      return null;
    });
    clock += 60_000;
    await expect(monitor.ingest(1, token, [sample(clock)])).rejects.toMatchObject({ status: 401 });
    expect(records).toHaveLength(1);
  });
  it('serializes uploads per host and reports stale data without inventing failed/zero samples', async () => {
    let finish;
    store.latest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = monitor.ingest(1, token, [sample(clock)]);
    await expect(monitor.ingest(1, token, [sample(clock)])).rejects.toMatchObject({ status: 429 });
    finish(null);
    await first;
    expect((await monitor.summary(servers))[0].stale).toBe(false);
    clock += 121_000;
    expect((await monitor.summary(servers))[0].stale).toBe(true);
    expect(records).toHaveLength(1);
  });
  it('runs only retention cleanup on its timer, never SSH connections', async () => {
    vi.useFakeTimers();
    monitor.start();
    monitor.start();
    await monitor.tick();
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.prune).toHaveBeenCalledTimes(2);
    await monitor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.prune).toHaveBeenCalledTimes(2);
    expect(ssh.execute).not.toHaveBeenCalled();
  });
});

it('isolates and rotates machine credentials without storing or exposing plaintext', async () => {
  let saved;
  const execute = vi.fn();
  const service = createSshService({
    load: async () => [],
    save: async (_name, rows) => {
      saved = rows;
    },
    execute,
  });
  await service.init();
  const first = await service.create(host());
  const second = await service.create(host(2));
  const credential = await service.issueMonitorToken(first.id);
  expect(service.authorizeMonitor(first.id, credential)?.id).toBe(first.id);
  expect(service.authorizeMonitor(second.id, credential)).toBeNull();
  expect(JSON.stringify(saved)).not.toContain(credential);
  expect(service.list()[0]).not.toHaveProperty('monitorTokenHash');
  const replacement = await service.issueMonitorToken(first.id);
  expect(service.authorizeMonitor(first.id, credential)).toBeNull();
  expect(service.authorizeMonitor(first.id, replacement)).toBeTruthy();
  await service.update(first.id, { repo: 'new/repo' });
  expect(service.authorizeMonitor(first.id, replacement)).toBeNull();
  const third = await service.issueMonitorToken(first.id);
  await service.revokeMonitorToken(first.id);
  expect(service.authorizeMonitor(first.id, third)).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('validates counters and preserves null rates across reboots and resets', () => {
  expect(() => parseResourceSnapshot({})).toThrow();
  expect(parseResourceSnapshot({ ...snapshot(), secret: 'x' })).not.toHaveProperty('secret');
  const old = snapshot();
  expect(
    resourceMetrics(snapshot({ bootId: 'reboot', uptimeSeconds: 160 }), old).cpu.usagePercent,
  ).toBeNull();
  const reset = resourceMetrics(
    snapshot({ uptimeSeconds: 160, network: [{ name: 'eth0', rxBytes: 1, txBytes: 1 }] }),
    old,
  );
  expect(reset.network[0].rxBytesPerSecond).toBeNull();
});

it('authenticates the telemetry HTTP ingress before parsing and rejects device credentials', async () => {
  const app = express();
  app.use(sshTelemetryRoutes({ ssh, monitor }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/telemetry/ssh`;
  try {
    const post = (id, credential, body) =>
      fetch(`${base}/${id}/samples`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    expect((await post(1, 'operator-token', '{broken')).status).toBe(401);
    expect((await post(2, token, { samples: [sample(clock)] })).status).toBe(401);
    const accepted = await post(1, token, { samples: [sample(clock)] });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ received: 1, accepted: 1 });
    expect((await post(1, token, { samples: [] })).status).toBe(400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
