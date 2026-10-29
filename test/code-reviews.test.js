import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FINDINGS, codeReviewRoutes, findingFields } from '../lib/code-reviews.js';

describe('findingFields', () => {
  it('requires severity, verdict and title on a new finding, normalising case', () => {
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
  let server, base, sessions, reviews, findings;
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
