// @ts-check
import { Router } from 'express';
import {
  ADJUDICATION_VERDICTS,
  JUDGMENT_ASSESSMENTS,
  LIMITS,
  answerSnapshot,
  caseStanding,
  compareRuns,
  normalizeCase,
  scoreResult,
  summarizeRun,
} from './review-benchmark.js';
import { qualityWindow, summarizeReviewQuality } from './review-quality.js';
import { asGithubUser } from './github.js';

// The review benchmark and the review quality summary, through the client API
// (lib/api-v1.js) only. The cases carry their answers, so who reaches these handlers is
// the point: a person's token with access to the project, never an agent session. A
// session's token opens /api/agent/* and nothing here, and a request that arrives still
// carrying a credential did not come through the gateway, which strips it, and is refused.

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const refused = (status, code, message, more = {}) =>
  Object.assign(new Error(message), { status, code, more });
const FINAL = ['done', 'failed', 'cancelled'];
const iso = (v) => (v == null ? null : new Date(Number(v)).toISOString());

/**
 * @param {{
 *   getProject: (repo: string) => any,
 *   store: ReturnType<typeof import('./review-benchmark-store.js').createBenchmarkStore>,
 *   runner: { tick: () => Promise<unknown>, cancelled: (run: any) => Promise<unknown> },
 *   runSettings: (project: any) => { runtime: any, configuration: any },
 *   qualityRows: (repo: string, window: { since: number, until: number }) => Promise<any>,
 *   now?: () => number,
 * }} deps
 * `runSettings` is what a run starts under: the project's review runtime as it resolves
 * now and the review configuration, recorded with the run; it throws (409) when the
 * project has no runtime a review could start on. `qualityRows` reads a project's review
 * records for a window (lib/review-quality.js readReviewQualityRows).
 */
