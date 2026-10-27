import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({ githubToken: 'test' }) }));
vi.mock('../lib/db.js', () => ({ loadAppSetting: vi.fn(), saveAppSetting: vi.fn() }));
vi.mock('../lib/github.js', () => ({ githubRest: vi.fn() }));
import { githubRest } from '../lib/github.js';
import {
  readFeedbackSnapshot,
  externalFeedbackRevisions,
  feedbackAssessmentSpec,
  parseFeedbackAssessment,
  feedbackSnapshotCurrent,
} from '../lib/feedback-assessment.js';

const review = {
  id: 42,
  user: { login: 'sergio', type: 'User' },
  body: '- Wrong redirect\n- Missing permission test',
  state: 'COMMENTED',
  commit_id: 'old-sha',
  html_url: 'https://github.com/acme/shop/pull/7#pullrequestreview-42',
};
const inline = {
  id: 44,
  user: { login: 'sergio' },
  body: 'Permission check is missing',
  path: 'app.js',
  line: 3,
  pull_request_review_id: 42,
};
const pr = {
  number: 7,
  state: 'open',
  user: { login: 'nadin' },
  head: { sha: 'head-sha', ref: 'feature', repo: { full_name: 'acme/shop' } },
};
let snapshot;
beforeEach(async () => {
  vi.mocked(githubRest)
    .mockReset()
    .mockImplementation(async (_cfg, _method, route) => ({
      ok: true,
      json: async () =>
        route.includes('/reviews?')
          ? [review]
          : route.includes('/pulls/7/comments?')
            ? [inline, { ...inline, id: 45, in_reply_to_id: 44, body: 'Already fixed' }]
            : route.includes('/issues/')
              ? [{ id: 46, body: '## Review triage\nPreviously left optional', user: { login: 'nadin' } }]
              : pr,
    }));
  snapshot = await readFeedbackSnapshot('acme/shop', 7);
});

describe('feedback snapshot', () => {
  it('includes summary-only COMMENTED feedback and inline roots, preserving replies and earlier decisions as history', () => {
    expect(snapshot.sha).toBe('head-sha');
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review:42', body: review.body, commitSha: 'old-sha' }),
        expect.objectContaining({ id: 'comment:44', file: 'app.js' }),
      ]),
    );
    expect(snapshot.sources.some((s) => s.id === 'comment:45')).toBe(false);
    expect(snapshot.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ replyTo: 44, body: 'Already fixed' }),
        expect.objectContaining({ body: expect.stringContaining('Previously left optional') }),
      ]),
    );
  });
  it('paginates and refuses a failed read rather than starting blind', async () => {
    vi.mocked(githubRest).mockImplementation(async (_cfg, _method, route) => ({
      ok: true,
      json: async () => {
        if (route.includes('/reviews?'))
          return route.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, i) => ({ ...review, id: i + 100 }))
            : [review];
        return route.includes('/comments?') ? [] : pr;
      },
    }));
    expect((await readFeedbackSnapshot('acme/shop', 7)).sources).toHaveLength(101);
    vi.mocked(githubRest).mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(readFeedbackSnapshot('acme/shop', 7)).rejects.toThrow('403');
  });
  it('refuses closed PRs and forks', async () => {
    for (const row of [
      { ...pr, state: 'closed' },
      { ...pr, head: { ...pr.head, repo: { full_name: 'other/shop' } } },
    ]) {
      vi.mocked(githubRest).mockResolvedValueOnce({ ok: true, json: async () => row });
      await expect(readFeedbackSnapshot('acme/shop', 7)).rejects.toThrow();
    }
  });
  it('groups body and inline feedback by review and detects edits without requiring a push', () => {
    const revisions = externalFeedbackRevisions(snapshot);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].sources).toEqual(['review:42', 'comment:44']);
    const reanchored = structuredClone(snapshot);
    reanchored.sources[1].line = 900;
    expect(externalFeedbackRevisions(reanchored)[0].revision).toBe(revisions[0].revision);
    const edited = structuredClone(snapshot);
    edited.sources[0].body += '\nAnother finding';
    expect(externalFeedbackRevisions(edited)[0].revision).not.toBe(revisions[0].revision);
    expect(
      externalFeedbackRevisions({
        ...snapshot,
        sources: snapshot.sources.map((s) => ({ ...s, author: 'nadin' })),
      }),
    ).toEqual([]);
    expect(
      externalFeedbackRevisions({ ...snapshot, sources: snapshot.sources.map((s) => ({ ...s, bot: true })) }),
    ).toEqual([]);
  });
  it.each(['added', 'edited', 'deleted'])(
    'invalidates selected feedback when a reviewer reply is %s',
    (change) => {
      const current = structuredClone(snapshot);
      if (change === 'added')
        current.history.push({
          ...current.history.find((s) => s.id === 'comment:45'),
          id: 'comment:47',
          body: 'Withdrawn',
        });
      if (change === 'edited') current.history.find((s) => s.id === 'comment:45').body = 'Withdrawn';
      if (change === 'deleted') current.history = current.history.filter((s) => s.id !== 'comment:45');
      expect(feedbackSnapshotCurrent(snapshot, current)).toBe(false);
      expect(externalFeedbackRevisions(current)[0].revision).not.toBe(
        externalFeedbackRevisions(snapshot)[0].revision,
      );
    },
  );
  it('ignores unrelated threads and implementation notes when checking selected feedback', () => {
    const current = structuredClone(snapshot);
    current.history.push(
      {
        ...current.history.find((s) => s.id === 'comment:45'),
        id: 'comment:47',
        replyTo: 99,
        body: 'Unrelated withdrawal',
      },
      {
        ...current.history.find((s) => s.id === 'comment:45'),
        id: 'comment:48',
        author: 'nadin',
        body: 'Implemented',
      },
      {
        ...current.history.find((s) => s.id === 'comment:45'),
        id: 'comment:49',
        bot: true,
        body: 'Bot note',
      },
    );
    expect(feedbackSnapshotCurrent(snapshot, current)).toBe(true);
    expect(externalFeedbackRevisions(current)).toEqual(externalFeedbackRevisions(snapshot));
    const selected = { ...snapshot, sources: snapshot.sources.filter((s) => s.id === 'issue:46') };
    current.history.find((s) => s.id === 'comment:45').body = 'Withdrawn';
    expect(feedbackSnapshotCurrent(selected, current)).toBe(true);
  });
});

