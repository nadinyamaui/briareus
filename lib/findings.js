// @ts-check
// Review findings and the must-fix verdicts on them.
//
// The findings themselves live on the pull request: every review's summary
// comment ends with a machine-readable `<!-- reviewer:findings [...] -->`
// block (part of the shared review instructions in providers.js), so GitHub is
// the source of truth and this module only parses it. What the app owns is the
// operator's decision per finding (fix / optional / dismissed) stored in the
// `review_findings` table and mirrored onto the PR as one anchored
// "Required fixes" checklist comment, which a later review is instructed to
// tick as pushes actually fix items.
//
// Findings are keyed by a hash of their title: the title is the one thing the
// block, the stored decision and the checklist comment all carry, so it is the
// join key across all three.

import crypto from 'crypto';
import { getConfig } from './config.js';
import { githubRest } from './github.js';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR } from './markers.js';
import { loadFindingDecisions, saveFindingDecision } from './db.js';

const FINDINGS_BLOCK_RE = /<!--\s*reviewer:findings\s*([\s\S]*?)-->/gi;
const FIX_ITEM_RE = /-\s*\[([ xX])\][^\n]*?<!--\s*fix:([0-9a-f]{12})\s*-->/g;

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const DECISIONS = ['fix', 'optional', 'dismissed'];

// Why a finding was left out of the fix turn, for the caller to say so.
export const PARK_REASONS = {
  severity: 'below this round’s severity floor',
  'out-of-diff': 'on a file this pull request does not change',
};

