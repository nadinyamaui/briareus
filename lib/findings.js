// @ts-check
// Review findings and the must-fix verdicts on them.
//
// The findings live on the PR, in each review summary's machine-readable
// `<!-- reviewer:findings [...] -->` block (see providers.js); this module only
// parses them. The app owns the per-finding decision (fix / optional /
// dismissed), stored in `review_findings` and mirrored as an anchored
// "Required fixes" checklist comment that later reviews tick.
//
// Findings are keyed by a hash of their title, the one field the block, the
// stored decision and the checklist all carry.

import crypto from 'crypto';
import { getConfig } from './config.js';
import { githubRest, viewerLogin } from './github.js';
import { TEST_SHEET_ANCHOR, FIXES_ANCHOR } from './markers.js';
import { loadFindingDecisions, saveFindingDecision } from './db.js';

const FINDINGS_BLOCK_RE = /<!--\s*reviewer:findings\s*([\s\S]*?)-->/gi;
const FIX_ITEM_RE = /-\s*\[([ xX])\][^\n]*?<!--\s*fix:([0-9a-f]{12})\s*-->/g;

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const DECISIONS = ['fix', 'optional', 'dismissed'];

function capitalize(text) {
  const s = String(text || '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Why a finding was left out of the fix turn, for the caller to say so.
export const PARK_REASONS = {
  value: 'verified, but the benefit does not justify fixing it in this PR',
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

// The PR's issue comments, where review summaries and the checklist live.
// Capped at three pages (300 comments).
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

// The files the PR changes. Null rather than a partial set past three pages,
// so the out-of-diff parking rule fails open.
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

// Absorbs a leading ./ or / so it is not read as a different file.
function normalizePath(file) {
  return String(file || '')
    .trim()
    .replace(/^\.?\//, '');
}

// A link to the finding in the PR's Files changed tab. GitHub anchors a file by
// the sha256 of its path and a line by side and number ("R" is the new side).
export function findingUrl(repo, prNumber, file, line) {
  const base = `https://github.com/${repo}/pull/${prNumber}/files`;
  const path = normalizePath(file);
  if (!path) return base;
  const anchor = crypto.createHash('sha256').update(path).digest('hex');
  return `${base}#diff-${anchor}${line ? `R${line}` : ''}`;
}

// Every finding the PR's reviews declare, merged in posting order so a later
// review re-declaring a title overrides the earlier entry.
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
        const assessment = e.assessment;
        const assessed =
          assessment?.verified === true &&
          typeof assessment.worthFixing === 'boolean' &&
          typeof assessment.evidence === 'string' &&
          assessment.evidence.trim() &&
          typeof assessment.reason === 'string' &&
          assessment.reason.trim();
        findings.set(key, {
          key,
          severity,
          title,
          file: String(e.file || '').trim() || null,
          line,
          ...(assessed
            ? {
                assessment: {
                  verified: true,
                  evidence: assessment.evidence.trim(),
                  worthFixing: assessment.worthFixing,
                  reason: assessment.reason.trim(),
                },
              }
            : {}),
        });
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

// A short cache for the panel's poll; decision writes invalidate it.
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

// Each declared finding with its stored decision and whether a review has
// ticked it as fixed on the checklist.
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
      url: findingUrl(repo, prNumber, f.file, f.line),
      decision: decisions.get(f.key)?.decision || null,
      fixed: fixes ? fixes.checked.get(f.key) === true : false,
    }));
  return { findings: list, fixesUrl: fixes ? fixes.url : null };
}

// What the newest review alone declared, which is what the fix turn works from
// (the merged view would re-feed findings earlier pushes already fixed). An
// empty block answers an empty list, not the previous review's.
//
// `since` (ISO timestamp) limits this to comments after the review started, so
// a round that never published does not answer with the previous round's.
export async function latestReviewFindings(repo, prNumber, options = {}) {
  return (await latestReviewDeclaration(repo, prNumber, options)).findings;
}

