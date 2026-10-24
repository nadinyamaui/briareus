import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createUsers } from '../lib/users.js';
import { createShares } from '../lib/shares.js';

// Run the actual store-loading block without starting HTTP, timers or workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const startup = source.slice(
  source.lastIndexOf('(async () => {', source.indexOf('    await initDb();')) + '(async () => {'.length,
  source.indexOf('// Only after the provider rows are loaded.'),
);

describe('startup store loading', () => {
  it.each(['users', 'shares', 'credentials'])(
    'continues startup after %s fails and allows later recovery',
    async (failed) => {
      const member = { id: 2, name: 'Ana', role: 'member', createdAt: 1, disabledAt: null };
      const loads = {
        users: vi.fn().mockResolvedValue([member]),
        shares: vi.fn().mockResolvedValue([{ kind: 'project', id: '3', userId: 2 }]),
      };
      if (failed !== 'credentials') loads[failed].mockRejectedValueOnce(new Error('transient read failure'));
      const users = createUsers({ load: loads.users });
      const shares = createShares({ load: loads.shares });
      const deps = { users, shares, console: { error: vi.fn() } };
      for (const name of [
        'initDb',
        'initTemplates',
        'initProjects',
        'initDbServers',
        'initSavedPrompts',
        'initMemorySelection',
        'initMemories',
        'initProviders',
        'restoreProviderUsage',
      ])
        deps[name] = vi.fn().mockResolvedValue(undefined);
      for (const name of [
        'sshService',
        'slackService',
        'mcpService',
        'envoyerService',
        'forgeAccounts',
        'mailService',
        'mobileAuth',
        'credentials',
      ])
        deps[name] = { init: vi.fn().mockResolvedValue(undefined) };
      if (failed === 'credentials')
        deps.credentials.init.mockRejectedValueOnce(new Error('transient read failure'));
      deps.listProviders = () => [];

      await new Function(...Object.keys(deps), `return (async () => {${startup}})();`)(
        ...Object.values(deps),
      );

      expect(loads.users.mock.invocationCallOrder[0]).toBeLessThan(
        deps.slackService.init.mock.invocationCallOrder[0],
      );
      for (const name of ['mobileAuth', 'mailService']) expect(deps[name].init).toHaveBeenCalledOnce();
      for (const name of [
        'initSavedPrompts',
        'initMemorySelection',
        'initMemories',
        'initProviders',
        'restoreProviderUsage',
      ])
        expect(deps[name]).toHaveBeenCalledOnce();
      expect(loads.users).toHaveBeenCalledOnce();
      expect(loads.shares).toHaveBeenCalledOnce();
      expect(deps.console.error).toHaveBeenCalledWith(
        `Could not load ${failed === 'credentials' ? 'user credentials' : failed}:`,
        'transient read failure',
      );
      if (failed === 'users') expect(() => users.get(2)).toThrow(expect.objectContaining({ status: 503 }));
      else if (failed === 'shares')
        expect(() => shares.allows(member, 'project', '3')).toThrow(expect.objectContaining({ status: 503 }));

      await users.refresh();
      await shares.refresh();
      expect(users.get(2)).toEqual(member);
      expect(shares.allows(member, 'project', '3')).toBe(true);
    },
  );
});