export function reviewBenchmarkRoutes({
  getProject,
  store,
  runner,
  runSettings,
  qualityRows,
  now = () => Date.now(),
}) {
  const router = Router();
  for (const path of ['/api/review-benchmarks', '/api/review-quality'])
    router.use(path, (req, res, next) => {
      if (req.headers.authorization)
        return res
          .status(403)
          .json({ error: 'The review benchmark is reached through /api/v1 with a person’s own token' });
      next();
    });

  const fail = (res, e) => {
    const status = e.status || 503;
    if (status >= 500) console.error(`Review benchmark: ${e.message}`);
    res.status(status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.more || {}) });
  };
  const projectOf = (source) => {
    const project = getProject(String(source?.repo || ''));
    if (!project) throw refused(404, 'unknown_project', `Unknown project: ${source?.repo || ''}`);
    return project;
  };
  const userOf = (res) => {
    const user = res.locals.apiUser;
    if (!user) throw refused(401, 'no_user', 'Call this with a person’s own token');
    return user;
  };
  const idOf = (value, name) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw invalid(`${name} must be a positive whole number`);
    return id;
  };
  const only = (body, allowed) => {
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw invalid(`Unknown fields: ${unknown.join(', ')}`);
  };
  const note = (value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw invalid('note must be text');
    if (value.length > LIMITS.note) throw invalid(`note is longer than ${LIMITS.note} characters`);
    return value.trim() || null;
  };

  const caseView = (c) => {
    const { adjudications = [], ...rest } = c;
    return {
      ...rest,
      retiredAt: iso(c.retiredAt),
      createdAt: iso(c.createdAt),
      updatedAt: iso(c.updatedAt),
      standing: caseStanding(c, adjudications),
      adjudications: adjudications.map((a) => ({
        userId: a.userId,
        verdict: a.verdict,
        note: a.note,
        current: a.answerHash === c.answerHash,
        independent: c.authoredBy == null || a.userId !== c.authoredBy,
        at: iso(a.updatedAt),
      })),
    };
  };
  // A result with its score. A case still under way has none; a cancelled one has none
  // either (a review is kept only on the move to done or failed), and is counted as cancelled.
  const scored = (result) => {
    const score =
      result.state === 'done' || result.state === 'failed'
        ? scoreResult({ answer: result.answer, review: result.review, judgments: result.judgments })
        : null;
    return { ...result, score };
  };
  const runView = (run) => {
    const results = run.results.map(scored);
    return {
      ...runHeader(run),
      summary: summarizeRun(results),
      results: results.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        caseKey: r.caseKey,
        state: r.state,
        prNumber: r.prNumber,
        sessionId: r.jobId,
        codeReviewId: r.codeReviewId,
        headBranch: r.headBranch,
        baseBranch: r.baseBranch,
        error: r.error,
        startedAt: iso(r.startedAt),
        endedAt: iso(r.endedAt),
        cleanedAt: iso(r.cleanedAt),
        cleanupError: r.cleanupError,
        answer: r.answer,
        review: r.review,
        judgments: r.judgments.map((j) => ({
          ...j,
          createdAt: iso(j.createdAt),
          updatedAt: iso(j.updatedAt),
        })),
        score: r.score,
      })),
    };
  };
  const runHeader = (run) => ({
    id: run.id,
    repo: run.repo,
    label: run.label,
    note: run.note,
    status: run.status,
    requestedBy: run.requestedBy,
    concurrency: run.concurrency,
    runtime: run.runtime,
    configuration: run.configuration,
    createdAt: iso(run.createdAt),
    endedAt: iso(run.endedAt),
  });
  const runOf = async (project, id) => {
    const run = await store.getRun(project.repo, id);
    if (!run) throw refused(404, 'not_found', 'No such run in this project');
    return run;
  };
  const caseOf = async (project, id) => {
    const found = await store.getCase(project.repo, id);
    if (!found) throw refused(404, 'not_found', 'No such case in this project');
    return found;
  };
  // The tick is the server's work, whoever's request started it: outside the caller's
  // GitHub identity (lib/github.js), or its writes would be made with their token.
  const kick = () => {
    asGithubUser(null, () => runner.tick()).catch((e) =>
      console.error(`Review benchmark tick: ${e.message}`),
    );
  };

  router.get('/api/review-benchmarks/cases', async (req, res) => {
    try {
      const project = projectOf(req.query);
      res.json({ cases: (await store.listCases(project.repo)).map(caseView) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/review-benchmarks/cases', async (req, res) => {
    try {
      const user = userOf(res);
      const project = projectOf(req.body);
      const c = normalizeCase(req.body);
      res.status(201).json({ case: caseView(await store.createCase(project.repo, c, { userId: user.id })) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.put('/api/review-benchmarks/cases/:caseId', async (req, res) => {
    try {
      const user = userOf(res);
      const project = projectOf(req.body);
      const existing = await caseOf(project, idOf(req.params.caseId, 'caseId'));
      const c = normalizeCase(req.body, { key: existing.key });
      res.json({ case: caseView(await store.updateCase(project.repo, existing.id, c, { userId: user.id })) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/review-benchmarks/cases/:caseId/retire', async (req, res) => {
    try {
      userOf(res);
      const body = req.body || {};
      only(body, ['repo', 'retired']);
      const project = projectOf(body);
      if (typeof body.retired !== 'boolean') throw invalid('retired must be true or false');
      const id = idOf(req.params.caseId, 'caseId');
      res.json({ case: caseView(await store.retireCase(project.repo, id, body.retired)) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/review-benchmarks/cases/:caseId/adjudications', async (req, res) => {
    try {
      const user = userOf(res);
      const body = req.body || {};
      only(body, ['repo', 'verdict', 'note']);
      const project = projectOf(body);
      if (!ADJUDICATION_VERDICTS.includes(body.verdict))
        throw invalid(`verdict must be one of ${ADJUDICATION_VERDICTS.join(', ')}`);
      const id = idOf(req.params.caseId, 'caseId');
      const found = await store.adjudicate(project.repo, id, {
        userId: user.id,
        verdict: body.verdict,
        note: note(body.note),
      });
      res.json({ case: caseView(found) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get('/api/review-benchmarks/runs', async (req, res) => {
    try {
      const project = projectOf(req.query);
      res.json({ runs: (await store.listRuns(project.repo)).map(runHeader) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/review-benchmarks/runs', async (req, res) => {
    try {
      const user = userOf(res);
      const body = req.body || {};
      only(body, ['repo', 'label', 'note', 'cases', 'concurrency']);
      const project = projectOf(body);
      if (project.reviewBenchmark !== true)
        throw refused(
          409,
          'benchmark_not_enabled',
          'This project is not set aside for the review benchmark: a run opens and closes pull requests in its repository, so switch reviewBenchmark on in its settings first',
        );
      if (body.label != null && (typeof body.label !== 'string' || body.label.length > LIMITS.label))
        throw invalid(`label must be text of at most ${LIMITS.label} characters`);
      const concurrency = body.concurrency == null ? 1 : body.concurrency;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > LIMITS.concurrency)
        throw invalid(`concurrency must be a whole number from 1 to ${LIMITS.concurrency}`);
      if (body.cases != null && (!Array.isArray(body.cases) || body.cases.some((k) => typeof k !== 'string')))
        throw invalid('cases must be a list of case keys');
      const all = await store.listCases(project.repo);
      const standing = new Map(all.map((c) => [c.key, caseStanding(c, c.adjudications)]));
      let chosen;
      if (body.cases == null) chosen = all.filter((c) => standing.get(c.key)?.runnable);
      else {
        const keys = [...new Set(body.cases)];
        const unknown = keys.filter((k) => !standing.has(k));
        if (unknown.length)
          throw refused(404, 'unknown_case', `No such cases: ${unknown.join(', ')}`, { cases: unknown });
        const unfit = keys.filter((k) => !standing.get(k)?.runnable);
        if (unfit.length)
          throw refused(
            409,
            'case_not_adjudicated',
            `Only cases somebody other than their author agreed with, and nobody disputes, are run: ${unfit.join(', ')}`,
            { cases: unfit.map((k) => ({ key: k, status: standing.get(k)?.status })) },
          );
        chosen = all.filter((c) => keys.includes(c.key));
      }
      if (!chosen.length)
        throw refused(409, 'no_cases', 'There is no adjudicated case to run in this project');
      if (chosen.length > LIMITS.casesPerRun)
        throw invalid(`A run takes at most ${LIMITS.casesPerRun} cases; name the ones to run in cases`);
      const running = (await store.listRuns(project.repo, { limit: 20 })).find((r) => r.status === 'running');
      if (running)
        throw refused(409, 'run_in_progress', `Run ${running.id} is still running on this project`, {
          runId: running.id,
        });
      const { runtime, configuration } = runSettings(project);
      const run = await store.createRun(project.repo, {
        label: body.label?.trim() || null,
        note: note(body.note),
        requestedBy: user.id,
        concurrency,
        runtime,
        configuration,
        cases: chosen.map((c) => ({ caseId: c.id, caseKey: c.key, answer: answerSnapshot(c) })),
      });
      kick();
      res.status(201).json({ run: runView(run) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get('/api/review-benchmarks/runs/:runId', async (req, res) => {
    try {
      const project = projectOf(req.query);
      res.json({ run: runView(await runOf(project, idOf(req.params.runId, 'runId'))) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/review-benchmarks/runs/:runId/cancel', async (req, res) => {
    try {
      userOf(res);
      const body = req.body || {};
      only(body, ['repo']);
      const project = projectOf(body);
      const run = await store.cancelRun(project.repo, idOf(req.params.runId, 'runId'));
      await runner.cancelled(run);
      kick();
      res.json({ run: runView(run) });
    } catch (e) {
      fail(res, e);
    }
  });

  // A person's word on one finding of a result: which defect it is, or that it is a
  // false positive, or a real problem the answer misses, and whether its fix would harm.
  const judgmentTarget = async (project, params) => {
    const run = await runOf(project, idOf(params.runId, 'runId'));
    const resultId = idOf(params.resultId, 'resultId');
    const result = run.results.find((r) => r.id === resultId);
    if (!result) throw refused(404, 'not_found', 'No such result in this run');
    const findingId = idOf(params.findingId, 'findingId');
    if (!FINAL.includes(result.state) || !result.review?.findings?.some((f) => f.id === findingId))
      throw refused(404, 'not_found', 'The result kept no such finding');
    return { run, result, findingId };
  };

  router.put(
    '/api/review-benchmarks/runs/:runId/results/:resultId/judgments/:findingId',
    async (req, res) => {
      try {
        const user = userOf(res);
        const body = req.body || {};
        only(body, ['repo', 'assessment', 'defectId', 'harmfulFix', 'note']);
        const project = projectOf(body);
        const { run, result, findingId } = await judgmentTarget(project, req.params);
        if (!JUDGMENT_ASSESSMENTS.includes(body.assessment))
          throw invalid(`assessment must be one of ${JUDGMENT_ASSESSMENTS.join(', ')}`);
        let defectId = null;
        if (body.assessment === 'matches') {
          defectId = typeof body.defectId === 'string' ? body.defectId : '';
          if (!result.answer.defects.some((d) => d.id === defectId))
            throw invalid('defectId must name one of the defects of this case’s answer');
        } else if (body.defectId != null) throw invalid('defectId goes only with the assessment matches');
        if (body.harmfulFix != null && typeof body.harmfulFix !== 'boolean')
          throw invalid('harmfulFix must be true or false');
        await store.saveJudgment(result.id, findingId, {
          assessment: body.assessment,
          defectId,
          harmfulFix: body.harmfulFix === true,
          note: note(body.note),
          userId: user.id,
        });
        res.json({ run: runView(await runOf(project, run.id)) });
      } catch (e) {
        fail(res, e);
      }
    },
  );

  router.delete(
    '/api/review-benchmarks/runs/:runId/results/:resultId/judgments/:findingId',
    async (req, res) => {
      try {
        userOf(res);
        const project = projectOf(req.query);
        const { run, result, findingId } = await judgmentTarget(project, req.params);
        await store.deleteJudgment(result.id, findingId);
        res.json({ run: runView(await runOf(project, run.id)) });
      } catch (e) {
        fail(res, e);
      }
    },
  );

  router.get('/api/review-benchmarks/compare', async (req, res) => {
    try {
      const project = projectOf(req.query);
      const a = await runOf(project, idOf(req.query.a, 'a'));
      const b = await runOf(project, idOf(req.query.b, 'b'));
      const side = (run) => ({ run: runHeader(run), results: run.results.map(scored) });
      res.json({ comparison: compareRuns(side(a), side(b)) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get('/api/review-quality', async (req, res) => {
    try {
      const project = projectOf(req.query);
      const at = now();
      const window = qualityWindow(req.query.days, at);
      const rows = await qualityRows(project.repo, window);
      res.json({
        quality: { repo: project.repo, ...summarizeReviewQuality({ ...rows, ...window, now: at }) },
      });
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}
