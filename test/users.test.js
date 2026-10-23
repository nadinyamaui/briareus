import { it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadUserRows: vi.fn() }));
const { activeAdmins, checkRole, checkUserName, createUsers } = await import('../lib/users.js');

const owner = { id: 1, name: 'Owner', role: 'admin', createdAt: 1, disabledAt: null };
const ana = { id: 2, name: 'Ana', role: 'member', createdAt: 2, disabledAt: null };

it('is unavailable until the list loads, then finds each user by id', async () => {
  const load = vi.fn(async () => [owner, ana]);
  const users = createUsers({ load });
  expect(() => users.get(1)).toThrow(expect.objectContaining({ status: 503 }));
  expect(() => users.list()).toThrow('unavailable');
  await users.init();
  expect(users.get(2)).toBe(ana);
  expect(users.get('2')).toBeNull();
  expect(users.list()).toEqual([owner, ana]);
});

it('keeps the last good list when a reload fails', async () => {
  const load = vi.fn(async () => [owner]);
  const users = createUsers({ load });
  await users.init();
  load.mockRejectedValueOnce(new Error('DB down'));
  await expect(users.refresh()).rejects.toThrow('DB down');
  expect(users.get(1)).toBe(owner);
  load.mockResolvedValueOnce([owner, ana]);
  await users.refresh();
  expect(users.get(2)).toBe(ana);
});

it('checks names and roles', () => {
  expect(checkUserName('  Ana ')).toBe('Ana');
  for (const bad of ['', '   ', 'x'.repeat(101), null, 3]) expect(() => checkUserName(bad)).toThrow();
  expect(checkRole('member')).toBe('member');
  expect(() => checkRole('owner')).toThrow('admin or member');
});

it('counts only the enabled admins', () => {
  expect(activeAdmins([owner, ana, { ...owner, id: 3, disabledAt: 5 }])).toEqual([owner]);
});
