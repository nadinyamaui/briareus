import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ loadShareRows: vi.fn(), replaceShares: vi.fn() }));
const { createShares } = await import('../lib/shares.js');

// Exercise the server's actual wiring without booting its workers.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const wiring = source.slice(source.indexOf('const sessionMayUse ='), source.indexOf('// On every response,'));

it('checks session project access against the shared project ID', async () => {
  const shares = createShares({
    load: async () => [{ kind: 'project', id: '3', userId: 2 }],
  });
  await shares.init();
  const owners = [
    { id: 1, role: 'admin', disabledAt: null },
    { id: 2, role: 'member', disabledAt: null },
  ];
  const users = { get: (id) => owners.find((u) => u.id === id) };
  const projects = [
    { id: 3, repo: 'acme/shared' },
    { id: 4, repo: 'acme/private' },
  ];
  let allowed;
  new Function('users', 'shares', 'getProject', 'setDbServerFilter', 'setSessionProjectAccess', wiring)(
    users,
    shares,
    (repo) => projects.find((p) => p.repo === repo),
    vi.fn(),
    (fn) => {
      allowed = fn;
    },
  );
  expect(allowed({ ownerId: 2 }, 'acme/shared')).toBe(true);
  expect(allowed({ ownerId: 2 }, 'acme/private')).toBe(false);
  expect(allowed({ ownerId: 1 }, 'acme/private')).toBe(true);
  expect(allowed({ ownerId: null }, 'acme/private')).toBe(true);
  owners[1].disabledAt = 1;
  expect(allowed({ ownerId: 2 }, 'acme/shared')).toBe(false);
  expect(allowed({ ownerId: 99 }, 'acme/shared')).toBe(false);
});
