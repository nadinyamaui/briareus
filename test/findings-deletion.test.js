import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FIXES_ANCHOR } from '../lib/markers.js';
import { asGithubUser } from '../lib/github.js';
import {
  decideFinding,
  deleteFindingFromReview,
  findingKey,
  latestReviewFindings,
  postTriageNotes,
  replyOnFindingThread,
} from '../lib/findings.js';

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function github({ deleteStatus, readStatus = 200, patchStatus = 200, inlineComments = [inline] }) {
  const fetchMock = vi.fn(async (url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: deleteStatus });
    if (init.method === 'PATCH') return Response.json({}, { status: patchStatus });
    if (url.endsWith('/pulls/comments/101')) return Response.json(inline, { status: readStatus });
    if (url.includes('/pulls/5/comments?')) return Response.json(inlineComments);
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

it.each([403, 404, 500, 204])(
  'reports an unconfirmed triage-notes removal (%i) using the connected identity',
  async (status) => {
    const request = vi.fn(async (url, init) => {
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ id: 41, body: '<!-- reviewer:triage-notes sess-1 -->\nOld notes' }]);
      }
      if (init.method === 'DELETE') return new Response(null, { status });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const result = asGithubUser('personal-token', () => postTriageNotes(repo, 5, 'sess-1', [], {}));
    if (status === 204) await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow(`GitHub answered ${status} removing the triage notes comment`);
    expect(request.mock.calls.map(([url, init]) => [init.method, url, init.headers.Authorization])).toEqual([
      [
        'GET',
        `https://api.github.com/repos/${repo}/issues/5/comments?per_page=100&page=1`,
        'Bearer server-token',
      ],
      ['DELETE', `https://api.github.com/repos/${repo}/issues/comments/41`, 'Bearer personal-token'],
    ]);
  },
);

it.each([200, 500])(
  'rejects an owner quotation during publication capture and recovery (%i)',
  async (lookupStatus) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
    const since = '2026-09-08T09:00:00Z';
    let unavailable = lookupStatus !== 200;
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'alice' }, created_at: since }]);
      }
      if (url.includes('/pulls/5/comments?')) {
        if (unavailable) return new Response(null, { status: lookupStatus });
        return Response.json([
          {
            ...inline,
            line: 90,
            in_reply_to_id: 99,
            user: { login: 'alice' },
            body: `I disagree with "${finding.title}" from the other review.`,
            created_at: '2026-09-08T10:00:00Z',
          },
        ]);
      }
      if (init.method === 'PATCH' || init.method === 'POST') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, { since, authorLogin: 'alice' });
    const held = JSON.parse(JSON.stringify(published));
    expect(held).not.toHaveProperty('reviewCommentId');
    unavailable = false;
    await expect(replyOnFindingThread(repo, 5, held, 'Noted', { since })).rejects.toThrow(/no comment/);
    await expect(deleteFindingFromReview(repo, 5, held, { since })).resolves.toEqual({
      commentDeleted: false,
      undeclared: true,
      warning: null,
    });
    expect(request.mock.calls.some(([, init]) => ['POST', 'DELETE'].includes(init.method))).toBe(false);
  },
);

