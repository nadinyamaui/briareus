import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FINDINGS,
  PULL_REVIEWS_LIMIT,
  codeReviewRoutes,
  findingFields,
  pullCodeReviewRoutes,
} from '../lib/code-reviews.js';

describe('findingFields', () => {
  it('requires severity and title on a new finding, normalising case', () => {
    expect(findingFields({ severity: 'HIGH', shouldFix: 'Fix', title: '  Off by one  ' })).toEqual({
      severity: 'high',
      shouldFix: 'fix',
      title: 'Off by one',
    });
    expect(() => findingFields({ shouldFix: 'fix', title: 't' })).toThrow(/severity must be one of/);
    expect(() => findingFields({ severity: 'low', shouldFix: 'maybe', title: 't' })).toThrow(/shouldFix/);
    expect(() => findingFields({ severity: 'low', shouldFix: 'fix', title: '  ' })).toThrow(
      /title is required/,
    );
    // The verdict waits for the verification step.
    expect(findingFields({ severity: 'low', title: 't' })).toEqual({ severity: 'low', title: 't' });
    expect(findingFields({ severity: 'low', title: 't', shouldFix: null })).toMatchObject({
      shouldFix: null,
    });
  });

  it('checks the optional fields it is given', () => {
    const base = { severity: 'low', shouldFix: 'optional', title: 't' };
    expect(
      findingFields({ ...base, verification: 'confirmed', type: 'security', filePath: 'a.js', startLine: 3 }),
    ).toMatchObject({ verification: 'confirmed', type: 'security', filePath: 'a.js', startLine: 3 });
    expect(findingFields({ ...base, verification: null })).toMatchObject({ verification: null });
    expect(() => findingFields({ ...base, verification: 'sure' })).toThrow(/verification/);
    expect(() => findingFields({ ...base, startLine: 0 })).toThrow(/startLine/);
    expect(() => findingFields({ ...base, startLine: 9, endLine: 3 })).toThrow(/endLine/);
    expect(() => findingFields({ ...base, type: 'x'.repeat(41) })).toThrow(/type is longer/);
  });

  it('checks only the carried fields of an update', () => {
    expect(findingFields({ shouldFix: 'dismiss', comments: 'not reachable' }, { partial: true })).toEqual({
      shouldFix: 'dismiss',
      comments: 'not reachable',
    });
    expect(() => findingFields({ title: '' }, { partial: true })).toThrow(/title is required/);
  });
});

