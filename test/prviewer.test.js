import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ githubToken: 'token' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
vi.mock('../lib/github.js', () => ({ githubRest: vi.fn(), githubGraphql: vi.fn() }));
import { githubRest } from '../lib/github.js';
import { pullRequestView } from '../lib/prviewer.js';

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
const ok = (data) => ({ ok: true, json: async () => structuredClone(data) });
let respond;
beforeEach(() => {
  cfg.githubToken = 'token';
  githubRest.mockReset();
  respond = (path) => {
    if (path.endsWith('/pulls/42')) return ok(raw);
    throw new Error(`Unexpected URL: ${path}`);
  };
  githubRest.mockImplementation(async (_cfg, method, path) => {
    expect(method).toBe('GET');
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
    });
    expect(githubRest).toHaveBeenCalledTimes(1);
    expect(githubRest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/repos/owner/repo/pulls/42',
      undefined,
      { conditional: true },
    );
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
      expect(githubRest).toHaveBeenCalledTimes(1);
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
});
