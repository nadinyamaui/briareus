// @ts-check
import {
  loadSshResourceSamples,
  latestSshResourceSample,
  saveSshResourceSample,
  pruneSshResourceSamples,
} from './db.js';
import { resourceMetrics, resourceTarget, parseResourceSnapshot } from './ssh-resource-collector.js';

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
  const receiving = new Set();
  const publicSample = (sample) =>
    sample ? { at: sample.at, metrics: sample.metrics, error: sample.error } : null;
  const tick = () => {
    if (!running)
      running = prune(now() - RESOURCE_RETENTION_MS)
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
      timer = setInterval(() => void tick(), RESOURCE_INTERVAL_MS);
      timer.unref();
      void tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      return running || Promise.resolve();
    },
    async ingest(id, token, samples) {
      const server = ssh.authorizeMonitor(id, token);
      if (!server) throw Object.assign(new Error('Invalid monitor credential'), { status: 401 });
      if (receiving.has(id))
        throw Object.assign(new Error('Telemetry upload already in progress'), { status: 429 });
      if (!Array.isArray(samples) || samples.length < 1 || samples.length > 10)
        throw Object.assign(new Error('Send 1–10 samples'), { status: 400 });
      const time = now();
      let parsed;
      try {
        parsed = samples
          .map((sample) => {
            if (!Number.isSafeInteger(sample?.at) || sample.at < 0 || sample.at > time + 30_000)
              throw new Error('Invalid sample timestamp');
            if (JSON.stringify(sample.raw).length > 64 * 1024) throw new Error('Snapshot too large');
            return {
              at: Math.floor(Math.min(sample.at, time) / RESOURCE_INTERVAL_MS) * RESOURCE_INTERVAL_MS,
              raw: parseResourceSnapshot(sample.raw),
            };
          })
          .sort((a, b) => a.at - b.at);
      } catch {
        throw Object.assign(new Error('Invalid resource sample'), { status: 400 });
      }
      receiving.add(id);
      const target = resourceTarget(server);
      try {
        let previous = await latest(id, target, time - RESOURCE_RETENTION_MS);
        let accepted = 0;
        for (const sample of parsed) {
          if (sample.at < time - RESOURCE_RETENTION_MS || (previous && sample.at <= previous.at)) continue;
          const current = ssh.authorizeMonitor(id, token);
          if (!current || resourceTarget(current) !== target)
            throw Object.assign(new Error('Monitor access changed'), { status: 401 });
          const row = { ...sample, metrics: resourceMetrics(sample.raw, previous?.raw), error: null };
          await save(id, target, row);
          previous = row;
          accepted++;
        }
        return { received: samples.length, accepted };
      } finally {
        receiving.delete(id);
      }
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
