// @ts-check
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';

const SETTING = 'mobile_devices';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicDevice = ({ tokenHash, ownerHash, ...device }) => device;

// Owner-issued personal device tokens, never a secret embedded in an app build.
// Persist hashes only. Serialize writes and publish state only after persistence
// succeeds, so a failed revoke cannot appear successful or lose a concurrent add.
export function createMobileAuth({ load = loadAppSetting, save = saveAppSetting, now = Date.now } = {}) {
  let devices = [];
  let ready = false;
  let writes = Promise.resolve();
  function requireReady() {
    if (!ready) throw fail(503, 'Mobile authentication is unavailable');
  }
  function write(fn) {
    const operation = writes.then(async () => {
      requireReady();
      const next = structuredClone(devices);
      const result = fn(next);
      await save(SETTING, next);
      devices = next;
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
    list() {
      requireReady();
      return devices.map(publicDevice);
    },
    create({ label, repos, permission, days }, ownerSecret) {
      if (typeof ownerSecret !== 'string' || !ownerSecret) throw fail(403, 'Dashboard login is required');
      if (typeof label !== 'string' || !label.trim() || label.length > 100)
        throw fail(400, 'Enter a device name (up to 100 characters)');
      if (
        !Array.isArray(repos) ||
        !repos.length ||
        repos.some((r) => typeof r !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r))
      )
        throw fail(400, 'Select at least one project');
      if (!['read', 'manage'].includes(permission)) throw fail(400, 'Choose read or manage permission');
      if (!Number.isInteger(days) || days < 1 || days > 365) throw fail(400, 'Choose 1–365 days');
      return write((next) => {
        if (next.filter((d) => d.expiresAt > now()).length >= 100)
          throw fail(400, 'Revoke an existing device before adding another');
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
