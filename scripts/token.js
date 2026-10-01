// @ts-check
// Issues, lists and revokes API tokens from a shell, without the dashboard:
//
//   npm run token -- issue --name Web --permission admin --days 90
//   npm run token -- issue --name CI --permission read --repo owner/app --repo owner/api
//   npm run token -- list
//   npm run token -- revoke <id>
//
// The same tokens Settings → Devices and clients makes, written to the same
// database row, so a running server picks them up within 15 seconds and the
// settings page lists and revokes them like any other. It is how the first
// token gets made on a machine with no browser, and how one gets made for a
// deploy script. Uses the same .env the server does.
//
// `issue` prints the token alone on stdout and everything else on stderr, so
// `TOKEN=$(npm run -s token -- issue ...)` captures just the token. It is shown
// once: only its hash is stored.

import { parseArgs } from 'node:util';
import { getConfig } from '../lib/config.js';
import { createMobileAuth } from '../lib/mobile-auth.js';

const USAGE = `Usage:
  npm run token -- issue --name <name> --permission read|manage|admin [--repo owner/name ...] [--days 1-365]
  npm run token -- list
  npm run token -- revoke <id>`;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      permission: { type: 'string' },
      repo: { type: 'string', multiple: true },
      days: { type: 'string', default: '90' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.error(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  // The secret binds each token to this login: a token made without it would
  // be refused by the server anyway, so say so here instead of minting a dud.
  const secret = getConfig().auth.secret;
  if (!secret) throw new Error('The login is off (no AUTH_SECRET). Run `npm run set-password` first.');

  const auth = createMobileAuth();
  await auth.init();

  if (command === 'issue') {
    const { device, token } = await auth.create(
      {
        label: values.name ?? '',
        permission: values.permission ?? '',
        repos: values.repo ?? [],
        days: Number(values.days),
      },
      secret,
    );
    const scope = device.permission === 'admin' ? 'every project' : device.repos.join(', ');
    console.error(`Issued "${device.label}" (${device.id}): ${device.permission} on ${scope}.`);
    console.error(`Expires ${day(device.expiresAt)}. Shown once; only its hash is stored.`);
    console.log(token);
  } else if (command === 'list') {
    const devices = auth.list();
    if (!devices.length) console.log('No tokens.');
    for (const d of devices) {
      const scope = d.permission === 'admin' ? '*' : d.repos.join(',');
      const state = d.expiresAt <= Date.now() ? 'expired' : `until ${day(d.expiresAt)}`;
      console.log(`${d.id}  ${d.permission.padEnd(6)}  ${state.padEnd(16)}  ${d.label}  [${scope}]`);
    }
  } else if (command === 'revoke') {
    const [id] = rest;
    if (!id) throw new Error('Name the token to revoke: `npm run token -- list` shows the ids.');
    if (!auth.list().some((d) => d.id === id)) throw new Error(`No token with id ${id}.`);
    await auth.revoke(id);
    console.error(`Revoked ${id}. A running server stops accepting it within 15 seconds.`);
  } else {
    console.error(`Unknown command "${command}".\n${USAGE}`);
    process.exitCode = 2;
  }
}

// The database pool has no close of its own, so the process ends explicitly
// once the work is done rather than idling on open connections.
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
