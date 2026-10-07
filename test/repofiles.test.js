import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ githubToken: 'token' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
vi.mock('../lib/github.js', () => ({ githubRest: vi.fn() }));
import { githubRest } from '../lib/github.js';
import { MAX_FILE_BYTES, repoFile, repoTree } from '../lib/repofiles.js';

const project = { repo: 'owner/repo' };
const ok = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });
const commit = { sha: 'c0ffee', commit: { tree: { sha: 'tree1' } } };
const base64 = (text) => Buffer.from(text).toString('base64');
let respond;
beforeEach(() => {
  cfg.githubToken = 'token';
  githubRest.mockReset();
  githubRest.mockImplementation(async (_cfg, method, path) => {
    expect(method).toBe('GET');
    return respond(path);
  });
});

describe('a repository’s tree', () => {
  it('reads the default branch’s commit, then its tree, pinned to that commit', async () => {
    respond = (path) => {
      if (path === '/repos/owner/repo') return ok({ default_branch: 'main' });
      if (path === '/repos/owner/repo/commits/main') return ok(commit);
      if (path === '/repos/owner/repo/git/trees/tree1?recursive=1')
        return ok({
          truncated: false,
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/a.js', type: 'blob', size: 12 },
            { path: 'vendor/lib', type: 'commit' },
          ],
        });
      throw new Error(`Unexpected URL: ${path}`);
    };
    expect(await repoTree(project)).toEqual({
      ref: 'main',
      sha: 'c0ffee',
      truncated: false,
      entries: [
        { path: 'src', type: 'tree' },
        { path: 'src/a.js', type: 'blob', size: 12 },
      ],
    });
  });

  it('reads a named branch, its slash encoded, and passes truncation on', async () => {
    respond = (path) => {
      if (path === '/repos/owner/repo/commits/feature%2Fx') return ok(commit);
      if (path.startsWith('/repos/owner/repo/git/trees/tree1')) return ok({ truncated: true, tree: [] });
      throw new Error(`Unexpected URL: ${path}`);
    };
    expect(await repoTree(project, 'feature/x')).toMatchObject({
      ref: 'feature/x',
      truncated: true,
      entries: [],
    });
    expect(githubRest).not.toHaveBeenCalledWith(cfg, 'GET', '/repos/owner/repo');
  });

  it.each([403, 404, 422, 500])('maps default-branch metadata status %s', async (code) => {
    respond = (path) => {
      expect(path).toBe('/repos/owner/repo');
      return status(code);
    };
    await expect(repoTree(project)).rejects.toMatchObject({
      status: code === 422 ? 404 : code === 500 ? 502 : code,
    });
    expect(githubRest).toHaveBeenCalledTimes(1);
  });

  it('preserves a rate-limit error from default-branch resolution', async () => {
    const error = Object.assign(new Error('GitHub rate limit'), { status: 429, retryAfter: 60 });
    githubRest.mockRejectedValue(error);
    await expect(repoTree(project)).rejects.toBe(error);
    expect(githubRest).toHaveBeenCalledTimes(1);
  });

  it('reports a repository without a default branch', async () => {
    respond = () => ok({ default_branch: null });
    await expect(repoTree(project)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a ref that is not one, and maps GitHub’s refusals', async () => {
    for (const ref of ['../x', '/main', 'a b', 'main/'])
      await expect(repoTree(project, ref)).rejects.toMatchObject({ status: 400 });
    respond = () => status(422);
    await expect(repoTree(project, 'nope')).rejects.toMatchObject({ status: 404 });
    respond = () => status(500);
    await expect(repoTree(project, 'main')).rejects.toMatchObject({ status: 502 });
  });

  it('needs a GitHub token', async () => {
    cfg.githubToken = '';
    await expect(repoTree(project)).rejects.toMatchObject({ status: 503 });
  });
});

describe('Git refs on both routes', () => {
  it.each(['feature/test#1', 'feature/ñ', 'リリース/v1', 'release/v1!'])(
    'accepts and encodes %s',
    async (ref) => {
      respond = (path) => {
        if (path === `/repos/owner/repo/commits/${encodeURIComponent(ref)}`) return ok(commit);
        if (path === '/repos/owner/repo/git/trees/tree1?recursive=1') return ok({ tree: [] });
        if (path === `/repos/owner/repo/contents/a.js?ref=${encodeURIComponent(ref)}`)
          return ok({ type: 'file', size: 1, encoding: 'base64', content: base64('a') });
        throw new Error(`Unexpected URL: ${path}`);
      };
      expect(await repoTree(project, ref)).toMatchObject({ ref, sha: commit.sha });
      expect(await repoFile(project, ref, 'a.js')).toMatchObject({ ref, content: 'a' });
    },
  );

  it.each([
    '../x',
    '/main',
    'main/',
    'a//b',
    'a b',
    'a\u0000b',
    'a\u007fb',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    '@',
    'a@{b',
    'a/.b',
    'a/b.lock',
    'main.',
  ])('rejects invalid ref %j before contacting GitHub', async (ref) => {
    await expect(repoTree(project, ref)).rejects.toMatchObject({ status: 400 });
    await expect(repoFile(project, ref, 'a.js')).rejects.toMatchObject({ status: 400 });
    expect(githubRest).not.toHaveBeenCalled();
  });
});

describe('a repository’s file', () => {
  it('sends a text file’s content, at the ref asked for', async () => {
    respond = (path) => {
      expect(path).toBe('/repos/owner/repo/contents/src/a%20b.js?ref=c0ffee');
      return ok({
        type: 'file',
        size: 5,
        encoding: 'base64',
        content: base64('héllo'),
        html_url: 'https://x/a',
      });
    };
    expect(await repoFile(project, 'c0ffee', 'src/a b.js')).toEqual({
      path: 'src/a b.js',
      ref: 'c0ffee',
      size: 5,
      url: 'https://x/a',
      content: 'héllo',
      binary: false,
      tooLarge: false,
    });
  });

  it('sends only the size of a binary or too large file', async () => {
    respond = () =>
      ok({
        type: 'file',
        size: 4,
        encoding: 'base64',
        content: Buffer.from([0x89, 0, 1, 2]).toString('base64'),
      });
    expect(await repoFile(project, undefined, 'logo.png')).toMatchObject({
      content: null,
      binary: true,
      ref: '',
    });
    respond = () => ok({ type: 'file', size: MAX_FILE_BYTES + 1, encoding: 'none', content: '' });
    expect(await repoFile(project, 'main', 'big.sql')).toMatchObject({ content: null, tooLarge: true });
  });

  it('refuses a folder and a path that leaves the repository', async () => {
    respond = () => ok([{ path: 'src/a.js' }]);
    await expect(repoFile(project, 'main', 'src')).rejects.toMatchObject({ status: 400 });
    for (const path of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b'])
      await expect(repoFile(project, 'main', path)).rejects.toMatchObject({ status: 400 });
    respond = () => status(404);
    await expect(repoFile(project, 'main', 'gone.js')).rejects.toMatchObject({ status: 404 });
  });
});
