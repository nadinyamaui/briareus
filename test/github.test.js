import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// github.js keeps the rate-limit buckets and the branch cache at module level,
// so every test imports a fresh copy rather than inheriting the last one's
// cooldown. execFile is mocked for the ls-remote fallback; fetch is stubbed per
// test.
const execState = vi.hoisted(() => ({ impl: null, calls: [] }));

vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    execState.calls.push({ cmd, args, opts });
    execState.impl(cb);
  },
}));

const cfg = { githubToken: 'tok' };

// A fetch stub returning one canned Response per call, in order.
function stubFetch(...responses) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch to ${url}`);
    return next;
  });
  fn.calls = calls;
  vi.stubGlobal('fetch', fn);
  return fn;
}

function reply({ status = 200, headers = {}, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

async function freshGithub() {
  vi.resetModules();
  return import('../lib/github.js');
}

beforeEach(() => {
  execState.impl = (cb) => cb(null, '');
  execState.calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('githubRest', () => {
  it('sends the token and the API headers', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(reply());

    await githubRest(cfg, 'GET', '/repos/a/b');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/a/b');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['User-Agent']).toBe('claude-pr-reviewer');
  });

  it('sends no body when there is none', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(reply());

    await githubRest(cfg, 'GET', '/repos/a/b');

    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('serializes a body when there is one', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(reply());

    await githubRest(cfg, 'POST', '/repos/a/b/issues', { title: 'hi' });

    expect(fetchMock.mock.calls[0][1].body).toBe('{"title":"hi"}');
  });

  it('hands a non-ok response back to the caller rather than throwing', async () => {
    // A 404 is the caller's business; only rate limits are handled here.
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 404 }));

    const res = await githubRest(cfg, 'GET', '/repos/a/b');

    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('lets a plain 403 through: a missing scope is not a rate limit', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 403 }));

    const res = await githubRest(cfg, 'GET', '/repos/a/b');

    expect(res.status).toBe(403);
  });

  it('throws a rate-limit error on a 403 carrying Retry-After', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 403, headers: { 'retry-after': '60' } }));

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
    });
  });

  // The message used to spell the deadline with toLocaleTimeString(), a bare
  // wall-clock time with no date and no timezone, unreadable next to a UTC
  // log or from a session in another timezone. It must be an absolute,
  // self-describing instant instead.
  it('spells the backoff deadline as an ISO 8601 UTC instant, not a locale wall-clock time', async () => {
    const { githubRest } = await freshGithub();
    const retryAfterSeconds = 60;
    stubFetch(reply({ status: 403, headers: { 'retry-after': String(retryAfterSeconds) } }));
    const before = Date.now();

    let caught;
    try {
      await githubRest(cfg, 'GET', '/repos/a/b');
    } catch (e) {
      caught = e;
    }

    expect(caught.message).toMatch(/backing off until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(caught.resource).toBe('core');
    const spelled = new Date(caught.message.split('backing off until ')[1]).getTime();
    expect(spelled).toBeGreaterThanOrEqual(before + retryAfterSeconds * 1000);
  });

  it('throws on a 429 with an exhausted primary budget', async () => {
    const { githubRest } = await freshGithub();
    const resetAt = Math.floor(Date.now() / 1000) + 600;
    // The first call records the reset time; the second is the exhausted one.
    stubFetch(
      reply({
        headers: {
          'x-ratelimit-remaining': '1',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': String(resetAt),
        },
      }),
      reply({ status: 429, headers: { 'x-ratelimit-remaining': '0' } }),
    );

    await githubRest(cfg, 'GET', '/repos/a/b');

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toMatchObject({ rateLimited: true });
  });

  it('does not treat an exhausted budget as a limit when no reset time is known', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }));

    const res = await githubRest(cfg, 'GET', '/repos/a/b');

    expect(res.status).toBe(403);
  });

  it('refuses the next call while the cooldown is running, without reaching the network', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(reply({ status: 429, headers: { 'retry-after': '60' } }));

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toThrow(/rate limit/);
    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toThrow(/rate limit/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets calls through again once the cooldown has passed', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 429, headers: { 'retry-after': '1' } }), reply());

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toThrow(/rate limit/);
    // The cooldown is the reset plus a 5s margin, so the clock has to move past both.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).resolves.toMatchObject({ ok: true });
  });

  it('keeps the core and graphql budgets apart', async () => {
    // A core cooldown must not stop a GraphQL call: the budgets are separate.
    const { githubRest, githubGraphql } = await freshGithub();
    stubFetch(
      reply({ status: 429, headers: { 'retry-after': '60' } }),
      reply({ body: { data: { ok: true } } }),
    );

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toThrow(/rate limit/);

    await expect(githubGraphql(cfg, 'query {}', {})).resolves.toEqual({ ok: true });
  });

  it('believes the resource the response names over the one assumed', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ headers: { 'x-ratelimit-resource': 'graphql', 'retry-after': '60' }, status: 403 }));

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).rejects.toMatchObject({ rateLimited: true });
  });

  it('ignores rate headers that are not numbers', async () => {
    // A proxy in front of the API can rewrite these; garbage must leave the
    // bucket as it was rather than poisoning it with NaN.
    const { githubRest } = await freshGithub();
    stubFetch(
      reply({
        headers: { 'x-ratelimit-remaining': 'n/a', 'x-ratelimit-limit': 'n/a', 'x-ratelimit-reset': 'n/a' },
      }),
      reply({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );

    await githubRest(cfg, 'GET', '/repos/a/b');

    // No reset was ever recorded, so the exhausted budget is not actionable.
    await expect(githubRest(cfg, 'GET', '/repos/a/b')).resolves.toMatchObject({ status: 403 });
  });

  it('ignores a zero limit and a zero reset', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(
      reply({ headers: { 'x-ratelimit-limit': '0', 'x-ratelimit-reset': '0' } }),
      reply({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );

    await githubRest(cfg, 'GET', '/repos/a/b');

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).resolves.toMatchObject({ status: 403 });
  });

  it('ignores a non-positive Retry-After', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ status: 429, headers: { 'retry-after': '0' } }));

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).resolves.toMatchObject({ status: 429 });
  });

  it('ignores a resource header naming a bucket it does not keep', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(reply({ headers: { 'x-ratelimit-resource': 'search' } }));

    await expect(githubRest(cfg, 'GET', '/repos/a/b')).resolves.toMatchObject({ ok: true });
  });
});

describe('githubGraphql', () => {
  it('posts the query and variables and unwraps data', async () => {
    const { githubGraphql } = await freshGithub();
    const fetchMock = stubFetch(reply({ body: { data: { repository: { id: 1 } } } }));

    const data = await githubGraphql(cfg, 'query($n:String!){}', { n: 'x' });

    expect(data).toEqual({ repository: { id: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    expect(JSON.parse(init.body)).toEqual({ query: 'query($n:String!){}', variables: { n: 'x' } });
  });

  it('throws on a non-ok response', async () => {
    const { githubGraphql } = await freshGithub();
    stubFetch(reply({ status: 502 }));

    await expect(githubGraphql(cfg, 'q', {})).rejects.toThrow(/GraphQL answered 502/);
  });

  it('throws with every error message a 200 carried', async () => {
    // GraphQL reports failures inside a 200, so an ok response can still be one.
    const { githubGraphql } = await freshGithub();
    stubFetch(reply({ body: { errors: [{ message: 'first' }, { message: 'second' }] } }));

    await expect(githubGraphql(cfg, 'q', {})).rejects.toThrow('first; second');
  });

  it('passes an empty errors array through as success', async () => {
    const { githubGraphql } = await freshGithub();
    stubFetch(reply({ body: { data: { ok: 1 }, errors: [] } }));

    await expect(githubGraphql(cfg, 'q', {})).resolves.toEqual({ ok: 1 });
  });
});

describe('upsertPrComment', () => {
  it('posts a new comment when no anchor is given', async () => {
    const { upsertPrComment } = await freshGithub();
    const fetchMock = stubFetch(reply({ body: { id: 5 } }));

    await upsertPrComment(cfg, 'o/r', 3, null, 'hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/issues/3/comments');
    expect(init.method).toBe('POST');
  });

  it('posts a new comment when the anchor is nowhere on the PR', async () => {
    const { upsertPrComment } = await freshGithub();
    const fetchMock = stubFetch(reply({ body: [{ id: 1, body: 'unrelated' }] }), reply({ body: { id: 5 } }));

    await upsertPrComment(cfg, 'o/r', 3, '<!-- anchor -->', 'hello');

    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });

  it('edits the existing comment when the anchor is already there', async () => {
    // The app reviews every push; one live comment beats one comment per push.
    const { upsertPrComment } = await freshGithub();
    const fetchMock = stubFetch(
      reply({ body: [{ id: 11, body: 'old <!-- anchor -->' }] }),
      reply({ body: { id: 11 } }),
    );

    await upsertPrComment(cfg, 'o/r', 3, '<!-- anchor -->', 'new');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.github.com/repos/o/r/issues/comments/11');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ body: 'new' });
  });

  it('edits the last anchored comment when the anchor appears more than once', async () => {
    const { upsertPrComment } = await freshGithub();
    const fetchMock = stubFetch(
      reply({
        body: [
          { id: 11, body: 'a <!-- anchor -->' },
          { id: 12, body: 'b <!-- anchor -->' },
        ],
      }),
      reply({ body: { id: 12 } }),
    );

    await upsertPrComment(cfg, 'o/r', 3, '<!-- anchor -->', 'new');

    expect(fetchMock.mock.calls[1][0]).toContain('/comments/12');
  });

  it('skips a comment with no body when looking for the anchor', async () => {
    const { upsertPrComment } = await freshGithub();
    const fetchMock = stubFetch(
      // The search runs newest-first, so the body-less comment is the one
      // examined before the anchored one is reached.
      reply({
        body: [
          { id: 1, body: '<!-- anchor -->' },
          { id: 2, body: null },
        ],
      }),
      reply({ body: { id: 1 } }),
    );

    await upsertPrComment(cfg, 'o/r', 3, '<!-- anchor -->', 'new');

    expect(fetchMock.mock.calls[1][0]).toContain('/comments/1');
  });

  it('pages through the conversation and stops at three pages', async () => {
    const { upsertPrComment } = await freshGithub();
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' }));
    const fetchMock = stubFetch(
      reply({ body: full }),
      reply({ body: full }),
      reply({ body: full }),
      reply({ body: { id: 5 } }),
    );

    await upsertPrComment(cfg, 'o/r', 3, '<!-- anchor -->', 'hello');

    expect(fetchMock.mock.calls[2][0]).toContain('page=3');
    expect(fetchMock.mock.calls[3][1].method).toBe('POST');
  });

  it('throws when the conversation cannot be listed', async () => {
    const { upsertPrComment } = await freshGithub();
    stubFetch(reply({ status: 404 }));

    await expect(upsertPrComment(cfg, 'o/r', 3, '<!-- a -->', 'x')).rejects.toThrow(
      /answered 404 listing o\/r#3 comments/,
    );
  });

  it('throws when the comment cannot be written', async () => {
    const { upsertPrComment } = await freshGithub();
    stubFetch(reply({ status: 422 }));

    await expect(upsertPrComment(cfg, 'o/r', 3, null, 'x')).rejects.toThrow(
      /answered 422 commenting on o\/r#3/,
    );
  });
});

describe('listRepoBranches', () => {
  // The branch cache is keyed by repo, so every test uses its own name.
  let n = 0;
  const repo = () => `o/r${++n}`;

  it('puts the default branch first and sorts the rest', async () => {
    const { listRepoBranches } = await freshGithub();
    stubFetch(
      reply({ body: { default_branch: 'main' } }),
      reply({ body: [{ name: 'zeta' }, { name: 'main' }, { name: 'alpha' }] }),
    );

    const result = await listRepoBranches(cfg, repo());

    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'alpha', 'zeta'] });
  });

  it('sorts alone when the repo has no default branch', async () => {
    const { listRepoBranches } = await freshGithub();
    stubFetch(reply({ body: {} }), reply({ body: [{ name: 'b' }, { name: 'a' }] }));

    const result = await listRepoBranches(cfg, repo());

    expect(result).toEqual({ defaultBranch: null, branches: ['a', 'b'] });
  });

  it('answers a second call for the same repo from cache', async () => {
    const { listRepoBranches } = await freshGithub();
    const fetchMock = stubFetch(
      reply({ body: { default_branch: 'main' } }),
      reply({ body: [{ name: 'main' }] }),
    );
    const name = repo();

    await listRepoBranches(cfg, name);
    await listRepoBranches(cfg, name);

    expect(fetchMock).toHaveBeenCalledTimes(2); // the second call added none
  });

  it('goes back to the network once the cache entry has aged out', async () => {
    const { listRepoBranches } = await freshGithub();
    stubFetch(
      reply({ body: { default_branch: 'main' } }),
      reply({ body: [{ name: 'main' }] }),
      reply({ body: { default_branch: 'main' } }),
      reply({ body: [{ name: 'main' }, { name: 'next' }] }),
    );
    const name = repo();

    await listRepoBranches(cfg, name);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);

    await expect(listRepoBranches(cfg, name)).resolves.toMatchObject({ branches: ['main', 'next'] });
  });

  it('pages through branches and stops at five pages', async () => {
    const { listRepoBranches } = await freshGithub();
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `b${String(i).padStart(3, '0')}` }));
    const fetchMock = stubFetch(
      reply({ body: { default_branch: 'main' } }),
      ...Array.from({ length: 5 }, () => reply({ body: full })),
    );

    const result = await listRepoBranches(cfg, repo());

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.branches).toHaveLength(501); // 500 + the default branch in front
  });

  it('falls back to ls-remote when the API refuses', async () => {
    // A missing scope or a rate limit must not kill the branch picker.
    const { listRepoBranches } = await freshGithub();
    stubFetch(reply({ status: 403 }));
    execState.impl = (cb) =>
      cb(null, 'ref: refs/heads/main\tHEAD\nsha1\trefs/heads/main\nsha2\trefs/heads/feature\n');

    const result = await listRepoBranches(cfg, repo());

    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'feature'] });
  });

  it('falls back to ls-remote when the branch listing refuses', async () => {
    const { listRepoBranches } = await freshGithub();
    stubFetch(reply({ body: { default_branch: 'main' } }), reply({ status: 403 }));
    execState.impl = (cb) => cb(null, 'sha1\trefs/heads/only\n');

    const result = await listRepoBranches(cfg, repo());

    expect(result).toEqual({ defaultBranch: null, branches: ['only'] });
  });

  it('uses ls-remote directly when there is no token', async () => {
    const { listRepoBranches } = await freshGithub();
    const fetchMock = stubFetch();
    execState.impl = (cb) => cb(null, 'sha1\trefs/heads/main\n');

    await listRepoBranches({ githubToken: '' }, repo());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execState.calls[0].cmd).toBe('git');
  });

  it('tells git not to prompt for credentials it cannot answer', async () => {
    const { listRepoBranches } = await freshGithub();
    execState.impl = (cb) => cb(null, '');

    await listRepoBranches({ githubToken: '' }, repo());

    expect(execState.calls[0].opts.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('reports a repo git cannot reach', async () => {
    const { listRepoBranches } = await freshGithub();
    execState.impl = (cb) => cb(new Error('not found'), '');
    const name = repo();

    await expect(listRepoBranches({ githubToken: '' }, name)).rejects.toThrow(
      `Could not list branches for ${name}: not found`,
    );
  });
});
