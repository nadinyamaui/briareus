import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createWhatsAppOwners } from '../lib/whatsapp-owners.js';

// Execute the actual initialization block without starting HTTP or paid workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('(async () => {', source.indexOf('// Load projects and sessions'));
const startup = source.slice(
  start + '(async () => {'.length,
  source.indexOf('  // Only after the provider rows'),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

it('loads core services even when WhatsApp account discovery fails', async () => {
  const listAccounts = vi
    .fn()
    .mockRejectedValueOnce(new Error('WAHA down'))
    .mockResolvedValue({ accounts: [] });
  const whatsappOwners = createWhatsAppOwners({
    load: async () => ({}),
    legacyOwner: () => 1,
    listAccounts,
  });
  const deps = {
    whatsappOwners,
    users: { init: vi.fn(), list: () => [{ id: 1 }] },
    loadAppSetting: vi.fn(async () => 1),
    saveAppSetting: vi.fn(),
    listProviders: () => [],
    console: { error: vi.fn() },
  };
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
    deps[name] = vi.fn();
  for (const name of [
    'sshService',
    'slackService',
    'mcpService',
    'envoyerService',
    'forgeAccounts',
    'mailService',
    'shares',
    'credentials',
    'mobileAuth',
  ])
    deps[name] = { init: vi.fn() };
  await new AsyncFunction(...Object.keys(deps), `let legacyOwnerId; ${startup}`)(...Object.values(deps));
  for (const name of [
    'initSavedPrompts',
    'initMemorySelection',
    'initMemories',
    'initProviders',
    'restoreProviderUsage',
  ])
    expect(deps[name]).toHaveBeenCalledOnce();
  expect(deps.mobileAuth.init).toHaveBeenCalledOnce();
  expect(deps.console.error).toHaveBeenCalledExactlyOnceWith(
    'Could not initialize WhatsApp ownership:',
    'WAHA down',
  );
  expect(whatsappOwners.owns(1, 'default')).toBe(false);
  await whatsappOwners.init();
  expect(whatsappOwners.owns(1, 'default')).toBe(true);
});