it.each([
  ...[
    `**Medium — follow-up: ${finding.title}**`,
    `## High — ${finding.title}`,
    `**Low — optional: ${finding.title}**`,
    `### Critical – ${finding.title}`,
    `Medium - ${finding.title}`,
  ].flatMap((heading) =>
    [
      [null, null, 200],
      [null, null, 500],
      ['lib/x.js', null, 200],
      ['lib/x.js', 12, 200],
    ].map((location) => [heading, ...location]),
  ),
])('recognizes heading %s at %s:%s with lookup %i', async (heading, file, line, lookupStatus) => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
  const since = '2026-09-08T09:00:00Z';
  const entry = { ...finding, file, line };
  let unavailable = lookupStatus !== 200;
  const request = vi.fn(async (url, init) => {
    if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
    if (url.includes('/issues/5/comments?'))
      return Response.json([
        {
          ...summary,
          body: `<!-- reviewer:findings ${JSON.stringify([entry])} -->`,
          user: { login: 'alice' },
          created_at: since,
        },
      ]);
    if (url.includes('/pulls/5/comments?')) {
      if (unavailable) return new Response(null, { status: lookupStatus });
      return Response.json([
        {
          ...inline,
          line: 90,
          in_reply_to_id: 99,
          user: { login: 'alice' },
          body: `${heading}\n\nStill needs fixing.`,
          created_at: '2026-09-08T10:00:00Z',
        },
      ]);
    }
    if (init.method === 'PATCH' || init.method === 'POST') return Response.json({});
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
  });
  vi.stubGlobal('fetch', request);

  const [published] = await latestReviewFindings(repo, 5, { since, authorLogin: 'alice' });
  const held = JSON.parse(JSON.stringify(published));
  if (lookupStatus === 200) expect(held.reviewCommentId).toBe(101);
  else expect(held).not.toHaveProperty('reviewCommentId');
  unavailable = false;
  await asGithubUser('personal-token', () => replyOnFindingThread(repo, 5, held, 'Noted', { since }));
  await expect(
    asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, held, { since })),
  ).resolves.toEqual({ commentDeleted: true, undeclared: true, warning: null });
  const writes = request.mock.calls.filter(([, init]) => ['POST', 'DELETE'].includes(init.method));
  expect(writes.map(([url]) => url)).toEqual([
    `https://api.github.com/repos/${repo}/pulls/5/comments/99/replies`,
    `https://api.github.com/repos/${repo}/pulls/comments/101`,
  ]);
  expect(writes.every(([, init]) => init.headers.Authorization === 'Bearer personal-token')).toBe(true);
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

it.each([403, 404, 500])(
  'fails summary-only withdrawal when the declaration rewrite is refused (%i)',
  async (patchStatus) => {
    const request = github({ patchStatus, inlineComments: [] });

    await expect(
      asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, finding)),
    ).rejects.toThrow(`GitHub answered ${patchStatus} rewriting the review's findings block`);

    expect(request.mock.calls.map(([, init]) => [init.method, init.headers.Authorization])).toEqual([
      ['GET', 'Bearer server-token'],
      ['GET', 'Bearer server-token'],
      ['PATCH', 'Bearer personal-token'],
    ]);
  },
);

it('withdraws a summary-only finding when the declaration rewrite succeeds', async () => {
  const request = github({ inlineComments: [] });

  await expect(
    asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, finding)),
  ).resolves.toEqual({ commentDeleted: false, undeclared: true, warning: null });

  const patch = request.mock.calls.find(([, init]) => init.method === 'PATCH');
  expect(patch[1].headers.Authorization).toBe('Bearer personal-token');
  expect(JSON.parse(patch[1].body).body).not.toContain(finding.title);
});

it.each([204, 404])(
  'keeps the rewrite warning after a successful or confirmed-absent inline deletion (%i)',
  async (deleteStatus) => {
    github({ deleteStatus, readStatus: 404, patchStatus: 403 });

    await expect(
      asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, finding)),
    ).resolves.toEqual({
      commentDeleted: true,
      undeclared: false,
      warning: "GitHub answered 403 rewriting the review's findings block",
    });
  },
);

