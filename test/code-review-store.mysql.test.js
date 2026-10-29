import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../lib/config.js';
import { createCodeReviewStore } from '../lib/code-review-store.js';
import { up, down } from '../migrations/2026_10_29_150000_create_code_reviews.js';

describe.skipIf(process.env.CODE_REVIEW_MYSQL !== '1')('code review storage on MySQL', () => {
  const database = `briareus_reviews_test_${randomBytes(6).toString('hex')}`;
  let bootstrap, pool, store;
  const input = {
    repo: 'acme/shop',
    prNumber: 42,
    branch: 'feature',
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    ownerId: 2,
    providerId: 1,
    model: 'example-model',
    effort: 'high',
  };
  const output = {
    summary: 'One finding',
    findings: [
      {
        title: 'Wrong account',
        details: 'No account filter',
        severity: 'high',
        proof: 'Reproduced',
        shouldFix: true,
      },
    ],
  };
  beforeAll(async () => {
    const { database: _database, ...config } = getConfig().db;
    bootstrap = await mysql.createConnection(config);
    await bootstrap.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    await up({ context: pool });
    await up({ context: pool });
    store = createCodeReviewStore({ connection: () => pool.getConnection() });
  });
  afterAll(async () => {
    if (pool) {
      await down({ context: pool });
      await down({ context: pool });
      expect((await pool.query('SHOW TABLES'))[0]).toHaveLength(0);
      await pool.end();
      await bootstrap.query(`DROP DATABASE ${database}`);
    }
    await bootstrap?.end();
  });
  it('stores one-to-many findings atomically, retains raw output and does not auto-confirm', async () => {
    const review = await store.create(input);
    await store.update(review.id, 'queued', { status: 'exporting' });
    const saved = await store.importOutput(review.id, 'Original command output', output);
    expect(saved).toMatchObject({
      status: 'publishing',
      rawOutput: 'Original command output',
      findings: [{ reviewerShouldFix: true, shouldFix: null, verificationStatus: 'pending' }],
    });
    await expect(store.importOutput(review.id, 'duplicate', output)).rejects.toThrow('state changed');
    expect((await store.get(review.id)).findings).toHaveLength(1);
    await store.updateFinding(review.id, saved.findings[0].id, { comments: 'Kept after session removal' });
    expect((await store.get(review.id)).findings[0].comments).toBe('Kept after session removal');
  });
  it('rejects malformed output without changing the review', async () => {
    const review = await store.create(input);
    await store.update(review.id, 'queued', { status: 'exporting' });
    await expect(store.importOutput(review.id, 'bad', { summary: 'bad' })).rejects.toThrow();
    expect(await store.get(review.id)).toMatchObject({ status: 'exporting', findings: [], rawOutput: null });
  });
  it('filters list queries by owner, project and PR and omits large output', async () => {
    const foreign = await store.create({ ...input, ownerId: 3 });
    const system = await store.create({ ...input, ownerId: null });
    const result = await store.list({ repo: input.repo, prNumber: 42, ownerId: 2 });
    expect(result.reviews.map((r) => r.id)).toContain(system.id);
    expect(result.reviews.map((r) => r.id)).not.toContain(foreign.id);
    expect(result.reviews[0]).not.toHaveProperty('rawOutput');
    expect((await store.list({ repo: 'another/project' })).reviews).toEqual([]);
    expect((await store.list({ repo: input.repo, prNumber: 99 })).reviews).toEqual([]);
  });
  it('enforces the relationship and rolls back a partial import', async () => {
    const review = await store.create(input);
    await store.update(review.id, 'queued', { status: 'exporting' });
    // A prior row simulates an inconsistent partial write; the transaction must
    // preserve both the original review state and that row on unique-key failure.
    await pool.query(
      'INSERT INTO code_review_findings (id, review_id, position, title, severity, details, proof, comments) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
      ['f'.repeat(32), review.id, 'original', 'high', '', '', ''],
    );
    await expect(
      store.importOutput(review.id, 'partial', {
        ...output,
        findings: [...output.findings, ...output.findings],
      }),
    ).rejects.toThrow();
    const after = await store.get(review.id);
    expect(after).toMatchObject({ status: 'exporting', rawOutput: null, findings: [{ title: 'original' }] });
    await pool.query('DELETE FROM code_reviews WHERE id = ?', [review.id]);
    expect(
      (await pool.query('SELECT id FROM code_review_findings WHERE review_id = ?', [review.id]))[0],
    ).toHaveLength(0);
  });
});
