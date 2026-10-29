import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createCodeReviewService } from '../lib/code-review-service.js';
import { reviewOutput } from '../lib/code-review-output.js';
import { codeReviewCommand, codeReviewProtocol, reviewExportPrompt } from '../lib/code-review-prompts.js';
import { codeReviewAnchor, codeReviewFindingAnchor } from '../lib/markers.js';

let service, store, deps, records, jobs, events, pr, comments, posts, selected;
const source = {
  summary: 'Repeated check',
  short_summary: 'Repeated check',
  category: 'simplification',
  file: 'src/items.js',
  line: 10,
  failure_scenario: 'The same policy is checked twice.',
  verdict: 'CONFIRMED',
};
beforeEach(() => {
  records = new Map();
  jobs = new Map();
  events = new Map();
  comments = [];
  posts = [];
  selected = { provider: { id: 1, binary: 'claude' }, model: 'configured-model', effort: 'high' };
  pr = {
    state: 'open',
    head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'acme/shop' } },
    base: { sha: 'b'.repeat(40), ref: 'main' },
  };
  store = {
    create: vi.fn(async (input) => {
      const record = { ...input, id: `r${records.size + 1}`, status: 'queued', findings: [] };
      records.set(record.id, record);
      return structuredClone(record);
    }),
    get: vi.fn(async (id) => structuredClone(records.get(id) || null)),
    update: vi.fn(async (id, status, patch) => {
      const record = records.get(id);
      if (record.status !== status) throw new Error('state changed');
      Object.assign(record, patch);
    }),
    importOutput: vi.fn(async (id, rawOutput, output) => {
      const record = records.get(id);
      if (record.status !== 'exporting') throw new Error('state changed');
      const normalized = reviewOutput(output);
      Object.assign(record, normalized, {
        rawOutput,
        status: 'publishing',
        findings: normalized.findings.map((f, i) => ({
          ...f,
          id: `f${i}`,
          reviewId: id,
          verificationStatus: 'pending',
          shouldFix: null,
        })),
      });
      return structuredClone(record);
    }),
    updateFinding: vi.fn(async (id, findingId, patch) =>
      Object.assign(
        records.get(id).findings.find((f) => f.id === findingId),
        patch,
      ),
    ),
    active: vi.fn(async () =>
      [...records.values()]
        .filter((r) => ['queued', 'reviewing', 'exporting', 'publishing', 'verifying'].includes(r.status))
        .map((r) => r.id),
    ),
  };
  deps = {
    store,
    runtime: vi.fn(() => selected),
    allowed: vi.fn(() => true),
    ready: () => true,
    createSession: vi.fn((input) => {
      const job = { ...input, providerId: input.provider, id: `s${jobs.size + 1}`, status: 'running' };
      jobs.set(job.id, job);
      events.set(job.id, [{ kind: 'user', text: input.prompt }]);
      return job;
    }),
    getJob: (id) => jobs.get(id),
    listJobs: () => [...jobs.values()],
    eventsFor: async (job) => events.get(job.id),
    sendMessage: vi.fn((id, text) => {
      events.get(id).push({ kind: 'user', text });
      jobs.get(id).status = 'running';
    }),
    closeSession: vi.fn(async (id) => {
      jobs.get(id).status = 'closed';
    }),
    request: vi.fn(async (review, method, path, body) => {
      if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return structuredClone(pr);
      if (method === 'GET') return comments.filter((c) => c.path === path.split('?')[0]);
      if (method === 'POST') {
        const comment = {
          id: comments.length + 1,
          html_url: 'https://github.com/acme/shop/pull/42#comment',
          path,
          ...body,
        };
        comments.push(comment);
        posts.push({ review, path, body });
        return comment;
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }),
  };
  service = createCodeReviewService(deps);
});
async function start() {
  return service.start({ repo: 'acme/shop', prNumber: 42, ownerId: 2 });
}
function finish(id, report = { findings: [source] }) {
  const review = records.get(id);
  jobs.get(review.sessionId).status = 'idle';
  events.get(review.sessionId).push({ kind: 'text', text: 'One cleanup opportunity.' });
  if (report) events.get(review.sessionId).push({ kind: 'code-review-result', report });
}