it('does not bind or delete someone else’s title-quoting reply on an unrelated old thread', async () => {
  const since = '2026-09-08T09:00:00Z';
  const unrelated = {
    id: 101,
    in_reply_to_id: 99,
    path: 'lib/unrelated.js',
    line: finding.line,
    body: `Regarding "${finding.title}"`,
    user: { login: 'someone-else' },
    created_at: '2026-09-08T10:00:00Z',
  };
  const request = vi.fn(async (url, init) => {
    if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
    if (url.includes('/issues/5/comments?')) {
      return Response.json([
        { ...summary, user: { login: 'server-account' }, created_at: '2026-09-08T11:00:00Z' },
      ]);
    }
    if (url.includes('/pulls/5/comments?')) {
      return Response.json([
        { ...unrelated, id: 99, in_reply_to_id: undefined, created_at: '2026-09-01T10:00:00Z' },
        unrelated,
      ]);
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (init.method === 'PATCH' || init.method === 'POST') return Response.json({});
    throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
  });
  vi.stubGlobal('fetch', request);

  const [published] = await latestReviewFindings(repo, 5, { since, authorLogin: 'owner-account' });
  const options = { since, authorLogin: published.reviewAuthorLogin };
  const reply = replyOnFindingThread(repo, 5, published, 'Noted', options);
  await expect(reply).rejects.toThrow(/no comment/);
  expect((await deleteFindingFromReview(repo, 5, published, options)).commentDeleted).toBe(false);
  expect(published).not.toHaveProperty('reviewCommentId');
  expect(request.mock.calls.some(([, init]) => ['POST', 'DELETE'].includes(init.method))).toBe(false);
});

it.each(['Unrelated discussion', `Regarding "${finding.title}"`])(
  'does not target a later personal-account reply after a summary-only capture (%s)',
  async (body) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
    const since = '2026-09-08T09:00:00Z';
    const root = { ...inline, id: 99, created_at: '2026-09-01T10:00:00Z' };
    const comments = [root];
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'alice' }, created_at: '2026-09-08T11:00:00Z' }]);
      }
      if (url.includes('/pulls/5/comments?')) return Response.json(comments);
      if (init.method === 'POST' || init.method === 'PATCH') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, { since, authorLogin: 'alice' });
    const held = JSON.parse(JSON.stringify(published));
    comments.push({
      ...inline,
      in_reply_to_id: root.id,
      user: { login: 'alice' },
      created_at: '2026-09-08T12:00:00Z',
      body,
    });
    now.mockReturnValue(Date.parse('2026-09-08T12:05:00Z'));
    const options = { since, authorLogin: held.reviewAuthorLogin };
    await expect(
      asGithubUser('personal-token', () => replyOnFindingThread(repo, 5, held, 'Noted', options)),
    ).rejects.toThrow(/no comment/);
    await expect(
      asGithubUser('personal-token', () => deleteFindingFromReview(repo, 5, held, options)),
    ).resolves.toEqual({ commentDeleted: false, undeclared: true, warning: null });

    expect(request.mock.calls.some(([, init]) => ['POST', 'DELETE'].includes(init.method))).toBe(false);
    const patches = request.mock.calls.filter(([, init]) => init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0][1].headers.Authorization).toBe('Bearer personal-token');
    expect(JSON.parse(patches[0][1].body).body).not.toContain(finding.title);
  },
);

