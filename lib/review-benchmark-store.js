// @ts-check
// The review benchmark's tables (migrations/2026_11_12_130000_add_review_benchmarks.js):
// cases with their adjudications, runs with a result per case, and the judgments of the
// findings those results kept. What the rows mean is lib/review-benchmark.js's.
import { githubStoreConnection } from './db.js';
import { answerHash } from './review-benchmark.js';

const conflict = (message, code) => Object.assign(new Error(message), { status: 409, code });
const missing = (message) => Object.assign(new Error(message), { status: 404, code: 'not_found' });

const n = (v) => (v == null ? null : Number(v));
function parse(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToCase(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    key: r.case_key,
    title: r.title,
    description: r.description ?? null,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    kind: r.kind,
    defects: parse(r.defects, []),
    referenceFix: r.reference_fix ?? null,
    origin: r.origin,
    provenance: r.provenance ?? null,
    answerHash: r.answer_hash,
    authoredBy: n(r.authored_by),
    retiredAt: n(r.retired_at),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToAdjudication(r) {
  return {
    id: Number(r.id),
    caseId: Number(r.case_id),
    userId: Number(r.user_id),
    answerHash: r.answer_hash,
    verdict: r.verdict,
    note: r.note ?? null,
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToRun(r) {
  return {
    id: Number(r.id),
    repo: r.repo,
    label: r.label ?? null,
    note: r.note ?? null,
    status: r.status,
    requestedBy: n(r.requested_by),
    concurrency: Number(r.concurrency),
    runtime: parse(r.runtime, null),
    configuration: parse(r.configuration, null),
    endedAt: n(r.ended_at),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToResult(r) {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    caseId: Number(r.case_id),
    caseKey: r.case_key,
    answer: parse(r.answer, { hash: null, kind: 'clean', defects: [] }),
    state: r.state,
    headBranch: r.head_branch ?? null,
    baseBranch: r.base_branch ?? null,
    prNumber: n(r.pr_number),
    jobId: r.job_id ?? null,
    codeReviewId: n(r.code_review_id),
    review: parse(r.review, null),
    error: r.error ?? null,
    startedAt: n(r.started_at),
    endedAt: n(r.ended_at),
    cleanedAt: n(r.cleaned_at),
    cleanupError: r.cleanup_error ?? null,
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToJudgment(r) {
  return {
    resultId: Number(r.result_id),
    findingId: Number(r.finding_id),
    assessment: r.assessment,
    defectId: r.defect_id ?? null,
    harmfulFix: !!r.harmful_fix,
    note: r.note ?? null,
    userId: n(r.user_id),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

// What a result may be moved to by the runner, by column.
const RESULT_COLUMNS = {
  state: 'state',
  headBranch: 'head_branch',
  baseBranch: 'base_branch',
  prNumber: 'pr_number',
  jobId: 'job_id',
  codeReviewId: 'code_review_id',
  review: 'review',
  error: 'error',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  cleanedAt: 'cleaned_at',
  cleanupError: 'cleanup_error',
};

/** @param {{ connection?: () => Promise<any>, now?: () => number }} [options] */
export function createBenchmarkStore({
  connection = () => githubStoreConnection(),
  now = () => Date.now(),
} = {}) {
  async function withConnection(fn) {
    const c = await connection();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }
  async function transaction(fn) {
    return withConnection(async (c) => {
      await c.beginTransaction();
      try {
        const out = await fn(c);
        await c.commit();
        return out;
      } catch (e) {
        await c.rollback().catch(() => {});
        throw e;
      }
    });
  }
  const adjudicationsOf = async (c, ids) => {
    if (!ids.length) return new Map();
    const [rows] = await c.query(
      'SELECT * FROM `review_benchmark_adjudications` WHERE `case_id` IN (?) ORDER BY `id`',
      [ids],
    );
    const out = new Map(ids.map((id) => [id, []]));
    for (const a of rows.map(rowToAdjudication)) out.get(a.caseId)?.push(a);
    return out;
  };

  async function listCases(repo, { includeRetired = true } = {}) {
    return withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT * FROM \`review_benchmark_cases\` WHERE \`repo\` = ?${includeRetired ? '' : ' AND `retired_at` IS NULL'} ORDER BY \`case_key\``,
        [repo],
      );
      const cases = rows.map(rowToCase);
      const adjudications = await adjudicationsOf(
        c,
        cases.map((x) => x.id),
      );
      return cases.map((x) => ({ ...x, adjudications: adjudications.get(x.id) || [] }));
    });
  }

  async function getCase(repo, id) {
    return withConnection(async (c) => {
      const [rows] = await c.query('SELECT * FROM `review_benchmark_cases` WHERE `repo` = ? AND `id` = ?', [
        repo,
        id,
      ]);
      if (!rows.length) return null;
      const found = rowToCase(rows[0]);
      return { ...found, adjudications: (await adjudicationsOf(c, [found.id])).get(found.id) || [] };
    });
  }

  // `c` is a case as lib/review-benchmark.js normalizeCase returns it.
  async function createCase(repo, c, { userId = null } = {}) {
    const at = now();
    const hash = answerHash(c);
    const id = await withConnection(async (conn) => {
      try {
        const [res] = await conn.query(
          `INSERT INTO \`review_benchmark_cases\`
             (\`repo\`, \`case_key\`, \`title\`, \`description\`, \`base_sha\`, \`head_sha\`, \`kind\`, \`defects\`, \`reference_fix\`, \`origin\`, \`provenance\`, \`answer_hash\`, \`authored_by\`, \`created_at\`, \`updated_at\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repo,
            c.key,
            c.title,
            c.description,
            c.baseSha,
            c.headSha,
            c.kind,
            JSON.stringify(c.defects),
            c.referenceFix,
            c.origin,
            c.provenance,
            hash,
            userId,
            at,
            at,
          ],
        );
        return res.insertId;
      } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') throw conflict(`A case named ${c.key} already exists`, 'case_exists');
        throw e;
      }
    });
    return getCase(repo, id);
  }

  // A whole case replaced. The adjudications stay on record and stop counting when the
  // fingerprint moves (lib/review-benchmark.js caseStanding). Whoever moves it becomes the
  // answer's author, so their own agreement with it adjudicates nothing; the author is set
  // first, while `answer_hash` still holds the old fingerprint.
  async function updateCase(repo, id, c, { userId }) {
    const hash = answerHash(c);
    const [res] = await withConnection((conn) =>
      conn.query(
        `UPDATE \`review_benchmark_cases\` SET \`authored_by\` = IF(\`answer_hash\` = ?, \`authored_by\`, ?), \`title\` = ?, \`description\` = ?, \`base_sha\` = ?, \`head_sha\` = ?, \`kind\` = ?, \`defects\` = ?, \`reference_fix\` = ?, \`origin\` = ?, \`provenance\` = ?, \`answer_hash\` = ?, \`updated_at\` = ?
         WHERE \`repo\` = ? AND \`id\` = ?`,
        [
          hash,
          userId,
          c.title,
          c.description,
          c.baseSha,
          c.headSha,
          c.kind,
          JSON.stringify(c.defects),
          c.referenceFix,
          c.origin,
          c.provenance,
          hash,
          now(),
          repo,
          id,
        ],
      ),
    );
    if (!res.affectedRows) throw missing('No such case in this project');
    return getCase(repo, id);
  }

  async function retireCase(repo, id, retired) {
    const [res] = await withConnection((conn) =>
      conn.query(
        // Retiring one already retired keeps when it first was.
        'UPDATE `review_benchmark_cases` SET `retired_at` = IF(?, COALESCE(`retired_at`, ?), NULL), `updated_at` = ? WHERE `repo` = ? AND `id` = ?',
        [retired ? 1 : 0, now(), now(), repo, id],
      ),
    );
    if (!res.affectedRows) throw missing('No such case in this project');
    return getCase(repo, id);
  }

  // One person's verdict on the case as it stands; ruling again on the same answer
  // replaces theirs.
  async function adjudicate(repo, id, { userId, verdict, note = null }) {
    await transaction(async (c) => {
      const [rows] = await c.query(
        'SELECT `answer_hash` FROM `review_benchmark_cases` WHERE `repo` = ? AND `id` = ? FOR UPDATE',
        [repo, id],
      );
      if (!rows.length) throw missing('No such case in this project');
      const at = now();
      await c.query(
        `INSERT INTO \`review_benchmark_adjudications\` (\`case_id\`, \`user_id\`, \`answer_hash\`, \`verdict\`, \`note\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`verdict\` = VALUES(\`verdict\`), \`note\` = VALUES(\`note\`), \`updated_at\` = VALUES(\`updated_at\`)`,
        [id, userId, rows[0].answer_hash, verdict, note, at, at],
      );
    });
    return getCase(repo, id);
  }

  /**
   * A run and a queued result per case, in one transaction.
   * @param {string} repo
   * @param {{ label?: string|null, note?: string|null, requestedBy?: number|null, concurrency: number, runtime: any, configuration: any, cases: Array<{ caseId: number, caseKey: string, answer: any }> }} run
   */
  async function createRun(repo, run) {
    const id = await transaction(async (c) => {
      const at = now();
      const [res] = await c.query(
        `INSERT INTO \`review_benchmark_runs\` (\`repo\`, \`label\`, \`note\`, \`requested_by\`, \`concurrency\`, \`runtime\`, \`configuration\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          repo,
          run.label ?? null,
          run.note ?? null,
          run.requestedBy ?? null,
          run.concurrency,
          JSON.stringify(run.runtime ?? null),
          JSON.stringify(run.configuration ?? null),
          at,
          at,
        ],
      );
      for (const item of run.cases)
        await c.query(
          `INSERT INTO \`review_benchmark_results\` (\`run_id\`, \`case_id\`, \`case_key\`, \`answer\`, \`created_at\`, \`updated_at\`)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [res.insertId, item.caseId, item.caseKey, JSON.stringify(item.answer), at, at],
        );
      return res.insertId;
    });
    return getRun(repo, id);
  }

  async function listRuns(repo, { limit = 50 } = {}) {
    return withConnection(async (c) => {
      const [rows] = await c.query(
        'SELECT * FROM `review_benchmark_runs` WHERE `repo` = ? ORDER BY `created_at` DESC, `id` DESC LIMIT ?',
        [repo, limit],
      );
      return rows.map(rowToRun);
    });
  }

  // A run with its results, and each result with the judgments of its findings. Without
  // `repo`, any project's (the runner's own reads).
  async function getRun(repo, id) {
    return withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT * FROM \`review_benchmark_runs\` WHERE \`id\` = ?${repo == null ? '' : ' AND `repo` = ?'}`,
        repo == null ? [id] : [id, repo],
      );
      if (!rows.length) return null;
      const run = rowToRun(rows[0]);
      const [results] = await c.query(
        'SELECT * FROM `review_benchmark_results` WHERE `run_id` = ? ORDER BY `id`',
        [id],
      );
      const list = results.map((r) => ({ ...rowToResult(r), judgments: [] }));
      if (list.length) {
        const byId = new Map(list.map((r) => [r.id, r]));
        const [judged] = await c.query(
          'SELECT * FROM `review_benchmark_judgments` WHERE `result_id` IN (?) ORDER BY `finding_id`',
          [[...byId.keys()]],
        );
        for (const j of judged.map(rowToJudgment)) byId.get(j.resultId)?.judgments.push(j);
      }
      return { ...run, results: list };
    });
  }

  // The runs the runner has work in: running ones, and ended ones with a pull request or
  // branches not yet cleaned up.
  async function listRunningRuns() {
    return withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT \`id\` FROM \`review_benchmark_runs\` r WHERE r.\`status\` = 'running' OR EXISTS (
           SELECT 1 FROM \`review_benchmark_results\` x WHERE x.\`run_id\` = r.\`id\` AND x.\`cleaned_at\` IS NULL
              AND (x.\`pr_number\` IS NOT NULL OR x.\`head_branch\` IS NOT NULL OR x.\`base_branch\` IS NOT NULL)
              AND x.\`state\` IN ('done', 'failed', 'cancelled'))
         ORDER BY \`id\``,
      );
      return rows.map((r) => Number(r.id));
    });
  }

  // A result moved on. `from` names the states it may be in for the move to happen, so
  // a cancellation and the runner cannot both win.
  async function updateResult(id, changes, { from = null } = {}) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      const column = RESULT_COLUMNS[key];
      if (!column) throw new Error(`Unknown result field ${key}`);
      sets.push(`\`${column}\` = ?`);
      values.push(key === 'review' && value != null ? JSON.stringify(value) : value);
    }
    sets.push('`updated_at` = ?');
    values.push(now());
    const guard = from ? ' AND `state` IN (?)' : '';
    const [res] = await withConnection((c) =>
      c.query(
        `UPDATE \`review_benchmark_results\` SET ${sets.join(', ')} WHERE \`id\` = ?${guard}`,
        from ? [...values, id, from] : [...values, id],
      ),
    );
    return res.affectedRows > 0;
  }

  async function finishRun(id, status) {
    const at = now();
    const [res] = await withConnection((c) =>
      c.query(
        "UPDATE `review_benchmark_runs` SET `status` = ?, `ended_at` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'running'",
        [status, at, at, id],
      ),
    );
    return res.affectedRows > 0;
  }

  // The run stops: queued cases are not started, and cases under way are cancelled for
  // the runner to wind down (lib/review-benchmark-runner.js closes their sessions and
  // cleans up what they made). A case whose review already ended keeps its result.
  async function cancelRun(repo, id) {
    await transaction(async (c) => {
      const [rows] = await c.query(
        'SELECT `status` FROM `review_benchmark_runs` WHERE `id` = ? AND `repo` = ? FOR UPDATE',
        [id, repo],
      );
      if (!rows.length) throw missing('No such run in this project');
      if (rows[0].status !== 'running') throw conflict(`The run is ${rows[0].status}`, 'run_not_running');
      const at = now();
      await c.query(
        "UPDATE `review_benchmark_results` SET `state` = 'cancelled', `ended_at` = ?, `cleaned_at` = ?, `updated_at` = ? WHERE `run_id` = ? AND `state` = 'queued'",
        [at, at, at, id],
      );
      await c.query(
        "UPDATE `review_benchmark_results` SET `state` = 'cancelled', `ended_at` = ?, `updated_at` = ? WHERE `run_id` = ? AND `state` IN ('opening', 'reviewing')",
        [at, at, id],
      );
      await c.query(
        "UPDATE `review_benchmark_runs` SET `status` = 'cancelled', `ended_at` = ?, `updated_at` = ? WHERE `id` = ?",
        [at, at, id],
      );
    });
    return getRun(repo, id);
  }

  async function saveJudgment(
    resultId,
    findingId,
    { assessment, defectId = null, harmfulFix = false, note = null, userId = null },
  ) {
    const at = now();
    await withConnection((c) =>
      c.query(
        `INSERT INTO \`review_benchmark_judgments\` (\`result_id\`, \`finding_id\`, \`assessment\`, \`defect_id\`, \`harmful_fix\`, \`note\`, \`user_id\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`assessment\` = VALUES(\`assessment\`), \`defect_id\` = VALUES(\`defect_id\`), \`harmful_fix\` = VALUES(\`harmful_fix\`), \`note\` = VALUES(\`note\`), \`user_id\` = VALUES(\`user_id\`), \`updated_at\` = VALUES(\`updated_at\`)`,
        [resultId, findingId, assessment, defectId, harmfulFix ? 1 : 0, note, userId, at, at],
      ),
    );
  }

  async function deleteJudgment(resultId, findingId) {
    const [res] = await withConnection((c) =>
      c.query('DELETE FROM `review_benchmark_judgments` WHERE `result_id` = ? AND `finding_id` = ?', [
        resultId,
        findingId,
      ]),
    );
    return res.affectedRows > 0;
  }

  return {
    listCases,
    getCase,
    createCase,
    updateCase,
    retireCase,
    adjudicate,
    createRun,
    listRuns,
    getRun,
    listRunningRuns,
    updateResult,
    finishRun,
    cancelRun,
    saveJudgment,
    deleteJudgment,
  };
}
