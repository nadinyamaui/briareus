import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { createGithubStore } from '../lib/github-store.js';
import { createGithubSync } from '../lib/github-sync.js';
import { up, down } from '../migrations/2026_10_27_120000_add_github_mirror.js';
import {
  up as observationUp,
  down as observationDown,
} from '../migrations/2026_10_27_130000_add_github_observation_times.js';
import {
  up as itemObservationUp,
  down as itemObservationDown,
} from '../migrations/2026_10_27_140000_add_github_item_observation_times.js';

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
    await observationUp({ context: pool });
    await observationUp({ context: pool });
    await itemObservationUp({ context: pool });
    await itemObservationUp({ context: pool });
    store = createGithubStore({ connection: () => pool.getConnection() });
  });
  afterAll(async () => {
    if (pool) {
      await itemObservationDown({ context: pool });
      await itemObservationDown({ context: pool });
      await observationDown({ context: pool });
      await observationDown({ context: pool });
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

  it('orders shared external issue stubs without promoting them to complete items', async () => {
    const r = repo(),
      other = repo(),
      external = repo();
    const linked = {
      number: 9,
      repo: external,
      title: 'New title',
      state: 'closed',
      stateReason: 'completed',
      labels: [{ name: 'new', color: 'abcdef' }],
    };
    await store.saveBoard(r, board({ pulls: [pull({ issues: [linked] })], observedAt: 2000 }));
    await store.saveBoard(
      other,
      board({
        pulls: [
          pull({
            issues: [
              {
                ...linked,
                title: 'Old title',
                state: 'open',
                stateReason: null,
                labels: [{ name: 'old', color: '000000' }],
              },
            ],
          }),
        ],
        observedAt: 1000,
      }),
    );
    expect((await store.readBoard(r)).pulls[0].issues[0]).toMatchObject(linked);
    const [[stub]] = await pool.query(
      'SELECT observed_at, reference_observed_at FROM github_items i JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=? AND number=9',
      [external],
    );
    expect(Number(stub.observed_at)).toBe(0);
    expect(Number(stub.reference_observed_at)).toBe(2000);
    await store.saveItem(external, {
      ...issue({ number: 9, title: 'Complete', labels: [] }),
      kind: 'issue',
      state: 'open',
      observedAt: 3000,
    });
    await store.saveBoard(r, board({ pulls: [pull({ issues: [linked] })], observedAt: 4000 }));
    expect((await store.readBoard(r)).pulls[0].issues[0]).toMatchObject({
      title: 'Complete',
      state: 'open',
      labels: [],
    });
  });

  it('reopens an external PR stub from the open-only board connection', async () => {
    const r = repo(),
      external = repo();
    const linked = {
      number: 9,
      repo: external,
      title: 'External PR',
      url: 'https://github.com/other/repo/pull/9',
      draft: false,
    };
    await store.saveItem(r, {
      ...issue({ pulls: [{ ...linked, state: 'closed' }] }),
      kind: 'issue',
      state: 'open',
      observedAt: 1000,
    });
    await store.saveBoard(r, board({ issues: [issue({ pulls: [linked] })], observedAt: 2000 }));
    expect((await store.readBoard(r)).issues[0].pulls).toEqual([linked]);
  });

  it('completes same-revision downloads behind newer boards without replacing their fields', async () => {
    const r = repo();
    const row = {
      ...pull(),
      kind: 'pull',
      state: 'open',
      body: 'Full body',
      observedAt: 1000,
      sourceUpdatedAt: pull().updatedAt,
    };
    await store.saveBoard(
      r,
      board({ pulls: [pull({ title: 'New board', checks: 'failure' })], observedAt: 2000 }),
    );
    expect(await store.saveItem(r, row, { comments: [{ id: 1, body: 'Complete comment' }] })).toBe(true);
    expect((await store.readBoard(r)).pulls[0]).toMatchObject({ title: 'New board', checks: 'failure' });
    expect((await store.syncedItems(r)).get(1)).toBe(row.sourceUpdatedAt);
    const [[saved]] = await pool.query(
      'SELECT body, observed_at, full_observed_at FROM github_items i JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=? AND number=1',
      [r],
    );
    expect(saved.body).toBe('Full body');
    expect(Number(saved.observed_at)).toBe(2000);
    expect(Number(saved.full_observed_at)).toBe(1000);
    expect(await store.saveItem(r, { ...row, observedAt: 500 }, { comments: [] })).toBe(false);
    const [[comment]] = await pool.query(
      'SELECT c.body FROM github_comments c JOIN github_items i ON i.id=c.item_id JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=?',
      [r],
    );
    expect(comment.body).toBe('Complete comment');
  });

  it('backfills later history while every full PR download overlaps a newer partial board', async () => {
    const r = repo();
    let clock = 1000,
      boardCalls = 0,
      filesCalls = 0;
    const errors = [];
    const rawIssue = (number) => ({
      number,
      title: `Item ${number}`,
      state: 'open',
      html_url: `https://github.com/${r}/issues/${number}`,
      updated_at: pull().updatedAt,
      ...(number === 1 ? { pull_request: {} } : {}),
    });
    const rawPull = {
      ...rawIssue(1),
      head: { sha: pull().headSha, ref: 'fix' },
      base: { sha: 'b'.repeat(40), ref: 'main' },
    };
    const newerBoard = async () => {
      await store.saveBoard(
        r,
        board({ pulls: [pull({ title: 'New board', checks: 'failure' })], observedAt: ++clock }),
      );
    };
    const service = createGithubSync({
      projects: () => [{ repo: r }],
      config: () => ({ githubToken: 'token' }),
      store,
      now: () => ++clock,
      log: (message) => errors.push(message),
      invalidate: () => {},
      rest: async (_cfg, _method, path) => {
        const resource = new URL(path, 'https://api.github.com').pathname.replace(`/repos/${r}`, '');
        let result = [];
        if (resource === '/issues') result = [rawIssue(1), rawIssue(2)];
        else if (resource === '/pulls') result = [rawPull];
        else if (resource === '/pulls/1') result = rawPull;
        else if (resource === '/issues/1') result = rawIssue(1);
        else if (resource.endsWith('/check-runs')) result = { check_runs: [] };
        else if (resource === '/pulls/1/files') {
          filesCalls++;
          await newerBoard();
          result = [{ filename: 'app.js', status: 'modified', additions: 1, deletions: 0 }];
        }
        return { ok: true, json: async () => result };
      },
      graphql: async (_cfg, _query, { number }) => ({
        repository: {
          issueOrPullRequest: {
            __typename: number === 1 ? 'PullRequest' : 'Issue',
            closingIssuesReferences: { nodes: [] },
            closedByPullRequestsReferences: { nodes: [] },
            subIssues: { nodes: [] },
          },
        },
      }),
      board: async () => {
        boardCalls++;
        await newerBoard();
        return { issuesError: null, issuesTruncated: false };
      },
    });
    await service.tick();
    await service.tick();
    expect(errors).toEqual([]);
    expect(filesCalls).toBe(2);
    expect(boardCalls).toBe(2);
    expect([...(await store.syncedItems(r)).keys()].sort()).toEqual([1, 2]);
    const [[file]] = await pool.query(
      'SELECT filename FROM github_pull_files f JOIN github_items i ON i.id=f.item_id JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=?',
      [r],
    );
    expect(file.filename).toBe('app.js');
  });

  it.each([
    { headSha: 'c'.repeat(40) },
    { baseBranch: 'release' },
    { baseSha: 'd'.repeat(40) },
    { updatedAt: '2026-10-27T11:00:00Z' },
  ])('rejects a superseded full download after a board revision change: %j', async (change) => {
    const r = repo();
    const row = {
      ...pull({ baseSha: 'b'.repeat(40) }),
      kind: 'pull',
      state: 'open',
      observedAt: 1000,
      sourceUpdatedAt: pull().updatedAt,
    };
    await store.saveBoard(r, board({ pulls: [pull({ baseSha: row.baseSha, ...change })], observedAt: 2000 }));
    expect(await store.saveItem(r, row, { files: [] })).toBe(false);
    expect((await store.syncedItems(r)).has(1)).toBe(false);
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

  it('orders overlapping boards by observation time while returning completion time', async () => {
    const r = repo();
    await store.saveBoard(r, board({ observedAt: 100, syncedAt: new Date(300).toISOString() }));
    await store.saveBoard(
      r,
      board({ pulls: [pull({ title: 'Newer' })], observedAt: 200, syncedAt: new Date(400).toISOString() }),
    );
    await store.saveBoard(r, board({ observedAt: 100, syncedAt: new Date(500).toISOString() }));
    expect((await store.readBoard(r)).pulls[0].title).toBe('Newer');
    expect((await store.readBoard(r)).syncedAt).toBe(new Date(400).toISOString());
  });

  it('preserves complete closing relationships through bounded board saves', async () => {
    const r = repo();
    const closed = { number: 8, title: 'Closed PR', state: 'closed', repo: r };
    await store.saveItem(r, { ...issue({ pulls: [closed] }), kind: 'issue', state: 'open', observedAt: 500 });
    const linked = Array.from({ length: 70 }, (_, i) => ({
      number: i + 100,
      title: 'Linked issue',
      state: 'closed',
      repo: r,
    }));
    await store.saveItem(r, { ...pull({ issues: linked }), kind: 'pull', state: 'open', observedAt: 500 });
    await store.saveBoard(r, board({ pulls: [pull({ issues: linked.slice(0, 65) })] }));
    const [[count]] = await pool.query(
      `SELECT COUNT(*) AS n FROM github_item_links l
      JOIN github_items i ON i.id=l.item_id JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=?`,
      [r],
    );
    expect(count.n).toBe(71);
    expect((await store.readBoard(r)).issues[0].pulls).toEqual([]);
    await store.saveItem(r, { ...issue(), kind: 'issue', state: 'open', observedAt: 2000 });
    const [[remaining]] = await pool.query(
      `SELECT COUNT(*) AS n FROM github_item_links l
      JOIN github_items i ON i.id=l.item_id JOIN github_repositories r ON r.id=i.repository_id WHERE r.repo=? AND l.relation='closed_by'`,
      [r],
    );
    expect(remaining.n).toBe(0);
  });

  it('retains confirmed closures across truncated refreshes without hiding unpaged issues', async () => {
    const r = repo();
    const issues = Array.from({ length: 102 }, (_, i) => issue({ number: i + 2 }));
    await store.saveBoard(r, board({ issues }));
    await store.saveItem(r, {
      ...issue({ number: 103 }),
      kind: 'issue',
      state: 'closed',
      stateReason: 'completed',
      observedAt: 2000,
    });
    await store.saveBoard(
      r,
      board({
        issues: issues.slice(0, 100),
        issuesTruncated: true,
        observedAt: 3000,
        syncedAt: new Date(3000).toISOString(),
      }),
    );
    const result = await store.readBoard(r);
    expect(result.issues).toHaveLength(101);
    expect(result.issues.some((i) => i.number === 103)).toBe(false);
    expect(result.issues.some((i) => i.number === 102)).toBe(true);
  });

  it.each(['pull', 'issue'])(
    'removes only obsolete reciprocal closing links after an authoritative %s refresh',
    async (kind) => {
      const r = repo(),
        external = repo();
      const linkedIssue = { number: 2, title: 'Issue', state: 'open', repo: external };
      const linkedPull = { number: 1, title: 'Pull', state: 'open', repo: r };
      await store.saveBoard(r, board({ issues: [], pulls: [pull({ issues: [linkedIssue] })] }));
      await store.saveBoard(external, board({ pulls: [], issues: [issue({ pulls: [linkedPull] })] }));
      // Bounded empty projections must retain both historical directions.
      await store.saveBoard(r, board({ issues: [], observedAt: 1500 }));
      await store.saveBoard(external, board({ pulls: [], observedAt: 1500 }));
      expect((await store.readBoard(r)).pulls[0].issues).toHaveLength(1);
      expect((await store.readBoard(external)).issues[0].pulls).toHaveLength(1);
      // Keep an unrelated reciprocal link while removing the first one.
      await store.saveItem(r, {
        ...pull({ number: 3, issues: [linkedIssue] }),
        kind: 'pull',
        state: 'open',
        observedAt: 1600,
      });
      await store.saveItem(external, {
        ...issue({ pulls: [linkedPull, { ...linkedPull, number: 3 }] }),
        kind: 'issue',
        state: 'open',
        observedAt: 1600,
      });
      // An obsolete complete refresh cannot unlink a newer observation.
      await store.saveItem(kind === 'pull' ? r : external, {
        ...(kind === 'pull' ? pull() : issue()),
        kind,
        state: 'open',
        observedAt: 500,
      });
      expect((await store.readBoard(external)).issues[0].pulls).toHaveLength(2);
      await store.saveItem(kind === 'pull' ? r : external, {
        ...(kind === 'pull' ? pull() : issue({ pulls: [{ ...linkedPull, number: 3 }] })),
        kind,
        state: 'open',
        observedAt: 2000,
      });
      await store.saveBoard(r, board({ issues: [], pulls: [pull(), pull({ number: 3 })], observedAt: 3000 }));
      await store.saveBoard(external, board({ pulls: [], observedAt: 3000 }));
      const result = await store.readBoard(r);
      expect(result.pulls.find((p) => p.number === 1).issues).toEqual([]);
      expect(result.pulls.find((p) => p.number === 3).issues).toHaveLength(1);
      expect((await store.readBoard(external)).issues[0].pulls.map((p) => p.number)).toEqual([3]);
    },
  );

  it('preserves absent stub fields in parent references but accepts explicit state changes', async () => {
    const r = repo();
    const closed = {
      number: 8,
      title: 'Closed parent',
      url: issue().url,
      state: 'closed',
      stateReason: 'completed',
    };
    const parent = { number: 8, title: closed.title, url: closed.url };
    await store.saveBoard(
      r,
      board({
        pulls: [pull({ issues: [closed] })],
        issues: [issue({ parent })],
      }),
    );
    expect((await store.readBoard(r)).pulls[0].issues[0]).toMatchObject(closed);
    await store.saveBoard(
      r,
      board({
        pulls: [pull({ issues: [{ number: 8 }] })],
        issues: [issue({ parent })],
        observedAt: 2000,
      }),
    );
    expect((await store.readBoard(r)).pulls[0].issues[0]).toMatchObject(closed);
    await store.saveBoard(
      r,
      board({
        pulls: [pull({ issues: [{ ...closed, state: 'open', stateReason: null }] })],
        issues: [issue({ parent })],
        observedAt: 3000,
      }),
    );
    expect((await store.readBoard(r)).pulls[0].issues[0]).toMatchObject({ state: 'open', stateReason: null });
  });

  it('updates external PR draft stubs in time order and protects complete PRs', async () => {
    const r = repo(),
      other = repo(),
      external = repo();
    const linked = { number: 9, title: 'External PR', repo: external, draft: true };
    await store.saveBoard(r, board({ issues: [issue({ pulls: [linked] })] }));
    await store.saveBoard(
      r,
      board({ issues: [issue({ pulls: [{ ...linked, draft: false }] })], observedAt: 2000 }),
    );
    expect((await store.readBoard(r)).issues[0].pulls[0].draft).toBe(false);
    // Another source's old reference must not roll back a newer stub flag.
    await store.saveBoard(other, board({ issues: [issue({ pulls: [linked] })], observedAt: 1500 }));
    expect((await store.readBoard(r)).issues[0].pulls[0].draft).toBe(false);
    await store.saveBoard(r, board({ issues: [issue({ pulls: [linked] })], observedAt: 3000 }));
    expect((await store.readBoard(r)).issues[0].pulls[0].draft).toBe(true);
    await store.saveItem(external, {
      ...pull({ number: 9, draft: false }),
      kind: 'pull',
      state: 'open',
      observedAt: 4000,
    });
    await store.saveBoard(r, board({ issues: [issue({ pulls: [linked] })], observedAt: 5000 }));
    expect((await store.readBoard(r)).issues[0].pulls[0].draft).toBe(false);
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

  it('preserves stable label and milestone assignments when names swap', async () => {
    const r = repo();
    const metadata = {
      labels: [
        { id: 11, name: 'A' },
        { id: 22, name: 'B' },
      ],
      milestones: [
        { id: 11, title: 'A' },
        { id: 22, title: 'B' },
      ],
    };
    await store.saveMetadata(r, metadata);
    for (const [index, name] of ['A', 'B'].entries())
      await store.saveItem(r, {
        ...issue({ number: index + 1, labels: [{ name }], milestone: name }),
        kind: 'issue',
        state: 'closed',
        observedAt: 1000,
      });
    await store.saveMetadata(r, {
      labels: [
        { id: 11, name: 'B' },
        { id: 22, name: 'A' },
      ],
      milestones: [
        { id: 11, title: 'B' },
        { id: 22, title: 'A' },
      ],
    });
    const [rows] = await pool.query(
      `SELECT i.number, l.github_id AS label_id, l.name, m.github_id AS milestone_id, m.title
      FROM github_items i JOIN github_repositories r ON r.id=i.repository_id
      JOIN github_item_labels il ON il.item_id=i.id JOIN github_labels l ON l.id=il.label_id
      JOIN github_milestones m ON m.id=i.milestone_id WHERE r.repo=? ORDER BY i.number`,
      [r],
    );
    expect(
      rows.map((row) => ({ ...row, label_id: Number(row.label_id), milestone_id: Number(row.milestone_id) })),
    ).toEqual([
      { number: 1, label_id: 11, name: 'B', milestone_id: 11, title: 'B' },
      { number: 2, label_id: 22, name: 'A', milestone_id: 22, title: 'A' },
    ]);
  });
});
