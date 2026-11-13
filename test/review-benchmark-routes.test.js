import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { asGithubUser, githubRest } from '../lib/github.js';
import { reviewBenchmarkRoutes } from '../lib/review-benchmark-routes.js';
import { answerHash } from '../lib/review-benchmark.js';

const repo = 'acme/bench';
const sha = (c) => c.repeat(40);
const caseBody = (over = {}) => ({
  repo,
  key: 'cache',
  title: 'Cache the lookup',
  description: 'Adds a cache in front of the lookup.',
  baseSha: sha('a'),
  headSha: sha('b'),
  kind: 'defective',
  defects: [
    { id: 'd1', filePath: 'lib/a.js', startLine: 3, severity: 'high', summary: 'The cache never expires' },
  ],
  referenceFix: 'Give the cache entries a TTL.',
  origin: 'constructed',
  ...over,
});

// The store's contract in memory (lib/review-benchmark-store.js on MySQL).
function memoryStore() {
  const cases = [];
  const runs = [];
  let ids = 0;
  const conflict = (message, code) => Object.assign(new Error(message), { status: 409, code });
  const missing = () => Object.assign(new Error('No such thing'), { status: 404 });
  const copy = (x) => structuredClone(x);
  return {
    cases,
    runs,
    async listCases(r) {
      return copy(cases.filter((c) => c.repo === r));
    },
    async getCase(r, id) {
      const c = cases.find((x) => x.repo === r && x.id === id);
      return c ? copy(c) : null;
    },
    async createCase(r, c, { userId }) {
      if (cases.some((x) => x.repo === r && x.key === c.key)) throw conflict('exists', 'case_exists');
      const row = {
        ...c,
        id: ++ids,
        repo: r,
        answerHash: answerHash(c),
        authoredBy: userId,
        retiredAt: null,
        adjudications: [],
      };
      cases.push(row);
      return copy(row);
    },
    async updateCase(r, id, c, { userId }) {
      const row = cases.find((x) => x.repo === r && x.id === id);
      if (!row) throw missing();
      const hash = answerHash(c);
      Object.assign(row, c, {
        answerHash: hash,
        authoredBy: hash === row.answerHash ? row.authoredBy : userId,
      });
      return copy(row);
    },
    async retireCase(r, id, retired) {
      const row = cases.find((x) => x.repo === r && x.id === id);
      if (!row) throw missing();
      row.retiredAt = retired ? 1 : null;
      return copy(row);
    },
    async adjudicate(r, id, { userId, verdict, note }) {
      const row = cases.find((x) => x.repo === r && x.id === id);
      if (!row) throw missing();
      row.adjudications = row.adjudications.filter(
        (a) => !(a.userId === userId && a.answerHash === row.answerHash),
      );
      row.adjudications.push({ userId, verdict, note, answerHash: row.answerHash, updatedAt: 1 });
      return copy(row);
    },
    async createRun(r, run) {
      const row = {
        id: ++ids,
        repo: r,
        status: 'running',
        ...run,
        results: run.cases.map((c, i) => ({
          id: 100 + i,
          ...c,
          state: 'queued',
          review: null,
          judgments: [],
        })),
      };
      delete row.cases;
      runs.push(row);
      return copy(row);
    },
    async listRuns(r) {
      return copy(runs.filter((x) => x.repo === r));
    },
    async getRun(r, id) {
      const run = runs.find((x) => x.id === id && (r == null || x.repo === r));
      return run ? copy(run) : null;
    },
    async cancelRun(r, id) {
      const run = runs.find((x) => x.id === id && x.repo === r);
      if (!run) throw missing();
      if (run.status !== 'running') throw conflict('ended', 'run_not_running');
      run.status = 'cancelled';
      for (const x of run.results)
        if (['queued', 'opening', 'reviewing'].includes(x.state)) x.state = 'cancelled';
      return copy(run);
    },
    async saveJudgment(resultId, findingId, judgment) {
      for (const run of runs)
        for (const x of run.results)
          if (x.id === resultId) {
            x.judgments = x.judgments.filter((j) => j.findingId !== findingId);
            x.judgments.push({ resultId, findingId, ...judgment });
          }
    },
    async deleteJudgment(resultId, findingId) {
      for (const run of runs)
        for (const x of run.results)
          if (x.id === resultId) x.judgments = x.judgments.filter((j) => j.findingId !== findingId);
      return true;
    },
  };
}

