// @ts-check
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadAppSetting, saveAppSetting, updateAppSetting } from './db.js';

const SETTING = 'mobile_devices';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicDevice = ({ tokenHash, ownerHash, ...device }) => device;

// Owner-issued tokens for the client API (/api/v1), never a secret embedded in
// an app build. The names here say "mobile" and "device" because the first
// client was a phone; the stored setting keeps its name so issued tokens stand.
// Persist hashes only. Serialize writes and publish state only after persistence
// succeeds, so a failed revoke cannot appear successful or lose a concurrent add.
// The server is not the only writer: `npm run create-token` issues and revokes
// from a shell, against the same row. So each write changes the row as stored, under a
// row lock (updateAppSetting), not this process's copy, and refresh() lets a
// long-lived process pick up what another one wrote.
/**
 * @param {{ load?: Function, save?: Function, update?: Function, now?: () => number }} [options]
 */
export function createMobileAuth({ load, save, update, now = Date.now } = {}) {
  // Tests hand in load and save as an in-memory store; one process has no
  // other writer to lock against, so the two compose into the update.
  if (!update && (load || save)) {
    const read = load || loadAppSetting;
    const write = save || saveAppSetting;
    update = async (name, fallback, fn) => {
      const value = await read(name, fallback);
      const result = fn(value);
      await write(name, value);
      return { value, result };
    };
  }
  load ||= loadAppSetting;
  const change = update || updateAppSetting;
  let devices = [];
  let ready = false;
  let writes = Promise.resolve();
  function requireReady() {
    if (!ready) throw fail(503, 'Token authentication is unavailable');
  }
  function write(fn) {
    const operation = writes.then(async () => {
      requireReady();
      const { value, result } = await change(SETTING, [], fn);
      devices = value;
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return {
    async init() {
      devices = await load(SETTING, []);
      ready = true;
    },
    // Queued behind writes, so a reload can never publish a list older than
    // one this process just saved. A failed reload keeps the last good list.
    refresh() {
      const operation = writes.then(async () => {
        devices = await load(SETTING, []);
        ready = true;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    list() {
      requireReady();
      return devices.map(publicDevice);
    },
    create({ label, repos, permission, days }, ownerSecret) {
      if (typeof ownerSecret !== 'string' || !ownerSecret)
        throw fail(403, 'AUTH_SECRET must be set before a token is issued');
      if (typeof label !== 'string' || !label.trim() || label.length > 100)
        throw fail(400, 'Enter a name for the token (up to 100 characters)');
      if (!['read', 'manage', 'admin'].includes(permission))
        throw fail(400, 'Choose read, manage or admin permission');
      // An admin token is the operator's own: it is not held to a project
      // list, so it carries none, and a project added later is covered too.
      if (permission === 'admin') repos = [];
      else if (
        !Array.isArray(repos) ||
        !repos.length ||
        repos.some((r) => typeof r !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r))
      )
        throw fail(400, 'Select at least one project');
      if (!Number.isInteger(days) || days < 1 || days > 365) throw fail(400, 'Choose 1–365 days');
      return write((next) => {
        if (next.filter((d) => d.expiresAt > now()).length >= 100)
          throw fail(400, 'Revoke an existing token before adding another');
        const token = `brm_${randomBytes(32).toString('base64url')}`;
        const device = {
          id: randomBytes(16).toString('hex'),
          label: label.trim(),
          repos: [...new Set(repos)],
          permission,
          createdAt: now(),
          expiresAt: now() + days * 86400_000,
          tokenHash: digest(token),
          ownerHash: digest(ownerSecret),
        };
        next.push(device);
        return { device: publicDevice(device), token };
      });
    },
    authenticate(header, ownerSecret) {
      requireReady();
      if (!ownerSecret || typeof header !== 'string' || !/^Bearer brm_[A-Za-z0-9_-]{43}$/.test(header))
        throw fail(401, 'Invalid or expired device token');
      const hash = Buffer.from(digest(header.slice(7)), 'hex');
      const device = devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), hash));
      if (!device || device.expiresAt <= now() || device.ownerHash !== digest(ownerSecret))
        throw fail(401, 'Invalid or expired device token');
      return publicDevice(device);
    },
    revoke(id) {
      return write((next) => {
        const index = next.findIndex((d) => d.id === id);
        if (index !== -1) next.splice(index, 1);
      });
    },
  };
}
