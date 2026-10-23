import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FIXES_ANCHOR } from '../lib/markers.js';
import { asGithubUser } from '../lib/github.js';
import { decideFinding, deleteFindingFromReview, findingKey } from '../lib/findings.js';

const db = vi.hoisted(() => ({ decisions: new Map() }));
vi.mock('../lib/config.js', () => ({ getConfig: () => ({ githubToken: 'server-token' }) }));
vi.mock('../lib/db.js', () => ({
  loadFindingDecisions: vi.fn(async () => new Map(db.decisions)),
  saveFindingDecision: vi.fn(async (decision) => db.decisions.set(decision.key, decision)),
}));

const repo = 'acme/private';
const finding = { title: 'Guard the retry loop', file: 'lib/x.js', line: 12 };
const key = findingKey(finding.title);
const inline = { id: 101, path: finding.file, line: finding.line, body: finding.title };
const summary = { id: 7, body: `<!-- reviewer:findings ${JSON.stringify([finding])} -->` };
const checklist = { id: 77, body: `${FIXES_ANCHOR}\n- [ ] ${finding.title} <!-- fix:${key} -->` };

beforeEach(() => db.decisions.clear());
afterEach(() => vi.unstubAllGlobals());

function github({ deleteStatus, readStatus = 200 }) {
  const fetchMock = vi.fn(async (url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: deleteStatus });
    if (init.method === 'PATCH') return Response.json({});
    if (url.endsWith('/pulls/comments/101')) return Response.json(inline, { status: readStatus });
    if (url.includes('/pulls/5/comments?')) return Response.json([inline]);
    if (url.includes('/issues/5/comments?')) return Response.json([summary, checklist]);
    throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it.each([403, 404, 500])(
  'reports a refused checklist deletion (%i) under the connected identity',
  async (status) => {
    db.decisions.set(key, { decision: 'fix' });
    const request = github({ deleteStatus: status });

    await expect(
      asGithubUser('personal-token', () => decideFinding(repo, 5, key, 'optional')),
    ).rejects.toThrow(`GitHub answered ${status} deleting the Required fixes comment`);

    expect(db.decisions.get(key).decision).toBe('optional');
    const deletes = request.mock.calls.filter(([, init]) => init.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe(`https://api.github.com/repos/${repo}/issues/comments/77`);
    expect(deletes[0][1].headers.Authorization).toBe('Bearer personal-token');
    for (const [, init] of request.mock.calls.filter(([, init]) => init.method === 'GET')) {
      expect(init.headers.Authorization).toBe('Bearer server-token');
    }
  },
);

it('accepts a successful checklist deletion', async () => {
  github({ deleteStatus: 204 });
  await expect(
    asGithubUser('personal-token', () => decideFinding(repo, 5, key, 'dismissed')),
  ).resolves.toBeDefined();
});

it.each([200, 403, 500])(
  'retains the finding when a deletion 404 cannot be confirmed absent (read %i)',
  async (readStatus) => {
    const request = github({ deleteStatus: 404, readStatus });

    await expect(
      asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, finding)),
    ).rejects.toThrow(/deleting the finding's review comment/);

    const calls = request.mock.calls.map(([url, init]) => [init.method, url, init.headers.Authorization]);
    expect(calls).toEqual([
      [
        'GET',
        `https://api.github.com/repos/${repo}/pulls/5/comments?per_page=100&page=1`,
        'Bearer server-token',
      ],
      ['DELETE', `https://api.github.com/repos/${repo}/pulls/comments/101`, 'Bearer personal-token'],
      ['GET', `https://api.github.com/repos/${repo}/pulls/comments/101`, 'Bearer server-token'],
    ]);
  },
);

it.each([204, 404])(
  'removes the declaration after a successful or confirmed-absent deletion (%i)',
  async (deleteStatus) => {
    const request = github({ deleteStatus, readStatus: 404 });

    await expect(
      asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, finding)),
    ).resolves.toEqual({
      commentDeleted: true,
      undeclared: true,
      warning: null,
    });

    const reads = request.mock.calls.filter(([url]) => url.endsWith('/pulls/comments/101'));
    expect(reads.map(([, init]) => init.method)).toEqual(
      deleteStatus === 404 ? ['DELETE', 'GET'] : ['DELETE'],
    );
    const patch = request.mock.calls.find(([, init]) => init.method === 'PATCH');
    expect(patch[1].headers.Authorization).toBe('Bearer personal-token');
    expect(JSON.parse(patch[1].body).body).not.toContain(finding.title);
  },
);
