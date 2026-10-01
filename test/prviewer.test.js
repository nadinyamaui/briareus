import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ githubToken: 'token' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
vi.mock('../lib/github.js', () => ({ githubRest: vi.fn(), githubGraphql: vi.fn() }));
import { githubRest } from '../lib/github.js';
import { commitView, mergePullRequest, pullRequestView, pullRequestViewOptions } from '../lib/prviewer.js';

const project = { repo: 'owner/repo' };
const raw = {
  number: 42,
  title: 'Example',
  body: '# Description',
  html_url: 'https://github.com/owner/repo/pull/42',
  user: { login: 'author' },
  state: 'open',
  draft: false,
  head: { sha: 'abc', ref: 'feature', label: 'fork:feature' },
  base: { sha: 'def', ref: 'main' },
  additions: 3,
  deletions: 2,
  changed_files: 101,
};
const file = {
  filename: 'new.js',
  previous_filename: 'old.js',
  status: 'renamed',
  additions: 3,
  deletions: 2,
  patch: '@@ -1 +1 @@\n-old\n+new',
  blob_url: 'https://github.com/owner/repo/blob/abc/new.js',
};
const repoRaw = { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: true };
const ok = (data) => ({ ok: true, json: async () => structuredClone(data) });
let respond;
let repoAnswer;
beforeEach(() => {
  repoAnswer = () => ok(repoRaw);
  cfg.githubToken = 'token';
  githubRest.mockReset();
  respond = (path) => {
    if (path.endsWith('/pulls/42')) return ok(raw);
    throw new Error(`Unexpected URL: ${path}`);
  };
  githubRest.mockImplementation(async (_cfg, method, path) => {
    expect(method).toBe('GET');
    // The repository's merge settings ride along with the viewer's first read.
    if (path === '/repos/owner/repo') return repoAnswer();
    return respond(path);
  });
});