describe('assessment protocol and findings', () => {
  const project = {
    reviewProviderId: 26,
    reviewModel: 'configured-model',
    reviewEffort: 'low',
    autonomousReviewLoop: true,
  };
  const finding = {
    source: 'review:42',
    title: 'Wrong redirect',
    severity: 'low',
    recommendation: 'optional',
    assessment: {
      verified: true,
      worthFixing: false,
      evidence: 'Checked controller line 79 and reproduced a 404',
      reason: 'Rare cosmetic outcome with no data loss',
    },
  };
  const result = (findings = [finding]) =>
    JSON.stringify({
      sha: snapshot.sha,
      complete: true,
      sourcesReviewed: snapshot.sources.map((s) => s.id),
      findings,
    });
  it('uses the configured runtime, releases resources, and never arms autonomous fixing', () => {
    const spec = feedbackAssessmentSpec(project, snapshot);
    expect(spec).toMatchObject({
      provider: 26,
      model: 'configured-model',
      effort: 'low',
      autoClose: true,
      reviewLoop: false,
      activity: 'assess-feedback',
    });
    expect(spec.prompt).toContain(review.body.replaceAll('\n', '\\n'));
    expect(spec.prompt).toContain('Do not modify repository source, commit, push');
    expect(spec.prompt).toContain('already fixed');
    expect(spec.prompt).toContain('sourcesReviewed');
    expect(() => feedbackAssessmentSpec({}, snapshot)).toThrow(/review provider/);
  });
  it('keeps the assessment protocol when a project replaces the editable template', () => {
    const spec = feedbackAssessmentSpec(
      { ...project, promptTemplates: { assessFeedback: 'CUSTOM' } },
      snapshot,
    );
    expect(spec.prompt).toMatch(/^CUSTOM/);
    expect(spec.prompt).toContain('Assessment protocol');
    // Sources must remain available even when an override omits its context token.
    expect(spec.prompt).toContain('review:42');
  });
  it('retains optional and unverified claims for manual judgment, with canonical sources and no saved verdict', () => {
    const found = parseFeedbackAssessment(result(), snapshot)[0];
    expect(found).toMatchObject({
      title: 'Wrong redirect',
      url: review.html_url,
      sourceBody: review.body,
      reviewAuthorLogin: 'sergio',
      recommendation: 'optional',
      assessment: finding.assessment,
    });
    expect(found).not.toHaveProperty('decision');
    expect(
      parseFeedbackAssessment(
        result([{ ...finding, assessment: { ...finding.assessment, verified: false } }]),
        snapshot,
      )[0].assessment.verified,
    ).toBe(false);
  });
  it('fails closed on incomplete output, changed SHA, missing evidence, invented sources or duplicated findings', () => {
    for (const body of [
      '{}',
      result().replace('head-sha', 'other-sha'),
      result().replace('true', 'false'),
      JSON.stringify({ sha: snapshot.sha, complete: true, sourcesReviewed: [], findings: [] }),
      result([{ ...finding, source: 'review:invented' }]),
      result([{ ...finding, assessment: {} }]),
      result([finding, finding]),
    ])
      expect(() => parseFeedbackAssessment(body, snapshot)).toThrow();
  });
  it('detects changed or dismissed source comments and new commits while a card is held', () => {
    expect(feedbackSnapshotCurrent(snapshot, structuredClone(snapshot))).toBe(true);
    expect(feedbackSnapshotCurrent(snapshot, { ...snapshot, sha: 'new-sha' })).toBe(false);
    expect(feedbackSnapshotCurrent(snapshot, { ...snapshot, sources: [] })).toBe(false);
  });
});
