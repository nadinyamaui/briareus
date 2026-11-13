import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMPARE_FILES, carryoverFor, changeDigest, sameChange } from '../lib/review-carryover.js';

const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const mergeBase = 'c'.repeat(40);
const modified = (patch, over = {}) => ({
  filename: 'lib/cart.js',
  status: 'modified',
  sha: 'blob1',
  patch,
  ...over,
});

describe('changeDigest', () => {
  const patch = '@@ -10,3 +10,4 @@ function total() {\n a\n+b\n c\n@@ -50 +51 @@\n-x\n+y';

  it('is the same change wherever the hunks landed, and in whatever order files are listed', () => {
    const moved = '@@ -110,3 +112,4 @@ function sum() {\n a\n+b\n c\n@@ -150 +153 @@\n-x\n+y';
    const other = { filename: 'README.md', status: 'added', sha: 'blob2', patch: '@@ -0,0 +1 @@\n+hi' };
    expect(changeDigest([modified(patch), other])).toBe(
      changeDigest([other, modified(moved, { sha: 'blob9' })]),
    );
  });

  it('differs for another line, another context, another file name or status', () => {
    const digest = changeDigest([modified(patch)]);
    expect(changeDigest([modified(patch.replace('+b', '+B'))])).not.toBe(digest);
    expect(changeDigest([modified(patch.replace(' c', ' C'))])).not.toBe(digest);
    expect(changeDigest([modified(patch, { filename: 'lib/carts.js' })])).not.toBe(digest);
    expect(changeDigest([modified(patch, { status: 'added' })])).not.toBe(digest);
    expect(changeDigest([modified(patch), modified(patch, { filename: 'b.js' })])).not.toBe(digest);
  });

  it('compares a file without a patch by the blob it leaves', () => {
    const binary = { filename: 'logo.png', status: 'modified', sha: 'blob1' };
    expect(changeDigest([binary])).toBe(changeDigest([{ ...binary }]));
    expect(changeDigest([binary])).not.toBe(changeDigest([{ ...binary, sha: 'blob2' }]));
    expect(changeDigest([{ filename: 'logo.png', status: 'modified' }])).toBeNull();
  });

  it('is unknown for a list GitHub may have cut short, or one it did not give', () => {
    const many = Array.from({ length: MAX_COMPARE_FILES }, (_, i) =>
      modified(patch, { filename: `f${i}.js` }),
    );
    expect(changeDigest(many)).toBeNull();
    expect(changeDigest(many.slice(1))).toEqual(expect.any(String));
    expect(changeDigest(undefined)).toBeNull();
    expect(changeDigest([{ status: 'modified', patch }])).toBeNull();
  });
});

describe('sameChange', () => {
  let compares;
  beforeEach(() => {
    compares = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const key = decodeURIComponent(/\/compare\/(.+)$/.exec(url)[1]);
        return key in compares
          ? new Response(JSON.stringify({ files: compares[key] }), { status: 200 })
          : new Response('{}', { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const cfg = { githubToken: 'tok' };
  const ask = (baseRef = 'feature/base') =>
    sameChange(cfg, 'acme/shop', { headSha: head, mergeBaseSha: mergeBase }, { headSha: next, baseRef });

  it('answers the shared digest when both revisions make the same change', async () => {
    compares[`${mergeBase}...${head}`] = [modified('@@ -1 +1 @@\n-a\n+b')];
    compares[`feature/base...${next}`] = [modified('@@ -9 +9 @@\n-a\n+b')];
    expect(await ask()).toBe(changeDigest([modified('@@ -1 +1 @@\n-a\n+b')]));
    // The branch's slash stays a slash in the path.
    expect(fetch.mock.calls[1][0]).toContain(`/compare/feature/base...${next}`);
  });

  it('answers null when they differ, and throws when GitHub cannot say', async () => {
    compares[`${mergeBase}...${head}`] = [modified('@@ -1 +1 @@\n-a\n+b')];
    compares[`feature/base...${next}`] = [modified('@@ -1 +1 @@\n-a\n+c')];
    expect(await ask()).toBeNull();
    await expect(ask('main')).rejects.toThrow('GitHub answered 404');
  });
});

describe('carryoverFor', () => {
  const review = { id: 5, headSha: head, baseRef: 'main' };
  const row = {
    codeReviewId: 5,
    reviewedSha: head,
    reviewedBaseRef: 'main',
    headSha: next,
    baseRef: 'trunk',
  };

  it('finds only the carry-over of this review, from what it read, to exactly this revision', () => {
    expect(carryoverFor([row], review, { headSha: next, baseRef: 'trunk' })).toBe(row);
    expect(carryoverFor([row], review, { headSha: next, baseRef: 'main' })).toBeNull();
    expect(carryoverFor([row], review, { headSha: head, baseRef: 'trunk' })).toBeNull();
    expect(carryoverFor([row], { ...review, id: 6 }, { headSha: next, baseRef: 'trunk' })).toBeNull();
    expect(
      carryoverFor([row], { ...review, baseRef: 'release' }, { headSha: next, baseRef: 'trunk' }),
    ).toBeNull();
    expect(carryoverFor([row], review, { headSha: next, baseRef: null })).toBeNull();
    expect(carryoverFor(undefined, review, { headSha: next, baseRef: 'trunk' })).toBeNull();
  });
});
