import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { loadAppSetting, saveAppSetting, updateAppSetting } from '../lib/db.js';
import { createSshService } from '../lib/ssh.js';
import { createSshResourceMonitor } from '../lib/ssh-resource-monitor.js';
import { sshTelemetryRoutes } from '../lib/ssh-telemetry-routes.js';

vi.mock('../lib/db.js', async (original) => ({
  ...(await original()),
  loadAppSetting: vi.fn(),
  saveAppSetting: vi.fn(),
  updateAppSetting: vi.fn(),
}));

const input = { repo: 'owner/repo', host: 'server.example', username: 'deploy' };
const sample = () => ({
  at: Date.now(),
  raw: {
    bootId: 'boot-one',
    uptimeSeconds: 100,
    cpu: { cores: 1, counters: [10, 0, 10, 70, 10, 0, 0, 0], loadAverage: [0, 0, 0] },
    memory: {
      totalBytes: 1000,
      usedBytes: 400,
      availableBytes: 600,
      usedPercent: 40,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    disks: [],
    network: [],
  },
});
let stored, lock, beforeCommit, a, b, id, token;
beforeEach(async () => {
  stored = [];
  lock = Promise.resolve();
  beforeCommit = null;
  vi.mocked(loadAppSetting)
    .mockReset()
    .mockImplementation(async () => structuredClone(stored));
  vi.mocked(saveAppSetting)
    .mockReset()
    .mockImplementation(async (_name, value) => {
      stored = structuredClone(value);
    });
  // Model the shared row lock provided by updateAppSetting. Each service has
  // its own cache and local write queue; only this store serializes instances.
  vi.mocked(updateAppSetting)
    .mockReset()
    .mockImplementation((name, fallback, fn) => {
      expect(name).toBe('ssh_servers');
      const task = lock.then(async () => {
        const value = structuredClone(stored ?? fallback);
        const result = await fn(value);
        if (beforeCommit) await beforeCommit();
        stored = structuredClone(value);
        return { value, result };
      });
      lock = task.catch(() => {});
      return task;
    });
  a = createSshService();
  await a.init();
  id = (await a.create(input)).id;
  token = await a.issueMonitorToken(id);
  b = createSshService();
  await b.init();
});

describe('monitor credentials across core instances', () => {
  it('observes rotation and revocation without stale edits restoring credentials', async () => {
    const replacement = await a.issueMonitorToken(id);
    expect(await b.authorizeMonitor(id, token)).toBeNull();
    expect((await b.authorizeMonitor(id, replacement))?.id).toBe(id);
    // B has not authenticated or refreshed since the original token was issued.
    await b.update(id, { label: 'Renamed after rotation' });
    expect(await b.authorizeMonitor(id, token)).toBeNull();
    expect((await b.authorizeMonitor(id, replacement))?.id).toBe(id);
    await a.revokeMonitorToken(id);
    expect(await b.authorizeMonitor(id, replacement)).toBeNull();
    await b.update(id, { label: 'Renamed after revocation' });
    const c = createSshService();
    await c.init();
    for (const service of [a, b, c]) {
      expect(await service.authorizeMonitor(id, token)).toBeNull();
      expect(await service.authorizeMonitor(id, replacement)).toBeNull();
    }
    expect(saveAppSetting).not.toHaveBeenCalled();
  });

  it.each(['edit', 'revoke'])('keeps revocation when %s holds the shared write lock first', async (first) => {
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (entered = resolve));
    beforeCommit = async () => {
      beforeCommit = null;
      entered();
      await gate;
    };
    const edit = () => b.update(id, { label: 'Concurrent edit' });
    const revoke = () => a.revokeMonitorToken(id);
    const holding = first === 'edit' ? edit() : revoke();
    await started;
    const waiting = first === 'edit' ? revoke() : edit();
    release();
    await Promise.all([holding, waiting]);
    expect(stored[0].label).toBe('Concurrent edit');
    expect(stored[0].monitorTokenHash).toBe('');
    expect(await b.authorizeMonitor(id, token)).toBeNull();
  });

  it.each([{ enabled: false }, { monitoringEnabled: false }, { host: 'new.example' }, 'remove'])(
    'rejects a credential after another instance changes the target: %j',
    async (change) => {
      if (change === 'remove') await a.remove(id);
      else await a.update(id, change);
      expect(await b.authorizeMonitor(id, token)).toBeNull();
    },
  );

  it('fails closed on shared storage errors and preserves credentials on failed writes', async () => {
    vi.mocked(loadAppSetting).mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(b.authorizeMonitor(id, token)).rejects.toThrow('Read unavailable');
    vi.mocked(updateAppSetting).mockRejectedValueOnce(new Error('Write unavailable'));
    await expect(a.revokeMonitorToken(id)).rejects.toThrow('Write unavailable');
    expect((await b.authorizeMonitor(id, token))?.id).toBe(id);
    await a.revokeMonitorToken(id);
    expect(await b.authorizeMonitor(id, token)).toBeNull();
  });

  it('awaits shared authorization at HTTP ingress and during ingestion', async () => {
    const save = vi.fn();
    const latest = vi.fn(async () => null);
    const monitor = createSshResourceMonitor({ ssh: b, save, latest });
    const app = express();
    app.use(sshTelemetryRoutes({ ssh: b, monitor }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1/telemetry/ssh/${id}/samples`;
    const post = (body) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
    try {
      const accepted = await post(JSON.stringify({ samples: [sample()] }));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ received: 1, accepted: 1 });
      save.mockClear();
      vi.mocked(loadAppSetting).mockRejectedValueOnce(new Error('Read unavailable'));
      expect((await post('{broken')).status).toBe(503);
      latest.mockImplementationOnce(async () => {
        await a.revokeMonitorToken(id);
        return null;
      });
      // Revocation after initial authorization must be noticed before saving.
      await expect(monitor.ingest(id, token, [sample()])).rejects.toMatchObject({ status: 401 });
      expect((await post('{broken')).status).toBe(401);
      await expect(monitor.ingest(id, token, [])).rejects.toMatchObject({ status: 401 });
      expect(save).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
