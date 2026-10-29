// @ts-check
// Invalid or incomplete output is an error, never an empty, successful review.
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];

function text(value, name, required = false, max = 15000) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error(`Invalid review ${name}`);
  return value;
}

function line(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000000) throw new Error('Invalid finding line');
  return value;
}

export function reviewOutput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid review output');
  const summary = text(input.summary, 'summary', true);
  if (!Array.isArray(input.findings) || input.findings.length > 100)
    throw new Error('Review output must contain a findings array (at most 100)');
  const findings = input.findings.map((f) => {
    if (!f || typeof f !== 'object' || !REVIEW_SEVERITIES.includes(f.severity ?? 'unknown'))
      throw new Error('Invalid finding severity');
    const path = f.path == null ? null : text(f.path, 'path', true, 1024);
    if (path && (path.startsWith('/') || path.split('/').includes('..') || /[\x00-\x1f\\]/.test(path)))
      throw new Error('Finding path must be relative to the repository');
    const startLine = path ? line(f.startLine) : null;
    const endLine = path ? line(f.endLine ?? f.startLine) : null;
    const side = path ? f.side || 'RIGHT' : null;
    if (path && (endLine < startLine || !['LEFT', 'RIGHT'].includes(side)))
      throw new Error('Invalid finding location');
    if (f.shouldFix != null && typeof f.shouldFix !== 'boolean')
      throw new Error('Invalid reviewer shouldFix');
    const category = f.category ?? 'uncategorized';
    if (typeof category !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(category))
      throw new Error('Invalid finding category');
    if (f.reviewerVerdict != null && !['CONFIRMED', 'PLAUSIBLE'].includes(f.reviewerVerdict))
      throw new Error('Invalid original reviewer verdict');
    return {
      title: text(f.title, 'title', true, 500),
      shortSummary: text(f.shortSummary, 'short summary', false, 255),
      category,
      failureScenario: text(f.failureScenario, 'failure scenario'),
      reviewerVerdict: f.reviewerVerdict ?? null,
      severity: f.severity ?? 'unknown',
      details: text(f.details, 'details', true),
      proof: text(f.proof, 'proof'),
      comments: text(f.comments, 'comments'),
      path,
      startLine,
      endLine,
      side,
      reviewerShouldFix: f.shouldFix ?? null,
    };
  });
  return { summary, findings };
}
