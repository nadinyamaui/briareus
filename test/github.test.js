import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// github.js keeps the rate-limit buckets and branch cache at module level, so every test
// imports a fresh copy. execFile is mocked for ls-remote; fetch is stubbed per test.
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

  // The deadline was once a locale wall-clock time with no date or zone, unreadable beside a
  // UTC log or from another timezone.
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

  it.each(['RATE_LIMIT', 'RATE_LIMITED', undefined])(
    'backs off a GraphQL 200 with error type %s until reset',
    async (type) => {
      const { githubGraphql } = await freshGithub();
      const reset = Math.floor(Date.now() / 1000) + 600;
      const fetchMock = stubFetch(
        reply({
          headers: {
            'x-ratelimit-resource': 'graphql',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(reset),
          },
          body: { data: null, errors: [{ type, message: 'API rate limit exceeded' }] },
        }),
      );

      const caught = await githubGraphql(cfg, 'query {}', {}).catch((e) => e);
      expect(caught).toMatchObject({ rateLimited: true, status: 429, resource: 'graphql' });
      expect(caught.retryAt).toBe(reset * 1000 + 5000);
      // And the next call waits out the cooldown without reaching the network.
      await expect(githubGraphql(cfg, 'query {}', {})).rejects.toMatchObject({ rateLimited: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

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

describe('conditional requests', () => {
  const tagged = (body, etag = '"v1"') => reply({ headers: { etag }, body });
  const on = { conditional: true };

  it('sends the ETag back on the next GET of the same URL and answers a 304 from the cache', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(tagged({ n: 1 }), reply({ status: 304 }));

    const first = await githubRest(cfg, 'GET', '/repos/a/b/pulls/1', undefined, on);
    expect(first.notModified).toBe(false);
    expect(await first.json()).toEqual({ n: 1 });

    const second = await githubRest(cfg, 'GET', '/repos/a/b/pulls/1', undefined, on);
    expect(fetchMock.mock.calls[0][1].headers['If-None-Match']).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('"v1"');
    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    expect(second.notModified).toBe(true);
    expect(second.etag).toBe('"v1"');
    expect(await second.json()).toEqual({ n: 1 });
  });

  it('replaces the cached body when GitHub answers 200 with a new tag', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(tagged({ n: 1 }), tagged({ n: 2 }, '"v2"'), reply({ status: 304 }));

    await githubRest(cfg, 'GET', '/repos/a/b', undefined, on);
    const changed = await githubRest(cfg, 'GET', '/repos/a/b', undefined, on);
    expect(changed.notModified).toBe(false);
    expect(changed.etag).toBe('"v2"');
    expect(await changed.json()).toEqual({ n: 2 });
    expect(await (await githubRest(cfg, 'GET', '/repos/a/b', undefined, on)).json()).toEqual({ n: 2 });
  });

  it('caches nothing for an answer without an ETag, a non-ok answer, or a write', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(
      reply({ body: { a: 1 } }),
      reply({ body: { a: 2 } }),
      reply({ status: 404 }),
      reply(),
      tagged({}),
      reply(),
    );

    await githubRest(cfg, 'GET', '/repos/a/b', undefined, on);
    await githubRest(cfg, 'GET', '/repos/a/b', undefined, on);
    await githubRest(cfg, 'GET', '/repos/a/missing', undefined, on);
    await githubRest(cfg, 'GET', '/repos/a/missing', undefined, on);
    await githubRest(cfg, 'POST', '/repos/a/b/issues', { title: 'x' }, on);
    await githubRest(cfg, 'POST', '/repos/a/b/issues', { title: 'x' }, on);
    for (const [, init] of fetchMock.mock.calls) expect(init.headers['If-None-Match']).toBeUndefined();
  });

  it("keeps one token's tags away from another", async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(tagged({ n: 1 }), tagged({ n: 1 }));

    await githubRest(cfg, 'GET', '/repos/a/b', undefined, on);
    await githubRest({ githubToken: 'other' }, 'GET', '/repos/a/b', undefined, on);
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBeUndefined();
  });

  it('holds nothing for a GET that did not ask for it', async () => {
    const { githubRest } = await freshGithub();
    const fetchMock = stubFetch(tagged({ n: 1 }), tagged({ n: 1 }));

    const first = await githubRest(cfg, 'GET', '/user');
    expect(first.notModified).toBeUndefined();
    expect(await first.json()).toEqual({ n: 1 });
    await githubRest(cfg, 'GET', '/user');
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBeUndefined();
  });

  it('hands every caller a copy of its own, so one editing the answer cannot corrupt the next', async () => {
    const { githubRest } = await freshGithub();
    stubFetch(tagged({ list: [1, 2] }), reply({ status: 304 }), reply({ status: 304 }));

    (await (await githubRest(cfg, 'GET', '/repos/a/b', undefined, on)).json()).list.push(3);
    const second = await (await githubRest(cfg, 'GET', '/repos/a/b', undefined, on)).json();
    expect(second).toEqual({ list: [1, 2] });
    second.list.length = 0;
    expect(await (await githubRest(cfg, 'GET', '/repos/a/b', undefined, on)).json()).toEqual({
      list: [1, 2],
    });
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

  it('preserves partial PR data and issue permission errors on the final GraphQL point', async () => {
    const { githubGraphql } = await freshGithub();
    const data = { repository: { pullRequests: { nodes: [{ number: 1 }] }, issues: null } };
    const errors = [
      { type: 'FORBIDDEN', message: 'Issues permission missing', path: ['repository', 'issues'] },
    ];
    const fetchMock = stubFetch(
      reply({
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        },
        body: { data, errors },
      }),
    );
    const caught = await githubGraphql(cfg, 'query {}', {}).catch((e) => e);
    expect(caught).toMatchObject({ data, errors });
    await expect(githubGraphql(cfg, 'query {}', {})).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('removePullRequestLabel', () => {
  it('removes one encoded label without replacing the pull request labels', async () => {
    const { removePullRequestLabel } = await freshGithub();
    const fetchMock = stubFetch(reply({ body: [{ name: 'code-approved' }] }));

    await removePullRequestLabel(cfg, 'o/r', 3, 'feedback given');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/issues/3/labels/feedback%20given');
    expect(init.method).toBe('DELETE');
  });

  it('accepts an already-absent label', async () => {
    const { removePullRequestLabel } = await freshGithub();
    stubFetch(reply({ status: 404 }));

    await expect(removePullRequestLabel(cfg, 'o/r', 3, 'feedback-given')).resolves.toEqual([]);
  });

  it('reports a label removal GitHub refuses', async () => {
    const { removePullRequestLabel } = await freshGithub();
    stubFetch(reply({ status: 500 }));

    await expect(removePullRequestLabel(cfg, 'o/r', 3, 'feedback-given')).rejects.toThrow(
      /answered 500 removing feedback-given from o\/r#3/,
    );
  });
});

describe('accepted label writes with unreadable bodies', () => {
  it('removePullRequestLabel accepts truncated HTTP-200 JSON', async () => {
    const { removePullRequestLabel } = await freshGithub();
    stubFetch(new Response('[{"name":', { status: 200 }));
    await expect(removePullRequestLabel(cfg, 'o/r', 3, 'code-approved')).resolves.toEqual([]);
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

describe('background GitHub budgets', () => {
  it.each(['core', 'graphql'])(
    'reserves %s headroom without blocking foreground reads and resumes after reset',
    async (resource) => {
      vi.useFakeTimers();
      vi.setSystemTime(1800000000000);
      const gh = await freshGithub();
      const reserve = resource === 'core' ? 1000 : 500;
      const request = () =>
        resource === 'core'
          ? gh.githubRest(cfg, 'GET', '/repos/acme/shop', undefined, { reserve })
          : gh.githubGraphql(cfg, 'query {}', {}, { reserve });
      const fetch = stubFetch(
        reply({
          headers: {
            'x-ratelimit-resource': resource,
            'x-ratelimit-remaining': String(reserve),
            'x-ratelimit-reset': '1800000600',
          },
          body: { data: {} },
        }),
        reply({ body: { data: {} } }),
        reply({ body: { data: {} } }),
      );
      await request();
      await expect(request()).rejects.toMatchObject({ status: 429, resource, retryAt: 1800000605000 });
      expect(() => gh.checkGithubSyncBudget()).toThrow(/reserved/);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (resource === 'core') await gh.githubRest(cfg, 'GET', '/repos/acme/shop');
      else await gh.githubGraphql(cfg, 'query {}', {});
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(605000);
      await request();
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it('does not turn absent headers into an exhausted background allowance', async () => {
    const gh = await freshGithub();
    stubFetch(
      reply({
        headers: {
          'x-ratelimit-remaining': '2000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        },
      }),
      reply(),
    );
    await gh.githubRest(cfg, 'GET', '/a');
    await gh.githubRest(cfg, 'GET', '/b');
    expect(() => gh.checkGithubSyncBudget()).not.toThrow();
  });
});

describe('acting as a user', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes changes with the user’s token and reads with the server’s', async () => {
    const gh = await freshGithub();
    const fetch = stubFetch(reply(), reply(), reply({ body: { data: {} } }), reply({ body: { data: {} } }));
    await gh.asGithubUser('user-tok', async () => {
      await gh.githubRest(cfg, 'GET', '/repos/o/r');
      await gh.githubRest(cfg, 'POST', '/repos/o/r/issues/1/comments', { body: 'hi' });
      await gh.githubGraphql(cfg, 'query { viewer { login } }');
      await gh.githubGraphql(cfg, ' mutation { addStar(input: {}) { clientMutationId } }');
    });
    expect(fetch.calls.map((c) => c.init.headers.Authorization)).toEqual([
      'Bearer tok',
      'Bearer user-tok',
      'Bearer tok',
      'Bearer user-tok',
    ]);
  });

  it('runs as the server without a user token, and outside the call', async () => {
    const gh = await freshGithub();
    const fetch = stubFetch(reply(), reply());
    await gh.asGithubUser(null, () => gh.githubRest(cfg, 'POST', '/x'));
    await gh.githubRest(cfg, 'POST', '/y');
    expect(fetch.calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer tok', 'Bearer tok']);
  });

  it('leaves the server’s rate limit alone when a user’s token is limited', async () => {
    const gh = await freshGithub();
    stubFetch(reply({ status: 429, headers: { 'retry-after': '60' } }), reply());
    const answer = await gh.asGithubUser('user-tok', () => gh.githubRest(cfg, 'POST', '/x'));
    expect(answer.status).toBe(429);
    expect((await gh.githubRest(cfg, 'GET', '/y')).status).toBe(200);
  });

  it.each([
    [429, { 'retry-after': '60' }, {}],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000600' }, {}],
    [200, { 'x-ratelimit-reset': '1800000600' }, { errors: [{ type: 'RATE_LIMITED' }] }],
    [200, {}, { errors: [{ type: 'RATE_LIMITED' }] }],
    [200, { 'x-ratelimit-reset': '1800000600' }, { errors: [{ type: 'RATE_LIMIT' }] }],
    [200, {}, { errors: [{ type: 'RATE_LIMIT' }] }],
  ])(
    'preserves a personal GraphQL limit (%s, %j) without cooling down the server',
    async (status, headers, body) => {
      const gh = await freshGithub();
      vi.useFakeTimers();
      vi.setSystemTime(1800000000000);
      const fetch = stubFetch(reply({ status, headers, body }), reply({ body: { data: { ok: true } } }));
      await expect(
        gh.asGithubUser('user-tok', () => gh.githubGraphql(cfg, 'mutation {}', {})),
      ).rejects.toMatchObject({
        status: 429,
        rateLimited: true,
        resource: 'graphql',
        retryAt: 1800000000000 + ('x-ratelimit-reset' in headers ? 600000 : 60000) + 5000,
      });
      await expect(gh.githubGraphql(cfg, 'query {}', {})).resolves.toEqual({ ok: true });
      expect(fetch.calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer user-tok', 'Bearer tok']);
    },
  );

  it('clears a request identity for detached work and restores it for the request', async () => {
    const gh = await freshGithub();
    const fetch = stubFetch(reply(), reply());
    let background;
    await gh.asGithubUser('user-tok', async () => {
      background = gh.asGithubUser(null, async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await gh.githubRest(cfg, 'POST', '/background');
      });
      await gh.githubRest(cfg, 'POST', '/request');
    });
    await background;
    expect(fetch.calls.map((c) => [c.url, c.init.headers.Authorization])).toEqual([
      ['https://api.github.com/request', 'Bearer user-tok'],
      ['https://api.github.com/background', 'Bearer tok'],
    ]);
  });

  it('keeps PAT validation outside the server cooldown in both directions', async () => {
    const gh = await freshGithub();
    const limited = () => reply({ status: 429, headers: { 'retry-after': '60' } });
    const fetch = stubFetch(limited(), reply(), limited(), reply());
    const validate = () =>
      gh.githubRest({ githubToken: 'pat' }, 'GET', '/user', undefined, { trackServerRate: false });
    expect((await validate()).status).toBe(429);
    expect((await gh.githubRest(cfg, 'GET', '/repos/o/r')).ok).toBe(true);
    await expect(gh.githubRest(cfg, 'GET', '/repos/o/r')).rejects.toMatchObject({ rateLimited: true });
    expect((await validate()).ok).toBe(true);
    expect(fetch.calls.map((c) => c.init.headers.Authorization)).toEqual([
      'Bearer pat',
      'Bearer tok',
      'Bearer tok',
      'Bearer pat',
    ]);
  });
});
