import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));

const { createCiRates, normalizeCiRates } = await import('../lib/ci-rates.js');

describe('CI runner group rates', () => {
  it('defaults to USD with no priced groups and keeps zero as a real price', () => {
    expect(normalizeCiRates({})).toEqual({ currency: 'USD', groups: {} });
    expect(normalizeCiRates({ currency: 'EUR', groups: { Default: 0, 'Ubuntu EU': 0.05 } })).toEqual({
      currency: 'EUR',
      groups: { Default: 0, 'Ubuntu EU': 0.05 },
    });
  });

  it.each([
    [null, 'Send { currency, groups }'],
    [[], 'Send { currency, groups }'],
    [{ currency: 'usd' }, 'three-letter code'],
    [{ groups: [] }, 'Groups must map'],
    [{ groups: { '': 1 } }, '1–255 characters'],
    [{ groups: { ['x'.repeat(256)]: 1 } }, '1–255 characters'],
    [{ groups: { Default: -1 } }, 'Invalid hourly rate for Default'],
    [{ groups: { Default: '1' } }, 'Invalid hourly rate'],
    [{ groups: { Default: Infinity } }, 'Invalid hourly rate'],
    [{ groups: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`g${i}`, 1])) }, 'At most 100'],
  ])('refuses %j with a 400', (input, message) => {
    expect(() => normalizeCiRates(input)).toThrow(message);
    try {
      normalizeCiRates(input);
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  it('stores only validated rates and reads the empty default before any are set', async () => {
    let stored = null;
    const rates = createCiRates({
      load: async () => stored,
      save: async (_name, value) => {
        stored = value;
      },
    });
    expect(await rates.get()).toEqual({ currency: 'USD', groups: {} });
    await expect(rates.set({ groups: { Default: -1 } })).rejects.toThrow('Invalid hourly rate');
    expect(stored).toBeNull();
    expect(await rates.set({ groups: { Default: 0.1 } })).toEqual({
      currency: 'USD',
      groups: { Default: 0.1 },
    });
    expect(await rates.get()).toEqual({ currency: 'USD', groups: { Default: 0.1 } });
  });
});
