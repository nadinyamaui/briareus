import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubSync, GITHUB_SYNC_INTERVAL_MS, GITHUB_WEBHOOK_INTERVAL_MS } from '../lib/github-sync.js';

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

const services = [];

function harness({
  initial = [],
  cursor = null,
  synced = new Map(),
  now = () => Date.parse('2026-10-27T12:00:00Z'),
  projects = [project],
} = {}) {
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
  const budget = vi.fn();
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
    projects: () => projects,
    config: () => ({ githubToken: 'token' }),
    store,
    rest,
    graphql,
    board,
    budget,
    invalidate,
    now,
    log: (m) => errors.push(m),
  });
  services.push(service);
  return { service, store, rest, graphql, routes, board, budget, invalidate, errors };
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
});

describe('durable GitHub synchronization', () => {
  it('uses conditional REST reads for repeated synchronization', async () => {
    const h = harness({ initial: [issue(1)] });
    await h.service.tick();
    expect(h.rest.mock.calls.length).toBeGreaterThan(0);
    for (const call of h.rest.mock.calls)
      expect(call.slice(3)).toEqual([undefined, { conditional: true, reserve: 1000 }]);
  });

  it('does no REST work for hourly or webhook updates while GraphQL background work is paused', async () => {
    const h = harness();
    h.budget.mockImplementation(() => {
      throw Object.assign(new Error('reserved'), { status: 429, resource: 'graphql' });
    });
    await h.service.tick();
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    await h.service.flush(project.repo);
    expect(h.rest).not.toHaveBeenCalled();
    expect(h.graphql).not.toHaveBeenCalled();
    expect(h.board).not.toHaveBeenCalled();
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
  });

  it('retains and coalesces webhook deliveries until the shared budget resets', async () => {
    vi.useFakeTimers();
    const h = harness({ now: () => Date.now() });
    const retryAt = Date.now() + 120000;
    h.budget.mockImplementation(() => {
      if (Date.now() < retryAt)
        throw Object.assign(new Error('paused'), { status: 429, resource: 'graphql', retryAt });
    });
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    await h.service.flush(project.repo);
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
    await vi.advanceTimersByTimeAsync(119999);
    expect(h.rest).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2]);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
  });

  it('coalesces sustained webhook traffic and performs one trailing board refresh', async () => {
    vi.useFakeTimers();
    const h = harness({ now: () => Date.now() });
    const deliver = (number) =>
      h.service.onWebhook('issues', {
        repository: { full_name: project.repo },
        issue: { number },
      });
    deliver(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(h.board).toHaveBeenCalledTimes(1);
    deliver(2);
    await vi.advanceTimersByTimeAsync(2000);
    deliver(2);
    deliver(3);
    await vi.advanceTimersByTimeAsync(GITHUB_WEBHOOK_INTERVAL_MS - 2001);
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2, 3]);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000 - GITHUB_WEBHOOK_INTERVAL_MS);
    expect(h.board).toHaveBeenCalledTimes(2);
    expect(h.invalidate).toHaveBeenCalledTimes(3);
    expect(h.store.finishSync).not.toHaveBeenCalled();
  });

  it.each([6000, 7000])(
    'retains webhook work when core recovery finishes at %s after reset',
    async (recoveryAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const h = harness({ now: () => Date.now() });
      h.budget.mockImplementation(() => {
        if (Date.now() < 6000)
          throw Object.assign(new Error('core exhausted'), { status: 429, resource: 'core', retryAt: 6000 });
      });
      h.board.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, recoveryAt));
        return { issuesError: null, issuesTruncated: false };
      });
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
      const work = h.service.flush(project.repo);
      await vi.advanceTimersByTimeAsync(recoveryAt);
      await work;
      await vi.advanceTimersByTimeAsync(1);
      expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    Object.assign(new Error('bad gateway'), { status: 502 }),
    new Error('network unavailable'),
    Object.assign(new Error('graphql exhausted'), { status: 429, resource: 'graphql', retryAt: 9000 }),
  ])('retains the core retry when independent board recovery fails with $message', async (boardError) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    h.budget.mockImplementation(() => {
      if (Date.now() < 6000)
        throw Object.assign(new Error('core exhausted'), { status: 429, resource: 'core', retryAt: 6000 });
    });
    h.board.mockRejectedValueOnce(boardError);
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    await h.service.flush(project.repo);
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.errors).toEqual([`${project.repo}: ${boardError.message}`, `${project.repo}: core exhausted`]);
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, boardError.message);
    await vi.advanceTimersByTimeAsync(5999);
    expect(h.rest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1]);
    expect(h.board).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checkpoints webhook items, expanded targets and metadata across quota windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    h.store.openPullNumbers.mockResolvedValue([1, 2, 3, 4, 5]);
    const relationships = h.graphql.getMockImplementation();
    let window = -1;
    let remaining = 0;
    h.graphql.mockImplementation(async (...args) => {
      const current = Math.floor(Date.now() / 60000);
      if (current !== window) {
        window = current;
        remaining = 2;
      }
      if (!remaining--)
        throw Object.assign(new Error('graphql exhausted'), {
          status: 429,
          resource: 'graphql',
          retryAt: (current + 1) * 60000,
        });
      return relationships(...args);
    });
    h.service.onWebhook('label', { repository: { full_name: project.repo } });
    h.service.onWebhook('push', { repository: { full_name: project.repo }, ref: 'refs/heads/fix' });
    await h.service.flush(project.repo);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(h.store.openPullNumbers).toHaveBeenCalledTimes(1);
    expect(h.store.saveMetadata).toHaveBeenCalledTimes(1);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains failed work and fresh deliveries while checkpointing a rate-limited batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    const deliver = (number) =>
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
    h.store.saveMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));
    h.routes.set('/repos/acme/shop/issues/1/comments', new Error('offline'));
    h.routes.set('/repos/acme/shop/issues/3/comments', () => {
      deliver(2); // A new update to an item already completed by the in-flight batch.
      deliver(4);
      throw Object.assign(new Error('graphql exhausted'), {
        status: 429,
        resource: 'graphql',
        retryAt: 60000,
      });
    });
    h.service.onWebhook('label', { repository: { full_name: project.repo } });
    for (const number of [1, 2, 3]) deliver(number);
    await h.service.flush(project.repo);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([2]);
    h.routes.delete('/repos/acme/shop/issues/1/comments');
    h.routes.delete('/repos/acme/shop/issues/3/comments');
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([2, 2, 4, 1, 3]);
    expect(h.store.saveMetadata).toHaveBeenCalledTimes(2);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a deferred board refresh after repeated GraphQL cooldowns without replaying details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    const times = [];
    h.board.mockImplementation(async () => {
      times.push(Date.now());
      if (Date.now() > 0 && Date.now() < 180000)
        throw Object.assign(new Error('graphql exhausted'), {
          status: 429,
          resource: 'graphql',
          retryAt: Date.now() + 60000,
        });
      return { issuesError: null, issuesTruncated: false };
    });
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    await h.service.flush(project.repo);
    await vi.advanceTimersByTimeAsync(15000);
    h.service.onWebhook('push', { repository: { full_name: project.repo }, ref: 'refs/heads/main' });
    await h.service.flush(project.repo);
    const detailReads = h.rest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(164999);
    expect(times).toEqual([0, 60000, 120000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 60000, 120000, 180000]);
    expect(h.rest).toHaveBeenCalledTimes(detailReads);
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a deferred board when error recording outlasts its cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 1 } });
    await h.service.flush(project.repo);
    await vi.advanceTimersByTimeAsync(15000);
    h.service.onWebhook('push', { repository: { full_name: project.repo }, ref: 'refs/heads/main' });
    await h.service.flush(project.repo);
    const detailReads = h.rest.mock.calls.length;
    h.board.mockRejectedValueOnce(
      Object.assign(new Error('graphql exhausted'), { status: 429, resource: 'graphql', retryAt: 66000 }),
    );
    h.store.finishSync.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 7000));
    });
    await vi.advanceTimersByTimeAsync(51999);
    expect(h.board).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.board).toHaveBeenCalledTimes(3);
    expect(h.rest).toHaveBeenCalledTimes(detailReads);
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks the board throttle after a deferred callback waits behind a slow webhook', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    const times = [];
    h.board.mockImplementation(async () => {
      times.push(Date.now());
      return { issuesError: null, issuesTruncated: false };
    });
    for (const number of [1, 2]) {
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
      await h.service.flush(project.repo);
      await vi.advanceTimersByTimeAsync(15000);
    }
    let release;
    h.routes.set('/repos/acme/shop/issues/3/comments', async () => {
      await new Promise((resolve) => (release = resolve));
      return { ok: true, json: async () => [] };
    });
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 3 } });
    const slow = h.service.flush(project.repo);
    await vi.advanceTimersByTimeAsync(35000);
    expect(times).toEqual([0]);
    release();
    await slow;
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0, 65000]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(times).toEqual([0, 65000, 125000]);
  });

  it('cancels a pending trailing board refresh on shutdown', async () => {
    vi.useFakeTimers();
    const h = harness({ now: () => Date.now() });
    for (const number of [1, 2]) {
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
      await h.service.flush(project.repo);
    }
    expect(h.board).toHaveBeenCalledTimes(1);
    h.service.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.board).toHaveBeenCalledTimes(1);
  });

  it('cancels a deferred board cooldown retry on shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness({ now: () => Date.now() });
    for (const number of [1, 2]) {
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
      await h.service.flush(project.repo);
    }
    h.board.mockRejectedValue(
      Object.assign(new Error('graphql exhausted'), { status: 429, resource: 'graphql', retryAt: 120000 }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.board).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    h.service.stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.board).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mirrors a changed review decision while the full board refresh is deferred', async () => {
    const h = harness();
    await h.service.tick();
    h.routes.set('/repos/acme/shop/issues/1', issue(1, { pull_request: {} }));
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    h.graphql.mockResolvedValue({
      repository: {
        issueOrPullRequest: {
          __typename: 'PullRequest',
          reviewDecision: 'CHANGES_REQUESTED',
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    h.service.onWebhook('pull_request_review', {
      repository: { full_name: project.repo },
      pull_request: { number: 1 },
    });
    await h.service.flush(project.repo);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.store.saveItem).toHaveBeenCalledWith(
      project.repo,
      expect.objectContaining({ reviewDecision: 'changes_requested' }),
      expect.anything(),
    );
  });

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

  it.each(['cancelled', 'stale', 'startup_failure', 'new_state', null])(
    'mirrors terminal check conclusion %s as failure',
    async (conclusion) => {
      const h = harness({ initial: [issue(1, { pull_request: {} })] });
      h.routes.set('/repos/acme/shop/pulls/1', pull(1));
      h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, {
        check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion }],
      });
      await h.service.tick();
      expect(h.store.saveItem.mock.calls[0][1].checks).toBe('failure');
    },
  );

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

  it('reconciles healthy history, open PRs and the board while retrying a failed historical item', async () => {
    const h = harness({ initial: [issue(1, { state: 'closed', pull_request: {} }), issue(2)], cursor: 1000 });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1, { state: 'closed' }));
    h.routes.set('/repos/acme/shop/pulls/1/files', () => ({ ok: false, status: 503 }));
    h.routes.set('/repos/acme/shop/pulls', [pull(3)]);
    h.routes.set('/repos/acme/shop/issues/3', issue(3, { pull_request: {} }));
    h.routes.set('/repos/acme/shop/pulls/3', pull(3));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    await h.service.tick();
    await h.service.tick();
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([2, 3, 3]);
    expect(h.board).toHaveBeenCalledTimes(2);
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.errors).toHaveLength(2);
    h.routes.set('/repos/acme/shop/pulls/1/files', []);
    await h.service.tick();
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([2, 3, 3, 1, 3]);
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, Date.parse('2026-10-27T12:00:00Z'));
  });

  it('continues a webhook batch and reconciles the board after an item fails', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues/1/comments', new Error('offline'));
    for (const number of [1, 2])
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
    await h.service.flush(project.repo);
    expect(h.store.saveItem.mock.calls.map((c) => c[1].number)).toEqual([2]);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith(project.repo);
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'offline');
  });

  it('stops further requests when an item hits a repository-wide rate limit', async () => {
    const h = harness({ initial: [issue(1), issue(2)] });
    h.routes.set(
      '/repos/acme/shop/issues/1/comments',
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    await h.service.tick();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.board).not.toHaveBeenCalled();
    expect(h.errors).toEqual([expect.stringContaining('rate limited')]);
  });

  it.each(['issues', 'pulls'])(
    'reconciles the board after a %s inventory failure and retries without advancing the cursor',
    async (inventory) => {
      const h = harness({ cursor: 1000 });
      h.routes.set(
        `/repos/acme/shop/${inventory}`,
        Object.assign(new Error('Inventory503'), { status: 503 }),
      );
      await h.service.tick();
      expect(h.board).toHaveBeenCalledExactlyOnceWith(project, { complete: true });
      expect(h.invalidate).toHaveBeenCalledWith(project.repo);
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'Inventory503');
      expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
      expect(new URL(h.rest.mock.calls.at(-1)[2], 'https://api.github.com').pathname).toBe(
        `/repos/acme/shop/${inventory}`,
      );
      h.routes.set(`/repos/acme/shop/${inventory}`, []);
      await h.service.tick();
      expect(h.board).toHaveBeenCalledTimes(2);
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, Date.parse('2026-10-27T12:00:00Z'));
      expect(
        decodeURIComponent(h.rest.mock.calls.findLast((call) => call[2].includes('/issues?'))[2]),
      ).toContain('since=1969-12-31T23:59:01.000Z');
    },
  );

  it('preserves an inventory failure when the independent board hits a GraphQL cooldown', async () => {
    const h = harness({ cursor: 1000 });
    h.routes.set('/repos/acme/shop/issues', Object.assign(new Error('Inventory503'), { status: 503 }));
    h.board.mockRejectedValue(
      Object.assign(new Error('graphql exhausted'), { status: 429, resource: 'graphql' }),
    );
    await h.service.tick();
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'Inventory503');
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.errors).toContain(`${project.repo}: graphql exhausted`);
    expect(h.errors).toContain(`${project.repo}: Inventory503`);
  });

  it('reconciles boards across repeated core windows while unchanged open PR detail work exhausts REST', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/pulls', [pull(1), pull(2), pull(3)]);
    for (const number of [1, 2, 3]) {
      h.routes.set(`/repos/acme/shop/issues/${number}`, issue(number, { pull_request: {} }));
      h.routes.set(`/repos/acme/shop/pulls/${number}`, pull(number));
    }
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
    h.routes.set(
      '/repos/acme/shop/pulls/3/files',
      Object.assign(new Error('core exhausted'), {
        status: 429,
        resource: 'core',
        rateLimited: true,
      }),
    );
    await h.service.tick();
    await h.service.tick();
    expect(h.store.saveItem.mock.calls.map(([, row]) => row.number)).toEqual([1, 2, 1, 2]);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.errors).toEqual([`${project.repo}: core exhausted`, `${project.repo}: core exhausted`]);
    h.routes.set('/repos/acme/shop/pulls/3/files', []);
    await h.service.tick();
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, Date.parse('2026-10-27T12:00:00Z'));
  });

  it.each(['inventory', 'item', 'metadata'])(
    'reconciles current boards after a core rate limit in %s without more REST work',
    async (stage) => {
      const h = harness({ initial: [issue(1), issue(2)] });
      const path = {
        inventory: '/repos/acme/shop/issues',
        item: '/repos/acme/shop/issues/1/comments',
        metadata: '/repos/acme/shop/labels',
      }[stage];
      h.routes.set(path, Object.assign(new Error('core exhausted'), { status: 429, resource: 'core' }));
      await h.service.tick();
      expect(new URL(h.rest.mock.calls.at(-1)[2], 'https://api.github.com').pathname).toBe(path);
      expect(h.board).toHaveBeenCalledWith(project, { complete: true });
      expect(h.invalidate).toHaveBeenCalledWith(project.repo);
      expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
      expect(h.errors).toEqual([`${project.repo}: core exhausted`]);
    },
  );

  it('reconciles later repositories while the shared core allowance remains exhausted', async () => {
    const other = { repo: 'acme/other', enabled: true };
    const h = harness({ initial: [issue(1)], projects: [project, other] });
    const limited = Object.assign(new Error('core exhausted'), { status: 429, resource: 'core' });
    h.routes.set('/repos/acme/shop/issues/1/comments', limited);
    h.routes.set('/repos/acme/other/issues', limited);
    await h.service.tick();
    expect(h.board.mock.calls.map(([project]) => project.repo)).toEqual([project.repo, other.repo]);
    expect(h.invalidate.mock.calls.map(([repo]) => repo)).toEqual([project.repo, other.repo]);
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.store.finishSync).not.toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(h.errors).toEqual([`${project.repo}: core exhausted`, `${other.repo}: core exhausted`]);
  });

  it.each(['item', 'metadata'])('reconciles a webhook board after %s exhausts core', async (stage) => {
    const h = harness();
    const path = stage === 'item' ? '/repos/acme/shop/issues/1/comments' : '/repos/acme/shop/labels';
    h.routes.set(path, Object.assign(new Error('core exhausted'), { status: 429, resource: 'core' }));
    if (stage === 'metadata') h.service.onWebhook('label', { repository: { full_name: project.repo } });
    for (const number of [1, 2])
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
    await h.service.flush(project.repo);
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(new URL(h.rest.mock.calls.at(-1)[2], 'https://api.github.com').pathname).toBe(path);
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith(project.repo);
    expect(h.errors).toEqual([`${project.repo}: core exhausted`]);
  });

  it('does not retry board work after GraphQL rate limits', async () => {
    const h = harness({ initial: [issue(1), issue(2)] });
    h.graphql.mockRejectedValue(
      Object.assign(new Error('graphql exhausted'), {
        status: 429,
        resource: 'graphql',
      }),
    );
    await h.service.tick();
    expect(h.graphql).toHaveBeenCalledTimes(1);
    expect(h.board).not.toHaveBeenCalled();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.errors).toEqual([`${project.repo}: graphql exhausted`]);
  });

  it('records both board and core rate limits after core exhaustion', async () => {
    const h = harness({ initial: [issue(1)] });
    h.routes.set(
      '/repos/acme/shop/issues/1/comments',
      Object.assign(new Error('core exhausted'), {
        status: 429,
        resource: 'core',
      }),
    );
    h.board.mockRejectedValue(
      Object.assign(new Error('graphql exhausted'), {
        status: 429,
        resource: 'graphql',
      }),
    );
    await h.service.tick();
    expect(h.board).toHaveBeenCalledTimes(1);
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'graphql exhausted');
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'core exhausted');
    expect(h.errors).toEqual([`${project.repo}: graphql exhausted`, `${project.repo}: core exhausted`]);
  });

  it.each(['failure', 'error'])(
    'retains a failed commit-status context (%s) while another is pending',
    async (state) => {
      const h = harness({ initial: [issue(1, { pull_request: {} })] });
      h.routes.set('/repos/acme/shop/pulls/1', pull(1));
      h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, { check_runs: [] });
      h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/statuses`, [
        { id: 1, context: 'build', state },
        { id: 2, context: 'slow', state: 'pending' },
      ]);
      h.board.mockRejectedValue(new Error('board unavailable'));
      await h.service.tick();
      expect(h.store.saveItem.mock.calls[0][1].checks).toBe('failure');
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, 'board unavailable');
    },
  );

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
    expect(h.board).toHaveBeenCalledTimes(1);
  });

  it('hides a deleted or transferred issue without deleting its history', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues/2', () => ({ ok: false, status: 404 }));
    h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
    await h.service.flush(project.repo);
    expect(h.store.hideItem).toHaveBeenCalledWith(project.repo, 2, Date.parse('2026-10-27T12:00:00Z'));
    expect(h.store.saveItem).not.toHaveBeenCalled();
  });

  it('continues a deletion batch after GitHub returns 410', async () => {
    const h = harness();
    h.routes.set('/repos/acme/shop/issues/2', () => ({ ok: false, status: 410 }));
    for (const number of [2, 3])
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number } });
    await h.service.flush(project.repo);
    expect(h.store.hideItem).toHaveBeenCalledWith(project.repo, 2, Date.parse('2026-10-27T12:00:00Z'));
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
    expect(h.board).toHaveBeenCalledTimes(1);
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

  it.each(['labels', 'milestones', 'write'])(
    'reconciles current boards during %s metadata failures and retries without advancing the cursor',
    async (failure) => {
      const h = harness({ initial: [issue(2)], cursor: 1000 });
      if (failure === 'write') h.store.saveMetadata.mockRejectedValue(new Error('metadata write failed'));
      else h.routes.set(`/repos/acme/shop/${failure}`, () => ({ ok: false, status: 503 }));
      await h.service.tick();
      await h.service.tick();
      expect(h.store.saveItem).toHaveBeenCalledTimes(1);
      expect(h.board).toHaveBeenCalledTimes(2);
      expect(h.invalidate).toHaveBeenCalledTimes(2);
      expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, expect.any(String));
      expect(h.errors).toHaveLength(2);
      if (failure === 'write') h.store.saveMetadata.mockResolvedValue();
      else h.routes.delete(`/repos/acme/shop/${failure}`);
      await h.service.tick();
      expect(h.board).toHaveBeenCalledTimes(3);
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, Date.parse('2026-10-27T12:00:00Z'));
    },
  );

  it.each(['labels', 'milestones', 'write'])(
    'continues healthy coalesced item webhooks after %s metadata failures',
    async (failure) => {
      const h = harness();
      if (failure === 'write') h.store.saveMetadata.mockRejectedValue(new Error('metadata write failed'));
      else h.routes.set(`/repos/acme/shop/${failure}`, () => ({ ok: false, status: 503 }));
      h.service.onWebhook('label', { repository: { full_name: project.repo } });
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
      await h.service.flush(project.repo);
      expect(h.store.saveItem).toHaveBeenCalledWith(
        project.repo,
        expect.objectContaining({ number: 2 }),
        expect.anything(),
      );
      expect(h.board).toHaveBeenCalledTimes(1);
      expect(h.invalidate).toHaveBeenCalledWith(project.repo);
      expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, null, expect.any(String));
      expect(h.store.finishSync).not.toHaveBeenCalledWith(project.repo, expect.any(Number));
      expect(h.errors).toHaveLength(1);
    },
  );

  it.each(['hourly', 'webhook'])(
    'aborts %s board reconciliation immediately on metadata rate limits',
    async (source) => {
      const h = harness();
      h.routes.set('/repos/acme/shop/labels', Object.assign(new Error('rate limited'), { status: 429 }));
      if (source === 'hourly') await h.service.tick();
      else {
        h.service.onWebhook('label', { repository: { full_name: project.repo } });
        h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
        await h.service.flush(project.repo);
      }
      expect(h.store.saveItem).not.toHaveBeenCalled();
      expect(h.store.saveMetadata).not.toHaveBeenCalled();
      expect(h.board).not.toHaveBeenCalled();
      expect(h.invalidate).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
    },
  );

  it('retains inventory observation times when a newer webhook runs before a queued item', async () => {
    let time = 100;
    const h = harness({ initial: [issue(1), issue(2, { title: 'Old', state: 'closed' })], now: () => time });
    h.routes.set('/repos/acme/shop/issues/2', issue(2, { title: 'New', state: 'closed' }));
    let webhook;
    h.routes.set('/repos/acme/shop/issues/1/comments', () => {
      time = 200;
      h.service.onWebhook('issues', { repository: { full_name: project.repo }, issue: { number: 2 } });
      webhook = h.service.flush(project.repo);
      return { ok: true, json: async () => [] };
    });
    await h.service.tick();
    await webhook;
    const snapshots = h.store.saveItem.mock.calls.map(([, row]) => [row.number, row.title, row.observedAt]);
    expect(snapshots).toEqual([
      [1, 'Issue 1', 100],
      [2, 'New', 200],
      [2, 'Old', 100],
    ]);
    expect(h.errors).toEqual([]);
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
