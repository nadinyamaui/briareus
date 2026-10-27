import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubSync, GITHUB_SYNC_INTERVAL_MS } from '../lib/github-sync.js';

const project = { repo: 'acme/shop', enabled: true };
const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/acme/shop/issues/${number}`,
  body: '**Description**',
  state: 'open',
  user: { login: 'alice' },
  assignees: [],
  labels: [],
  updated_at: '2026-10-27T10:00:00Z',
  ...extra,
});
const pull = (number, extra = {}) => ({
  ...issue(number),
  head: { ref: 'fix', sha: 'a'.repeat(40), repo: { id: 1 } },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 1 } },
  ...extra,
});

function harness({ initial = [], cursor = null, synced = new Map() } = {}) {
  const routes = new Map([
    ['/repos/acme/shop/issues', initial],
    ['/repos/acme/shop/pulls', []],
  ]);
  const errors = [];
  const store = {
    syncState: vi.fn(async () => ({ synced_at: cursor })),
    syncedItems: vi.fn(async () => synced),
    saveItem: vi.fn(async (_repo, row) => {
      synced.set(row.number, row.sourceUpdatedAt);
    }),
    finishSync: vi.fn(async () => {}),
    hideItem: vi.fn(async () => {}),
    openPullNumbers: vi.fn(async () => []),
    saveMetadata: vi.fn(async () => {}),
  };
  const rest = vi.fn(async (_cfg, _method, path) => {
    const url = new URL(path, 'https://api.github.com');
    const route = routes.has(path) ? routes.get(path) : routes.get(url.pathname);
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(url);
    if (route !== undefined) return { ok: true, json: async () => route };
    if (url.pathname.includes('/issues/') && !url.pathname.endsWith('/comments'))
      return { ok: true, json: async () => issue(Number(url.pathname.split('/').at(-1))) };
    return { ok: true, json: async () => [] };
  });
  const board = vi.fn(async () => ({ issuesError: null, issuesTruncated: false }));
  const invalidate = vi.fn();
  const graphql = vi.fn(async (_cfg, _query, { number }) => ({
    repository: {
      issueOrPullRequest: {
        __typename: routes.has(`/repos/acme/shop/pulls/${number}`) ? 'PullRequest' : 'Issue',
        parent: null,
        subIssuesSummary: { total: 0, completed: 0 },
        subIssues: { nodes: [], pageInfo: { hasNextPage: false } },
        closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    },
  }));
  const service = createGithubSync({
    projects: () => [project],
    config: () => ({ githubToken: 'token' }),
    store,
    rest,
    graphql,
    board,
    invalidate,
    now: () => Date.parse('2026-10-27T12:00:00Z'),
    log: (m) => errors.push(m),
  });
  return { service, store, rest, graphql, routes, board, invalidate, errors };
}

afterEach(() => vi.useRealTimers());

describe('durable GitHub synchronization', () => {
  it('backfills every page including closed issues before advancing the watermark', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues', (url) => ({
      ok: true,
      json: async () =>
        url.searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, i) => issue(i + 1))
          : [issue(101, { state: 'closed' })],
    }));
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledTimes(101);
    expect(h.store.saveItem.mock.calls.at(-1)[1]).toMatchObject({
      number: 101,
      state: 'closed',
      body: '**Description**',
    });
    expect(h.rest.mock.calls[0][2]).toContain('state=all');
    expect(h.board).toHaveBeenCalledWith(project, { complete: true });
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, Date.parse('2026-10-27T12:00:00Z'));
    expect(h.invalidate).toHaveBeenCalledWith(project.repo);
  });

  it('uses an overlapping incremental cursor and preserves merged PRs and their collections', async () => {
    const h = harness({
      initial: [issue(1, { pull_request: {} })],
      cursor: Date.parse('2026-10-27T11:00:00Z'),
    });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1, { merged_at: '2026-10-27T10:00:00Z', state: 'closed' }));
    h.routes.set('/repos/acme/shop/pulls/1/reviews', [{ id: 4, user: { login: 'bob' }, state: 'APPROVED' }]);
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, {
      check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }],
    });
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/statuses`, [
      { id: 3, context: 'deploy', state: 'success' },
      { id: 2, context: 'deploy', state: 'failure' },
    ]);
    await h.service.tick();
    expect(decodeURIComponent(h.rest.mock.calls[0][2])).toContain('since=2026-10-27T10:59:00.000Z');
    const [, row, collections] = h.store.saveItem.mock.calls[0];
    expect(row).toMatchObject({
      kind: 'pull',
      state: 'merged',
      body: '**Description**',
      checks: 'success',
      reviewers: [{ user: 'bob', state: 'approved', url: null }],
    });
    expect(collections).toMatchObject({
      comments: [],
      reviewComments: [],
      commits: [],
      files: [],
      reviews: [{ id: 4 }],
    });
    expect(collections.checks.map((c) => c.id)).toEqual([1, 3]);
  });

  it('does not replace any collection or advance the cursor when a later page fails', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {} })], cursor: 1000 });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set('/repos/acme/shop/pulls/1/files', (url) => ({
      ok: url.searchParams.get('page') === '1',
      status: 503,
      json: async () => Array.from({ length: 100 }, () => ({ filename: 'app.js' })),
    }));
    await h.service.tick();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, expect.stringContaining('503'));
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.errors).toHaveLength(1);
  });

  it('resumes a failed backfill without downloading already completed items again', async () => {
    const h = harness({ initial: [issue(1), issue(2)] });
    h.routes.set('/repos/acme/shop/issues/2/comments', new Error('offline'));
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    h.routes.delete('/repos/acme/shop/issues/2/comments');
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledTimes(2);
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([1, 2]);
  });

  it('refreshes unchanged open PRs to catch missed CI and review events', async () => {
    const h = harness({
      initial: [issue(1, { pull_request: {} })],
      synced: new Map([[1, issue(1).updated_at]]),
    });
    h.routes.set('/repos/acme/shop/pulls', [pull(1)]);
    h.routes.set('/repos/acme/shop/issues/1', issue(1, { pull_request: {} }));
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(h.store.saveItem.mock.calls[0][2].checks).toEqual([]);
  });

  it('runs at startup and hourly without overlapping a running sweep', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.service.start();
    await h.service.tick();
    expect(h.board).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_SYNC_INTERVAL_MS);
    expect(h.board).toHaveBeenCalledTimes(2);
    h.service.stop();
    await vi.advanceTimersByTimeAsync(GITHUB_SYNC_INTERVAL_MS);
    expect(h.board).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate deliveries and reads authoritative data for the registered repository', async () => {
    const h = harness();
    const event = {
      repository: { full_name: 'ACME/SHOP' },
      issue: { number: 2, title: 'Untrusted old title' },
    };
    h.service.onWebhook('issues', event);
    h.service.onWebhook('issue_comment', event);
    await h.service.flush('acme/shop');
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(h.store.saveItem.mock.calls[0][1].title).toBe('Issue 2');
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.store.finishSync).not.toHaveBeenCalled(); // webhook does not move hourly cursor
  });

  it('ignores unknown events and repositories outside enabled projects', async () => {
    const h = harness();
    h.service.onWebhook('issues', { repository: { full_name: 'other/repo' }, issue: { number: 1 } });
    h.service.onWebhook('ping', { repository: { full_name: project.repo } });
    await h.service.flush('acme/shop');
    await h.service.flush('other/repo');
    expect(h.rest).not.toHaveBeenCalled();
    expect(h.board).not.toHaveBeenCalled();
  });

  it('does not treat a cross-repository parent number as an issue in this repository', async () => {
    const h = harness();
    h.service.onWebhook('sub_issues', {
      repository: { full_name: project.repo },
      parent_issue_repo: { full_name: 'other/repo' },
      parent_issue: { number: 1, html_url: 'https://github.com/other/repo/issues/1' },
      sub_issue: issue(2),
    });
    await h.service.flush(project.repo);
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([2]);
  });

  it('uses commit and branch indexes for status events without a PR number', async () => {
    const h = harness();
    h.store.openPullNumbers.mockResolvedValue([1]);
    h.service.onWebhook('status', { repository: { full_name: project.repo }, sha: 'a'.repeat(40) });
    await h.service.flush(project.repo);
    expect(h.store.openPullNumbers).toHaveBeenCalledWith(project.repo, { sha: 'a'.repeat(40), branch: '' });
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
  });

  it('queues a new delivery received while the previous refresh is running', async () => {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.board.mockImplementationOnce(() => gate);
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    const first = h.service.flush(project.repo);
    await vi.waitFor(() => expect(h.board).toHaveBeenCalledTimes(1));
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
    const second = h.service.flush(project.repo);
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    release({});
    await Promise.all([first, second]);
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([1, 2]);
    expect(h.board).toHaveBeenCalledTimes(2);
  });

  it('hides a deleted or transferred issue without deleting its history', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues/2', () => ({ ok: false, status: 404 }));
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
    await h.service.flush(project.repo);
    expect(h.store.hideItem).toHaveBeenCalledWith(project.repo, 2);
    expect(h.store.saveItem).not.toHaveBeenCalled();
  });

  it('continues a deletion batch after GitHub returns 410', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues/2', () => ({ ok: false, status: 410 }));
    for (const number of [2, 3])
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
    await h.service.flush(project.repo);
    expect(h.store.hideItem).toHaveBeenCalledWith(project.repo, 2);
    expect(h.store.saveItem).toHaveBeenCalledWith(
      project.repo,
      expect.objectContaining({ number: 3 }),
      expect.anything(),
    );
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith(project.repo);
    expect(h.errors).toEqual([]);
  });

  it('reconciles PRs and the board without optional Issues or Checks access', async () => {
    const h = harness();
    const forbidden = () => ({ ok: false, status: 403 });
    h.routes.set('/repos/acme/shop/issues', forbidden);
    h.routes.set('/repos/acme/shop/issues/1', forbidden);
    h.routes.set('/repos/acme/shop/issues/1/comments', forbidden);
    h.routes.set('/repos/acme/shop/labels', forbidden);
    h.routes.set('/repos/acme/shop/milestones', forbidden);
    h.routes.set('/repos/acme/shop/pulls', [pull(1)]);
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, forbidden);
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/statuses`, forbidden);
    h.graphql.mockRejectedValue(
      Object.assign(new Error('Issues forbidden'), { errors: [{ type: 'FORBIDDEN' }] }),
    );
    h.board.mockResolvedValue({ issuesError: 'Issues forbidden', issuesTruncated: false });
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledWith(
      project.repo,
      expect.objectContaining({ kind: 'pull', number: 1 }),
      expect.objectContaining({ reviews: [], commits: [], files: [] }),
    );
    const [, row, collections] = h.store.saveItem.mock.calls[0];
    expect(row).not.toHaveProperty('issues');
    expect(row).not.toHaveProperty('checks');
    expect(collections).not.toHaveProperty('comments');
    expect(collections).not.toHaveProperty('checks');
    expect(h.store.saveMetadata).not.toHaveBeenCalled();
    expect(h.board).toHaveBeenCalledWith(project, { complete: true });
    expect(h.invalidate).toHaveBeenCalledWith(project.repo);
    // Keep the issue backfill watermark so granting access later recovers history.
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    h.service.onWebhook('pull_request', {
      repository: { full_name: project.repo },
      pull_request: { number: 1 },
    });
    await h.service.flush(project.repo);
    expect(h.store.saveItem).toHaveBeenCalledTimes(2);
    expect(h.board).toHaveBeenCalledTimes(2);
  });

  it('preserves check collections when only Checks permission is absent', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {} })] });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, () => ({ ok: false, status: 403 }));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/statuses`, [
      { id: 1, context: 'deploy', state: 'success' },
    ]);
    await h.service.tick();
    const [, row, collections] = h.store.saveItem.mock.calls[0];
    expect(row).not.toHaveProperty('checks');
    expect(collections).not.toHaveProperty('checks');
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.errors).toEqual([]);
  });

  it.each([429, 503])('does not suppress check-run failures with status %s', async (status) => {
    const h = harness({ initial: [issue(1, { pull_request: {} })] });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, () => ({ ok: false, status }));
    await h.service.tick();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.store.finishSync).toHaveBeenCalledWith(
      project.repo,
      null,
      expect.stringContaining(String(status)),
    );
  });

  it('does not advance the cursor after an incomplete issue board', async () => {
    const h = harness();
    h.board.mockResolvedValue({ issuesError: 'Issues permission missing', issuesTruncated: false });
    await h.service.tick();
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'Issues permission missing');
  });

  it('refreshes label and milestone metadata for repository-level deliveries', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/labels', [{ id: 4, name: 'renamed', color: 'abcdef' }]);
    h.service.onWebhook('label', { repository: { full_name: project.repo } });
    await h.service.flush(project.repo);
    expect(h.store.saveMetadata).toHaveBeenCalledWith(project.repo, {
      labels: [{ id: 4, name: 'renamed', color: 'abcdef' }],
      milestones: [],
    });
  });

  it('does not advance the cursor if a concurrent board superseded an item download', async () => {
    const h = harness({ initial: [issue(1)] });
    h.store.saveItem.mockResolvedValueOnce(false);
    await h.service.tick();
    expect(h.store.finishSync).toHaveBeenCalledWith(
      project.repo,
      null,
      expect.stringContaining('retry required'),
    );
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
  });

  it('paginates historical closing references instead of limiting them to the board summary', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {} })] });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    h.graphql.mockImplementation(async (_cfg, _query, vars) => ({
      repository: {
        issueOrPullRequest: {
          __typename: 'PullRequest',
          closingIssuesReferences: {
            nodes: [
              {
                number: vars.pullCursor ? 3 : 2,
                title: 'Linked',
                state: 'CLOSED',
                url: 'https://github.com/acme/shop/issues/2',
              },
            ],
            pageInfo: { hasNextPage: !vars.pullCursor, endCursor: vars.pullCursor ? null : 'next' },
          },
        },
      },
    }));
    await h.service.tick();
    expect(h.store.saveItem.mock.calls[0][1].issues.map((i) => i.number)).toEqual([2, 3]);
    expect(h.graphql).toHaveBeenCalledTimes(2);
  });

  it('preserves the prior snapshot if a push lands while downloading PR collections', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {} })] });
    let reads = 0;
    h.routes.set('/repos/acme/shop/pulls/1', () => ({
      ok: true,
      json: async () => pull(1, ++reads > 1 ? { head: { sha: 'c'.repeat(40) } } : {}),
    }));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    await h.service.tick();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.store.finishSync).toHaveBeenCalledWith(
      project.repo,
      null,
      expect.stringContaining('changed during synchronization'),
    );
  });
});
