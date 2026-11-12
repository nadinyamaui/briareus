import { beforeEach, describe, expect, it } from 'vitest';
import { createBenchmarkRunner } from '../lib/review-benchmark-runner.js';
import { answerHash, answerSnapshot, normalizeCase } from '../lib/review-benchmark.js';

const repo = 'acme/bench';
const sha = (c) => c.repeat(40);

// The store's contract, in memory: what lib/review-benchmark-store.js does on MySQL.
function memoryStore() {
  const runs = new Map();
  return {
    runs,
    add(run, results) {
      runs.set(run.id, {
        status: 'running',
        concurrency: 1,
        requestedBy: 5,
        repo,
        ...run,
        results: results.map((r, i) => ({
          id: i + 1,
          state: 'queued',
          headBranch: null,
          baseBranch: null,
          prNumber: null,
          jobId: null,
          codeReviewId: null,
          review: null,
          error: null,
          startedAt: null,
          endedAt: null,
          cleanedAt: null,
          cleanupError: null,
          judgments: [],
          ...r,
        })),
      });
    },
    async getRun(_repo, id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    async listRunningRuns() {
      return [...runs.values()]
        .filter(
          (run) =>
            run.status === 'running' ||
            run.results.some(
              (r) =>
                r.cleanedAt == null &&
                (r.prNumber != null || r.headBranch != null || r.baseBranch != null) &&
                ['done', 'failed', 'cancelled'].includes(r.state),
            ),
        )
        .map((run) => run.id);
    },
    async updateResult(id, changes, { from = null } = {}) {
      for (const run of runs.values())
        for (const r of run.results)
          if (r.id === id) {
            if (from && !from.includes(r.state)) return false;
            Object.assign(r, structuredClone(changes));
            return true;
          }
      return false;
    },
    async finishRun(id, status) {
      const run = runs.get(id);
      if (run.status !== 'running') return false;
      run.status = status;
      return true;
    },
  };
}

// GitHub as far as the runner uses it: refs and pull requests.
function fakeGithub() {
  const refs = new Map();
  const pulls = [];
  const calls = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  let failNext = null;
  const github = async (method, path, body) => {
    calls.push([method, path, body]);
    if (failNext) {
      const status = failNext;
      failNext = null;
      return json(status, { message: 'nope' });
    }
    if (method === 'POST' && path.endsWith('/git/refs')) {
      const name = body.ref.replace('refs/heads/', '');
      if (refs.has(name)) return json(422, { message: 'Reference already exists' });
      refs.set(name, body.sha);
      return json(201, {});
    }
    if (method === 'GET' && path.includes('/git/ref/heads/')) {
      const name = decodeURI(path.split('/git/ref/heads/')[1]);
      return refs.has(name) ? json(200, { object: { sha: refs.get(name) } }) : json(404, {});
    }
    if (method === 'GET' && path.includes('/pulls?')) {
      const head = decodeURIComponent(new URL(`https://x${path}`).searchParams.get('head')).split(':')[1];
      return json(
        200,
        pulls.filter((p) => p.head.ref === head),
      );
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      const pr = {
        number: 100 + pulls.length,
        head: { ref: body.head },
        base: { ref: body.base },
        ...body,
        state: 'open',
      };
      pulls.push(pr);
      return json(201, pr);
    }
    if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) {
      const pr = pulls.find((p) => p.number === Number(path.split('/').pop()));
      if (!pr) return json(404, {});
      pr.state = body.state;
      return json(200, pr);
    }
    if (method === 'DELETE' && path.includes('/git/refs/heads/')) {
      const name = decodeURI(path.split('/git/refs/heads/')[1]);
      if (!refs.delete(name)) return json(422, {});
      return json(204, null);
    }
    return json(500, {});
  };
  return { github, refs, pulls, calls, failOnce: (status) => (failNext = status) };
}

const caseOf = (key, over = {}) => {
  const c = normalizeCase({
    key,
    title: `Change ${key}`,
    description: 'Adds a cache in front of the lookup.',
    baseSha: sha('a'),
    headSha: sha('b'),
    kind: 'defective',
    defects: [
      { id: 'd1', filePath: 'lib/a.js', startLine: 3, severity: 'high', summary: 'The cache never expires' },
    ],
    referenceFix: 'Give the cache entries a TTL of a minute.',
    origin: 'constructed',
    ...over,
  });
  return { caseId: 1, caseKey: key, answer: answerSnapshot({ ...c, answerHash: answerHash(c) }) };
};

