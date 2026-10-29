// @ts-check
import { randomBytes } from 'node:crypto';
import { githubStoreConnection } from './db.js';
import { reviewOutput } from './code-review-output.js';

const reviewColumns = {
  id: 'id',
  repo: 'repo',
  prNumber: 'pr_number',
  branch: 'branch',
  baseSha: 'base_sha',
  headSha: 'head_sha',
  ownerId: 'owner_id',
  providerId: 'provider_id',
  model: 'model',
  effort: 'effort',
  sessionId: 'session_id',
  status: 'status',
  summary: 'summary',
  rawOutput: 'raw_output',
  error: 'error',
  summaryCommentId: 'summary_comment_id',
  summaryCommentUrl: 'summary_comment_url',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
const findingColumns = {
  id: 'id',
  reviewId: 'review_id',
  position: 'position',
  title: 'title',
  shortSummary: 'short_summary',
  category: 'category',
  failureScenario: 'failure_scenario',
  reviewerVerdict: 'reviewer_verdict',
  severity: 'severity',
  details: 'details',
  proof: 'proof',
  comments: 'comments',
  path: 'path',
  startLine: 'start_line',
  endLine: 'end_line',
  side: 'side',
  reviewerShouldFix: 'reviewer_should_fix',
  shouldFix: 'should_fix',
  fixReason: 'fix_reason',
  verificationStatus: 'verification_status',
  verificationProof: 'verification_proof',
  verificationSha: 'verification_sha',
  verificationSessionId: 'verification_session_id',
  verificationOutput: 'verification_output',
  verificationError: 'verification_error',
  inlineCommentId: 'inline_comment_id',
  inlineCommentUrl: 'inline_comment_url',
};
const id = () => randomBytes(16).toString('hex');
const conflict = () => Object.assign(new Error('Review state changed'), { status: 409 });
const map = (row, columns) =>
  Object.fromEntries(
    Object.entries(columns).map(([key, column]) => {
      let value = row[column] ?? null;
      if (value != null && ['shouldFix', 'reviewerShouldFix'].includes(key)) value = !!value;
      if (value != null && ['createdAt', 'updatedAt'].includes(key)) value = Number(value);
      return [key, value];
    }),
  );
async function query(c, sql, values = []) {
  return /** @type {any} */ ((await c.query(sql, values))[0]);
}

// SQL identifiers come only from the fixed maps above, never a caller's keys.
function assignments(patch, columns) {
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !columns[key])) throw new Error('Invalid review update');
  return {
    sql: entries.map(([key]) => `\`${columns[key]}\` = ?`).join(', '),
    values: entries.map(([, value]) => value),
  };
}

export function createCodeReviewStore({ connection = () => githubStoreConnection() } = {}) {
  async function using(fn) {
    const c = await connection();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }
  async function get(reviewId) {
    return using(async (c) => {
      const rows = await query(c, 'SELECT * FROM code_reviews WHERE id = ?', [reviewId]);
      if (!rows.length) return null;
      const findings = await query(
        c,
        'SELECT * FROM code_review_findings WHERE review_id = ? ORDER BY position',
        [reviewId],
      );
      return { ...map(rows[0], reviewColumns), findings: findings.map((f) => map(f, findingColumns)) };
    });
  }
  async function create(input) {
    const record = {
      id: id(),
      repo: input.repo.toLowerCase(),
      prNumber: input.prNumber,
      branch: input.branch,
      headSha: input.headSha,
      baseSha: input.baseSha,
      ownerId: input.ownerId ?? null,
      providerId: input.providerId,
      model: input.model,
      effort: input.effort,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const keys = Object.keys(record);
    await using((c) =>
      query(
        c,
        `INSERT INTO code_reviews (${keys.map((k) => reviewColumns[k]).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        Object.values(record),
      ),
    );
    return get(record.id);
  }
  async function list({ repo, prNumber = null, ownerId = null, page = 1 }) {
    const where = ['repo = ?'];
    const args = [repo.toLowerCase()];
    if (prNumber != null) {
      where.push('pr_number = ?');
      args.push(prNumber);
    }
    if (ownerId != null) {
      where.push('(owner_id IS NULL OR owner_id = ?)');
      args.push(ownerId);
    }
    const columns = Object.values(reviewColumns)
      .filter((v) => v !== 'raw_output')
      .map((v) => `r.${v}`)
      .join(',');
    return using(async (c) => {
      const rows = await query(
        c,
        `SELECT ${columns}, (SELECT COUNT(*) FROM code_review_findings f WHERE f.review_id = r.id) AS finding_count FROM code_reviews r WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 101 OFFSET ?`,
        [...args, (page - 1) * 100],
      );
      return {
        reviews: rows.slice(0, 100).map((r) => {
          const { rawOutput: _raw, ...review } = map(r, reviewColumns);
          return { ...review, findingCount: Number(r.finding_count) };
        }),
        nextPage: rows.length > 100 ? page + 1 : null,
      };
    });
  }
  async function update(reviewId, expectedStatus, patch) {
    const change = assignments({ ...patch, updatedAt: Date.now() }, reviewColumns);
    return using(async (c) => {
      const result = await query(c, `UPDATE code_reviews SET ${change.sql} WHERE id = ? AND status = ?`, [
        ...change.values,
        reviewId,
        expectedStatus,
      ]);
      if (!result.affectedRows) throw conflict();
    });
  }
  async function importOutput(reviewId, rawOutput, input) {
    const { summary, findings } = reviewOutput(input);
    if (typeof rawOutput !== 'string' || rawOutput.length > 1000000)
      throw new Error('Invalid raw review output');
    await using(async (c) => {
      await c.beginTransaction();
      try {
        const changed = await query(
          c,
          "UPDATE code_reviews SET summary = ?, raw_output = ?, status = 'publishing', updated_at = ? WHERE id = ? AND status = 'exporting'",
          [summary, rawOutput, Date.now(), reviewId],
        );
        if (!changed.affectedRows) throw conflict();
        for (const [position, finding] of findings.entries()) {
          const row = { id: id(), reviewId, position, ...finding };
          const keys = Object.keys(row);
          await query(
            c,
            `INSERT INTO code_review_findings (${keys.map((k) => findingColumns[k]).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
            Object.values(row),
          );
        }
        await c.commit();
      } catch (e) {
        await c.rollback();
        throw e;
      }
    });
    return get(reviewId);
  }
  async function updateFinding(reviewId, findingId, patch) {
    const change = assignments(patch, findingColumns);
    await using(async (c) => {
      const result = await query(
        c,
        `UPDATE code_review_findings SET ${change.sql} WHERE id = ? AND review_id = ?`,
        [...change.values, findingId, reviewId],
      );
      if (!result.affectedRows) throw conflict();
    });
  }
  async function active() {
    return using(async (c) =>
      (
        await query(
          c,
          "SELECT id FROM code_reviews WHERE status IN ('queued','reviewing','exporting','publishing','verifying') ORDER BY created_at",
        )
      ).map((r) => r.id),
    );
  }
  return { create, get, list, update, importOutput, updateFinding, active };
}
