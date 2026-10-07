// @ts-check
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadAppSetting, saveAppSetting, updateAppSetting } from './db.js';

const SETTING = 'mobile_devices';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicDevice = ({ tokenHash, ownerHash, ...device }) => {
  device.lastUsedAt ??= null;
  return device;
};
const USAGE_INTERVAL_MS = 60_000;

// Owner-issued tokens for the client API (/api/v1), never a secret baked into an app.
// "mobile" names date from the first client; the stored setting keeps its name so issued
// tokens stand. Only hashes are persisted, and state is published only after persistence
// so a failed revoke cannot look successful or lose a concurrent add. `npm run
// create-token` writes the same row, so each write updates the stored row under a lock
// (updateAppSetting), and refresh() picks up what another process wrote.
/**
 * @param {{ load?: Function, save?: Function, update?: Function, now?: () => number }} [options]
 */
export function createMobileAuth({ load, save, update, now = Date.now } = {}) {
  // Tests pass load and save as an in-memory store; with no other writer they compose
  // into the update.
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
  function write(fn, needed = () => true) {
    const operation = writes.then(async () => {
      requireReady();
      if (!needed()) return;
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
    // Queued behind writes so a reload never publishes a list older than one just saved.
    // A failed reload keeps the last good list.
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
      // An admin token is the operator's own: no project list, so later projects are
      // covered too.
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
          lastUsedAt: null,
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
    // Only incoming requests call this, never a stream's periodic check. It uses the
    // locked row like issue/revoke, so a stale server cannot resurrect a revoked token or
    // erase a CLI-issued one.
    recordUsage(id) {
      requireReady();
      const at = now();
      const due = (device) =>
        device && (device.lastUsedAt == null || at - device.lastUsedAt >= USAGE_INTERVAL_MS);
      if (!due(devices.find((d) => d.id === id))) return Promise.resolve();
      return write(
        (next) => {
          const device = next.find((d) => d.id === id);
          if (due(device) && device.expiresAt > at) device.lastUsedAt = at;
        },
        () => due(devices.find((d) => d.id === id)),
      );
    },
  };
}