describe('in-app pull request content', () => {
  it('reads the description without fetching files or checks', async () => {
    const { pr } = await pullRequestView(project, 42);
    expect(pr).toMatchObject({
      body: '# Description',
      author: 'author',
      headRef: 'fork:feature',
      headSha: 'abc',
      state: 'open',
      mergeable: null,
      mergeMethods: ['squash', 'rebase'],
    });
    expect(githubRest).toHaveBeenCalledTimes(2);
    expect(githubRest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/repos/owner/repo/pulls/42',
      undefined,
      { conditional: true },
    );
  });

  it('offers every merge method when GitHub hides the repository merge settings', async () => {
    repoAnswer = () => ok({ name: 'repo' });
    expect((await pullRequestView(project, 42)).pr.mergeMethods).toEqual(['squash', 'merge', 'rebase']);
  });

  it('still shows the pull request when the repository read fails', async () => {
    repoAnswer = () => ({ ok: false, status: 403 });
    const { pr } = await pullRequestView(project, 42);
    expect(pr).toMatchObject({ title: 'Example', mergeMethods: ['squash', 'merge', 'rebase'] });
    repoAnswer = () => {
      throw new Error('socket hang up');
    };
    await expect(pullRequestView(project, 42)).resolves.toMatchObject({ pr: { title: 'Example' } });
  });

  it('skips the repository read once the viewer is pinned to a head', async () => {
    const { pr } = await pullRequestView(project, 42, { headSha: 'abc', baseSha: 'def' });
    expect(pr.mergeMethods).toBeUndefined();
    expect(githubRest.mock.calls.map((call) => call[2])).toEqual(['/repos/owner/repo/pulls/42']);
  });

  it('reports a missing token as 503 rather than a bad gateway', async () => {
    cfg.githubToken = '';
    await expect(pullRequestView(project, 42)).rejects.toMatchObject({ status: 503 });
    expect(githubRest).not.toHaveBeenCalled();
  });

  it.each([
    [404, 404],
    [403, 403],
    [500, 502],
  ])('maps GitHub %s on the pull request to HTTP %s', async (githubStatus, status) => {
    respond = () => ({ ok: false, status: githubStatus });
    await expect(pullRequestView(project, 42)).rejects.toMatchObject({ status });
  });

  it.each([
    [{ ...raw, merged: true, state: 'closed' }, 'merged'],
    [{ ...raw, draft: true }, 'draft'],
    [{ ...raw, draft: true, state: 'closed' }, 'closed'],
  ])('preserves merged, draft and closed state', async (pr, expected) => {
    respond = () => ok(pr);
    expect((await pullRequestView(project, 42)).pr.state).toBe(expected);
  });

  it('paginates files, preserves renames and reports missing text patches', async () => {
    respond = (path) =>
      path.endsWith('/pulls/42')
        ? ok(raw)
        : ok(
            path.endsWith('page=1')
              ? Array.from({ length: 100 }, () => file)
              : [{ ...file, patch: undefined }],
          );
    const first = await pullRequestView(project, 42, { section: 'files' });
    expect(first.nextPage).toBe(2);
    expect(first.files[0]).toMatchObject({ previousFilename: 'old.js', patch: file.patch });
    const last = await pullRequestView(project, 42, {
      section: 'files',
      page: 2,
      headSha: 'abc',
      baseSha: 'def',
    });
    expect(last.nextPage).toBeNull();
    expect(last.files[0].patch).toBeNull();
  });

  it('reports the GitHub 3,000-file limit rather than pretending the list is complete', async () => {
    respond = (path) =>
      path.endsWith('/pulls/42')
        ? ok({ ...raw, changed_files: 3100 })
        : ok(Array.from({ length: 100 }, () => file));
    const result = await pullRequestView(project, 42, { section: 'files', page: 30 });
    expect(result).toMatchObject({ nextPage: null, truncated: true });
  });

  it.each([{ headSha: 'old' }, { baseSha: 'old' }])(
    'rejects files from a different revision',
    async (revision) => {
      await expect(pullRequestView(project, 42, { section: 'files', ...revision })).rejects.toMatchObject({
        status: 409,
      });
      expect(githubRest.mock.calls.map((call) => call[2])).not.toContainEqual(
        expect.stringContaining('/files'),
      );
    },
  );

  it('rejects a push that arrives during a file-page fetch', async () => {
    let reads = 0;
    respond = (path) =>
      path.endsWith('/pulls/42')
        ? ok(++reads === 1 ? raw : { ...raw, head: { ...raw.head, sha: 'new' } })
        : ok([file]);
    await expect(pullRequestView(project, 42, { section: 'files' })).rejects.toMatchObject({ status: 409 });
  });

  it('pages check runs and combines them with current commit statuses on the head SHA', async () => {
    respond = (path) => {
      if (path.endsWith('/pulls/42')) return ok(raw);
      expect(path).toContain('/commits/abc/');
      if (path.includes('/status?'))
        return ok({
          total_count: 1,
          statuses: [{ context: 'external', state: 'pending', description: 'Deploying' }],
        });
      return ok({
        total_count: 101,
        check_runs: path.endsWith('page=1')
          ? Array.from({ length: 100 }, () => ({
              name: 'tests',
              status: 'completed',
              conclusion: 'success',
              app: { name: 'CI' },
            }))
          : [{ name: 'lint', status: 'completed', conclusion: 'failure' }],
      });
    };
    const result = await pullRequestView(project, 42, { section: 'checks' });
    expect(result.checks).toHaveLength(102);
    expect(result.checks.at(-1)).toMatchObject({ name: 'external', status: 'in_progress', conclusion: null });
    expect(result.checks.find((c) => c.name === 'lint')).toMatchObject({
      conclusion: 'failure',
      failed: true,
    });
    expect(result.warnings).toEqual([]);
  });

  it('does not mark cancelled or stale check runs as failed', async () => {
    respond = (path) => {
      if (path.endsWith('/pulls/42')) return ok(raw);
      if (path.includes('/status?')) return ok({ total_count: 0, statuses: [] });
      return ok({
        total_count: 2,
        check_runs: [
          { name: 'old', status: 'completed', conclusion: 'cancelled' },
          { name: 'stale', status: 'completed', conclusion: 'stale' },
        ],
      });
    };
    const result = await pullRequestView(project, 42, { section: 'checks' });
    expect(result.checks).toMatchObject([
      { name: 'old', conclusion: 'cancelled', failed: false },
      { name: 'stale', conclusion: 'stale', failed: false },
    ]);
  });

  it('keeps available checks visible when the token cannot read check runs', async () => {
    respond = (path) => {
      if (path.endsWith('/pulls/42')) return ok(raw);
      if (path.includes('/check-runs?')) return { ok: false, status: 403 };
      return ok({ total_count: 1, statuses: [{ context: 'build', state: 'error' }] });
    };
    const result = await pullRequestView(project, 42, { section: 'checks' });
    expect(result.checks).toMatchObject([{ name: 'build', conclusion: 'failure' }]);
    expect(result.warnings[0]).toContain('403');
  });

  it('reports bounded check pagination as incomplete', async () => {
    respond = (path) => {
      if (path.endsWith('/pulls/42')) return ok(raw);
      if (path.includes('/status?')) return ok({ total_count: 0, statuses: [] });
      return ok({
        total_count: 1001,
        check_runs: Array.from({ length: 100 }, () => ({ name: 'check', status: 'queued' })),
      });
    };
    const result = await pullRequestView(project, 42, { section: 'checks' });
    expect(result.checks).toHaveLength(1000);
    expect(result.warnings[0]).toContain('1,000');
  });

  it.each([{ section: 'unknown' }, { page: 0 }, { page: 31 }, { page: 1.5 }])(
    'rejects invalid requests before contacting GitHub',
    async (options) => {
      await expect(pullRequestView(project, 42, options)).rejects.toMatchObject({ status: 400 });
      expect(githubRest).not.toHaveBeenCalled();
    },
  );

  it('reads its options from a query, where every value is a string', () => {
    expect(pullRequestViewOptions({ repo: 'owner/repo', pr: '42' })).toEqual({
      section: 'description',
      page: 1,
      headSha: '',
      baseSha: '',
    });
    expect(pullRequestViewOptions({ section: 'files', page: '2', headSha: 'abc', baseSha: 'def' })).toEqual({
      section: 'files',
      page: 2,
      headSha: 'abc',
      baseSha: 'def',
    });
  });
});