describe('codeReviewRoutes', () => {
  let server, base, sessions, reviews, findings, summaries;
  const call = (token, method, path, body) =>
    fetch(`${base}/api/agent/code-review${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));

  beforeEach(async () => {
    sessions = {
      rev: { id: 'rev', repo: 'acme/shop', activity: 'review' },
      other: { id: 'other', repo: 'acme/shop', activity: 'review' },
      chat: { id: 'chat', repo: 'acme/shop', activity: 'chat' },
      norow: { id: 'norow', repo: 'acme/shop', activity: 'review' },
    };
    reviews = { rev: { id: 1, jobId: 'rev' }, other: { id: 2, jobId: 'other' } };
    findings = [];
    summaries = {};
    let nextId = 0;
    const store = {
      getCodeReviewByJob: async (jobId) => reviews[jobId] || null,
      listCodeReviewFindings: async (reviewId) => findings.filter((f) => f.codeReviewId === reviewId),
      getCodeReviewFinding: async (reviewId, id) =>
        findings.find((f) => f.codeReviewId === reviewId && f.id === id) || null,
      addCodeReviewFinding: async (reviewId, fields) => {
        const finding = { id: ++nextId, codeReviewId: reviewId, ...fields };
        findings.push(finding);
        return finding;
      },
      setCodeReviewSummary: async (jobId, summary) => {
        summaries[jobId] = summary;
      },
      updateCodeReviewFinding: async (reviewId, id, changes) => {
        const finding = findings.find((f) => f.codeReviewId === reviewId && f.id === id);
        Object.assign(finding, changes);
        return finding;
      },
    };
    const agentSession = (req, res) => {
      const job = sessions[(req.headers.authorization || '').replace('Bearer ', '')];
      if (!job) res.status(401).json({ error: 'Unknown session token' });
      return job || null;
    };
    const app = express();
    app.use(express.json());
    app.use(codeReviewRoutes({ agentSession, store }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('serves only review sessions that have a review row', async () => {
    expect((await call('nobody', 'GET', '')).status).toBe(401);
    expect(await call('chat', 'GET', '')).toMatchObject({
      status: 403,
      json: { error: 'Only a code review session can register review findings' },
    });
    expect((await call('norow', 'GET', '')).status).toBe(409);
  });

  it('adds, lists and updates the session’s own findings', async () => {
    const added = await call('rev', 'POST', '/findings', {
      severity: 'high',
      shouldFix: 'fix',
      title: 'Null deref',
      filePath: 'lib/a.js',
      startLine: 4,
    });
    expect(added).toMatchObject({
      status: 201,
      json: { finding: { id: 1, codeReviewId: 1, severity: 'high' } },
    });
    expect(
      (await call('rev', 'POST', '/findings', { severity: 'bad', shouldFix: 'fix', title: 't' })).status,
    ).toBe(400);
    const updated = await call('rev', 'PATCH', '/findings/1', {
      shouldFix: 'dismiss',
      verification: 'plausible',
      comments: 'guarded upstream',
    });
    expect(updated.json.finding).toMatchObject({
      shouldFix: 'dismiss',
      verification: 'plausible',
      severity: 'high',
    });
    expect((await call('rev', 'PATCH', '/findings/1', { endLine: 2 })).status).toBe(400);
    const listed = await call('rev', 'GET', '');
    expect(listed.json).toMatchObject({ review: { id: 1 }, findings: [{ id: 1 }] });
  });

  it('registers a finding without a verdict and stores the summary', async () => {
    const added = await call('rev', 'POST', '/findings', { severity: 'medium', title: 'Unverified' });
    expect(added.status).toBe(201);
    expect(added.json.finding).not.toHaveProperty('shouldFix');
    expect((await call('rev', 'PUT', '/summary', { summary: '# Code Review' })).status).toBe(200);
    expect(summaries).toEqual({ rev: '# Code Review' });
    expect((await call('rev', 'PUT', '/summary', { summary: ' ' })).status).toBe(400);
  });

  it('never reaches another review’s finding', async () => {
    await call('rev', 'POST', '/findings', { severity: 'low', shouldFix: 'optional', title: 't' });
    expect((await call('other', 'PATCH', '/findings/1', { shouldFix: 'fix' })).status).toBe(404);
    expect((await call('other', 'GET', '')).json.findings).toEqual([]);
  });

  it('caps the findings of one review', async () => {
    for (let i = 0; i < MAX_FINDINGS; i++)
      findings.push({ id: 1000 + i, codeReviewId: 1, severity: 'low', shouldFix: 'optional', title: 't' });
    const refused = await call('rev', 'POST', '/findings', { severity: 'low', shouldFix: 'fix', title: 't' });
    expect(refused).toMatchObject({
      status: 409,
      json: { error: `A review holds at most ${MAX_FINDINGS} findings` },
    });
  });
});

describe('pullCodeReviewRoutes', () => {
  let server, base, asked, stored, store;
  const read = (query) =>
    fetch(`${base}/api/pr/code-reviews?${new URLSearchParams(query)}`).then(async (r) => ({
      status: r.status,
      json: await r.json(),
    }));
  const update = (body, reviewId = 7, findingId = 3) =>
    fetch(`${base}/api/pr/code-reviews/${reviewId}/findings/${findingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'acme/shop', pr: 12, ...body }),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));

  beforeEach(async () => {
    asked = [];
    stored = [
      {
        id: 7,
        jobId: 'rev2',
        repo: 'acme/shop',
        prNumber: 12,
        status: 'completed',
        findings: [{ id: 3, codeReviewId: 7, severity: 'high', shouldFix: 'fix', title: 'Null deref' }],
      },
      { id: 5, jobId: 'rev1', repo: 'acme/shop', prNumber: 12, status: 'failed', findings: [] },
    ];
    store = {
      listPullCodeReviews: async (repo, prNumber, limit) => {
        asked.push([repo, prNumber, limit]);
        if (prNumber === 99) throw new Error('database down');
        return stored.slice(0, limit);
      },
      getPullCodeReview: vi.fn(async (repo, prNumber, id) => {
        if (prNumber === 99) throw new Error('database down');
        return stored.find((r) => r.repo === repo && r.prNumber === prNumber && r.id === id) || null;
      }),
      getCodeReviewFinding: async (reviewId, id) =>
        stored.find((r) => r.id === reviewId)?.findings.find((f) => f.id === id) || null,
      updateCodeReviewFinding: vi.fn(async (reviewId, id, changes) => {
        const finding = await store.getCodeReviewFinding(reviewId, id);
        return finding ? Object.assign(finding, changes) : null;
      }),
    };
    // Projects are found case-insensitively; the store is asked with the canonical name.
    const getProject = (repo) =>
      ['acme/shop', 'acme/second'].includes(repo.toLowerCase()) ? { repo: repo.toLowerCase() } : null;
    const app = express();
    app.use(express.json());
    app.use(pullCodeReviewRoutes({ getProject, store }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('answers a pull request’s reviews with their findings, as sessions', async () => {
    const res = await read({ repo: 'Acme/Shop', pr: '12' });
    expect(res.status).toBe(200);
    expect(asked).toEqual([['acme/shop', 12, PULL_REVIEWS_LIMIT]]);
    expect(res.json.codeReviews).toEqual([
      {
        id: 7,
        sessionId: 'rev2',
        repo: 'acme/shop',
        prNumber: 12,
        status: 'completed',
        findings: [{ id: 3, severity: 'high', shouldFix: 'fix', title: 'Null deref' }],
      },
      { id: 5, sessionId: 'rev1', repo: 'acme/shop', prNumber: 12, status: 'failed', findings: [] },
    ]);
  });

  it('refuses an unknown project or a bad number and reports a database failure', async () => {
    expect((await read({ repo: 'acme/other', pr: '12' })).status).toBe(404);
    expect((await read({ repo: 'acme/shop', pr: 'x' })).status).toBe(400);
    expect((await read({ repo: 'acme/shop', pr: '0' })).status).toBe(400);
    expect(await read({ repo: 'acme/shop', pr: '99' })).toMatchObject({
      status: 503,
      json: { error: 'database down' },
    });
    expect(asked).toHaveLength(1);
  });

  it('updates a stored finding’s verdict and reason, preserving other fields in reads', async () => {
    for (const shouldFix of ['optional', 'dismiss', 'fix', null]) {
      const res = await update({ shouldFix, comments: 'Checked the caller', repo: 'Acme/Shop' });
      expect(res).toEqual({
        status: 200,
        json: {
          finding: {
            id: 3,
            severity: 'high',
            shouldFix,
            title: 'Null deref',
            comments: 'Checked the caller',
          },
        },
      });
      expect((await read({ repo: 'acme/shop', pr: 12 })).json.codeReviews[0].findings).toEqual([
        res.json.finding,
      ]);
    }
    expect(store.getPullCodeReview).toHaveBeenCalledWith('acme/shop', 12, 7);
    expect(store.updateCodeReviewFinding).toHaveBeenLastCalledWith(7, 3, {
      shouldFix: null,
      comments: 'Checked the caller',
    });
  });

  it('edits all finding fields and validates a partial update against the saved line range', async () => {
    Object.assign(stored[0].findings[0], { startLine: 4, endLine: 6 });
    expect((await update({ endLine: 3 })).status).toBe(400);
    expect((await update({ startLine: 8 })).status).toBe(400);
    expect(store.updateCodeReviewFinding).not.toHaveBeenCalled();
    const changes = {
      title: '  Guard missing  ',
      severity: 'LOW',
      verification: 'confirmed',
      type: 'correctness',
      body: 'Verified the caller',
      filePath: 'lib/caller.js',
      startLine: 8,
      endLine: 9,
    };
    expect((await update(changes)).json.finding).toMatchObject({
      ...changes,
      title: 'Guard missing',
      severity: 'low',
    });
    const cleared = { verification: null, comments: null, filePath: null, startLine: null, endLine: null };
    expect((await update(cleared)).json.finding).toMatchObject(cleared);
  });

  it('never updates a review or finding from a different repository, pull request or review', async () => {
    for (const [body, reviewId, findingId] of [
      [{ repo: 'acme/second' }, 7, 3],
      [{ pr: 13 }, 7, 3],
      [{}, 5, 3],
      [{}, 8, 3],
      [{}, 7, 4],
      [{ repo: 'acme/unknown' }, 7, 3],
    ]) {
      expect((await update({ shouldFix: 'dismiss', ...body }, reviewId, findingId)).status).toBe(404);
    }
    expect(store.updateCodeReviewFinding).not.toHaveBeenCalled();
    expect(stored[0].findings[0].shouldFix).toBe('fix');
  });

  it('updates older reviews without depending on their session or the latest reviews page', async () => {
    for (let id = 8; id < 8 + PULL_REVIEWS_LIMIT; id++) {
      stored.unshift({ id, repo: 'acme/shop', prNumber: 12, jobId: `rev${id}`, findings: [] });
    }
    expect((await read({ repo: 'acme/shop', pr: 12 })).json.codeReviews).toHaveLength(PULL_REVIEWS_LIMIT);
    expect((await update({ shouldFix: 'optional', comments: 'Defer low impact change' })).status).toBe(200);
  });

  it('rejects invalid ids and fields without writing', async () => {
    for (const body of [
      { shouldFix: 'not-fixing' },
      { verification: 'sure' },
      { title: '' },
      { severity: null },
      { comments: 1 },
      { startLine: 0 },
      { endLine: 1.5 },
      { shouldFix: 'optional', codeReviewId: 5 },
      { decision: 'dismiss' },
      {},
      { pr: 'bad', shouldFix: 'fix' },
      { pr: 0, shouldFix: 'fix' },
    ]) {
      expect((await update(body)).status).toBe(400);
    }
    for (const id of ['bad', '0', '-1', '1.5', '9007199254740992']) {
      expect((await update({ shouldFix: 'fix' }, id)).status).toBe(400);
      expect((await update({ shouldFix: 'fix' }, 7, id)).status).toBe(400);
    }
    expect(store.updateCodeReviewFinding).not.toHaveBeenCalled();
  });

  it('reports database failures and a finding removed by a concurrent rerun', async () => {
    expect(await update({ pr: 99, shouldFix: 'fix' })).toMatchObject({
      status: 503,
      json: { error: 'database down' },
    });
    store.updateCodeReviewFinding.mockRejectedValueOnce(new Error('write failed'));
    expect(await update({ shouldFix: 'optional' })).toMatchObject({
      status: 503,
      json: { error: 'write failed' },
    });
    store.updateCodeReviewFinding.mockResolvedValueOnce(null);
    expect((await update({ shouldFix: 'dismiss' })).status).toBe(404);
  });
});