export function findingKey(title) {
  const normalized = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// reading the PR
// ---------------------------------------------------------------------------

// The PR's issue comments: where `gh pr comment` posts, so both the review
// summaries and the checklist live here. Capped at three pages; a PR with more
// than 300 comments has bigger problems than a stale findings panel.
async function issueComments(cfg, repo, prNumber) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await githubRest(
      cfg,
      'GET',
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!res.ok) throw new Error(`GitHub answered ${res.status} listing PR #${prNumber} comments`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

// The files the pull request actually changes, as GitHub spells them. Answers
// null rather than a partial set when the diff is wider than the three pages
// read here: a finding is only ever parked for being outside the diff, so a
// list that might be missing its file has to fail open.
async function prPaths(cfg, repo, prNumber) {
  const paths = new Set();
  for (let page = 1; page <= 3; page++) {
    const res = await githubRest(
      cfg,
      'GET',
      `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    if (!res.ok) throw new Error(`GitHub answered ${res.status} listing PR #${prNumber} files`);
    const rows = await res.json();
    for (const row of rows) if (row && row.filename) paths.add(String(row.filename));
    if (rows.length < 100) return paths;
  }
  return null;
}

// A review states a finding's file the way the diff does; a leading ./ or / is
// the one variation worth absorbing rather than reading as a different file.
function normalizePath(file) {
  return String(file || '')
    .trim()
    .replace(/^\.?\//, '');
}

// Every finding the PR's review comments declare, merged across reviews in
// posting order, so a later review re-declaring the same title (same key)
// overrides the earlier entry.
function parseFindings(comments) {
  const findings = new Map(); // key -> { key, severity, title, file, line }
  for (const comment of comments) {
    for (const match of String(comment.body || '').matchAll(FINDINGS_BLOCK_RE)) {
      let entries;
      try {
        entries = JSON.parse(match[1].trim());
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        const title = String((e && e.title) || '')
          .trim()
          .slice(0, 200);
        if (!title) continue;
        const severity = SEVERITIES.includes(e.severity) ? e.severity : 'medium';
        const line = Number.isInteger(e.line) && e.line > 0 ? e.line : null;
        const key = findingKey(title);
        findings.set(key, { key, severity, title, file: String(e.file || '').trim() || null, line });
      }
    }
  }
  return findings;
}

// The anchored checklist comment, if the PR carries one: its id (to edit or
// delete) and which items are ticked, by finding key.
function parseRequiredFixes(comments) {
  const comment = [...comments].reverse().find((c) => String(c.body || '').includes(FIXES_ANCHOR));
  if (!comment) return null;
  const checked = new Map();
  for (const m of String(comment.body).matchAll(FIX_ITEM_RE)) {
    checked.set(m[2], m[1] !== ' ');
  }
  return { id: comment.id, url: comment.html_url || null, checked };
}

// ---------------------------------------------------------------------------
// the combined view
// ---------------------------------------------------------------------------

// A short cache so the panel's poll does not hammer GitHub. A decision write
// invalidates it, so the UI never reads its own write stale.
const cache = new Map(); // `${repo}#${pr}` -> { at, value }
const CACHE_MS = 30_000;

async function readPr(repo, prNumber, fresh = false) {
  const key = `${repo.toLowerCase()}#${prNumber}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comments = await issueComments(cfg, repo, prNumber);
  const value = { findings: parseFindings(comments), fixes: parseRequiredFixes(comments) };
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Everything the findings panel shows for one PR: each declared finding with
// its stored decision and, for the ones on the checklist, whether a review
// has ticked it as fixed.
export async function getFindings(repo, prNumber, { fresh = false } = {}) {
  const [{ findings, fixes }, decisions] = await Promise.all([
    readPr(repo, prNumber, fresh),
    loadFindingDecisions(repo, prNumber),
  ]);
  const rank = (s) => SEVERITIES.indexOf(s);
  const list = [...findings.values()]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.title.localeCompare(b.title))
    .map((f) => ({
      ...f,
      decision: decisions.get(f.key)?.decision || null,
      fixed: fixes ? fixes.checked.get(f.key) === true : false,
    }));
  return { findings: list, fixesUrl: fixes ? fixes.url : null };
}

// What one review declared, rather than what the pull request carries in total:
// the newest comment with a findings block, parsed on its own. This is what the
// fix turn works from: the merged view above accumulates every review the PR
// ever got, and re-fixing findings an earlier push already handled is not what
// "fix the feedback you just gave" means. A review that declared no findings
// (an empty block) answers with an empty list rather than falling through to
// the previous review's.
//
// `since` (an ISO timestamp) narrows that to comments posted after a review
// started, which is what makes "this review declared nothing" distinguishable
// from "this review published nothing at all": without it a round that never
// got to publish (no publish instructions configured, a failed publish turn,
// a provider that only left inline comments) answers with the *previous*
// round's findings, and the caller re-feeds work already done.
export async function latestReviewFindings(repo, prNumber, { since = null } = {}) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comments = await issueComments(cfg, repo, prNumber);
  const after = since ? new Date(since).getTime() : null;
  for (let i = comments.length - 1; i >= 0; i--) {
    // The listing is in creation order, so the first comment older than the
    // cut-off means every one left is older too. A comment GitHub gave no
    // timestamp for is read as usual rather than treated as ancient.
    if (after && comments[i].created_at) {
      const at = new Date(comments[i].created_at).getTime();
      if (at < after) break;
    }
    if (!/<!--\s*reviewer:findings/i.test(String(comments[i].body || ''))) continue;
    const found = [...parseFindings([comments[i]]).values()];
    return found.sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.title.localeCompare(b.title),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// the test sheet's verdict
// ---------------------------------------------------------------------------

// The scenarios the test run marked ❌ on the pull request's test sheet: the
// same anchored comment the run turn edits in place (see lib/prtasks.js), so
// the sheet is the source of truth for "did QA pass" exactly as it is for what
// was tested. A row's cells are read from both ends rather than by index: the
// Steps and Expected columns are prose an agent wrote, and one stray pipe in
// them must not turn every later column into the wrong one.
function parseSheetFailures(body) {
  const failures = [];
  for (const line of String(body || '').split('\n')) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.split('|').map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length < 6) continue;
    const status = cells[cells.length - 2];
    if (!status.includes('❌')) continue;
    const number = cells[0].replace(/[^0-9]/g, '');
    if (!number) continue; // the header row, and anything else without a number
    failures.push({
      number,
      scenario: cells[1],
      expected: cells[cells.length - 3],
      evidence: cells[cells.length - 1],
    });
  }
  return failures;
}

// What the newest test sheet on the PR says failed. No sheet at all answers
// with an empty list, since "nothing failed" and "nothing ran" are the same thing
// to the caller, which only ever asks in order to react to failures.
export async function latestTestFailures(repo, prNumber) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comments = await issueComments(cfg, repo, prNumber);
  const sheet = [...comments].reverse().find((c) => String(c.body || '').includes(TEST_SHEET_ANCHOR));
  return sheet ? parseSheetFailures(sheet.body) : [];
}

// ---------------------------------------------------------------------------
// deciding
// ---------------------------------------------------------------------------

// Titles land inside a markdown line that also carries an HTML-comment key,
// so a stray comment marker in the title must not eat the rest of the line.
function safeTitle(title) {
  return String(title)
    .replace(/<!--|-->/g, ' ')
    .trim();
}

function fixesBody(items, checked) {
  const lines = items.map((f) => {
    const box = checked.get(f.key) ? 'x' : ' ';
    const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
    return `- [${box}] **${f.severity.toUpperCase()}**: ${safeTitle(f.title)}${loc} <!-- fix:${f.key} -->`;
  });
  return [
    FIXES_ANCHOR,
    '## Required fixes',
    '',
    'These review findings must be addressed before this pull request merges:',
    '',
    ...lines,
    '',
    '_Managed by the reviewer dashboard. An item is ticked when a later review verifies its fix is on the branch._',
  ].join('\n');
}

// Rebuild the checklist comment from the current fix-decided findings,
// preserving the ticks the reviews have made. No fix-decided findings left
// means no comment: an existing one is deleted rather than left claiming work.
async function syncRequiredFixes(repo, prNumber) {
  const cfg = getConfig();
  const { findings, fixes } = await readPr(repo, prNumber, true);
  const decisions = await loadFindingDecisions(repo, prNumber);
  const items = [...findings.values()]
    .filter((f) => decisions.get(f.key)?.decision === 'fix')
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.title.localeCompare(b.title),
    );
  const checked = fixes ? fixes.checked : new Map();

  if (!items.length) {
    if (fixes) await githubRest(cfg, 'DELETE', `/repos/${repo}/issues/comments/${fixes.id}`);
    return;
  }
  const body = fixesBody(items, checked);
  const res = fixes
    ? await githubRest(cfg, 'PATCH', `/repos/${repo}/issues/comments/${fixes.id}`, { body })
    : await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} writing the Required fixes comment`);
}

// Whether a finding is one to hand to a fix turn at all, or one to record and
// leave alone. Two rules, both about work that is not worth a round trip:
//
//   severity:    below the floor the caller set for this round. The floor is
//                 the review loop's, and it tightens as rounds go by (see
//                 lib/jobs.js): a low found on a later round is nearly always
//                 a note on the code the previous round's fix introduced.
//   out-of-diff: the finding names a file this pull request does not touch.
//                 A review reading the whole repository will occasionally
//                 report something real about code the branch never changed;
//                 that is somebody's next branch, not this one's fix turn.
function parkReason(finding, severityFloor, paths) {
  const severity = SEVERITIES.includes(finding.severity) ? finding.severity : 'medium';
  if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(severityFloor)) return 'severity';
  const file = normalizePath(finding.file);
  if (paths && file && !paths.has(file)) return 'out-of-diff';
  return null;
}

// Put a review round's findings on the checklist so the fix turn that follows
// has somewhere to mark them solved: handing them over to be implemented is
// the decision to fix them. A verdict a person already gave wins, so a finding
// they dismissed or parked as optional is left off the list and out of `kept`.
//
// What is left splits by `parkReason` above. `kept` goes to the fix turn and
// onto the checklist; `parked` is recorded as optional instead: it stays
// visible in the findings panel and in the review's own comment, it just never
// costs a fix turn and a re-review. Recording it is what makes the split
// stick: a later round reads that verdict and leaves the finding alone rather
// than offering it again every time.
//
// A verdict already on record wins over both rules in either direction: a
// finding somebody dismissed or parked never comes back, and one somebody
// asked to have fixed is kept however low it is or wherever it points. The
// rules only decide what to do with a finding nobody has ruled on.
//
// The two halves fail differently, which is why `error` is answered rather
// than thrown: `kept` is what the caller sends to be fixed and must respect
// those verdicts, while mirroring onto GitHub is the part that can fail
// without changing what should happen next.
export async function queueFindingsForFix(repo, prNumber, findings, { severityFloor = 'low' } = {}) {
  const { kept, parked } = await sortFindingsForFix(repo, prNumber, findings, { severityFloor });
  const error = await recordFindingVerdicts(repo, prNumber, [
    ...kept.map((f) => ({ ...f, decision: 'fix' })),
    ...parked.map((f) => ({ ...f, decision: 'optional' })),
  ]);
  return { kept, parked, error };
}

// The read-only half of queueFindingsForFix: the same split, with nothing
// written. A round that is going to be triaged by hand (an orchestrator's,
// see lib/jobs.js) needs the split as advice and the verdicts left open;
// recording "fix" here would be the decision the triage is there to make.
// A finding somebody already dismissed or parked is out of both lists all
// the same: that verdict was the earlier triage's, and stands.
export async function sortFindingsForFix(repo, prNumber, findings, { severityFloor = 'low' } = {}) {
  const cfg = getConfig();
  const decisions = await loadFindingDecisions(repo, prNumber);
  const decisionOf = (f) => decisions.get(f.key || findingKey(f.title))?.decision || null;
  const undecided = (findings || []).filter((f) => !['dismissed', 'optional'].includes(decisionOf(f)));

  let paths = null;
  try {
    paths = await prPaths(cfg, repo, prNumber);
  } catch {
    // The diff could not be read, so the out-of-diff rule does not apply this
    // round. Withholding real findings because a listing failed is the worse
    // half of that trade.
  }

  const kept = [];
  const parked = [];
  for (const f of undecided) {
    const reason = decisionOf(f) === 'fix' ? null : parkReason(f, severityFloor, paths);
    if (reason) parked.push({ ...f, reason });
    else kept.push(f);
  }
  return { kept, parked };
}

// The writing half: store each finding's verdict and mirror the fix-decided
// set onto the checklist. A verdict already on record is left as it is, so a
// re-listed round writes nothing and touches the pull request only when
// something actually changed. Answers the error message rather than
// throwing, for the reason queueFindingsForFix gives: what the caller does
// next does not depend on whether GitHub took the checklist.
async function recordFindingVerdicts(repo, prNumber, verdicts) {
  let error = null;
  try {
    const decisions = await loadFindingDecisions(repo, prNumber);
    let changed = false;
    for (const f of verdicts) {
      const key = f.key || findingKey(f.title);
      const current = decisions.get(key)?.decision || null;
      // The automatic split only fills in blanks; a triage's verdicts
      // (`explicit`) may overturn an earlier one.
      if (current === f.decision) continue;
      if (current !== null && !f.explicit) continue;
      await saveFindingDecision({
        repo,
        prNumber,
        key,
        severity: f.severity || 'medium',
        title: f.title,
        decision: f.decision,
      });
      changed = true;
    }
    if (changed) await syncRequiredFixes(repo, prNumber);
  } catch (e) {
    error = e.message;
  }
  cache.delete(`${repo.toLowerCase()}#${prNumber}`);
  return error;
}

// What a triage comment is opened with, so the panel and a reader skimming
// the pull request can tell it from a review's own summary.
const TRIAGE_HEADING = '## Review triage';

// An orchestrator's verdicts on one review round: recorded like verdicts
// given by hand in the findings panel (so a later round leaves a dismissed
// finding alone), then said on the pull request with the reasons, which is
// where the next reader of that finding looks for why nothing was done about
// it. Every verdict is explicit: a triage may reverse an automatic "optional"
// from an earlier round, or override the severity floor, since the whole
// point of it is judgment the rules do not have. The comment is best-effort
// on top of the record: a verdict the pull request never heard about still
// holds, and the round says so.
export async function recordTriage(repo, prNumber, verdicts, { round = null, by = 'The orchestrator' } = {}) {
  const error = await recordFindingVerdicts(
    repo,
    prNumber,
    verdicts.map((v) => ({ ...v, explicit: true })),
  );
  const waived = verdicts.filter((v) => v.decision !== 'fix');
  if (!waived.length) return { error };
  const cfg = getConfig();
  const lines = waived.map((v) => {
    const loc = v.file ? ` (\`${v.file}${v.line ? `:${v.line}` : ''}\`)` : '';
    const why = v.reason ? `: ${safeTitle(v.reason)}` : '';
    return `- **${String(v.severity || 'medium').toUpperCase()}**: ${safeTitle(v.title)}${loc} — ${
      v.decision === 'dismissed' ? 'dismissed' : 'left optional'
    }${why}`;
  });
  const body = [
    TRIAGE_HEADING + (round ? ` (round ${round})` : ''),
    '',
    `${by} read this round's findings and left these out of the fix that follows:`,
    '',
    ...lines,
    '',
    '_Managed by the reviewer dashboard. A dismissed finding is not offered to the review loop again._',
  ].join('\n');
  try {
    const res = await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} writing the triage comment`);
  } catch (e) {
    return { error: error || e.message };
  }
  return { error };
}

// Set (or clear, with decision null) the verdict on one finding, then mirror
// the fix-decided set onto the PR's checklist comment.
export async function decideFinding(repo, prNumber, key, decision) {
  if (decision != null && !DECISIONS.includes(decision)) {
    throw new Error(`"${decision}" is not a decision; use ${DECISIONS.join(', ')}, or null to clear`);
  }
  const { findings } = await readPr(repo, prNumber, true);
  const finding = findings.get(String(key || ''));
  if (!finding) throw new Error('That finding is no longer on the pull request; refresh and try again');
  await saveFindingDecision({
    repo,
    prNumber,
    key: finding.key,
    severity: finding.severity,
    title: finding.title,
    decision: decision || null,
  });
  await syncRequiredFixes(repo, prNumber);
  cache.delete(`${repo.toLowerCase()}#${prNumber}`);
  return getFindings(repo, prNumber, { fresh: true });
}