it.each([
  ['server-account', 'server-account', false],
  ['owner-account', 'server-account', false],
  ['owner-account', 'server-account', true],
  ['server-account', 'server-account', true],
  ['server-account', 'owner-account', true],
  ['owner-account', 'other-owner', true],
])(
  'retains the %s review comment with a %s summary (follow-up: %s)',
  async (login, summaryLogin, followUp) => {
    const since = '2026-09-08T09:00:00Z';
    const root = { ...inline, created_at: '2026-09-01T10:00:00Z' };
    const restatement = {
      ...root,
      id: 102,
      ...(followUp ? { in_reply_to_id: root.id } : {}),
      user: { login },
      created_at: '2026-09-08T10:00:00Z',
    };
    let comments = [
      root,
      { ...restatement, id: 103, in_reply_to_id: root.id, body: finding.title, user: { login: 'unrelated' } },
      restatement,
      { ...restatement, id: 104, created_at: '2026-09-08T12:00:00Z' },
    ];
    const request = vi.fn(async (url, init) => {
      if (url.includes('/issues/5/comments?')) {
        return Response.json([
          { ...summary, user: { login: summaryLogin }, created_at: '2026-09-08T11:00:00Z' },
        ]);
      }
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/pulls/5/comments?')) return Response.json(comments);
      if (init.method === 'POST') return Response.json({ html_url: 'https://gh/reply' });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (init.method === 'PATCH') return Response.json({});
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, { since, authorLogin: 'owner-account' });
    expect(published.reviewAuthorLogin).toBe(login);
    expect(published.reviewCommentId).toBe(102);
    // The held finding survives restart and another account change.
    const held = JSON.parse(JSON.stringify(published));
    const options = { since, authorLogin: held.reviewAuthorLogin };
    await asGithubUser('current-token', () => replyOnFindingThread(repo, 5, held, 'Noted', options));
    expect(request.mock.calls.find(([, init]) => init.method === 'POST')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/5/comments/${followUp ? 101 : 102}/replies`,
    );
    await expect(
      asGithubUser('current-token', () => deleteFindingFromReview(repo, 5, held, options)),
    ).resolves.toEqual({ commentDeleted: true, undeclared: true, warning: null });
    expect(request.mock.calls.find(([, init]) => init.method === 'DELETE')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/102`,
    );
    for (const [, init] of request.mock.calls) {
      expect(init.headers.Authorization).toBe(
        init.method === 'GET' ? 'Bearer server-token' : 'Bearer current-token',
      );
    }

    // A later reply quoting the title must not replace the deleted publication.
    comments = [root, { ...restatement, id: 104, user: { login: 'unrelated' } }];
    request.mockClear();
    await expect(replyOnFindingThread(repo, 5, held, 'Noted', options)).rejects.toThrow(/no comment/);
    expect((await deleteFindingFromReview(repo, 5, held, options)).commentDeleted).toBe(false);
    expect(request.mock.calls.some(([, init]) => ['POST', 'DELETE'].includes(init.method))).toBe(false);
  },
);

it.each(['location', 'earlier account'])(
  'binds the actual follow-up across a differing summary %s',
  async (scenario) => {
    const since = '2026-09-08T09:00:00Z';
    const login = scenario === 'location' ? 'server-account' : 'alice';
    const restatement = {
      ...inline,
      user: { login },
      in_reply_to_id: 99,
      created_at: '2026-09-08T10:00:00Z',
    };
    const unrelated = {
      ...restatement,
      id: 102,
      in_reply_to_id: 88,
      line: 71,
      user: { login: 'bob' },
      body: `Regarding "${finding.title}"`,
    };
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'bob' }, created_at: '2026-09-08T11:00:00Z' }]);
      }
      if (url.includes('/pulls/5/comments?')) return Response.json([unrelated, restatement]);
      if (init.method === 'POST' || init.method === 'PATCH') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, {
      since,
      authorLogin: 'bob',
      authorLogins: ['alice', 'bob'],
    });
    const held = JSON.parse(JSON.stringify(published));
    expect(held.reviewAuthorLogin).toBe(login);
    expect(held.reviewCommentId).toBe(101);
    await replyOnFindingThread(repo, 5, held, 'Noted', { since });
    await deleteFindingFromReview(repo, 5, held, { since });
    expect(request.mock.calls.find(([, init]) => init.method === 'POST')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/5/comments/99/replies`,
    );
    expect(request.mock.calls.find(([, init]) => init.method === 'DELETE')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/101`,
    );
  },
);

