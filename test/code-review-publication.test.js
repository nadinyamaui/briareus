import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCodeReviewOverview } from '../lib/code-review-publication.js';
import { githubRest } from '../lib/github.js';

vi.mock('../lib/github.js', async (original) => ({
  ...(await original()),
  githubRest: vi.fn(),
}));

const cfg = { githubToken: 'publisher-token' };
const options = {
  repo: 'acme/shop',
  prNumber: 42,
  marker: 'session:0',
  summary: '# Code Review\n\n0 critical, 0 high, 0 medium, 0 low findings.',
  since: '2026-10-29T14:00:00Z',
};
const url = 'https://github.com/acme/shop/pull/42#issuecomment-1';
const ok = (body) => ({ ok: true, json: async () => body });
const comment = (extra = {}) => ({
  user: { login: 'reviewer' },
  created_at: options.since,
  body: options.summary,
  html_url: url,
  ...extra,
});

beforeEach(() => {
  githubRest.mockReset();
  githubRest.mockImplementation(async (_cfg, method, route) => {
    if (route === '/user') return ok({ login: 'reviewer' });
    return ok(method === 'POST' ? { html_url: url } : []);
  });
});

describe('code review overview publication', () => {
  it('posts stdout as an overview even when there are no findings', async () => {
    expect(await ensureCodeReviewOverview(cfg, options)).toBe(url);
    expect(githubRest).toHaveBeenCalledWith(
      cfg,
      'POST',
      '/repos/acme/shop/issues/42/comments',
      {
        body: `<!-- briareus-code-review:session:0 -->\n\n${options.summary}`,
      },
      expect.anything(),
    );
  });

  it('adds the overview heading when the CLI ignored the requested format', async () => {
    await ensureCodeReviewOverview(cfg, { ...options, summary: 'Review output.' });
    expect(githubRest.mock.calls.at(-1)[3].body).toContain('# Code Review\n\nReview output.');
  });

  it.each([
    comment(),
    comment({ body: '# Code Review\n\nDifferent final wording.' }),
    comment({
      created_at: '2026-10-28T00:00:00Z',
      body: '<!-- briareus-code-review:session:0 -->\nPrevious attempt',
    }),
  ])('does not duplicate a published overview or a retried fallback', async (existing) => {
    githubRest.mockResolvedValueOnce(ok({ login: 'reviewer' })).mockResolvedValueOnce(ok([existing]));
    expect(await ensureCodeReviewOverview(cfg, options)).toBe(url);
    expect(githubRest.mock.calls.every((call) => call[1] === 'GET')).toBe(true);
  });

  it.each([
    comment({ user: { login: 'someone-else' } }),
    comment({ created_at: '2026-10-28T00:00:00Z' }),
    comment({ body: 'An unrelated inline review was posted.' }),
  ])(
    'does not mistake another author, an old review, or unrelated text for this overview',
    async (existing) => {
      githubRest.mockResolvedValueOnce(ok({ login: 'reviewer' })).mockResolvedValueOnce(ok([existing]));
      await ensureCodeReviewOverview(cfg, options);
      expect(githubRest.mock.calls.at(-1)[1]).toBe('POST');
    },
  );

  it('checks later comment pages before publishing', async () => {
    githubRest
      .mockResolvedValueOnce(ok({ login: 'reviewer' }))
      .mockResolvedValueOnce(ok(Array(100).fill(comment({ body: 'Unrelated' }))))
      .mockResolvedValueOnce(ok([comment()]));
    await ensureCodeReviewOverview(cfg, options);
    expect(githubRest.mock.calls.at(-1)[2]).toContain('page=2');
    expect(githubRest.mock.calls.every((call) => call[1] === 'GET')).toBe(true);
  });

  it('fails without posting when comment verification is unavailable', async () => {
    githubRest
      .mockResolvedValueOnce(ok({ login: 'reviewer' }))
      .mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(ensureCodeReviewOverview(cfg, options)).rejects.toThrow('403');
    expect(githubRest.mock.calls.every((call) => call[1] === 'GET')).toBe(true);
  });

  it('fails when GitHub rejects the overview', async () => {
    githubRest
      .mockResolvedValueOnce(ok({ login: 'reviewer' }))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce({ ok: false, status: 422 });
    await expect(ensureCodeReviewOverview(cfg, options)).rejects.toThrow('422');
  });

  it.each(['', 'x'.repeat(65_537)])('does not post an empty or oversized artifact', async (summary) => {
    await expect(ensureCodeReviewOverview(cfg, { ...options, summary })).rejects.toThrow();
    expect(githubRest.mock.calls.every((call) => call[1] === 'GET')).toBe(true);
  });

  it('does not post after cancellation during the comment read', async () => {
    let canceled = false;
    githubRest.mockResolvedValueOnce(ok({ login: 'reviewer' })).mockImplementationOnce(async () => {
      canceled = true;
      return ok([]);
    });
    await expect(ensureCodeReviewOverview(cfg, { ...options, canceled: () => canceled })).rejects.toThrow(
      'canceled',
    );
    expect(githubRest.mock.calls.every((call) => call[1] === 'GET')).toBe(true);
  });
});
