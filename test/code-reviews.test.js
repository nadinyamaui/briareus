import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  let server, base, asked, stored;
  const read = (query) =>
    fetch(`${base}/api/pr/code-reviews?${new URLSearchParams(query)}`).then(async (r) => ({
      status: r.status,
      json: await r.json(),
    }));

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
    const store = {
      listPullCodeReviews: async (repo, prNumber, limit) => {
        asked.push([repo, prNumber, limit]);
        if (prNumber === 99) throw new Error('database down');
        return stored;
      },
    };
    // Projects are found case-insensitively; the store is asked with the canonical name.
    const getProject = (repo) => (repo.toLowerCase() === 'acme/shop' ? { repo: 'acme/shop' } : null);
    const app = express();
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
});
