// @ts-check
// Sets (or changes) the username and password the dashboard's own login asks
// for.
//
//   npm run set-password
//
// The password is typed here and hashed here: what lands in .env is the
// username, a scrypt hash and a random signing secret, never the password
// itself. Re-running it changes both; passing --off removes the keys, which
// switches the login back off.
//
// Nothing else reads .env at write time, so this rewrites the file line by line
// and leaves every other setting, and every comment, exactly where it was.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { hashPassword } from '../lib/auth.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

// The username is not a secret, so it is typed in the open, and offered back
// as a default, so changing only the password stays one Enter away.
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const rl = /** @type {any} */ (
      readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    );
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('cancelled'));
    });
  });
}

// Reads one line without echoing it, so the password never appears on screen
// or in the terminal's scrollback.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const rl = /** @type {any} */ (
      readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    );
    // The interface still needs to write the prompt; muting starts right after.
    process.stdout.write(prompt);
    let muted = true;
    const onWrite = rl._writeToOutput;
    rl._writeToOutput = (s) => {
      if (!muted) onWrite.call(rl, s);
    };
    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('cancelled'));
    });
  });
}

// Replaces the key in place if it is already there, appends it if not, so the
// file keeps its shape however it was ordered.
function upsert(lines, key, value) {
  const at = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (at === -1) return [...lines, `${key}=${value}`];
  const copy = [...lines];
  copy[at] = `${key}=${value}`;
  return copy;
}

function readKey(lines, key) {
  const line = lines.find((l) => l.trim().startsWith(`${key}=`));
  return line
    ? line
        .trim()
        .slice(key.length + 1)
        .trim()
    : '';
}

function removeKeys(lines, keys) {
  return lines.filter((l) => !keys.some((k) => l.trim().startsWith(`${k}=`)));
}

function readEnvLines() {
  if (!fs.existsSync(ENV_PATH)) return [];
  return fs.readFileSync(ENV_PATH, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function writeEnvLines(lines) {
  // One trailing newline, however many the input had.
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  fs.writeFileSync(ENV_PATH, text, 'utf8');
}

async function main() {
  const off = process.argv.includes('--off');
  let lines = readEnvLines();

  if (off) {
    lines = removeKeys(lines, ['AUTH_USERNAME', 'AUTH_PASSWORD_HASH', 'AUTH_SECRET']);
    writeEnvLines(lines);
    console.log('Login switched off: AUTH_USERNAME, AUTH_PASSWORD_HASH and AUTH_SECRET removed from .env.');
    console.log('Restart the server (pm2 restart reviewer) for it to take effect.');
    console.log('Do not leave it off while the app is reachable from outside this machine.');
    return;
  }

  const current = readKey(lines, 'AUTH_USERNAME') || 'admin';
  const username = (await ask(`Dashboard username [${current}]: `)) || current;
  if (!/^[^\s=]+$/.test(username)) {
    console.error('\nNo spaces or "=": the username is written to .env as one line.');
    process.exitCode = 1;
    return;
  }

  const password = await askHidden('New dashboard password: ');
  if (password.length < 12) {
    console.error('\nToo short: use at least 12 characters. This password is the only thing');
    console.error('between the internet and a shell on this machine.');
    process.exitCode = 1;
    return;
  }
  const again = await askHidden('Again: ');
  if (again !== password) {
    console.error('\nThose do not match. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  lines = upsert(lines, 'AUTH_USERNAME', username);
  lines = upsert(lines, 'AUTH_PASSWORD_HASH', hashPassword(password));
  // The secret signs the session cookie. Kept if one is already there, so
  // changing the password does not sign every other browser out; generated on
  // first use. Delete it by hand to sign everyone out at once.
  if (!lines.some((l) => l.trim().startsWith('AUTH_SECRET=') && l.trim().length > 'AUTH_SECRET='.length)) {
    lines = upsert(lines, 'AUTH_SECRET', crypto.randomBytes(32).toString('base64url'));
  }
  writeEnvLines(lines);

  console.log(`\nSign in as "${username}". .env now holds the username, the password's scrypt hash`);
  console.log('and a cookie signing secret.');
  console.log('Restart the server for it to take effect:  pm2 restart reviewer');
}

main().catch((e) => {
  console.error(e.message === 'cancelled' ? '\nCancelled. Nothing was changed.' : `\n${e.message}`);
  process.exitCode = 1;
});