// The same read, plus whether the review declared itself clean: its newest
// findings block is a well-formed empty array. Publishing no block at all also
// answers no findings, but is not a clean declaration.
export async function latestReviewDeclaration(
  repo,
  prNumber,
  { since = null, authorLogin = null, authorLogins = [] } = {},
) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comments = await issueComments(cfg, repo, prNumber);
  const after = since ? new Date(since).getTime() : null;
  for (let i = comments.length - 1; i >= 0; i--) {
    // Creation order, so the first older comment ends the scan. One without a
    // timestamp is read rather than treated as ancient.
    if (after && comments[i].created_at) {
      const at = new Date(comments[i].created_at).getTime();
      if (at < after) break;
    }
    // An incomplete review is a result too: do not fall back to an older
    // review or turn unavailable verification into a clean empty list.
    if (/<!--\s*reviewer:incomplete\s*-->/.test(String(comments[i].body || ''))) {
      const error = new Error('Independent review verification is incomplete');
      error.name = 'ReviewIncompleteError';
      throw error;
    }
    if (!/<!--\s*reviewer:findings/i.test(String(comments[i].body || ''))) continue;
    const declared = [...parseFindings([comments[i]]).values()];
    // Reviewers post the summary before inline comments; capture the completed turn's window.
    const publicationBefore = Date.now();
    // Resolve identity before inline lookup can put the shared read token into cooldown.
    const serverAuthor = declared.length && after ? await viewerLogin(cfg) : null;
    let inline = [];
    if (declared.length && after) {
      try {
        inline = await reviewComments(cfg, repo, prNumber);
      } catch {
        // The summary is still valid; retain safe lookup bounds for a later action.
        inline = null;
      }
    }
    const summaryAuthor = comments[i].user?.login || null;
    const publication = {
      after,
      before: publicationBefore,
      ...(declared.length && after && !serverAuthor ? { resolveServerAuthor: true } : {}),
      authors: [
        ...new Set(
          [summaryAuthor, authorLogin, ...authorLogins, serverAuthor]
            .filter(Boolean)
            .map((login) => login.toLowerCase()),
        ),
      ],
    };
    const found = declared.map((finding) => {
      const comment =
        !publication.resolveServerAuthor && inline && matchReviewPublication(finding, inline, publication);
      return {
        ...finding,
        reviewAuthorLogin: comment?.user?.login || summaryAuthor || authorLogin,
        ...(comment ? { reviewCommentId: comment.id } : {}),
        ...(after && !comment ? { reviewPublication: publication } : {}),
      };
    });
    const findings = found.sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.title.localeCompare(b.title),
    );
    return { findings, clean: !findings.length && declaresEmptyBlock(comments[i].body) };
  }
  return { findings: [], clean: false };
}

// Every findings block in the comment parses as an empty array; a malformed
// block is not read as clean.
function declaresEmptyBlock(body) {
  const blocks = [...String(body || '').matchAll(FINDINGS_BLOCK_RE)];
  return (
    blocks.length > 0 &&
    blocks.every((m) => {
      try {
        const entries = JSON.parse(m[1].trim());
        return Array.isArray(entries) && entries.length === 0;
      } catch {
        return false;
      }
    })
  );
}

// ---------------------------------------------------------------------------
// the test sheet's verdict
// ---------------------------------------------------------------------------

