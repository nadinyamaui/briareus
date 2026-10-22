import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createUsers } from '../lib/users.js';
import { createSlackService } from '../lib/slack.js';

// Exercise the server's actual resolvers without booting workers or the HTTP listener.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ownership = source.slice(
  source.indexOf('// Who owns what'),
  source.indexOf('setInboxOwner(inboxOwner)'),
);
const home = source.slice(
  source.indexOf('const homeAssistantOf ='),
  source.indexOf('api.use(\n  homeAssistantRoutes('),
);

it('keeps legacy Slack and Home Assistant with the original operator across role changes and restarts', async () => {
  let rows = [
    { id: 1, name: 'Owner', role: 'admin', createdAt: 1, disabledAt: null },
    { id: 2, name: 'Ana', role: 'admin', createdAt: 2, disabledAt: null },
  ];
  const environment = { url: 'http://home:8123', token: 'operator-token' };
  const credentials = { get: () => null };
  async function setup() {
    const users = createUsers({ load: async () => rows });
    await users.init();
    const resolvers = new Function(
      'users',
      'credentials',
      'getConfig',
      `${ownership}\n${home}\nreturn { legacyOwner: originalOperator, inboxOwner, homeAssistantOf };`,
    )(users, credentials, () => ({ homeAssistant: environment }));
    const slack = createSlackService({
      load: async (key, fallback) => (key === 'slack_workspaces' ? [{ id: 9, projects: [] }] : fallback),
      legacyOwner: resolvers.legacyOwner,
      inboxOwner: resolvers.inboxOwner,
    });
    await slack.init();
    return { users, slack, ...resolvers };
  }
  const assertOwnership = ({ slack, homeAssistantOf, inboxOwner }) => {
    expect(slack.list(undefined, 1)).toHaveLength(1);
    expect(slack.list(undefined, 2)).toEqual([]);
    expect(homeAssistantOf(rows[0])).toBe(environment);
    expect(homeAssistantOf(rows[1])).toBeNull();
    expect(inboxOwner({})).toBe(1);
  };
  const live = await setup();
  assertOwnership(live);
  rows = [{ ...rows[0], role: 'member' }, rows[1]];
  await live.users.refresh();
  assertOwnership(live);
  assertOwnership(await setup());
  rows = [{ ...rows[0], disabledAt: 10 }, rows[1]];
  await live.users.refresh();
  expect(live.inboxOwner({})).toBeNull();
  expect(live.slack.list(undefined, 2)).toEqual([]);
  expect(live.homeAssistantOf(rows[1])).toBeNull();
});
