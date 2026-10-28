import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual handlers without starting the HTTP server or paid workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const shutdown = source.slice(source.indexOf('// On shutdown, flush the write queue:'));

describe('shutdown persistence', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'])(
    'awaits the final flush after process termination fails (%s)',
    async (signal) => {
      const process = new EventEmitter();
      process.exit = vi.fn();
      const githubSync = { stop: vi.fn() };
      const stop = vi.fn(async () => {
        throw new Error('escaped tool still holds stdio');
      });
      let allowFlush;
      const flush = vi.fn(
        () =>
          new Promise((resolve) => {
            allowFlush = resolve;
          }),
      );
      new Function(
        'process',
        'stopAllJobProcesses',
        'flushJobs',
        'stopAllDevServes',
        'stopAllBrowsers',
        'setTimeout',
        'clearTimeout',
        'console',
        'githubSync',
        shutdown,
      )(process, stop, flush, vi.fn(), vi.fn(), vi.fn(), vi.fn(), { error: vi.fn() }, githubSync);
      process.emit(signal, new Error('crash'));
      expect(githubSync.stop).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      expect(process.exit).not.toHaveBeenCalled();
      allowFlush();
      await vi.waitFor(() =>
        expect(process.exit).toHaveBeenCalledWith(signal === 'uncaughtException' ? 1 : 0),
      );
    },
  );
});
