// @ts-check
import { loadAppSetting, saveAppSetting } from './db.js';

const SETTING = 'ci_runner_rates';
export const CI_RATE_GROUPS_MAX = 100;

/** @typedef {{ currency: string, groups: Record<string, number> }} CiRates */

/** @param {any} input @returns {CiRates} */
export function normalizeCiRates(input) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send { currency, groups }');
  const currency = input.currency == null ? 'USD' : input.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
    throw bad('Currency must be a three-letter code such as USD');
  const groups = input.groups ?? {};
  if (!groups || typeof groups !== 'object' || Array.isArray(groups))
    throw bad('Groups must map a runner group name to its hourly rate');
  const entries = Object.entries(groups);
  if (entries.length > CI_RATE_GROUPS_MAX) throw bad(`At most ${CI_RATE_GROUPS_MAX} runner groups`);
  for (const [name, rate] of entries) {
    if (!name.length || [...name].length > 255) throw bad('Runner group names must be 1–255 characters');
    // Zero is a real price (a machine whose power and hardware are already paid
    // for); it marks the group as priced rather than unknown.
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1e6)
      throw bad(`Invalid hourly rate for ${name}`);
  }
  return { currency, groups: Object.fromEntries(entries) };
}

// Rates are read on every report rather than cached, so a change applies to the
// whole history at once: cost is derived from stored durations, never stored.
export function createCiRates({ load = loadAppSetting, save = saveAppSetting } = {}) {
  return {
    /** @returns {Promise<CiRates>} */
    async get() {
      return normalizeCiRates((await load(SETTING, null)) || {});
    },
    /** @returns {Promise<CiRates>} */
    async set(input) {
      const rates = normalizeCiRates(input);
      await save(SETTING, rates);
      return rates;
    },
  };
}

export const ciRates = createCiRates();