describe('the benchmark runner', () => {
  let store, gh, reviews, started, closed, clock, names, project, outcomeOf;
  const runner = (over = {}) =>
    createBenchmarkRunner({
      store,
      github: gh.github,
      getProject: (r) => (r === repo ? project : null),
      startReview: async ({ prNumber, ownerId }) => {
        const jobId = `job-${prNumber}-${started.length}`;
        started.push({ prNumber, ownerId, jobId });
        reviews.set(prNumber, { id: 900 + prNumber, jobId, status: 'running', findings: [], stages: [] });
        return { jobId };
      },
      findReview: async (_repo, prNumber, jobId) => {
        const r = reviews.get(prNumber);
        return r && (!jobId || r.jobId === jobId) ? r : null;
      },
      readOutcome: async (_p, prNumber) => outcomeOf(prNumber),
      closeSession: async (jobId) => closed.push(jobId),
      now: () => clock,
      branchName: () => `review/${names++}`,
      log: () => {},
      ...over,
    });

  beforeEach(() => {
    store = memoryStore();
    gh = fakeGithub();
    reviews = new Map();
    started = [];
    closed = [];
    clock = 1_000_000;
    names = 1;
    project = { repo, reviewBenchmark: true };
    outcomeOf = (prNumber) => ({
      outcome: 'changes_required',
      reviewId: 900 + prNumber,
      reasons: [{ code: 'fix_required', effect: 'changes_required' }],
    });
  });

  it('opens a case as a pull request of the change alone and starts its review as the run’s requester', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    await runner().tick();
    expect(gh.refs).toEqual(
      new Map([
        ['review/1-base', sha('a')],
        ['review/1', sha('b')],
      ]),
    );
    expect(gh.pulls).toHaveLength(1);
    const pr = gh.pulls[0];
    expect(pr).toMatchObject({
      title: 'Change one',
      body: 'Adds a cache in front of the lookup.',
      head: 'review/1',
      base: 'review/1-base',
    });
    // Nothing of the answer reaches GitHub.
    const sent = JSON.stringify(gh.calls);
    for (const secret of ['The cache never expires', 'TTL of a minute', 'defective', 'benchmark'])
      expect(sent).not.toContain(secret);
    expect(started).toEqual([{ prNumber: 100, ownerId: 5, jobId: 'job-100-0' }]);
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({
      state: 'reviewing',
      prNumber: 100,
      jobId: 'job-100-0',
    });
  });

  it('keeps what the review left, closes the pull request, deletes the branches and completes the run', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    const r = runner();
    await r.tick();
    reviews.set(100, {
      ...reviews.get(100),
      status: 'completed',
      headSha: sha('b'),
      provider: 'Claude',
      model: 'opus',
      effort: 'high',
      costUsd: 0.75,
      costEstimated: true,
      unpricedTurns: 1,
      stages: [{ stage: 'discover', status: 'completed' }],
      findings: [
        {
          id: 7,
          severity: 'high',
          title: 'Never expires',
          filePath: 'lib/a.js',
          startLine: 3,
          shouldFix: 'fix',
          verification: 'confirmed',
        },
      ],
    });
    clock += 60_000;
    await r.tick();
    const run = await store.getRun(null, 1);
    expect(run.status).toBe('completed');
    const result = run.results[0];
    expect(result.state).toBe('done');
    expect(result.review).toMatchObject({
      codeReviewId: 1000,
      status: 'completed',
      costUsd: 0.75,
      costEstimated: true,
      unpricedTurns: 1,
      outcome: {
        outcome: 'changes_required',
        reasons: [{ code: 'fix_required', effect: 'changes_required' }],
      },
      findings: [expect.objectContaining({ id: 7, shouldFix: 'fix' })],
      startedAt: 1_000_000,
      endedAt: 1_060_000,
    });
    expect(result.cleanedAt).toBe(1_060_000);
    expect(gh.pulls[0].state).toBe('closed');
    expect(gh.refs.size).toBe(0);
  });

  it('keeps no outcome that belongs to another review of the pull request', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    outcomeOf = () => ({ outcome: 'passed', reviewId: 1, reasons: [] });
    const r = runner();
    await r.tick();
    reviews.get(100).status = 'completed';
    await r.tick();
    expect((await store.getRun(null, 1)).results[0].review.outcome).toBeNull();
  });

  it('picks up after a restart without a second pull request or a second review', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    // The previous process made the branches, the pull request and the review, and
    // recorded only the branch names.
    gh.refs.set('review/9-base', sha('a'));
    gh.refs.set('review/9', sha('b'));
    gh.pulls.push({ number: 55, head: { ref: 'review/9' }, base: { ref: 'review/9-base' }, state: 'open' });
    reviews.set(55, { id: 1, jobId: 'job-old', status: 'running', findings: [] });
    Object.assign(store.runs.get(1).results[0], {
      state: 'opening',
      headBranch: 'review/9',
      baseBranch: 'review/9-base',
      startedAt: 1,
    });
    await runner().tick();
    expect(gh.pulls).toHaveLength(1);
    expect(started).toEqual([]);
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({
      state: 'reviewing',
      prNumber: 55,
      jobId: 'job-old',
    });
  });

  it('fails a case whose branch name is taken at another commit, and cleans up what it made', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    gh.refs.set('review/1', sha('f'));
    await runner().tick();
    const result = (await store.getRun(null, 1)).results[0];
    expect(result.state).toBe('failed');
    expect(result.error).toContain('exists at another commit');
    // Its base branch was made first and is deleted again; the other one is somebody else's.
    expect(gh.refs.has('review/1-base')).toBe(false);
    expect(gh.refs.get('review/1')).toBe(sha('f'));
    expect(result.headBranch).toBeNull();
  });

  it('tries a passing GitHub failure again on the next tick', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    gh.failOnce(502);
    const r = runner();
    await r.tick();
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({ state: 'opening' });
    expect((await store.getRun(null, 1)).results[0].error).toContain('502');
    await r.tick();
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({ state: 'reviewing', error: null });
  });

  it('stops trying to open a case once it has tried for as long as a review may run', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    const refusing = async () => {
      throw new Error('No review runtime is available');
    };
    const r = runner({ timeoutMs: 1000, startReview: refusing });
    await r.tick();
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({
      state: 'opening',
      error: 'No review runtime is available',
    });
    clock += 1001;
    await r.tick();
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({ state: 'failed' });
    // What it made is cleaned up and the run ends.
    expect(gh.pulls[0].state).toBe('closed');
    expect((await store.getRun(null, 1)).status).toBe('completed');
  });

  it('gives up on a review that does not end in time and stops its session', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    const r = runner({ timeoutMs: 1000 });
    await r.tick();
    clock += 1001;
    await r.tick();
    const result = (await store.getRun(null, 1)).results[0];
    expect(result).toMatchObject({ state: 'failed', error: 'The review did not end in time' });
    expect(result.review.status).toBe('running');
    expect(closed).toEqual(['job-100-0']);
    expect((await store.getRun(null, 1)).status).toBe('completed');
  });

  it('runs no more cases at once than the run allows', async () => {
    store.add(
      { id: 1, concurrency: 2 },
      [caseOf('a'), caseOf('b'), caseOf('c')].map((c, i) => ({ ...c, caseId: i + 1 })),
    );
    const r = runner();
    await r.tick();
    expect(started).toHaveLength(2);
    reviews.get(100).status = 'completed';
    await r.tick();
    expect(started).toHaveLength(3);
    expect((await store.getRun(null, 1)).results.map((x) => x.state)).toEqual([
      'done',
      'reviewing',
      'reviewing',
    ]);
  });

  it('opens nothing once the project is no longer set aside for the benchmark', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    project = { repo, reviewBenchmark: false };
    await runner().tick();
    expect(gh.calls).toEqual([]);
    expect((await store.getRun(null, 1)).results[0]).toMatchObject({ state: 'failed' });
    expect((await store.getRun(null, 1)).status).toBe('completed');
  });

  it('winds down a cancelled run: stops its reviews and cleans up', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    const r = runner();
    await r.tick();
    const run = store.runs.get(1);
    run.status = 'cancelled';
    run.results[0].state = 'cancelled';
    await r.cancelled(await store.getRun(null, 1));
    expect(closed).toEqual(['job-100-0']);
    await r.tick();
    expect(gh.pulls[0].state).toBe('closed');
    expect(gh.refs.size).toBe(0);
    expect((await store.getRun(null, 1)).results[0].cleanedAt).not.toBeNull();
    expect(await store.listRunningRuns()).toEqual([]);
  });

  it('keeps a cleanup that failed owed and does it later', async () => {
    store.add({ id: 1 }, [caseOf('one')]);
    const r = runner();
    await r.tick();
    reviews.get(100).status = 'failed';
    gh.failOnce(503);
    await r.tick();
    let result = (await store.getRun(null, 1)).results[0];
    expect(result).toMatchObject({ state: 'done', cleanedAt: null });
    expect(result.cleanupError).toContain('503');
    expect((await store.getRun(null, 1)).status).toBe('running');
    await r.tick();
    result = (await store.getRun(null, 1)).results[0];
    expect(result.cleanedAt).not.toBeNull();
    expect((await store.getRun(null, 1)).status).toBe('completed');
  });
});