describe('the review benchmark routes', () => {
  let server, base, store, project, user, ticks, onTick, actingToken, cancelled, qualityAsked;

  beforeEach(async () => {
    store = memoryStore();
    project = { repo, reviewBenchmark: true, securityReview: 'off' };
    user = { id: 1, name: 'Ana' };
    ticks = 0;
    onTick = null;
    actingToken = null;
    cancelled = [];
    qualityAsked = [];
    const app = express();
    app.use(express.json());
    // What the gateway (lib/api-v1.js) leaves for a handler: the user, and no credential.
    app.use((req, res, next) => {
      if (user) res.locals.apiUser = user;
      // A user who linked their own GitHub token acts as it (lib/api-v1.js actAs).
      asGithubUser(actingToken, next);
    });
    app.use(
      reviewBenchmarkRoutes({
        getProject: (r) => (r === repo ? project : null),
        store,
        runner: {
          tick: async () => {
            ticks++;
            if (onTick) await onTick();
          },
          cancelled: async (run) => cancelled.push(run.id),
        },
        runSettings: () => ({
          runtime: { provider: 'Claude', model: 'opus', effort: 'high' },
          configuration: { coreRevision: 'abc' },
        }),
        qualityRows: async (r, window) => {
          qualityAsked.push([r, window]);
          return {
            reviews: [],
            rounds: [],
            counts: [],
            decisions: [],
            findings: [],
            approvals: [],
            readiness: [],
          };
        },
        now: () => 50 * 86_400_000,
      }),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const adjudicated = async (over = {}) => {
    const { body } = await call('POST', '/api/review-benchmarks/cases', caseBody(over));
    user = { id: 2, name: 'Ben' };
    await call('POST', `/api/review-benchmarks/cases/${body.case.id}/adjudications`, {
      repo,
      verdict: 'agree',
    });
    user = { id: 1, name: 'Ana' };
    return body.case;
  };

  it('refuses a request that still carries a credential: only the gateway reaches it', async () => {
    const res = await call('GET', `/api/review-benchmarks/cases?repo=${repo}`, null, {
      authorization: 'Bearer agent',
    });
    expect(res.status).toBe(403);
    expect(
      (await call('GET', `/api/review-quality?repo=${repo}`, null, { authorization: 'Bearer x' })).status,
    ).toBe(403);
  });

  it('needs a person for a write', async () => {
    user = null;
    expect((await call('POST', '/api/review-benchmarks/cases', caseBody())).status).toBe(401);
  });

  it('adds a draft case authored by its writer and adjudicates it only through somebody else', async () => {
    const created = await call('POST', '/api/review-benchmarks/cases', caseBody());
    expect(created.status).toBe(201);
    expect(created.body.case).toMatchObject({ key: 'cache', authoredBy: 1, standing: { status: 'draft' } });
    const id = created.body.case.id;
    const own = await call('POST', `/api/review-benchmarks/cases/${id}/adjudications`, {
      repo,
      verdict: 'agree',
    });
    expect(own.body.case.standing.status).toBe('draft');
    expect(own.body.case.adjudications[0]).toMatchObject({ independent: false, current: true });
    user = { id: 2 };
    const other = await call('POST', `/api/review-benchmarks/cases/${id}/adjudications`, {
      repo,
      verdict: 'agree',
    });
    expect(other.body.case.standing).toMatchObject({ status: 'adjudicated', runnable: true });
    // An edit of the answer leaves the agreements about another one.
    const edited = await call(
      'PUT',
      `/api/review-benchmarks/cases/${id}`,
      caseBody({ key: undefined, kind: 'clean', defects: [] }),
    );
    expect(edited.body.case.standing).toMatchObject({ status: 'draft', outdated: 2 });
    expect(edited.body.case.key).toBe('cache');
    // Whoever changed the answer is its author now: their own agreement adjudicates nothing.
    expect(edited.body.case.authoredBy).toBe(2);
    const editor = await call('POST', `/api/review-benchmarks/cases/${id}/adjudications`, {
      repo,
      verdict: 'agree',
    });
    expect(editor.body.case.standing).toMatchObject({ status: 'draft', runnable: false });
    user = { id: 1 };
    const original = await call('POST', `/api/review-benchmarks/cases/${id}/adjudications`, {
      repo,
      verdict: 'agree',
    });
    expect(original.body.case.standing).toMatchObject({ status: 'adjudicated', runnable: true });
  });

  it('refuses invalid cases, a duplicate key and unknown projects', async () => {
    expect(
      (await call('POST', '/api/review-benchmarks/cases', caseBody({ origin: 'incident' }))).status,
    ).toBe(400);
    expect((await call('POST', '/api/review-benchmarks/cases', caseBody())).status).toBe(201);
    const twice = await call('POST', '/api/review-benchmarks/cases', caseBody());
    expect(twice).toMatchObject({ status: 409, body: { code: 'case_exists' } });
    expect((await call('GET', '/api/review-benchmarks/cases?repo=acme/other')).status).toBe(404);
    expect(
      (await call('POST', '/api/review-benchmarks/cases/1/adjudications', { repo, verdict: 'maybe' })).status,
    ).toBe(400);
  });

  it('starts a run of the adjudicated cases only, under the project’s settings', async () => {
    await adjudicated();
    await call('POST', '/api/review-benchmarks/cases', caseBody({ key: 'draft' }));
    const started = await call('POST', '/api/review-benchmarks/runs', {
      repo,
      label: 'baseline',
      concurrency: 2,
    });
    expect(started.status).toBe(201);
    expect(started.body.run).toMatchObject({
      label: 'baseline',
      concurrency: 2,
      requestedBy: 1,
      runtime: { model: 'opus' },
      configuration: { coreRevision: 'abc' },
    });
    expect(started.body.run.results.map((r) => r.caseKey)).toEqual(['cache']);
    // The snapshot carries what the reviewer sees and the answer to score against; never the reference fix.
    expect(started.body.run.results[0].answer).toMatchObject({
      kind: 'defective',
      change: { title: 'Cache the lookup' },
    });
    expect(JSON.stringify(store.runs[0].results)).not.toContain('TTL');
    expect(ticks).toBe(1);
    expect(started.body.run.summary.cases).toMatchObject({ total: 1, scored: 0, pending: 1 });
    // One run at a time.
    const again = await call('POST', '/api/review-benchmarks/runs', { repo });
    expect(again).toMatchObject({ status: 409, body: { code: 'run_in_progress' } });
  });

  it('runs the tick a request starts as the server, not as the requesting user', async () => {
    await adjudicated();
    const sent = [];
    let ticked;
    const done = new Promise((resolve) => (ticked = resolve));
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (!String(url).startsWith('https://api.github.com')) return realFetch(url, init);
      sent.push(init.headers.Authorization);
      return Promise.resolve(new Response('{}', { status: 201 }));
    });
    try {
      onTick = async () => {
        await githubRest({ githubToken: 'SERVER' }, 'POST', `/repos/${repo}/git/refs`, { ref: 'x' });
        ticked();
      };
      actingToken = 'USER-A';
      expect((await call('POST', '/api/review-benchmarks/runs', { repo })).status).toBe(201);
      await done;
    } finally {
      spy.mockRestore();
    }
    expect(sent).toEqual(['Bearer SERVER']);
  });

  it('refuses a run the project or its cases are not fit for', async () => {
    expect((await call('POST', '/api/review-benchmarks/runs', { repo })).body.code).toBe('no_cases');
    await call('POST', '/api/review-benchmarks/cases', caseBody({ key: 'draft' }));
    const unfit = await call('POST', '/api/review-benchmarks/runs', { repo, cases: ['draft'] });
    expect(unfit).toMatchObject({
      status: 409,
      body: { code: 'case_not_adjudicated', cases: [{ key: 'draft', status: 'draft' }] },
    });
    expect((await call('POST', '/api/review-benchmarks/runs', { repo, cases: ['nope'] })).body.code).toBe(
      'unknown_case',
    );
    expect((await call('POST', '/api/review-benchmarks/runs', { repo, concurrency: 9 })).status).toBe(400);
    expect((await call('POST', '/api/review-benchmarks/runs', { repo, model: 'x' })).status).toBe(400);
    project = { ...project, reviewBenchmark: false };
    expect((await call('POST', '/api/review-benchmarks/runs', { repo })).body.code).toBe(
      'benchmark_not_enabled',
    );
  });

  it('scores a result and lets a person judge its findings', async () => {
    await adjudicated();
    const { body } = await call('POST', '/api/review-benchmarks/runs', { repo });
    const run = store.runs[0];
    Object.assign(run.results[0], {
      state: 'done',
      review: {
        status: 'completed',
        outcome: { outcome: 'changes_required' },
        findings: [
          {
            id: 7,
            severity: 'high',
            title: 'No expiry',
            filePath: 'lib/x.js',
            startLine: 1,
            shouldFix: 'fix',
          },
        ],
      },
    });
    const path = `/api/review-benchmarks/runs/${body.run.id}/results/100/judgments/7`;
    let read = await call('GET', `/api/review-benchmarks/runs/${body.run.id}?repo=${repo}`);
    expect(read.body.run.results[0].score.findings[0]).toMatchObject({
      class: 'false_positive',
      provisional: true,
    });
    expect(read.body.run.summary.defects).toMatchObject({ caught: 0, missed: 1 });

    expect((await call('PUT', path, { repo, assessment: 'matches', defectId: 'zz' })).status).toBe(400);
    expect((await call('PUT', path, { repo, assessment: 'false_positive', defectId: 'd1' })).status).toBe(
      400,
    );
    expect((await call('PUT', path, { repo, assessment: 'nope' })).status).toBe(400);
    expect((await call('PUT', path.replace('/7', '/8'), { repo, assessment: 'false_positive' })).status).toBe(
      404,
    );

    const judged = await call('PUT', path, {
      repo,
      assessment: 'matches',
      defectId: 'd1',
      harmfulFix: true,
      note: 'same bug',
    });
    expect(judged.status).toBe(200);
    expect(judged.body.run.results[0].score.findings[0]).toMatchObject({
      class: 'caught',
      basis: 'judgment',
      harmfulFix: true,
    });
    expect(judged.body.run.summary.defects).toMatchObject({ caught: 1, recall: 1 });
    expect(judged.body.run.summary.findings.harmfulFixes).toBe(1);

    read = await call('DELETE', `${path}?repo=${repo}`);
    expect(read.body.run.results[0].score.findings[0].class).toBe('false_positive');
  });

  it('cancels a running run and stops its reviews', async () => {
    await adjudicated();
    const { body } = await call('POST', '/api/review-benchmarks/runs', { repo });
    const res = await call('POST', `/api/review-benchmarks/runs/${body.run.id}/cancel`, { repo });
    expect(res.body.run.status).toBe('cancelled');
    expect(res.body.run.summary.cases.cancelled).toBe(1);
    expect(cancelled).toEqual([body.run.id]);
    const again = await call('POST', `/api/review-benchmarks/runs/${body.run.id}/cancel`, { repo });
    expect(again).toMatchObject({ status: 409, body: { code: 'run_not_running' } });
  });

  it('compares two runs of the project', async () => {
    await adjudicated();
    const a = (await call('POST', '/api/review-benchmarks/runs', { repo, label: 'a' })).body.run;
    store.runs[0].status = 'completed';
    const b = (await call('POST', '/api/review-benchmarks/runs', { repo, label: 'b' })).body.run;
    const res = await call('GET', `/api/review-benchmarks/compare?repo=${repo}&a=${a.id}&b=${b.id}`);
    expect(res.body.comparison).toMatchObject({ common: 1, a: { label: 'a' }, b: { label: 'b' } });
    expect((await call('GET', `/api/review-benchmarks/compare?repo=${repo}&a=${a.id}&b=999`)).status).toBe(
      404,
    );
  });

  it('summarizes review quality over the window asked for', async () => {
    const res = await call('GET', `/api/review-quality?repo=${repo}&days=7`);
    expect(res.status).toBe(200);
    expect(res.body.quality).toMatchObject({ repo, reviews: { total: 0 } });
    expect(qualityAsked).toEqual([[repo, { since: 43 * 86_400_000, until: 50 * 86_400_000 }]]);
    expect((await call('GET', `/api/review-quality?repo=${repo}&days=0`)).status).toBe(400);
  });
});
