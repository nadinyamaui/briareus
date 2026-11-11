import { expect, it, vi } from 'vitest';
import { SECURITY_POLICIES } from '../lib/review-security.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ db: {} }) }));
vi.mock('../lib/migrator.js', () => ({ ensureDatabase: async () => {}, runMigrations: async () => {} }));
vi.mock('mysql2/promise', () => ({ default: { createPool: () => ({ query }) } }));
import { saveProject } from '../lib/db.js';

it('serializes every supported policy through the shared validator on inserts and updates', async () => {
  // A future policy must not be silently saved as off by a second, stale list.
  SECURITY_POLICIES.push('future-policy');
  try {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT')) return [[]];
      return [{ insertId: 1, affectedRows: 1 }];
    });
    for (const id of [undefined, 1]) {
      for (const policy of [...SECURITY_POLICIES, 'invalid', undefined]) {
        query.mockClear();
        await saveProject({ id, repo: 'acme/shop', securityReview: policy });
        const [sql, values] = query.mock.calls[0];
        const columns = id
          ? [...sql.matchAll(/`(\w+)` = \?/g)].map((m) => m[1])
          : sql
              .match(/\(([^)]+)\)/)[1]
              .split(', ')
              .map((c) => c.replaceAll('`', ''));
        expect(values[columns.indexOf('security_review')]).toBe(
          SECURITY_POLICIES.includes(policy) ? policy : 'off',
        );
      }
    }
  } finally {
    SECURITY_POLICIES.pop();
  }
});
