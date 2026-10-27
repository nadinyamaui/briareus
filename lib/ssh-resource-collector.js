// @ts-check
import { createHash } from 'node:crypto';

// Connection and project changes start a separate history, so sharing the new
// server/project never discloses metrics of a previous target at the same id.
export function resourceTarget(server) {
  return createHash('sha256')
    .update(JSON.stringify([server.repo, server.host, server.port, server.username]))
    .digest('hex');
}

export function parseResourceSnapshot(stdout) {
  const raw = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  const number = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 4096;
  const array = (items, valid) => Array.isArray(items) && items.length <= 256 && items.every(valid);
  const sizes = (value, keys) => value && keys.every((key) => number(value[key]));
  if (
    !text(raw.bootId) ||
    !number(raw.uptimeSeconds) ||
    !sizes(raw.cpu, ['cores']) ||
    !array(raw.cpu.counters, number) ||
    raw.cpu.counters.length !== 8 ||
    !array(raw.cpu.loadAverage, number) ||
    raw.cpu.loadAverage.length !== 3 ||
    !sizes(raw.memory, [
      'totalBytes',
      'availableBytes',
      'usedBytes',
      'usedPercent',
      'swapTotalBytes',
      'swapUsedBytes',
    ]) ||
    raw.memory.usedPercent > 100 ||
    !array(
      raw.disks,
      (disk) =>
        text(disk.mount) &&
        text(disk.device) &&
        text(disk.filesystem) &&
        sizes(disk, ['totalBytes', 'usedBytes', 'availableBytes', 'usedPercent']) &&
        disk.usedPercent <= 100,
    ) ||
    !array(raw.network, (net) => text(net.name) && sizes(net, ['rxBytes', 'txBytes']))
  )
    throw new Error('Invalid resource snapshot');
  // Project onto the contract: arbitrary remote properties never reach clients.
  return {
    bootId: raw.bootId,
    uptimeSeconds: raw.uptimeSeconds,
    cpu: { counters: raw.cpu.counters, cores: raw.cpu.cores, loadAverage: raw.cpu.loadAverage },
    memory: Object.fromEntries(
      ['totalBytes', 'availableBytes', 'usedBytes', 'usedPercent', 'swapTotalBytes', 'swapUsedBytes'].map(
        (key) => [key, raw.memory[key]],
      ),
    ),
    disks: raw.disks.map(
      ({ mount, device, filesystem, totalBytes, usedBytes, availableBytes, usedPercent }) => ({
        mount,
        device,
        filesystem,
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent,
      }),
    ),
    network: raw.network.map(({ name, rxBytes, txBytes }) => ({ name, rxBytes, txBytes })),
  };
}

export function resourceMetrics(raw, previous = null) {
  const elapsed = previous && raw.bootId === previous.bootId ? raw.uptimeSeconds - previous.uptimeSeconds : 0;
  const delta =
    elapsed > 0 && previous.cpu.cores === raw.cpu.cores
      ? raw.cpu.counters.map((value, index) => value - previous.cpu.counters[index])
      : null;
  const total = delta?.reduce((sum, value) => sum + value, 0);
  const usagePercent =
    delta?.every((n) => n >= 0) && total > 0
      ? Math.min(100, Math.max(0, (100 * (total - delta[3] - delta[4])) / total))
      : null;
  const { counters, ...cpu } = raw.cpu;
  return {
    uptimeSeconds: raw.uptimeSeconds,
    cpu: { ...cpu, usagePercent },
    memory: raw.memory,
    disks: raw.disks,
    network: raw.network.map((net) => {
      const old = elapsed > 0 && previous.network.find((item) => item.name === net.name);
      const valid = old && net.rxBytes >= old.rxBytes && net.txBytes >= old.txBytes;
      return {
        ...net,
        rxBytesPerSecond: valid ? (net.rxBytes - old.rxBytes) / elapsed : null,
        txBytesPerSecond: valid ? (net.txBytes - old.txBytes) / elapsed : null,
      };
    }),
  };
}