describe('code review execution', () => {
  it('runs the native command with the configured effort, retaining categories and original verdicts', async () => {
    const review = await start();
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '/code-review high https://github.com/acme/shop/pull/42',
        ownerId: 2,
        model: 'configured-model',
      }),
    );
    expect(codeReviewProtocol(jobs.get(review.sessionId))).toContain(pr.head.sha);
    finish(review.id);
    await service.advance(review.id);
    expect(records.get(review.id)).toMatchObject({
      status: 'publishing',
      findings: [
        {
          category: 'simplification',
          shortSummary: 'Repeated check',
          reviewerVerdict: 'CONFIRMED',
          verificationStatus: 'pending',
          shouldFix: null,
          severity: 'unknown',
        },
      ],
    });
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  it('posts the summary before inline comments, then releases the execution session', async () => {
    const review = await start();
    finish(review.id);
    await service.advance(review.id);
    await service.advance(review.id);
    expect(posts.map((p) => p.path)).toEqual([
      '/repos/acme/shop/issues/42/comments',
      '/repos/acme/shop/pulls/42/comments',
    ]);
    expect(posts[1].body).toMatchObject({
      commit_id: pr.head.sha,
      path: 'src/items.js',
      line: 10,
      side: 'RIGHT',
    });
    expect(posts[1].body.body).toContain('Category: simplification');
    expect(records.get(review.id).status).toBe('completed');
    expect(deps.closeSession).toHaveBeenCalledWith(review.sessionId);
  });
  it('retains file grouping when the native report gives no line', async () => {
    const review = await start();
    finish(review.id, { findings: [{ ...source, line: undefined }] });
    await service.advance(review.id);
    await service.advance(review.id);
    expect(posts[1].body).toMatchObject({ subject_type: 'file', path: 'src/items.js' });
    expect(posts[1].body).not.toHaveProperty('line');
  });
  it('uses a formatting turn when the native command emits only text', async () => {
    const review = await start();
    finish(review.id, null);
    await service.advance(review.id);
    expect(deps.sendMessage).toHaveBeenCalledWith(review.sessionId, reviewExportPrompt(review));
    jobs.get(review.sessionId).status = 'idle';
    events
      .get(review.sessionId)
      .push({
        kind: 'text',
        text: JSON.stringify({ headSha: review.headSha, summary: 'Completed.', findings: [] }),
      });
    await service.advance(review.id);
    await service.advance(review.id);
    expect(records.get(review.id)).toMatchObject({
      status: 'completed',
      findings: [],
      rawOutput: 'One cleanup opportunity.',
    });
    expect(posts).toHaveLength(1);
  });
  it.each([
    'not json',
    JSON.stringify({ error: 'Unknown command' }),
    JSON.stringify({ headSha: 'wrong', summary: 'Done', findings: [] }),
  ])('rejects an invalid export without posting a clean review: %s', async (output) => {
    const review = await start();
    finish(review.id, null);
    await service.advance(review.id);
    jobs.get(review.sessionId).status = 'idle';
    events.get(review.sessionId).push({ kind: 'text', text: output });
    await service.advance(review.id);
    expect(records.get(review.id).status).toBe('failed');
    expect(posts).toEqual([]);
  });
  it('does not run on another provider or turn a configured runtime failure into a fallback', async () => {
    selected = null;
    await expect(start()).rejects.toThrow('Claude');
    selected = { provider: { id: 3, binary: 'codex' } };
    await expect(start()).rejects.toThrow('Claude');
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });
  it('marks a changed head stale before publishing anything', async () => {
    const review = await start();
    finish(review.id);
    await service.advance(review.id);
    pr.head.sha = 'c'.repeat(40);
    await service.advance(review.id);
    expect(records.get(review.id).status).toBe('stale');
    expect(posts).toEqual([]);
  });
  it('resumes queued session attachment and publication without duplicating work', async () => {
    const review = await start();
    records.get(review.id).status = 'queued';
    await service.advance(review.id);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    finish(review.id);
    await service.advance(review.id);
    comments.push({
      id: 1,
      html_url: 'https://github.com/acme/shop/pull/42#summary',
      path: '/repos/acme/shop/issues/42/comments',
      body: codeReviewAnchor(review.id),
    });
    comments.push({
      id: 2,
      html_url: 'https://github.com/acme/shop/pull/42#finding',
      path: '/repos/acme/shop/pulls/42/comments',
      body: codeReviewFindingAnchor(review.id, 'f0'),
      commit_id: pr.head.sha,
    });
    await service.advance(review.id);
    expect(posts).toEqual([]);
    expect(records.get(review.id).findings[0].inlineCommentId).toBe(2);
  });
  it('stops on an uncertain write and reconciles it before an explicit publication retry', async () => {
    const review = await start();
    finish(review.id);
    await service.advance(review.id);
    const request = deps.request.getMockImplementation();
    let uncertain = true;
    deps.request.mockImplementation(async (...args) => {
      const result = await request(...args);
      if (uncertain && args[1] === 'POST') {
        uncertain = false;
        throw new Error('connection reset');
      }
      return result;
    });
    await service.advance(review.id);
    expect(records.get(review.id).status).toBe('failed');
    await service.retryPublication(review.id);
    expect(posts).toHaveLength(2);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });
  it('stops ongoing work after access is revoked', async () => {
    const review = await start();
    deps.allowed.mockReturnValue(false);
    await service.advance(review.id);
    expect(records.get(review.id).status).toBe('failed');
    expect(posts).toEqual([]);
    expect(jobs.get(review.sessionId).status).toBe('closed');
  });
  it('does not request the native command to apply fixes or post before the summary exists', () => {
    expect(codeReviewCommand({ repo: 'acme/shop', prNumber: 42, effort: 'low' })).toBe(
      '/code-review low https://github.com/acme/shop/pull/42',
    );
  });
});
