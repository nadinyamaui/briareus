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
    const startLine = path && f.startLine != null ? line(f.startLine) : null;
    const endLine = startLine != null ? line(f.endLine ?? f.startLine) : null;
    const side = startLine != null ? f.side || 'RIGHT' : null;
    if (startLine != null && (endLine < startLine || !['LEFT', 'RIGHT'].includes(side)))
      throw new Error('Invalid finding location');
    const recommendation = f.reviewerShouldFix ?? f.shouldFix ?? null;
    if (recommendation != null && typeof recommendation !== 'boolean')
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
      reviewerShouldFix: recommendation,
    };
  });
  return { summary, findings };
}

export function parseReviewExport(text, headSha) {
  const value = JSON.parse(String(text).trim());
  if (value.error) throw new Error(`Review command failed: ${String(value.error).slice(0, 1000)}`);
  if (value.headSha !== headSha) throw new Error('Review output does not match the reviewed commit');
  return reviewOutput(value);
}

// ReportFindings has categories and scenarios, but no severity or proof fields.
// Missing information stays unknown; a native CONFIRMED verdict is not our verifier.
export function nativeReviewOutput(report, summary) {
  if (!Array.isArray(report?.findings)) throw new Error('Invalid native review report');
  return reviewOutput({
    summary: summary || `${report.findings.length} findings reported by /code-review.`,
    findings: report.findings.map((f) => ({
      title: f.summary,
      shortSummary: f.short_summary,
      category: f.category,
      details: f.summary,
      failureScenario: f.failure_scenario,
      path: f.file || null,
      startLine: f.line,
      reviewerVerdict: f.verdict,
    })),
  });
}
