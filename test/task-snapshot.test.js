import { expect, it } from 'vitest';
import { taskSnapshot } from '../lib/task-snapshot.js';
it('retains audit links but never conversation or workspace secrets', () => {
  const snapshot = taskSnapshot({
    id: 's',
    loopParentId: 'p',
    repo: 'a/b',
    events: ['secret'],
    workDir: '/private',
    providerSessionId: 'secret',
    prStatus: { number: 5, state: 'merged' },
    reviewLoop: { rounds: 3 },
  });
  expect(snapshot).toMatchObject({ parentId: 'p', prNumber: 5, reviewRounds: 3 });
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  expect(snapshot).not.toHaveProperty('workDir');
});
