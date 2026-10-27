import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { createGithubStore } from '../lib/github-store.js';
import { up, down } from '../migrations/2026_10_27_120000_add_github_mirror.js';

// Opt in against a real MySQL server: the normal suite needs no infrastructure.
// Only the randomly named database created by this file is ever dropped.
describe.skipIf(process.env.GITHUB_STORE_MYSQL !== '1')('GitHub mirror on MySQL', () => {
  const database = `briareus_github_test_${randomBytes(6).toString('hex')}`;
  let bootstrap, pool, store;
  let sequence = 0;
  const repo = () => `acme/store-${++sequence}`;
  const issue = (overrides = {}) => ({
    number: 2,
    title: 'An issue',
    url: 'https://github.com/acme/shop/issues/2',
    author: 'alice',
    assignees: ['alice', 'bob'],
    labels: [{ name: 'bug', color: 'ff0000' }],
    comments: 1,
    milestone: 'Launch',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-27T10:00:00Z',
    parent: null,
    subIssues: null,
    pulls: [],
    ...overrides,
  });
  const pull = (overrides = {}) => ({
    number: 1,
    title: 'A pull',
    url: 'https://github.com/acme/shop/pull/1',
    draft: false,
    author: 'alice',
    assignees: [],
    labels: [{ name: 'bug', color: 'ff0000' }],
    branch: 'fix',
    baseBranch: 'main',
    crossRepository: false,
    updatedAt: '2026-10-27T10:00:00Z',
    mergeable: 'mergeable',
    checks: 'success',
    headSha: 'a'.repeat(40),
    reviewDecision: 'approved',
    reviewers: [{ user: 'bob', state: 'approved', url: 'https://github.com/review' }],
    issues: [],
    ...overrides,
  });
  const board = (overrides = {}) => ({
    pulls: [pull()],
    issues: [issue()],
    defaultBranch: 'main',
    issuesError: null,
    issuesTruncated: false,
    observedAt: 1000,
    syncedAt: new Date(1000).toISOString(),
    ...overrides,
  });

  beforeAll(async () => {
    const { database: _database, ...config } = getConfig().db;
    bootstrap = await mysql.createConnection(config);
    await bootstrap.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    await up({ context: pool });
    await up({ context: pool }); // interrupted migrations can be retried
    store = createGithubStore({ connection: () => pool.getConnection() });
  });
  afterAll(async () => {
    if (pool) {
      await down({ context: pool });
      const [rows] = await pool.query('SHOW TABLES');
      expect(rows).toHaveLength(0);
      await pool.end();
      await bootstrap.query(`DROP DATABASE ${database}`);
    }
    await bootstrap?.end();
  });

  it('round trips board rows and relationships through normalized tables', async () => {
    const r = repo();
    const data = board({
      pulls: [
        pull({
          issues: [
            {
              number: 2,
              title: issue().title,
              url: issue().url,
              labels: issue().labels,
              state: 'open',
              stateReason: null,
              repo: r,
            },
          ],
        }),
      ],
      issues: [issue({ pulls: [{ number: 1, title: 'A pull', url: pull().url, draft: false, repo: r }] })],
    });
    await store.saveBoard(r, data);
    const result = await store.readBoard(r.toUpperCase());
    expect(result).toMatchObject({
      defaultBranch: 'main',
      syncedAt: data.syncedAt,
      issuesError: null,
      issuesTruncated: false,
    });
    expect(result.pulls).toEqual(data.pulls);
    expect(result.issues).toEqual(data.issues);
    const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM github_labels');
    expect(count.n).toBe(1); // the issue and pull share the same label
  });

  it('retains full bodies and closed/merged history after removing board membership', async () => {
    const r = repo();
    await store.saveBoard(r, board());
    await store.saveItem(r, {
      ...pull(),
      kind: 'pull',
      state: 'merged',
      body: 'Full **body**',
      observedAt: 2000,
      sourceUpdatedAt: pull().updatedAt,
      closedAt: '2026-10-27T11:00:00Z',
      mergedAt: '2026-10-27T11:00:00Z',
    });
    await store.saveBoard(r, board({ pulls: [], observedAt: 3000, syncedAt: new Date(3000).toISOString() }));
    expect((await store.readBoard(r)).pulls).toEqual([]);
    const [[row]] = await pool.query(
      `SELECT i.state, i.body, p.merged_at FROM github_items i
      JOIN github_repositories r ON r.id=i.repository_id JOIN github_pull_requests p ON p.item_id=i.id
      WHERE r.repo=? AND i.number=1`,
      [r],
    );
    expect(row).toMatchObject({ state: 'merged', body: 'Full **body**', merged_at: '2026-10-27T11:00:00Z' });
    expect((await store.syncedItems(r)).get(1)).toBe(pull().updatedAt);
  });

  it('preserves unpaged and unreadable issues while replacing a complete list', async () => {
    const r = repo();
    await store.saveBoard(r, board());
    await store.saveBoard(
      r,
      board({
        issues: [],
        issuesError: 'Issues permission missing',
        observedAt: 2000,
        syncedAt: new Date(2000).toISOString(),
      }),
    );
    expect((await store.readBoard(r)).issues).toHaveLength(1);
    await store.saveBoard(
      r,
      board({ issues: [], issuesTruncated: true, observedAt: 3000, syncedAt: new Date(3000).toISOString() }),
    );
    expect((await store.readBoard(r)).issues).toHaveLength(1);
    await store.saveBoard(r, board({ issues: [], observedAt: 4000, syncedAt: new Date(4000).toISOString() }));
    expect((await store.readBoard(r)).issues).toHaveLength(0);
  });

  it('rejects an older in-flight board and stale item metadata', async () => {
    const r = repo();
    await store.saveBoard(r, board({ observedAt: 3000, syncedAt: new Date(3000).toISOString() }));
    await store.saveBoard(r, board({ pulls: [], observedAt: 1000 }));
    await store.saveItem(r, { ...pull({ title: 'Stale' }), kind: 'pull', state: 'open', observedAt: 2000 });
    expect((await store.readBoard(r)).pulls[0].title).toBe('A pull');
    await store.saveItem(r, { ...pull({ title: 'Newer' }), kind: 'pull', state: 'open', observedAt: 4000 });
    expect((await store.readBoard(r)).pulls[0].title).toBe('Newer');
  });

  it('keeps cross-repository links and labels without exposing stubs as board rows', async () => {
    const r = repo();
    const linked = {
      number: 9,
      title: 'Elsewhere',
      url: 'https://github.com/other/repo/issues/9',
      repo: 'other/repo',
      state: 'closed',
      stateReason: 'completed',
      labels: [{ name: 'done', color: 'abcdef' }],
    };
    await store.saveBoard(r, board({ pulls: [pull({ issues: [linked] })] }));
    expect((await store.readBoard(r)).pulls[0].issues).toEqual([linked]);
    expect(await store.readBoard('other/repo')).toBeNull();
    await store.saveBoard(
      r,
      board({
        pulls: [pull({ issues: [{ ...linked, title: 'Renamed' }] })],
        observedAt: 2000,
        syncedAt: new Date(2000).toISOString(),
      }),
    );
    expect((await store.readBoard(r)).pulls[0].issues[0].title).toBe('Renamed');
  });

  it('keeps a newer open item visible when GitHub returns older metadata', async () => {
    const r = repo();
    await store.saveItem(r, {
      ...pull({ title: 'New title', updatedAt: '2026-10-27T11:00:00Z' }),
      kind: 'pull',
      state: 'open',
      observedAt: 1000,
    });
    await store.saveBoard(r, board({ observedAt: 2000, syncedAt: new Date(2000).toISOString() }));
    expect((await store.readBoard(r)).pulls[0].title).toBe('New title');
  });

  it('atomically replaces comments, reviews, commits, files and checks', async () => {
    const r = repo();
    const row = { ...pull(), kind: 'pull', state: 'open', observedAt: 1000 };
    await store.saveItem(r, row, {
      comments: [{ id: 5, user: { login: 'alice' }, body: 'Comment' }],
      reviewComments: [{ id: 7, user: { login: 'bob' }, body: 'Hunk comment', path: 'app.js', line: 3 }],
      reviews: [{ id: 6, user: { login: 'bob' }, body: 'LGTM', state: 'APPROVED' }],
      commits: [{ sha: 'a'.repeat(40), commit: { message: 'A commit' } }],
      files: [{ filename: 'app.js', status: 'modified', additions: 1, deletions: 0, patch: '+hello' }],
      checks: [{ id: 8, name: 'CI', status: 'completed', conclusion: 'success' }],
    });
    await expect(
      store.saveItem(
        r,
        { ...row, title: 'Must roll back', observedAt: 2000 },
        {
          comments: [{ id: 10, body: 'Replacement' }],
          reviews: [{ id: 11, state: null }],
        },
      ),
    ).rejects.toThrow();
    const [[comment]] = await pool.query(
      `SELECT c.body FROM github_comments c JOIN github_items i ON i.id=c.item_id
      JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=? AND c.kind=?`,
      [r, 'issue'],
    );
    expect(comment.body).toBe('Comment');
    await store.saveItem(r, { ...row, observedAt: 3000 }, { comments: [] });
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS n FROM github_comments c JOIN github_items i ON i.id=c.item_id
      JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=?`,
      [r],
    );
    expect(counts.n).toBe(1); // review comments are a different collection
    expect(await store.openPullNumbers(r, { sha: row.headSha })).toEqual([1]);
  });

  it('advances watermarks only on success and preserves the previous cursor on failure', async () => {
    const r = repo();
    await store.finishSync(r, 5000);
    await store.finishSync(r, null, 'GitHub unavailable');
    expect(await store.syncState(r)).toMatchObject({ synced_at: 5000, last_error: 'GitHub unavailable' });
    await store.finishSync(r, 6000);
    expect(await store.syncState(r)).toMatchObject({ synced_at: 6000, last_error: null });
  });

  it('renames labels and milestones across historical assignments and handles deletions', async () => {
    const r = repo();
    await store.saveBoard(r, board());
    await store.saveMetadata(r, {
      labels: [{ id: 55, name: 'bug', color: 'ff0000' }],
      milestones: [{ id: 66, number: 1, title: 'Launch', state: 'open' }],
    });
    // A board can observe the new label before the metadata refresh learns its
    // stable ID. Merge the duplicate without losing either set of assignments.
    await store.saveItem(r, {
      ...issue({ number: 3, labels: [{ name: 'defect', color: '00ff00' }] }),
      kind: 'issue',
      state: 'closed',
      observedAt: 2000,
    });
    await store.saveMetadata(r, {
      labels: [{ id: 55, name: 'defect', color: '00ff00' }],
      milestones: [{ id: 66, number: 1, title: 'Release', state: 'closed' }],
    });
    const result = await store.readBoard(r);
    expect(result.pulls[0].labels).toEqual([{ name: 'defect', color: '00ff00' }]);
    expect(result.issues[0].milestone).toBe('Release');
    const [[assigned]] = await pool.query(
      `SELECT COUNT(*) AS n FROM github_item_labels il
      JOIN github_items i ON i.id=il.item_id JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=?`,
      [r],
    );
    expect(assigned.n).toBe(3);
    await store.saveMetadata(r, { labels: [], milestones: [] });
    const empty = await store.readBoard(r);
    expect(empty.issues[0]).toMatchObject({ labels: [], milestone: null });
  });
});