// Execution coverage and failures on the PR's test sheet (the anchored comment from
// lib/prtasks.js). Cells are read from both ends, not by index, so a stray pipe
// in the agent-written prose columns cannot shift the later ones.
function parseSheetVerdict(body) {
  const failures = [];
  let total = 0;
  let passed = 0;
  let manual = 0;
  let resultColumns = 0;
  let fence = '';
  let comment = false;
  const lines = String(body || '').split('\n');
  for (const [index, line] of lines.entries()) {
    const row = line.trim();
    // Literal tables inside code fences are examples, not QA coverage.
    const fenceMarker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMarker &&
        fenceMarker[1][0] === fence[0] &&
        fenceMarker[1].length >= fence.length &&
        !fenceMarker[2].trim()
      )
        fence = '';
      continue;
    }
    // Block comments hide sample tables; inline comments inside cells stay cell content.
    if (comment || /^ {0,3}<!--/.test(line)) {
      comment = !line.includes('-->');
      resultColumns = 0;
      continue;
    }
    // Indented code cannot open a results table; existing table rows can be indented.
    if (!resultColumns && /^(?: {4}|\t)/.test(line)) continue;
    if (fenceMarker && (fenceMarker[1][0] !== '`' || !fenceMarker[2].includes('`'))) {
      fence = fenceMarker[1];
      resultColumns = 0;
      continue;
    }
    if (!row || /^(?:#{1,6}(?:\s|$)|(?:[-*_]\s*){3,}$)/.test(row) || (!row.includes('|') && !resultColumns)) {
      resultColumns = 0;
      continue;
    }
    const cells = row.split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    const headers = cells.map((cell) =>
      cell
        .replace(/[*_`~]/g, '')
        .trim()
        .toLowerCase(),
    );
    const delimiter = (lines[index + 1] || '')
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    const tableHeader =
      cells.length > 1 &&
      delimiter.length === cells.length &&
      delimiter.every((cell) => /^:?-+:?$/.test(cell));
    // Custom templates can translate every heading. Numbered rows with QA
    // markers identify that schema without treating ordinary data tables as QA.
    let markedResults = false;
    if (tableHeader && headers.length >= 6) {
      for (let nextIndex = index + 2; nextIndex < lines.length; nextIndex++) {
        const next = lines[nextIndex].trim();
        if (
          !next ||
          /^(?:#{1,6}(?:\s|$)|(?:[-*_]\s*){3,}$|<!--)/.test(next) ||
          /^ {0,3}(?:`{3,}[^`]*$|~{3,})/.test(lines[nextIndex])
        )
          break;
        const values = next.replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
        if (
          values.length === cells.length &&
          /\d/.test(values[0]) &&
          /[✅❌⬜🖐⚠⏭❓🚧🟡🔴]/u.test(values.at(-2))
        ) {
          markedResults = true;
          break;
        }
      }
    }
    const resultsHeader =
      tableHeader &&
      headers.length >= 6 &&
      ((/^(?:status|result|estado|resultado)\b/.test(headers.at(-2)) &&
        /^(?:evidence|evidencia|video)\b/.test(headers.at(-1))) ||
        markedResults) &&
      !cells.some((cell) => /[✅❌⬜🖐⚠⏭❓🚧🟡🔴]/u.test(cell));
    // A matching divider within a results table is a body row, not a new header.
    if (resultsHeader || (tableHeader && (!resultColumns || cells.length !== resultColumns))) {
      resultColumns = resultsHeader ? headers.length : 0;
      continue;
    }
    if (cells.every((cell) => !cell) || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!resultColumns) continue;
    const number = cells[0].replace(/[^0-9]/g, '');
    // Markdown permits omitted trailing cells; missing Status/Evidence still count as coverage.
    while (cells.length < resultColumns) cells.push('');
    const status = cells[cells.length - 2].replace(/(?<=\w)_(?=\w)/g, ' ').replace(/[*_`~]/g, '');
    total++;
    let evidence = cells[cells.length - 1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<img\b([^<>]*)>/gi, (tag, attributes) =>
        [
          ...attributes.matchAll(/(?:^|\s)(?:src|srcset|alt)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi),
        ].some((attribute) => (attribute[1] ?? attribute[2] ?? attribute[3]).trim())
          ? tag
          : '',
      )
      .replace(
        /<hr\b[^<>]*>|<(?!img\b|video\b|audio\b|source\b|embed\b|object\b)[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/>/gi,
        '',
      )
      .replace(/!?\[\s*\]\(\s*\)/g, '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/&(?:nbsp|ensp|emsp(?:13|14)?|numsp|puncsp|thinsp|hairsp|Tab|NewLine|ZeroWidthSpace);/gi, ' ')
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code) => {
        const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
        return point <= 0x10ffff && /[\s\u200b-\u200d\u2060]/u.test(String.fromCodePoint(point))
          ? ' '
          : entity;
      })
      .replace(/[\u200b-\u200d\u2060]/gu, '')
      .trim();
    // Unwrap nested HTML containers, keeping visible text and embedded artifacts.
    let visible;
    do {
      visible = evidence;
      evidence = evidence.replace(/<([a-z][a-z0-9-]*)(?:\s[^<>]*?)?\s*>([^<>]*)<\/\1\s*>/gi, '$2').trim();
    } while (evidence !== visible);
    // Empty HTML and whole-cell Markdown styling do not supply evidence.
    let wrapper;
    while ((wrapper = evidence.match(/^(\*{1,3}|_{1,3}|`+|~~)([\s\S]*?)\1$/))) {
      evidence = wrapper[2].trim();
    }
    // An observed application restriction can be the expected negative-test result.
    const expectedRestriction = cells[cells.length - 3]
      .replace(/[*_`~]/g, '')
      .trim()
      .match(/^(?:cannot|can\s+not|can[’']t|unable\s+to)\s+(?:finish|complete)\s+(.+?)[.!]?$/i)?.[1]
      .toLowerCase();
    // Parse execution annotations separately from their free-form explanations.
    const missingExecution = [status, evidence]
      .flatMap((text) => text.split(/✅|[;,\n(]|\band\b|<br\s*\/?\s*>/i))
      .flatMap((annotation) => {
        // Endpoint path slashes belong to the HTTP procedure's subject.
        const request = annotation.match(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/i)?.[0] || '';
        const parts = annotation.slice(request.length).split(/\/(?!a\b)/i);
        parts[0] = request + parts[0];
        return parts;
      })
      .some((annotation) => {
        const procedure = annotation
          .trim()
          .replace(/[*_`~]/g, '')
          .match(
            /^(?:API|UI|browser|Chromium|Chrome|Firefox|Safari|Edge|Playwright|E2E|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+)(?:\s*:\s*|\s+)(?:(?:(?:(?:regression|smoke)\s+)?tests?(?:\s+suite)?|testing|checks?|automation|execution|verification|validation)(?:\s*:\s*|\s+))*(.*)$/i,
          );
        if (!procedure) return false;
        const predicate = procedure[1]
          .replace(/^(is|was|are|were|has|have|did|does)n[’']t\b/i, '$1 not')
          .replace(/^(?:(?:is|was|are|were|has|have|had|did|does|do|remains?|been|still)\s+)+/i, '')
          .replace(/^attempted\s+but\s+/i, '')
          .replace(/^(?:would|will|may|might|could|should)\s+(?=(?:require|need)\b)/i, '');
        if (
          expectedRestriction &&
          predicate
            .match(/^(?:cannot|can\s+not|can[’']t|unable\s+to)\s+(?:finish|complete)\s+(.+?)[.!]?$/i)?.[1]
            .toLowerCase() === expectedRestriction
        )
          return false;
        if (
          /^(?:blocked|skipped|unknown|pending|manual|incomplete|failed|deferred|waiting|awaiting|omitted)\b/i.test(
            predicate,
          )
        ) {
          // State explanations describe execution; observed business subjects can still pass.
          return !/^(?:blocked|skipped|unknown|pending|manual|incomplete|failed|deferred|waiting|awaiting|omitted)\s+(?!(?:to|by|due|because|waiting|awaiting|until|for|on)\b|[—–:-])(?:\S+\s+)+(?:return(?:s|ed)?|receives?|gets?|sees?|display(?:s|ed)?|appears?|renders?|saved|completed|processed|succeed(?:s|ed)?|persist(?:s|ed)?|denied|rejected|forbidden|shown|(?:cannot|can\s+not|can[’']t)\s+(?:access|enter)|(?:is|was|are|were|remains?)\s+(?!(?:(?:still|currently)\s+)?(?:required|needed|missing|unavailable)\b)\S+)\b/i.test(
            predicate,
          );
        }
        return /^(?:(?:not|never)\s+(?:(?:yet|been|fully|completely)\s+)*(?:run|running|ran|execute|tested|executed|exercised|verified|checked|attempted|covered|performed|complete|completed|started|available|pass|passed|passing|successful|finish|finished|done)\b|(?:only\s+)?(?:partially|partly)\s+(?:tested|executed|exercised|verified|checked|covered|performed|completed)\b|(?:could\s+not|cannot|can\s+not|couldn[’']t|can[’']t|unable\s+to)\s+(?:be\s+)?(?:run|execute|start|started|launch|tested|executed|verified|checked|attempted|completed|finish|finished)\b|(?:yet\s+)?to\s+be\s+(?:run|tested|executed|verified|checked|completed)\b|must\s+be\s+(?:tested\s+manually|manually\s+verified)\b|(?:requires?|needs?)\s+(?:(?:a\s+)?manual\b|to\s+be\s+(?:run|tested|executed|verified|checked|completed)\b)|n\/a\b|🚫|untested\b|unexecuted\b|unavailable\b|excluded\b|in\s+progress\b)/i.test(
          predicate,
        );
      });
    evidence = evidence.replace(/\n/g, ' ');
    const unexecuted =
      missingExecution ||
      /(?:\b(?:API|UI|browser|Chromium|Chrome|Firefox|Safari|Edge)(?:\s*:\s*|\s+(?:(?:is|was)\s+)?)|(?:^|[✅;,(/]|<br\s*\/?\s*>)\s*)(?:blocked|skipped|unknown|pending|manual|failed|deferred|partial|unexecuted|unverified|unavailable|not\s+(?:run|tested|executed|verified|attempted)|in\s+progress)\b(?=\s*(?:$|[().:;,/!?]|<br|✅)|\s+(?:API|UI|due\s+to|because|needs)\b)/i.test(
        status,
      );
    const allPassed = status.includes('✅') && !/[❌⬜🖐⚠⏭❓🚧🟡🔴🚫]/u.test(status) && !unexecuted;
    if (
      allPassed &&
      evidence &&
      !/^(?:[-–—.…]+|n\/a(?:\s*[-–—:]\s*not\s+(?:recorded|captured|available|provided|collected))?|none|tbd|todo|no\s+evidence(?:\s+(?:(?:was|were|has\s+been|have\s+been)\s+)?(?:available|provided|recorded|captured|collected|attached|saved))?(?:\s*(?:[-–—:]|because\b)\s*.+)?|evidence\s+(?:(?:is|was)\s+)?pending|not(?:\s+yet)?\s+(?:run|tested|executed|performed|verified|captured|available|recorded|provided|collected)(?:\s*(?:[-–—:]|because\b)\s*.+)?)[.!]?$/i.test(
        evidence,
      )
    )
      passed++;
    if (/^🖐️?$/.test(status)) manual++;
    if (!status.includes('❌')) continue;
    failures.push({
      number,
      scenario: cells[1],
      expected: cells[cells.length - 3],
      evidence: cells[cells.length - 1],
    });
  }
  return { failures, total, passed, manual, incomplete: total === 0 || passed + failures.length < total };
}

// Missing, empty, manual and unexecuted sheets cannot certify QA.
export async function latestTestVerdict(repo, prNumber) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comments = await issueComments(cfg, repo, prNumber);
  const sheet = [...comments].reverse().find((c) => String(c.body || '').includes(TEST_SHEET_ANCHOR));
  return parseSheetVerdict(sheet?.body);
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

// Rebuild the checklist from the fix-decided findings, keeping existing ticks.
// With none left the comment is deleted rather than left claiming work.
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
    if (fixes) {
      const res = await githubRest(cfg, 'DELETE', `/repos/${repo}/issues/comments/${fixes.id}`);
      if (!res.ok) throw new Error(`GitHub answered ${res.status} deleting the Required fixes comment`);
    }
    return;
  }
  const body = fixesBody(items, checked);
  const res = fixes
    ? await githubRest(cfg, 'PATCH', `/repos/${repo}/issues/comments/${fixes.id}`, { body })
    : await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} writing the Required fixes comment`);
}

// Why a finding should be parked rather than handed to a fix turn, or null:
// judged not worth fixing, below the round's severity floor (which tightens
// over rounds, see lib/jobs.js), or on a file this PR does not touch.
function parkReason(finding, severityFloor, paths) {
  if (finding.assessment?.worthFixing === false) return 'value';
  const severity = SEVERITIES.includes(finding.severity) ? finding.severity : 'medium';
  if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(severityFloor)) return 'severity';
  const file = normalizePath(finding.file);
  if (paths && file && !paths.has(file)) return 'out-of-diff';
  return null;
}

// Splits a round's findings and records the split: `kept` is decided "fix" and
// put on the checklist for the fix turn, `parked` is recorded "optional" so later
// rounds leave it alone. A verdict already on record wins over parkReason in
// either direction. `error` is returned, not thrown, because a failed GitHub
// mirror does not change what the caller should do next.
export async function queueFindingsForFix(repo, prNumber, findings, { severityFloor = 'low' } = {}) {
  const { kept, parked } = await sortFindingsForFix(repo, prNumber, findings, { severityFloor });
  const error = await recordFindingVerdicts(repo, prNumber, [
    ...kept.map((f) => ({ ...f, decision: 'fix' })),
    ...parked.map((f) => ({ ...f, decision: 'optional' })),
  ]);
  return { kept, parked, error };
}

// The read-only half of queueFindingsForFix, used as advice for rounds that are
// triaged by hand (see lib/jobs.js). Already dismissed or optional findings are
// left out of both lists.
export async function sortFindingsForFix(repo, prNumber, findings, { severityFloor = 'low' } = {}) {
  const cfg = getConfig();
  const decisions = await loadFindingDecisions(repo, prNumber);
  const decisionOf = (f) => decisions.get(f.key || findingKey(f.title))?.decision || null;
  const undecided = (findings || []).filter((f) => !['dismissed', 'optional'].includes(decisionOf(f)));

  let paths = null;
  try {
    paths = await prPaths(cfg, repo, prNumber);
  } catch {
    // Fail open: skip the out-of-diff rule rather than withhold real findings.
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

// Stores each verdict and mirrors the fix set onto the checklist, touching the
// PR only when something changed. Returns the error message instead of throwing
// (see queueFindingsForFix).
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

// Tells a triage comment apart from a review's own summary.
const TRIAGE_HEADING = '## Review triage';

// Records a triage's verdicts on one round, then posts the reasons on the PR.
// Verdicts are explicit, so they may overturn earlier automatic ones. The
// comment is best-effort; the recorded verdict holds regardless.
// `by` is a lowercase noun phrase ("the user"), capitalised where it opens a
// sentence.
export async function recordTriage(
  repo,
  prNumber,
  verdicts,
  { round = null, by = 'the orchestrator', note = '' } = {},
) {
  const error = await recordFindingVerdicts(
    repo,
    prNumber,
    verdicts.map((v) => ({ ...v, explicit: true })),
  );
  const waived = verdicts.filter((v) => v.decision !== 'fix');
  // The round's note is posted too, or with nothing to fix it would go nowhere.
  const text = String(note || '').trim();
  if (!waived.length && !text) return { error };
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
    lines.length
      ? `${capitalize(by)} read this round's findings and left these out of the fix that follows:`
      : `${capitalize(by)} read this round's findings and sent every one of them to be fixed.`,
    ...(lines.length ? ['', ...lines] : []),
    ...(text ? ['', `**Note:** ${safeTitle(text)}`] : []),
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

// Posts the reasons and note typed on a held round before ruling, so they reach
// the PR even if the round is never completed. One anchored comment per round,
// rewritten on every save and deleted when nothing is left to say. `comments`
// are findings with `reason` and optional draft `decision`. Resolves to the
// comment's url, or null when nothing was posted.
export async function postTriageNotes(
  repo,
  prNumber,
  sessionId,
  comments,
  { note = '', round = null, standalone = false, by = 'the user' } = {},
) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const anchor = triageNotesAnchor(sessionId);
  const existing = [...(await issueComments(cfg, repo, prNumber))]
    .reverse()
    .find((c) => String(c.body || '').includes(anchor));
  const said = comments.filter((c) => String(c.reason || '').trim());
  const text = String(note || '').trim();
  if (!said.length && !text) {
    if (existing) {
      const res = await githubRest(cfg, 'DELETE', `/repos/${repo}/issues/comments/${existing.id}`);
      if (!res.ok) {
        throw new Error(`GitHub answered ${res.status} removing the triage notes comment`);
      }
    }
    return null;
  }
  const lines = said.map((c) => {
    const loc = c.file ? ` (\`${c.file}${c.line ? `:${c.line}` : ''}\`)` : '';
    const pick = DECISIONS.includes(c.decision) ? ` — ${c.decision === 'fix' ? 'to fix' : c.decision}` : '';
    return `- **${String(c.severity || 'medium').toUpperCase()}**: ${safeTitle(c.title)}${loc}${pick}: ${safeTitle(c.reason)}`;
  });
  const body = [
    anchor,
    `${TRIAGE_HEADING} notes${standalone ? '' : round ? ` (round ${round})` : ''}`,
    '',
    `${capitalize(by)} is reading this ${standalone ? 'review' : 'round'}'s findings and left these comments so far:`,
    '',
    ...lines,
    ...(text ? [...(lines.length ? [''] : []), `**Note:** ${safeTitle(text)}`] : []),
    '',
    '_Managed by the reviewer dashboard. Updated on every save; the verdicts follow when the review is completed._',
  ].join('\n');
  const res = existing
    ? await githubRest(cfg, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body })
    : await githubRest(cfg, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} writing the triage notes comment`);
  const json = await res.json().catch(() => null);
  return (json && json.html_url) || (existing && existing.html_url) || null;
}

// Keyed by session, so two held rounds on one PR each keep their own comment.
function triageNotesAnchor(sessionId) {
  return `<!-- reviewer:triage-notes ${String(sessionId).replace(/[^\w.-]/g, '')} -->`;
}

// ---------------------------------------------------------------------------
// taking a finding out of a review
// ---------------------------------------------------------------------------

// The PR's inline review comments, with the same three-page cap.
async function reviewComments(cfg, repo, prNumber) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await githubRest(
      cfg,
      'GET',
      `/repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!res.ok) throw new Error(`GitHub answered ${res.status} listing PR #${prNumber} review comments`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

// GitHub answers `line: null` once the code moved out of the diff, keeping the
// original in `original_line`.
function commentLine(comment) {
  const line = comment.line != null ? comment.line : comment.original_line;
  return Number.isInteger(line) ? line : null;
}

// The comment a finding was posted as: matched by file and line, then by title
// on that file (GitHub may have re-anchored it), then by title alone. Findings
// only listed in the summary match nothing, which is not a failure. Comments
// at the finding's line from more than one thread (a new comment beside a
// follow-up reply on an old thread) belong to different findings, so only the
// title picks among them; replies within one thread still leave its first
// comment. A lineless finding takes its file's only top-level comment, and only
// while every comment on the file sits in that comment's thread: a follow-up
// reply from another thread may be this finding's own restatement, so the new
// comment beside it can belong to some other finding.
function matchFindingComment(finding, comments) {
  const path = normalizePath(finding.file);
  const title = String(finding.title || '')
    .trim()
    .toLowerCase();
  const says = (c) =>
    !!title &&
    String(c.body || '')
      .toLowerCase()
      .includes(title);
  const onFile = path ? comments.filter((c) => normalizePath(c.path) === path) : [];
  const atLine = finding.line ? onFile.filter((c) => commentLine(c) === finding.line) : [];
  const threads = new Set(atLine.map((c) => c.in_reply_to_id || c.id));
  const tops = onFile.filter((c) => !c.in_reply_to_id);
  const soleThread =
    !finding.line && tops.length === 1 && onFile.every((c) => (c.in_reply_to_id || c.id) === tops[0].id);
  return (
    atLine.find(says) ||
    (threads.size === 1 ? atLine[0] : null) ||
    onFile.find(says) ||
    (soleThread ? tops[0] : null) ||
    comments.find(says) ||
    null
  );
}

// Require the publication's title heading, not a passing quotation in a discussion.
// Compare location across all known turn authors before falling back to a title.
function matchReviewPublication(finding, comments, { after, before, authors }) {
  const titled = comments.filter(
    (c) =>
      after &&
      Date.parse(c.created_at) >= after &&
      (!before || Date.parse(c.created_at) <= before) &&
      (!normalizePath(finding.file) || normalizePath(c.path) === normalizePath(finding.file)) &&
      authors.includes(c.user?.login?.toLowerCase()) &&
      String(c.body || '')
        .trim()
        .split('\n', 1)[0]
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*/g, '')
        .replace(/^(critical|high|medium|low)(?:\s*[—–-]\s*(?:follow-up|optional))?\s*[:—–-]\s*/i, '')
        .trim()
        .toLowerCase() === finding.title.trim().toLowerCase(),
  );
  return matchFindingComment(finding, titled);
}

// Rewrites this review's findings block without one finding, since everything
// else reads the block and would offer it again. Only the JSON is touched.
async function dropFindingFromBlock(cfg, repo, prNumber, key, since) {
  const comments = await issueComments(cfg, repo, prNumber);
  const after = since ? new Date(since).getTime() : null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (after && comment.created_at && new Date(comment.created_at).getTime() < after) break;
    const body = String(comment.body || '');
    if (!/<!--\s*reviewer:findings/i.test(body)) continue;
    let dropped = false;
    const next = body.replace(FINDINGS_BLOCK_RE, (whole, json) => {
      let entries;
      try {
        entries = JSON.parse(String(json).trim());
      } catch {
        return whole;
      }
      if (!Array.isArray(entries)) return whole;
      const kept = entries.filter(
        (e) =>
          findingKey(
            String((e && e.title) || '')
              .trim()
              .slice(0, 200),
          ) !== key,
      );
      if (kept.length === entries.length) return whole;
      dropped = true;
      return `<!-- reviewer:findings\n${JSON.stringify(kept, null, 2)}\n-->`;
    });
    if (!dropped) return false;
    const res = await githubRest(cfg, 'PATCH', `/repos/${repo}/issues/comments/${comment.id}`, {
      body: next,
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} rewriting the review's findings block`);
    return true;
  }
  return false;
}

// A saved publication ID pins the comment across account changes. Older findings
// use the matching below. With `since`, any comment
// posted since the review began counts, plus the review author's replies: a
// still-unfixed earlier finding is restated as a reply on its old thread.
// GitHub lists them oldest first, so the review's own comment wins over a reply
// posted on it later. Other people's replies never count, and neither does any
// reply without `since` or when the review author's login cannot be read.
async function findingComment(cfg, repo, prNumber, finding, since, authorLogin) {
  const comments = await reviewComments(cfg, repo, prNumber);
  if (finding.reviewCommentId) {
    return comments.find((c) => c.id === finding.reviewCommentId) || null;
  }
  if (finding.reviewPublication) {
    const publication = finding.reviewPublication;
    if (publication.resolveServerAuthor) {
      const serverAuthor = await viewerLogin(cfg);
      if (!serverAuthor) throw new Error('Could not read the review publication identity; try again later');
      return matchReviewPublication(finding, comments, {
        ...publication,
        authors: [...publication.authors, serverAuthor.toLowerCase()],
      });
    }
    return matchReviewPublication(finding, comments, publication);
  }
  const after = since ? new Date(since).getTime() : null;
  const me = after ? String(authorLogin || (await viewerLogin(cfg)) || '').toLowerCase() : '';
  const posted = comments.filter((c) => {
    if (after && c.created_at && new Date(c.created_at).getTime() < after) return false;
    if (!c.in_reply_to_id) return true;
    return !!me && String((c.user && c.user.login) || '').toLowerCase() === me;
  });
  return matchFindingComment(finding, posted);
}

// Reply on one finding's thread, as the token's own user. A restated finding's
// follow-up is itself a reply, so the reply goes under its thread's root.
// The PR number must be in the path: the replies endpoint under
// `/pulls/comments/:id` answers 404 on every call.
export async function replyOnFindingThread(
  repo,
  prNumber,
  finding,
  text,
  { since = null, authorLogin = null } = {},
) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Write something to reply with');
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comment = await findingComment(cfg, repo, prNumber, finding, since, authorLogin);
  if (!comment) {
    throw new Error(
      `This finding has no comment of its own on PR #${prNumber} to reply to; the review only listed it in its summary`,
    );
  }
  const res = await githubRest(
    cfg,
    'POST',
    `/repos/${repo}/pulls/${prNumber}/comments/${comment.in_reply_to_id || comment.id}/replies`,
    { body },
  );
  if (!res.ok) throw new Error(`GitHub answered ${res.status} replying on the finding's thread`);
  const created = await res.json();
  return { url: (created && created.html_url) || comment.html_url || null };
}

// Delete one finding from its review: the inline comment (only the follow-up
// reply, for a restated finding), and its entry in the findings block. `since`
// limits this to what the review posted. A failed block rewrite is only a
// warning, since the comment is already gone by then.
export async function deleteFindingFromReview(
  repo,
  prNumber,
  finding,
  { since = null, authorLogin = null } = {},
) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
  const comment = await findingComment(cfg, repo, prNumber, finding, since, authorLogin);
  if (comment) {
    const res = await githubRest(cfg, 'DELETE', `/repos/${repo}/pulls/comments/${comment.id}`);
    // A personal token can get an authorization-hiding 404. Only the server's
    // read identity can confirm that the comment we found is already gone.
    if (res.status === 404) {
      const check = await githubRest(cfg, 'GET', `/repos/${repo}/pulls/comments/${comment.id}`);
      if (check.status !== 404) {
        throw new Error(
          `GitHub answered 404 deleting the finding's review comment; server read answered ${check.status}, so deletion could not be confirmed`,
        );
      }
    }
    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub answered ${res.status} deleting the finding's review comment`);
    }
  }
  const key = finding.key || findingKey(finding.title);
  let declared = false;
  let warning = null;
  try {
    declared = await dropFindingFromBlock(cfg, repo, prNumber, key, since);
  } catch (e) {
    if (!comment) throw e;
    warning = e.message;
  }
  cache.delete(`${repo.toLowerCase()}#${prNumber}`);
  return { commentDeleted: !!comment, undeclared: declared, warning };
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
