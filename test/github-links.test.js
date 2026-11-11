import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadGithubLinkRows: vi.fn(), saveGithubLink: vi.fn() }));

import { createGithubLinks } from '../lib/github-links.js';

describe('the GitHub accounts users have linked', () => {
  let stored, save, links;
  beforeEach(async () => {
    stored = [{ userId: 1, id: 101, login: 'ada-dev' }];
    save = vi.fn(async (userId, account) => {
      stored.push({ userId, ...account });
    });
    links = createGithubLinks({ load: async () => stored.map((row) => ({ ...row })), save });
  });

  it('cannot be asked before they are loaded: an empty answer would read as never linked', () => {
    expect(() => links.of(1)).toThrow(/unavailable/);
    expect(() => links.all()).toThrow(/unavailable/);
    try {
      links.of(1);
    } catch (e) {
      expect(e.status).toBe(503);
    }
  });

  it('persists new links even when old history failed to load, keeping reads closed until recovery', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('History unavailable'))
      .mockImplementation(async () => stored);
    links = createGithubLinks({ load, save });
    await expect(links.init()).rejects.toThrow('History unavailable');
    await links.remember(2, { id: 102, login: 'grace-dev' });
    expect(save).toHaveBeenCalledWith(2, { id: 102, login: 'grace-dev' });
    expect(() => links.all()).toThrow(/unavailable/);
    await links.init();
    expect(links.of(2)).toEqual([{ id: 102, login: 'grace-dev' }]);
  });

  it('retains links saved while a history snapshot was loading', async () => {
    let finish;
    links = createGithubLinks({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      save,
    });
    const loading = links.init();
    await links.remember(2, { id: 102, login: 'grace-dev' });
    finish([]);
    await loading;
    expect(links.of(2)).toEqual([{ id: 102, login: 'grace-dev' }]);
  });

  it('keeps every account a user linked, entered once, after it is unlinked', async () => {
    await links.init();
    expect(links.of(1)).toEqual([{ id: 101, login: 'ada-dev' }]);
    await links.remember(1, { id: 101, login: 'ada-dev', token: 'not kept' });
    expect(save).not.toHaveBeenCalled();
    await links.remember(2, { id: 102, login: 'grace-dev', token: 'not kept' });
    await links.remember(2, { id: 102, login: 'grace-dev' });
    expect(save.mock.calls).toEqual([[2, { id: 102, login: 'grace-dev' }]]);
    // Nothing here ever removes one: unlinking is the credential's business, not the record's.
    expect(links.of(2)).toEqual([{ id: 102, login: 'grace-dev' }]);
    expect(links.all()).toEqual([
      { id: 101, login: 'ada-dev' },
      { id: 102, login: 'grace-dev' },
    ]);
    expect(links.of(3)).toEqual([]);
  });

  it('keeps a renamed account under both logins, and one without an id by its login', async () => {
    await links.init();
    await links.remember(1, { id: 101, login: 'ada-renamed' });
    await links.remember(1, { login: 'ada-legacy' });
    expect(links.of(1)).toEqual([
      { id: 101, login: 'ada-dev' },
      { id: 101, login: 'ada-renamed' },
      { id: null, login: 'ada-legacy' },
    ]);
    // Nothing linked is nothing to remember.
    await links.remember(1, null);
    await links.remember(1, { id: 5 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not keep in memory what it could not store, and survives a reload', async () => {
    await links.init();
    save.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(links.remember(2, { id: 102, login: 'grace-dev' })).rejects.toThrow('Connection lost');
    expect(links.of(2)).toEqual([]);
    await links.remember(2, { id: 102, login: 'grace-dev' });
    await links.init();
    expect(links.of(2)).toEqual([{ id: 102, login: 'grace-dev' }]);
  });
});