describe('the lists a pull request carries', () => {
  const lists = {
    '/pulls/42/commits': {
      sha: 'c1',
      commit: { message: 'Fix it\n\nBody', author: { name: 'Ada L', date: '2026-01-02T03:04:05Z' } },
      author: { login: 'ada' },
      html_url: 'https://github.com/owner/repo/commit/c1',
    },
    '/issues/42/comments': {
      id: 7,
      user: { login: 'bob' },
      body: 'Looks good',
      created_at: 'c',
      updated_at: 'u',
      html_url: 'comment-url',
    },
    '/pulls/42/reviews': {
      id: 8,
      user: { login: 'eve' },
      state: 'CHANGES_REQUESTED',
      body: 'Two things',
      commit_id: 'c1',
      submitted_at: 's',
      html_url: 'review-url',
    },
    '/pulls/42/comments': {
      id: 9,
      pull_request_review_id: 8,
      in_reply_to_id: 3,
      user: { login: 'eve' },
      body: 'Off by one',
      path: 'src/a.js',
      line: null,
      original_line: 12,
      side: 'RIGHT',
      diff_hunk: '@@ -1 +1 @@',
      commit_id: 'c1',
      created_at: 'c',
      updated_at: 'u',
      html_url: 'inline-url',
    },
  };
  beforeEach(() => {
    respond = (path) => {
      if (path.endsWith('/pulls/42')) return ok(raw);
      const [route, query] = path.replace('/repos/owner/repo', '').split('?');
      if (!lists[route]) throw new Error(`Unexpected URL: ${path}`);
      return ok(query.endsWith('page=1') ? Array.from({ length: 100 }, () => lists[route]) : [lists[route]]);
    };
  });

  it('reads commits, comments, reviews and inline comments from where GitHub keeps each', async () => {
    const commits = await pullRequestView(project, 42, { section: 'commits' });
    expect(commits.pr.headSha).toBe('abc');
    expect(commits.commits[0]).toEqual({
      sha: 'c1',
      message: 'Fix it\n\nBody',
      author: 'ada',
      date: '2026-01-02T03:04:05Z',
      url: 'https://github.com/owner/repo/commit/c1',
    });
    const comments = await pullRequestView(project, 42, { section: 'comments' });
    expect(comments.comments[0]).toMatchObject({ id: 7, author: 'bob', body: 'Looks good' });
    const reviews = await pullRequestView(project, 42, { section: 'reviews' });
    expect(reviews.reviews[0]).toMatchObject({ author: 'eve', state: 'changes_requested', commitSha: 'c1' });
    const inline = await pullRequestView(project, 42, { section: 'review-comments' });
    expect(inline.reviewComments[0]).toMatchObject({
      reviewId: 8,
      inReplyTo: 3,
      path: 'src/a.js',
      line: null,
      originalLine: 12,
      diffHunk: '@@ -1 +1 @@',
    });
  });

  it('offers the next page only after a full one, and refuses a page out of range', async () => {
    expect((await pullRequestView(project, 42, { section: 'comments' })).nextPage).toBe(2);
    const last = await pullRequestView(project, 42, { section: 'comments', page: 2 });
    expect(last.comments).toHaveLength(1);
    expect(last.nextPage).toBeNull();
    await expect(pullRequestView(project, 42, { section: 'commits', page: 31 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(pullRequestView(project, 42, { section: 'timeline' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('names a commit author with no GitHub account by the name on the commit', async () => {
    lists['/pulls/42/commits'] = { ...lists['/pulls/42/commits'], author: null };
    const { commits } = await pullRequestView(project, 42, { section: 'commits', page: 2 });
    expect(commits[0].author).toBe('Ada L');
  });
});

describe('one commit', () => {
  const commit = {
    sha: 'c'.repeat(40),
    commit: { message: 'Fix it', author: { name: 'Ada L', date: 'd' } },
    author: { login: 'ada' },
    html_url: 'commit-url',
    parents: [{ sha: 'p1' }],
    stats: { additions: 3, deletions: 2 },
    files: [file],
  };

  it('reads the commit with the files it changed', async () => {
    respond = (path) => {
      expect(path).toBe(`/repos/owner/repo/commits/${commit.sha}`);
      return ok(commit);
    };
    expect(await commitView(project, commit.sha)).toEqual({
      commit: {
        sha: commit.sha,
        message: 'Fix it',
        author: 'ada',
        date: 'd',
        url: 'commit-url',
        parents: ['p1'],
        additions: 3,
        deletions: 2,
      },
      files: [
        {
          filename: 'new.js',
          previousFilename: 'old.js',
          status: 'renamed',
          additions: 3,
          deletions: 2,
          patch: file.patch,
          url: file.blob_url,
        },
      ],
      truncated: false,
    });
  });

  it('says so when GitHub’s 300-file limit may have cut the list', async () => {
    respond = () => ok({ ...commit, files: Array.from({ length: 300 }, () => file) });
    expect((await commitView(project, commit.sha)).truncated).toBe(true);
  });

  it('refuses anything that is not a SHA before asking GitHub, and reports an unknown one as 404', async () => {
    for (const sha of ['', 'main', '../pulls/1', 'abc']) {
      await expect(commitView(project, sha)).rejects.toMatchObject({ status: 400 });
    }
    expect(githubRest).not.toHaveBeenCalled();
    respond = () => ({ ok: false, status: 422, json: async () => ({}) });
    await expect(commitView(project, 'abc1234')).rejects.toMatchObject({ status: 404 });
  });
});

describe('merging from the in-app viewer', () => {
  const sha = 'a'.repeat(40);
  const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });
  // The pull read before the merge, then the merge itself.
  const github = (merge, pull = answer(200, raw)) =>
    githubRest.mockImplementation(async (_cfg, verb) => (verb === 'GET' ? pull : merge));

  it('merges exactly the head the viewer showed, with the chosen method', async () => {
    github(answer(200, { merged: true, sha: 'b'.repeat(40), message: 'Merged' }));
    await expect(
      mergePullRequest(project, 42, { method: 'rebase', headSha: sha, baseRef: 'main' }),
    ).resolves.toEqual({
      merged: true,
      status: 'merged',
      sha: 'b'.repeat(40),
      message: 'Merged',
    });
    expect(githubRest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/repos/owner/repo/pulls/42',
      undefined,
      {
        apiVersion: '2026-03-10',
      },
    );
    expect(githubRest).toHaveBeenCalledWith(expect.anything(), 'PUT', '/repos/owner/repo/pulls/42/merge', {
      merge_method: 'rebase',
      sha,
    });
  });

  it('squashes when no method is given', async () => {
    github(answer(200, { merged: true, sha: 'b'.repeat(40), message: 'Merged' }));
    await mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' });
    expect(githubRest).toHaveBeenCalledWith(expect.anything(), 'PUT', '/repos/owner/repo/pulls/42/merge', {
      merge_method: 'squash',
      sha,
    });
  });

  it('refuses with 409 when the pull request was retargeted to another base branch', async () => {
    github(answer(200, { merged: true }), answer(200, { ...raw, base: { sha: 'def', ref: 'release' } }));
    await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).rejects.toMatchObject({
      status: 409,
      message: 'This pull request now merges into release, not main. Refresh to load its latest revision.',
    });
    expect(githubRest).not.toHaveBeenCalledWith(
      expect.anything(),
      'PUT',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not merge when the pull request cannot be read first', async () => {
    github(answer(200, { merged: true }), answer(500, {}));
    await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).rejects.toMatchObject({
      status: 502,
    });
    expect(githubRest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ method: 'octopus', headSha: sha, baseRef: 'main' }, 400],
    [{ method: 'squash', headSha: '', baseRef: 'main' }, 400],
    [{ method: 'squash', headSha: sha }, 400],
  ])('rejects %o before calling GitHub', async (options, status) => {
    await expect(mergePullRequest(project, 42, options)).rejects.toMatchObject({ status });
    expect(githubRest).not.toHaveBeenCalled();
  });

  it('reports a missing token as 503', async () => {
    cfg.githubToken = '';
    await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).rejects.toMatchObject({
      status: 503,
    });
  });

  describe('a stacked pull request', () => {
    const stacked = answer(200, { ...raw, stack: { id: 7, number: 3, size: 2, position: 2 } });
    // The pull read, the merge-async request, then each poll of its result.
    const githubStack = (accepted, ...polls) =>
      githubRest.mockImplementation(async (_cfg, verb, url) => {
        if (verb === 'PUT') return accepted;
        if (url.includes('/merge-async/')) return polls.shift() ?? answer(200, pendingBody);
        return stacked;
      });
    const pendingBody = { status: 'pending', details: { uuid: 'u-1', message: 'Merge requested' } };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('merges through the asynchronous endpoint and waits for the result', async () => {
      githubStack(
        answer(202, pendingBody),
        answer(200, { status: 'merged', details: { message: 'Merged', sha: 'c'.repeat(40) } }),
      );
      const merging = mergePullRequest(project, 42, { method: 'rebase', headSha: sha, baseRef: 'main' });
      await vi.runAllTimersAsync();
      await expect(merging).resolves.toEqual({
        merged: true,
        status: 'merged',
        sha: 'c'.repeat(40),
        message: 'Merged',
      });
      expect(githubRest).toHaveBeenCalledWith(
        expect.anything(),
        'PUT',
        '/repos/owner/repo/pulls/42/merge-async',
        { merge_method: 'rebase', sha },
        { apiVersion: '2026-03-10' },
      );
      expect(githubRest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        '/repos/owner/repo/pulls/42/merge-async/u-1',
        undefined,
        { apiVersion: '2026-03-10' },
      );
      expect(githubRest).not.toHaveBeenCalledWith(
        expect.anything(),
        'PUT',
        '/repos/owner/repo/pulls/42/merge',
        expect.anything(),
      );
    });

    it('reports a stack sent to the merge queue without polling', async () => {
      githubStack(answer(200, { status: 'enqueued', details: { message: 'Enqueued' } }));
      await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).resolves.toEqual({
        merged: false,
        status: 'enqueued',
        sha: null,
        message: 'Added to the merge queue with the 1 below it in the stack',
      });
      expect(githubRest).toHaveBeenCalledTimes(2);
    });

    it('reports a merge still running after the wait as pending', async () => {
      githubStack(answer(202, pendingBody));
      const merging = mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' });
      await vi.runAllTimersAsync();
      await expect(merging).resolves.toMatchObject({ merged: false, status: 'pending' });
      // The pull read, the request, then ten polls.
      expect(githubRest).toHaveBeenCalledTimes(12);
    });

    it('refuses with 409 when GitHub reports the stacked merge failed', async () => {
      githubStack(
        answer(202, pendingBody),
        answer(200, { status: 'failed', details: { message: 'Required checks are failing' } }),
      );
      const merging = mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' });
      const settled = expect(merging).rejects.toMatchObject({
        status: 409,
        message: 'GitHub could not merge the stack: Required checks are failing',
      });
      await vi.runAllTimersAsync();
      await settled;
    });

    it.each([
      [400, 409],
      [409, 409],
      [422, 422],
      [500, 502],
    ])('passes a refused request (GitHub %s) through as %s', async (githubStatus, status) => {
      githubStack(answer(githubStatus, { message: 'Pull request is not mergeable' }));
      await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).rejects.toMatchObject({
        status,
        message: 'GitHub refused the merge: Pull request is not mergeable',
      });
    });
  });

  it.each([
    [405, 405],
    [409, 409],
    [422, 422],
    [401, 502],
    [500, 502],
  ])('passes GitHub %s through as %s with its reason', async (githubStatus, status) => {
    github(answer(githubStatus, { message: 'Head branch was modified' }));
    await expect(mergePullRequest(project, 42, { headSha: sha, baseRef: 'main' })).rejects.toMatchObject({
      status,
      message: 'GitHub refused the merge: Head branch was modified',
    });
  });
});