it.each([403, 500, 'network'])(
  'retains findings through an inline lookup failure (%s) and retries actions safely',
  async (failure) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
    const since = '2026-09-08T09:00:00Z';
    let unavailable = true;
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'bob' }, created_at: '2026-09-08T11:00:00Z' }]);
      }
      if (url.includes('/pulls/5/comments?')) {
        if (unavailable) {
          if (failure === 'network') throw new Error('Network unavailable');
          return new Response(null, { status: failure });
        }
        return Response.json([
          {
            ...inline,
            id: 102,
            in_reply_to_id: 88,
            user: { login: 'unrelated' },
            created_at: '2026-09-08T10:00:00Z',
          },
          {
            ...inline,
            id: 103,
            in_reply_to_id: 88,
            user: { login: 'alice' },
            created_at: '2026-09-08T12:00:00Z',
          },
          { ...inline, in_reply_to_id: 99, user: { login: 'alice' }, created_at: '2026-09-08T10:00:00Z' },
        ]);
      }
      if (init.method === 'POST' || init.method === 'PATCH') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const findings = await latestReviewFindings(repo, 5, {
      since,
      authorLogin: 'bob',
      authorLogins: ['alice', 'bob'],
    });
    expect(findings).toHaveLength(1);
    const held = JSON.parse(JSON.stringify(findings[0]));
    expect(held.title).toBe(finding.title);
    await expect(replyOnFindingThread(repo, 5, held, 'Noted', { since })).rejects.toThrow();
    await expect(deleteFindingFromReview(repo, 5, held, { since })).rejects.toThrow();
    expect(request.mock.calls.some(([, init]) => init.method !== 'GET')).toBe(false);

    unavailable = false;
    await replyOnFindingThread(repo, 5, held, 'Noted', { since });
    await deleteFindingFromReview(repo, 5, held, { since });
    expect(request.mock.calls.find(([, init]) => init.method === 'POST')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/5/comments/99/replies`,
    );
    expect(request.mock.calls.find(([, init]) => init.method === 'DELETE')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/101`,
    );
  },
);

it.each([200, 403, 500, 'network'])(
  'includes inline comments posted after the summary in the completed review (%s)',
  async (status) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
    const since = '2026-09-08T09:00:00Z';
    const publishedInline = {
      ...inline,
      in_reply_to_id: 99,
      user: { login: 'alice' },
      created_at: '2026-09-08T11:01:00Z',
    };
    let unavailable = status !== 200;
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'alice' }, created_at: '2026-09-08T11:00:00Z' }]);
      }
      if (url.includes('/pulls/5/comments?')) {
        if (unavailable) {
          if (status === 'network') throw new Error('Network unavailable');
          return new Response(null, { status });
        }
        return Response.json([
          { ...publishedInline, id: 102, user: { login: 'unrelated' } },
          { ...publishedInline, id: 103, path: 'lib/unrelated.js' },
          { ...publishedInline, id: 104, created_at: '2026-09-08T08:00:00Z' },
          { ...publishedInline, id: 105, created_at: '2026-09-08T12:00:00Z' },
          publishedInline,
        ]);
      }
      if (init.method === 'POST' || init.method === 'PATCH') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, { since });
    const held = JSON.parse(JSON.stringify(published));
    if (unavailable) {
      expect(held.reviewPublication.before).toBe(Date.parse('2026-09-08T11:05:00Z'));
    } else {
      expect(held.reviewCommentId).toBe(101);
    }
    now.mockReturnValue(Date.parse('2026-09-08T12:05:00Z'));
    unavailable = false;
    await replyOnFindingThread(repo, 5, held, 'Noted', { since });
    await expect(deleteFindingFromReview(repo, 5, held, { since })).resolves.toEqual({
      commentDeleted: true,
      undeclared: true,
      warning: null,
    });
    expect(request.mock.calls.find(([, init]) => init.method === 'POST')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/5/comments/99/replies`,
    );
    expect(request.mock.calls.find(([, init]) => init.method === 'DELETE')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/101`,
    );
  },
);

