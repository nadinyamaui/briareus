import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/jobs.js', () => ({
  createDevSession: vi.fn(),
  devSessionSlots: vi.fn(),
  pullRequestHasOpenSession: vi.fn(),
  pendingFeedbackAssessment: vi.fn(),
  flushJobs: vi.fn(),
}));
import { createIncomingFeedback } from '../lib/incoming-feedback.js';

const project = {
  repo: 'acme/shop',
  enabled: true,
  babysitPrs: true,
  reviewAuthor: 'nadin',
  reviewProviderId: 26,
  reviewModel: 'selected',
  reviewEffort: 'low',
  autonomousReviewLoop: true,
};
const pr = { number: 7, author: 'nadin', branch: 'feature', updatedAt: 'today' };
function harness(over = {}) {
  const snapshot = {
    repo: project.repo,
    prNumber: 7,
    author: 'nadin',
    sha: 'same-sha',
    branch: 'feature',
    sources: [
      { id: 'review:42', author: 'sergio', body: '- One low finding', reviewId: 42, state: 'COMMENTED' },
    ],
    history: [],
  };
  let state = {};
  const start = vi.fn(() => ({ id: 'assessment' }));
  const read = vi.fn(async () => structuredClone(snapshot));
  const save = vi.fn(async (next) => {
    state = structuredClone(next);
  });
  const service = createIncomingFeedback({
    projects: () => [project],
    read,
    pending: () => null,
    busy: () => false,
    slots: () => 1,
    start,
    persist: async () => {},
    load: async () => state,
    save,
    ...over,
  });
  return { service, start, read, save, snapshot, state: () => state };
}

describe('incoming feedback intake', () => {
  it('automatically assesses COMMENTED reviews on the project runtime and waits for manual triage', async () => {
    const { service, start } = harness();
    expect(await service.assess(project, pr)).toBe(true);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 26,
        model: 'selected',
        effort: 'low',
        reviewLoop: false,
        autoClose: true,
        activity: 'assess-feedback',
      }),
    );
    expect(start.mock.calls[0][0].feedbackAssessment.sources).toHaveLength(1);
    expect(await service.assess(project, pr)).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('deduplicates across restart and admits a new review or edited body on the same head', async () => {
    const h = harness();
    await h.service.assess(project, pr);
    const restored = harness({ load: async () => h.state() });
    await restored.service.assess(project, pr);
    expect(restored.start).not.toHaveBeenCalled();
    h.snapshot.sources[0].body += ' edited';
    await h.service.assess(project, { ...pr, updatedAt: 'later' });
    h.snapshot.sources.push({ ...h.snapshot.sources[0], id: 'review:43', reviewId: 43 });
    await h.service.assess(project, { ...pr, updatedAt: 'latest' });
    expect(h.start).toHaveBeenCalledTimes(3);
  });
  it('a manual assessment is remembered so completing its card does not start the same review again', async () => {
    const h = harness();
    await h.service.remember(h.snapshot);
    await h.service.assess(project, pr);
    expect(h.start).not.toHaveBeenCalled();
  });
  it('defers while a card waits or capacity is full, without consuming the review', async () => {
    const pending = harness({ pending: () => ({ reviewTriage: {} }) });
    expect(await pending.service.assess(project, pr)).toBe(true);
    expect(pending.read).not.toHaveBeenCalled();
    let slots = 0;
    const h = harness({ slots: () => slots });
    await h.service.assess(project, pr);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    slots = 1;
    await h.service.assess(project, pr);
    expect(h.start).toHaveBeenCalledTimes(1);
  });
  it('leaves disabled projects, missing authors, colleagues’ PRs, drafts and forks alone', async () => {
    const h = harness();
    for (const p of [
      { ...project, babysitPrs: false },
      { ...project, enabled: false },
      { ...project, reviewAuthor: '' },
    ])
      await h.service.assess(p, pr);
    for (const row of [
      { ...pr, author: 'other' },
      { ...pr, draft: true },
      { ...pr, crossRepository: true },
      { ...pr, labels: ['blocked'] },
    ])
      await h.service.assess(project, row);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it('rechecks the canonical PR author and does not consume failed starts or failed reads', async () => {
    const h = harness();
    h.snapshot.author = 'other';
    await h.service.assess(project, pr);
    expect(h.start).not.toHaveBeenCalled();
    h.snapshot.author = 'nadin';
    h.start.mockImplementationOnce(() => {
      throw new Error('draining');
    });
    await expect(h.service.assess(project, pr)).rejects.toThrow('draining');
    expect(h.save).not.toHaveBeenCalled();
    await h.service.assess(project, pr);
    expect(h.start).toHaveBeenCalledTimes(2);
  });
  it('remembers reviews received while busy even when GitHub reports the same update timestamp', async () => {
    let busy = false;
    const h = harness({ busy: () => busy });
    await h.service.assess(project, pr);
    busy = true;
    h.snapshot.sources.push({ ...h.snapshot.sources[0], id: 'review:43', reviewId: 43 });
    await h.service.reviewEvent(project.repo, {
      action: 'submitted',
      pull_request: {
        number: 7,
        user: { login: 'nadin' },
        head: { ref: 'feature', repo: { full_name: 'acme/shop' } },
        updated_at: pr.updatedAt,
      },
    });
    expect(h.start).toHaveBeenCalledTimes(1);
    busy = false;
    await h.service.assess(project, pr);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it('serializes duplicate webhook deliveries and detects edits even without updatedAt changing', async () => {
    const h = harness();
    const event = {
      action: 'submitted',
      pull_request: {
        number: 7,
        user: { login: 'nadin' },
        head: { ref: 'feature', repo: { full_name: 'acme/shop' } },
        updated_at: 'today',
      },
    };
    await Promise.all([
      h.service.reviewEvent(project.repo, event),
      h.service.reviewEvent(project.repo, event),
    ]);
    expect(h.start).toHaveBeenCalledTimes(1);
    h.snapshot.sources[0].body += ' more';
    await h.service.reviewEvent(project.repo, { ...event, action: 'edited' });
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.service.reviewEvent(project.repo, { ...event, action: 'dismissed' });
    expect(h.start).toHaveBeenCalledTimes(2);
  });
});
