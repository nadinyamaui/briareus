import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createSlackService } from '../lib/slack.js';
import { createWhatsAppOwners } from '../lib/whatsapp-owners.js';

// Run the actual startup and ownership callbacks without booting the server or workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const callbacks = source.slice(source.indexOf('let legacyOwnerId'), source.indexOf('setInboxOwner('));
const startup = source.slice(
  source.indexOf('    // The users migration assigned'),
  source.indexOf('    await shares.init();'),
);
const homeAssistant = source.slice(source.indexOf('const homeAssistantOf ='));
const homeCallback = homeAssistant.slice(0, homeAssistant.indexOf('\napi.use('));

function boot(users, load, save) {
  return new Function(
    'users',
    'loadAppSetting',
    'saveAppSetting',
    'credentials',
    'getConfig',
    `${callbacks}\n${homeCallback}\nreturn {
      init: async () => { ${startup} }, legacyOwner, inboxOwner, homeAssistantOf,
    };`,
  )(users, load, save, { get: () => null }, () => ({ homeAssistant: 'original-home' }));
}

it('keeps the original operator’s integrations after demotion, restart and disable', async () => {
  let rows = [
    { id: 1, role: 'admin' },
    { id: 2, role: 'admin' },
  ];
  const users = { list: () => rows, get: (id) => rows.find((u) => u.id === id) };
  let stored = null;
  const load = async () => stored;
  const save = vi.fn(async (_key, id) => {
    stored = id;
  });
  let app = boot(users, load, save);
  expect(app.legacyOwner()).toBeNull();
  await app.init();
  expect(stored).toBe(1);
  rows[0] = { id: 1, role: 'member' };
  expect(app.legacyOwner()).toBe(1);
  expect(app.inboxOwner({})).toBe(1);
  expect(app.homeAssistantOf(rows[1])).toBeNull();
  // Starting again must load the saved identity, regardless of the current admins.
  app = boot(users, load, save);
  await app.init();
  expect(save).toHaveBeenCalledTimes(1);
  expect(app.legacyOwner()).toBe(1);
  expect(app.inboxOwner({})).toBe(1);
  expect(app.homeAssistantOf(rows[0])).toBe('original-home');
  expect(app.homeAssistantOf(rows[1])).toBeNull();
  const whatsapp = createWhatsAppOwners({ load: async () => ({}), legacyOwner: app.legacyOwner });
  await whatsapp.init();
  expect(whatsapp.owns(1, 'default')).toBe(true);
  expect(whatsapp.owns(2, 'default')).toBe(false);
  const slack = createSlackService({
    load: async (key) => (key === 'slack_workspaces' ? [{ id: 1 }] : []),
    legacyOwner: app.legacyOwner,
  });
  await slack.init();
  expect(slack.owns(1, 1)).toBe(true);
  expect(() => slack.owns(1, 2)).toThrow();
  rows[0] = { ...rows[0], disabledAt: 123 };
  expect(app.inboxOwner({})).toBeNull();
  expect(app.legacyOwner()).toBe(1);
  rows = [rows[1]];
  app = boot(users, load, save);
  await app.init();
  expect(app.legacyOwner()).toBe(1);
  expect(app.inboxOwner({})).toBeNull();
  expect(app.homeAssistantOf(rows[0])).toBeNull();
});

it('does not publish an ownership fallback it could not persist', async () => {
  const app = boot(
    { list: () => [{ id: 1 }] },
    async () => null,
    async () => {
      throw new Error('DB down');
    },
  );
  await expect(app.init()).rejects.toThrow('DB down');
  expect(app.legacyOwner()).toBeNull();
});
