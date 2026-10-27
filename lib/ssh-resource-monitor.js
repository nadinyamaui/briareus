// @ts-check
import {
  loadSshResourceSamples,
  latestSshResourceSample,
  saveSshResourceSample,
  pruneSshResourceSamples,
} from './db.js';
import { resourceMetrics, resourceTarget } from './ssh-resource-collector.js';

export const RESOURCE_INTERVAL_MS = 60_000;
export const RESOURCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function createSshResourceMonitor({
  ssh,
  history = loadSshResourceSamples,
  latest = latestSshResourceSample,
  save = saveSshResourceSample,
  prune = pruneSshResourceSamples,
  now = Date.now,
  report = (error) => console.error('SSH resource monitor:', error.message),
}) {
  let timer;
  let running = null;
  let stopped = false;
  const current = (server) => ssh.list().find((row) => row.id === server.id);
  const eligible = (server) => {
    const row = current(server);
    return (
      !stopped && row?.enabled && row.monitoringEnabled && resourceTarget(row) === resourceTarget(server)
    );
  };
  const publicSample = (sample) =>
    sample ? { at: sample.at, metrics: sample.metrics, error: sample.error } : null;
  async function collect(server) {
    const target = resourceTarget(server);
    const at = Math.floor(now() / RESOURCE_INTERVAL_MS) * RESOURCE_INTERVAL_MS;
    // Do not install or poll when the database cannot retain the result.
    const previous = await latest(server.id, target, now() - RESOURCE_RETENTION_MS);
    if (!eligible(server) || (previous && previous.at >= at)) return;
    let raw = null;
    let metrics = null;
    let error = null;
    try {
      raw = await ssh.collectResources(server.id);
      metrics = resourceMetrics(raw, previous?.raw);
    } catch {
      // SSH errors can contain credentials or remote-controlled text. Expose a
      // stable diagnostic, never stdout/stderr from an unsuccessful collection.
      error = 'Collection failed; check SSH connectivity, Python 3 and Linux /proc access';
    }
    if (!eligible(server)) return;
    await save(server.id, target, { at, metrics, error, raw });
  }
  async function poll() {
    // Expire even when every host is disabled, unreachable or has been removed.
    await prune(now() - RESOURCE_RETENTION_MS);
    const pending = ssh.list().filter((server) => server.enabled && server.monitoringEnabled);
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && !stopped) {
          const server = pending.shift();
          await collect(server).catch(report);
        }
      }),
    );
  }
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (!running)
      running = poll()
        .catch(report)
        .finally(() => {
          running = null;
        });
    return running;
  };
  return {
    tick,
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => void tick(), RESOURCE_INTERVAL_MS);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      return running || Promise.resolve();
    },
    async summary(servers) {
      const at = now();
      return Promise.all(
        servers.map(async (server) => {
          const sample = await latest(server.id, resourceTarget(server), at - RESOURCE_RETENTION_MS);
          return {
            id: server.id,
            label: server.label,
            repo: server.repo,
            enabled: server.enabled,
            monitoringEnabled: server.monitoringEnabled,
            latest: publicSample(sample),
            stale: !sample || at - sample.at > 2 * RESOURCE_INTERVAL_MS || !!sample.error,
          };
        }),
      );
    },
    async history(server, since) {
      const at = now();
      if (
        since !== undefined &&
        (typeof since !== 'string' || !/^\d+$/.test(since) || !Number.isSafeInteger(Number(since)))
      )
        throw Object.assign(new Error('since must be a Unix timestamp in milliseconds'), { status: 400 });
      const from = Math.max(at - RESOURCE_RETENTION_MS, since === undefined ? 0 : Number(since));
      const samples = await history(server.id, resourceTarget(server), from, at);
      return {
        serverId: server.id,
        intervalSeconds: 60,
        retentionHours: 24,
        from,
        to: at,
        samples: samples.map(publicSample),
      };
    },
  };
}