it.each([500, 429, 'network'])(
  'retries incomplete publication identity after a server lookup failure (%s)',
  async (failure) => {
    vi.resetModules();
    const { latestReviewFindings, replyOnFindingThread, deleteFindingFromReview } =
      await import('../lib/findings.js');
    const { asGithubUser } = await import('../lib/github.js');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
    const since = '2026-09-08T09:00:00Z';
    let unavailable = true;
    const publishedInline = {
      ...inline,
      in_reply_to_id: 99,
      user: { login: 'server-account' },
      created_at: '2026-09-08T10:00:00Z',
    };
    const request = vi.fn(async (url, init) => {
      if (url.endsWith('/user')) {
        if (unavailable) {
          if (failure === 'network') throw new Error('Network unavailable');
          return new Response(null, { status: failure, headers: { 'retry-after': '60' } });
        }
        return Response.json({ login: 'server-account' });
      }
      if (url.includes('/issues/5/comments?')) {
        return Response.json([{ ...summary, user: { login: 'bob' }, created_at: since }]);
      }
      if (url.includes('/pulls/5/comments?')) {
        return Response.json([
          { ...publishedInline, id: 102, user: { login: 'unrelated' } },
          { ...publishedInline, id: 103, path: 'lib/unrelated.js' },
          { ...publishedInline, id: 104, created_at: '2026-09-08T12:00:00Z' },
          publishedInline,
        ]);
      }
      if (init.method === 'POST' || init.method === 'PATCH') return Response.json({});
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected GitHub request: ${init.method} ${url}`);
    });
    vi.stubGlobal('fetch', request);

    const [published] = await latestReviewFindings(repo, 5, {
      since,
      authorLogin: 'bob',
      authorLogins: ['bob'],
    });
    const held = JSON.parse(JSON.stringify(published));
    expect(held.reviewPublication).toMatchObject({
      after: Date.parse(since),
      before: now(),
      resolveServerAuthor: true,
    });
    await expect(replyOnFindingThread(repo, 5, held, 'Noted', { since })).rejects.toThrow();
    await expect(deleteFindingFromReview(repo, 5, held, { since })).rejects.toThrow();
    expect(request.mock.calls.some(([, init]) => init.method !== 'GET')).toBe(false);

    unavailable = false;
    now.mockReturnValue(Date.parse('2026-09-08T12:05:00Z'));
    await asGithubUser('current-token', () => replyOnFindingThread(repo, 5, held, 'Noted', { since }));
    await expect(
      asGithubUser('current-token', () => deleteFindingFromReview(repo, 5, held, { since })),
    ).resolves.toEqual({ commentDeleted: true, undeclared: true, warning: null });
    expect(request.mock.calls.find(([, init]) => init.method === 'POST')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/5/comments/99/replies`,
    );
    expect(request.mock.calls.find(([, init]) => init.method === 'DELETE')[0]).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/101`,
    );
    for (const [, init] of request.mock.calls) {
      expect(init.headers.Authorization).toBe(
        init.method === 'GET' ? 'Bearer server-token' : 'Bearer current-token',
      );
    }
  },
);

it('keeps the server identity available when inline capture enters cooldown', async () => {
  vi.resetModules();
  const { latestReviewFindings } = await import('../lib/findings.js');
  const { viewerLogin } = await import('../lib/github.js');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T11:05:00Z'));
  const request = vi.fn(async (url) => {
    if (url.endsWith('/user')) return Response.json({ login: 'server-account' });
    if (url.includes('/issues/5/comments?')) return Response.json([summary]);
    if (url.includes('/pulls/5/comments?')) {
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  });
  vi.stubGlobal('fetch', request);

  const [held] = await latestReviewFindings(repo, 5, { since: '2026-09-08T09:00:00Z' });
  expect(held.reviewPublication.authors).toContain('server-account');
  expect(await viewerLogin({ githubToken: 'server-token' })).toBe('server-account');
  now.mockReturnValue(Date.parse('2026-09-08T12:05:00Z'));
  expect(await viewerLogin({ githubToken: 'server-token' })).toBe('server-account');
  expect(request.mock.calls.filter(([url]) => url.endsWith('/user'))).toHaveLength(1);
});
