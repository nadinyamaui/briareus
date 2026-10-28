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
  const ci = { save: vi.fn(async () => {}), pendingCommits: vi.fn(async () => []) };
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
    if (url.pathname.endsWith('/check-runs')) return { ok: true, json: async () => ({ check_runs: [] }) };
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
    ci,
    projects: () => projects,
    config: () => ({ githubToken: 'token' }),
    store,
    rest,
    graphql,
    board,
    invalidate,
    now,
    log: (m) => errors.push(m),
  });
  return { service, store, ci, rest, graphql, routes, board, invalidate, errors };
}

afterEach(() => vi.useRealTimers());

describe('durable GitHub synchronization', () => {
  it('continues collecting the default branch after a pending commit becomes unreadable', async () => {
    const h = harness();
    h.ci.pendingCommits.mockResolvedValue([{ sha: 'gone', branch: 'old' }]);
    h.routes.set('/repos/acme/shop/commits/gone/check-runs', () => ({ ok: false, status: 404 }));
    h.routes.set('/repos/acme/shop', { default_branch: 'main' });
    h.routes.set('/repos/acme/shop/commits/main', { sha: 'abc' });
    h.routes.set('/repos/acme/shop/commits/abc/check-runs', {
      check_runs: [{ id: 42, name: 'deploy', status: 'completed', conclusion: 'success' }],
    });
    await h.service.tick();
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [expect.objectContaining({ id: 42 })],
      expect.objectContaining({ sha: 'abc' }),
    );
    expect(h.board).toHaveBeenCalled();
    expect(h.errors[0]).toContain('GitHub answered 404');
    expect(h.store.finishSync).toHaveBeenCalledWith(project.repo, expect.any(Number));
    expect(h.store.finishSync).toHaveBeenCalledWith(
      project.repo,
      null,
      expect.stringContaining('CI collection: GitHub answered 404'),
    );
  });

  it.each(['pending', 'empty repository'])(
    'advances the issue cursor despite unavailable %s CI',
    async (source) => {
      let cursor = Date.parse('2026-10-26T12:00:00Z');
      let clock = Date.parse('2026-10-27T12:00:00Z');
      const h = harness({ now: () => clock });
      h.store.syncState.mockImplementation(async () => ({ synced_at: cursor }));
      h.store.finishSync.mockImplementation(async (_repo, at, error) => {
        if (!error) cursor = at;
      });
      if (source === 'pending') {
        h.ci.pendingCommits.mockResolvedValue([{ sha: 'gone', branch: 'old' }]);
        h.routes.set('/repos/acme/shop/commits/gone/check-runs', () => ({ ok: false, status: 404 }));
      } else {
        h.routes.set('/repos/acme/shop', { default_branch: 'main' });
        h.routes.set('/repos/acme/shop/commits/main', () => ({ ok: false, status: 409 }));
      }
      await h.service.tick();
      const firstCursor = cursor;
      clock += GITHUB_SYNC_INTERVAL_MS;
      await h.service.tick();
      const downloads = h.rest.mock.calls.filter((call) => call[2].includes('/issues?'));
      expect(downloads).toHaveLength(2);
      expect(new URL(downloads[1][2], 'https://api.github.com').searchParams.get('since')).toBe(
        new Date(firstCursor - 60000).toISOString(),
      );
      expect(cursor).toBe(clock);
      expect(h.errors).toHaveLength(2);
      expect(h.store.finishSync.mock.calls).toEqual([
        [project.repo, firstCursor],
        [project.repo, null, expect.stringMatching(/^CI collection:/)],
        [project.repo, clock],
        [project.repo, null, expect.stringMatching(/^CI collection:/)],
      ]);
    },
  );

  it.each(['GitHub', 'ledger', 'rate limit', 'metadata rate limit'])(
    'retains a non-PR webhook discovery after a %s failure and retries it hourly',
    async (failure) => {
      const h = harness();
      const sha = 'f'.repeat(40);
      const endpoint = `/repos/acme/shop/commits/${sha}/check-runs`;
      const check = { id: 99, head_sha: sha, name: 'deploy', status: 'completed', conclusion: 'success' };
      h.routes.set(endpoint, { check_runs: [check] });
      if (failure === 'GitHub') h.routes.set(endpoint, () => ({ ok: false, status: 503 }));
      if (failure === 'ledger') h.ci.save.mockRejectedValueOnce(new Error('ledger unavailable'));
      if (failure === 'rate limit')
        h.routes.set(endpoint, Object.assign(new Error('rate limited'), { status: 429, resource: 'core' }));
      if (failure === 'metadata rate limit') {
        h.service.onWebhook('label', { repository: { full_name: project.repo } });
        h.routes.set(
          '/repos/acme/shop/labels',
          Object.assign(new Error('rate limited'), { status: 429, resource: 'core' }),
        );
      }
      h.service.onWebhook('check_run', {
        repository: { full_name: project.repo },
        check_run: { head_sha: sha, check_suite: { head_branch: 'release' } },
      });
      await h.service.flush(project.repo);
      h.routes.set(endpoint, { check_runs: [check] });
      h.routes.delete('/repos/acme/shop/labels');
      h.ci.save.mockClear();
      await h.service.tick();
      expect(h.ci.save).toHaveBeenCalledWith(
        project.repo,
        [check],
        expect.objectContaining({ sha, branch: 'release' }),
      );
      h.rest.mockClear();
      await h.service.tick();
      expect(h.rest.mock.calls.some((call) => call[2].includes(`/commits/${sha}/`))).toBe(false);
    },
  );

  it.each([
    { source: 'webhook', outcome: 'success' },
    { source: 'hourly', outcome: 'success' },
    { source: 'webhook', outcome: 'failure' },
    { source: 'hourly', outcome: 'failure' },
  ])(
    'retains a newer discovery after older $source $outcome and a newer batch abort',
    async ({ source, outcome }) => {
      const h = harness();
      const sha = 'f'.repeat(40);
      const endpoint = `/repos/acme/shop/commits/${sha}/check-runs`;
      const statuses = `/repos/acme/shop/commits/${sha}/statuses`;
      const older = { id: 99, head_sha: sha, name: 'deploy', status: 'completed', conclusion: 'success' };
      const newer = { ...older, id: 100 };
      const discover = (branch) =>
        h.service.onWebhook('check_run', {
          repository: { full_name: project.repo },
          check_run: { head_sha: sha, check_suite: { head_branch: branch } },
        });
      discover('old-release');
      if (source === 'hourly') {
        h.routes.set(endpoint, () => ({ ok: false, status: 503 }));
        await h.service.flush(project.repo);
      }
      h.routes.set(endpoint, { check_runs: [older] });
      const readingStatuses = Promise.withResolvers();
      const releaseStatuses = Promise.withResolvers();
      h.routes.set(statuses, () => {
        readingStatuses.resolve();
        return releaseStatuses.promise;
      });
      const first = source === 'hourly' ? h.service.tick() : h.service.flush(project.repo);
      await readingStatuses.promise;

      // Register the next discovery while the older authoritative read is in flight.
      discover('release');
      h.service.onWebhook('label', { repository: { full_name: project.repo } });
      h.routes.set(
        '/repos/acme/shop/labels',
        Object.assign(new Error('rate limited'), { status: 429, resource: 'core' }),
      );
      const second = h.service.flush(project.repo);
      releaseStatuses.resolve(
        outcome === 'success' ? { ok: true, json: async () => [] } : { ok: false, status: 503 },
      );
      await Promise.all([first, second]);
      if (outcome === 'success')
        expect(h.ci.save).toHaveBeenCalledWith(
          project.repo,
          [older],
          expect.objectContaining({ sha, branch: 'old-release' }),
        );
      else expect(h.ci.save).not.toHaveBeenCalled();
      expect(h.errors).toContain('acme/shop: rate limited');

      h.routes.delete('/repos/acme/shop/labels');
      h.routes.set(statuses, []);
      h.routes.set(endpoint, { check_runs: [older, newer] });
      h.ci.save.mockClear();
      await h.service.tick();
      expect(h.ci.save).toHaveBeenCalledWith(
        project.repo,
        [older, newer],
        expect.objectContaining({ sha, branch: 'release' }),
      );
      h.rest.mockClear();
      await h.service.tick();
      expect(h.rest.mock.calls.some((call) => call[2].includes(`/commits/${sha}/`))).toBe(false);
    },
  );

  it('bounds hourly discovery retries and rotates failed targets past the first hundred', async () => {
    const h = harness();
    const shas = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(40, 'f'));
    for (const sha of shas) {
      h.routes.set(`/repos/acme/shop/commits/${sha}/check-runs`, () => ({ ok: false, status: 503 }));
      h.service.onWebhook('status', { repository: { full_name: project.repo }, sha });
    }
    await h.service.flush(project.repo);
    h.rest.mockClear();
    await h.service.tick();
    expect(h.rest.mock.calls.filter((call) => call[2].includes('/check-runs'))).toHaveLength(100);
    expect(h.rest.mock.calls.some((call) => call[2].includes(shas[100]))).toBe(false);
    h.rest.mockClear();
    await h.service.tick();
    expect(h.rest.mock.calls.filter((call) => call[2].includes('/check-runs'))).toHaveLength(100);
    expect(h.rest.mock.calls.some((call) => call[2].includes(shas[100]))).toBe(true);
  });

  it.each([
    [[{ name: 'staging', commit: { sha: 'abc' } }], 'staging'],
    [[{ name: 'staging' }, { name: 'production' }], null],
    [[], null],
  ])('uses only unambiguous status branch hints: %j', async (branches, branch) => {
    const h = harness();
    const status = { id: 15, context: 'deploy', state: 'success' };
    h.routes.set('/repos/acme/shop/commits/abc/statuses', [status]);
    h.service.onWebhook('status', { repository: { full_name: project.repo }, sha: 'abc', branches });
    await h.service.flush(project.repo);
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [status],
      expect.objectContaining({ sha: 'abc', branch }),
    );
  });

  it('retries an unchanged closed PR when its ledger write failed', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {}, state: 'closed' })] });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1, { state: 'closed' }));
    h.routes.set(`/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`, {
      check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }],
    });
    h.ci.save.mockRejectedValueOnce(new Error('ledger unavailable'));
    await h.service.tick();
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.errors).toContain('acme/shop: ledger unavailable');
    await h.service.tick();
    expect(h.store.saveItem).toHaveBeenCalledTimes(1);
    expect(h.store.finishSync).toHaveBeenLastCalledWith(project.repo, expect.any(Number));
  });

  it('records retries separately without changing the latest PR verdict', async () => {
    const h = harness({ initial: [issue(1, { pull_request: {} })] });
    h.routes.set('/repos/acme/shop/pulls/1', pull(1));
    const latest = { id: 12, name: 'CI', status: 'completed', conclusion: 'success' };
    const old = { ...latest, id: 11, conclusion: 'failure' };
    const endpoint = `/repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`;
    h.routes.set(endpoint, (url) => ({
      ok: true,
      json: async () => ({ check_runs: url.searchParams.get('filter') === 'all' ? [latest, old] : [latest] }),
    }));
    await h.service.tick();
    expect(h.store.saveItem.mock.calls[0][1].checks).toBe('success');
    const saved = h.ci.save.mock.calls.find((call) => call[1].length);
    expect(saved[1]).toEqual(expect.arrayContaining([latest, old]));
    expect(saved[2]).toMatchObject({ sha: 'a'.repeat(40), branch: 'fix' });
  });

  it('refetches checks from webhooks outside PRs rather than trusting an obsolete payload', async () => {
    const h = harness();
    const current = {
      id: 10,
      head_sha: 'c'.repeat(40),
      name: 'deploy',
      status: 'completed',
      conclusion: 'success',
    };
    h.routes.set(`/repos/acme/shop/commits/${current.head_sha}/check-runs`, { check_runs: [current] });
    h.service.onWebhook('check_run', {
      repository: { full_name: project.repo },
      check_run: {
        id: 10,
        head_sha: current.head_sha,
        status: 'queued',
        check_suite: { head_branch: 'production' },
      },
    });
    await h.service.flush(project.repo);
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [current],
      expect.objectContaining({ branch: 'production' }),
    );
    expect(h.store.saveItem).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('coalesces a matrix-job webhook burst into one CI fetch per commit', async () => {
    const h = harness();
    const sha = 'c'.repeat(40);
    for (let id = 1; id <= 100; id++)
      h.service.onWebhook('check_run', {
        repository: { full_name: project.repo },
        check_run: { id, head_sha: sha },
      });
    await h.service.flush(project.repo);
    expect(h.rest.mock.calls.filter((call) => call[2].includes('/check-runs'))).toHaveLength(1);
    expect(h.ci.save).toHaveBeenCalledTimes(1);
  });

  it('recovers pending old heads and collects default-branch checks during periodic synchronization', async () => {
    const h = harness();
    const sha = 'd'.repeat(40);
    h.ci.pendingCommits.mockResolvedValue([{ sha: 'c'.repeat(40), branch: 'old' }]);
    h.routes.set('/repos/acme/shop', { default_branch: 'main' });
    h.routes.set('/repos/acme/shop/commits/main', { sha });
    h.routes.set(`/repos/acme/shop/commits/${sha}/check-runs`, {
      check_runs: [{ id: 42, name: 'deploy', status: 'completed', conclusion: 'success' }],
    });
    await h.service.tick();
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [],
      expect.objectContaining({ sha: 'c'.repeat(40), branch: 'old' }),
    );
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [expect.objectContaining({ id: 42 })],
      expect.objectContaining({ sha, branch: 'main' }),
    );
    expect(h.errors).toEqual([]);
  });

  it.each([
    ['refs/heads/release/candidate', 'release/candidate'],
    ['refs/tags/v1', null],
    ['refs/pull/1/head', null],
    [undefined, null],
  ])('collects push checks using only branch refs as hints: %s', async (ref, branch) => {
    const h = harness();
    const sha = 'e'.repeat(40);
    const check = { id: 1, name: 'deploy', status: 'completed', conclusion: 'success' };
    h.routes.set(`/repos/acme/shop/commits/${sha}/check-runs`, { check_runs: [check] });
    h.service.onWebhook('push', { repository: { full_name: project.repo }, ref, after: sha });
    await h.service.flush(project.repo);
    expect(h.ci.save).toHaveBeenCalledWith(project.repo, [check], expect.objectContaining({ sha, branch }));
    expect(h.errors).toEqual([]);
  });

  it('records push checks without a PR and ignores deleted refs', async () => {
    const h = harness();
    const sha = 'e'.repeat(40);
    const status = { id: 1, context: 'deploy', state: 'success' };
    h.routes.set(`/repos/acme/shop/commits/${sha}/statuses`, [status]);
    h.service.onWebhook('push', {
      repository: { full_name: project.repo },
      ref: 'refs/heads/production',
      after: sha,
    });
    await h.service.flush(project.repo);
    expect(h.ci.save).toHaveBeenCalledWith(
      project.repo,
      [status],
      expect.objectContaining({ sha, branch: 'production' }),
    );
    h.ci.save.mockClear();
    h.service.onWebhook('push', {
      repository: { full_name: project.repo },
      ref: 'refs/heads/production',
      deleted: true,
      after: '0'.repeat(40),
    });
    await h.service.flush(project.repo);
    expect(h.ci.save).not.toHaveBeenCalled();
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
    expect(h.board).toHaveBeenCalledTimes(2);
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

  it('records a GraphQL board rate limit without retrying after core exhaustion', async () => {
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
    expect(h.errors).toEqual([`${project.repo}: graphql exhausted`]);
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
    expect(h.board).toHaveBeenCalledTimes(2);
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
