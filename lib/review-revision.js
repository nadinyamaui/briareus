// @ts-check
// What the server reads from GitHub about the revision a pull request is at, for the
// approval requirement (lib/review-risk.js, lib/review-approvals.js): the files the pull
// request changes, who wrote it, and the approvals given on GitHub. Read by the server
// with its own token, never taken from an agent, and kept per pull request so that the
// requirement is computed from the store like the outcome beside it.
//
// A read that fails is not a small change and not an approval. The risk is then unknown,
// which stands as the highest tier; the approvals GitHub holds do not count until they
// can be read; and the read is tried again later, a bounded number of times.
import { githubRest } from './github.js';
import { getCodeReviewRisk, saveCodeReviewRisk, syncGithubCodeReviewApprovals } from './db.js';
import { NO_DIRECTORY, githubApprovalRows } from './review-approvals.js';
import { approvalPolicyOf, assessRisk, assessRiskInBatches, policyFingerprint } from './review-risk.js';

const PAGE = 100;
// GitHub lists no more of a pull request's files than this, however many it changes.
export const MAX_FILES = 3000;
// Nor more of its commits than 250.
const MAX_COMMIT_PAGES = 3;
// Far more reviews than a pull request gets; past it the read says it could not finish.
const MAX_REVIEW_PAGES = 10;
// GitHub is asked while a review waits to start: an answer that never comes is a failure.
const READ_TIMEOUT_MS = 20_000;
// A read that keeps failing is tried again by the sweep this many times in a row, a
// minute apart at first and doubling. After that it is no longer tried by itself, and
// not given up either: whatever computes the outcome again reads it once more when the
// last attempt is this old, and a person's request (an approval) sooner.
export const OBSERVE_ATTEMPTS = 6;
const RETRY_FIRST_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
export const ASKED_RETRY_MS = 15_000;

/** @param {{ githubToken?: string }} cfg @param {string} url @param {string} what */
export async function readJson(cfg, url, what) {
  const res = await githubRest(cfg, 'GET', url, undefined, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} reading ${what}`);
  return res.json();
}

/**
 * Every review of a pull request, oldest first, or a throw: a list cut short would read
 * as approvals that are not there, or miss the one that takes an approval back.
 * @param {{ githubToken?: string }} cfg @param {string} repo @param {number} prNumber
 * @returns {Promise<any[]>}
 */
export async function pullReviews(cfg, repo, prNumber) {
  const all = [];
  for (let page = 1; ; page++) {
    if (page > MAX_REVIEW_PAGES) throw new Error('The pull request has more reviews than can be read');
    const reviews = await readJson(
      cfg,
      `/repos/${repo}/pulls/${prNumber}/reviews?per_page=${PAGE}&page=${page}`,
      'the pull request’s reviews',
    );
    all.push(...reviews);
    if (reviews.length < PAGE) return all;
  }
}

// The account the server's token is: the one whose approvals and statuses are the
// server's own. Asked once per token.
let server = {
  token: /** @type {string | undefined} */ (undefined),
  id: /** @type {number | null} */ (null),
  login: '',
};
/** @param {{ githubToken?: string }} cfg @returns {Promise<{ id: number | null, login: string }>} */
export async function serverGithubAccount(cfg) {
  if (server.login && server.token === cfg.githubToken) return { id: server.id, login: server.login };
  const user = await readJson(cfg, '/user', 'the server’s GitHub account');
  if (!user?.login) throw new Error('GitHub did not say which account the server’s token is');
  server = { token: cfg.githubToken, id: Number.isInteger(user.id) ? user.id : null, login: user.login };
  return { id: server.id, login: server.login };
}

/**
 * The revision a pull request is at as GitHub has it now, for an approval that names the
 * head it approves. Throws when GitHub cannot be read.
 * @param {{ githubToken?: string }} cfg @param {string} repo @param {number} prNumber
 */
export async function readPullRevision(cfg, repo, prNumber) {
  const pull = await readJson(cfg, `/repos/${repo}/pulls/${prNumber}`, 'the pull request');
  return {
    state: pull?.merged ? 'merged' : String(pull?.state || ''),
    headSha: String(pull?.head?.sha || ''),
    baseRef: String(pull?.base?.ref || ''),
    author: pull?.user?.login ?? null,
  };
}

/**
 * The open pull requests of a repository whose head is this commit, by number. A commit
 * status belongs to the commit, so every one of them reads the same statuses: what is
 * written for the commit has to hold for all of them (lib/review-enforcement.js).
 * Throws when the list cannot be read whole.
 * @param {{ githubToken?: string }} cfg @param {string} repo @param {string} sha
 * @returns {Promise<number[]>}
 */
export async function pullsAtHead(cfg, repo, sha) {
  const numbers = [];
  for (let page = 1; ; page++) {
    if (page > MAX_COMMIT_PAGES) throw new Error('The commit is in more pull requests than can be read');
    const list = await readJson(
      cfg,
      `/repos/${repo}/commits/${sha}/pulls?per_page=${PAGE}&page=${page}`,
      `the pull requests at ${sha.slice(0, 7)}`,
    );
    if (!Array.isArray(list)) throw new Error('GitHub answered no list of pull requests');
    // GitHub lists every pull request that contains the commit: one stacked on top of
    // it has another head, and other statuses.
    for (const pull of list)
      if (pull?.state === 'open' && pull.head?.sha === sha && Number.isInteger(pull.number))
        numbers.push(pull.number);
    if (list.length < PAGE) return [...new Set(numbers)].sort((a, b) => a - b);
  }
}

const accountOf = (user) =>
  user?.login ? { id: Number.isInteger(user.id) ? user.id : null, login: String(user.login) } : null;

/**
 * What GitHub says of a pull request at `headSha`: its changed files, and who wrote it.
 * Each is asked for only when `want` says so, and each fails by itself: `files` and
 * `authors` are null with `filesError` / `authorsError` when GitHub could not be read
 * for them, so that one read failing does not throw away what the other learned.
 *
 * `complete` is true only when the file list is known to be the whole change of that
 * head: the pull request was at that head before and after the pages were read, and as
 * many files were listed as it says it changes. Otherwise `incomplete` says why
 * (`head_moved`, `too_many_files`, `list_incomplete`), and whatever was read is returned
 * for what it is worth.
 *
 * `authors` is `{ author, commits, shas, complete }`: the account that opened the pull
 * request, the accounts on its commits (each `{ id, login }`), the commits themselves,
 * and whether that is all of them: GitHub lists 250 commits of a pull request and no
 * more, and past that who wrote the rest is not known.
 *
 * Throws only when the pull request itself cannot be read.
 * @param {{ githubToken?: string }} cfg @param {string} repo @param {number} prNumber
 * @param {{ headSha: string }} revision
 * @param {{ files?: boolean, authors?: boolean }} [want]
 */
export async function readRevisionFacts(cfg, repo, prNumber, { headSha }, want = {}) {
  const wantFiles = want.files !== false;
  const wantAuthors = want.authors !== false;
  const readPull = () => readJson(cfg, `/repos/${repo}/pulls/${prNumber}`, 'the pull request');
  const pull = await readPull();
  const baseRef = pull?.base?.ref ?? null;
  const moved = {
    baseRef,
    moved: true,
    files: wantFiles ? [] : null,
    complete: false,
    incomplete: 'head_moved',
    detail: null,
    filesError: null,
    authors: null,
    authorsError: wantAuthors ? 'the pull request moved on while its commits were being read' : null,
  };
  if (pull?.head?.sha !== headSha) return moved;
  /** @type {any[] | null} */
  let files = null;
  let filesError = null;
  if (wantFiles)
    try {
      files = [];
      for (let page = 1; (page - 1) * PAGE < MAX_FILES; page++) {
        const list = await readJson(
          cfg,
          `/repos/${repo}/pulls/${prNumber}/files?per_page=${PAGE}&page=${page}`,
          'the pull request’s files',
        );
        if (!Array.isArray(list)) throw new Error('GitHub answered no list of files');
        for (const file of list)
          files.push({
            path: String(file?.filename || ''),
            // Where a renamed or copied file was: a rule that covers either path applies.
            previousPath: file?.previous_filename ? String(file.previous_filename) : null,
            status: String(file?.status || ''),
            additions: Number(file?.additions) || 0,
            deletions: Number(file?.deletions) || 0,
          });
        if (list.length < PAGE) break;
      }
    } catch (e) {
      files = null;
      filesError = e;
    }
  let authors = null;
  let authorsError = null;
  if (wantAuthors)
    try {
      /** @type {Array<{ id: number | null, login: string }>} */
      const accounts = [];
      const shas = [];
      for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
        const list = await readJson(
          cfg,
          `/repos/${repo}/pulls/${prNumber}/commits?per_page=${PAGE}&page=${page}`,
          'the pull request’s commits',
        );
        if (!Array.isArray(list)) throw new Error('GitHub answered no list of commits');
        for (const commit of list) {
          if (commit?.sha) shas.push(String(commit.sha));
          for (const user of [commit?.author, commit?.committer]) {
            const account = accountOf(user);
            // GitHub's own committer for what was done in its web interface.
            if (!account || account.login === 'web-flow') continue;
            if (!accounts.some((known) => known.id === account.id && known.login === account.login))
              accounts.push(account);
          }
        }
        if (list.length < PAGE) break;
      }
      authors = {
        author: accountOf(pull.user),
        commits: accounts,
        shas,
        complete: Number.isInteger(pull.commits) && shas.length >= pull.commits,
      };
    } catch (e) {
      authorsError = e.message;
    }
  // A push while the pages were being read leaves lists of two revisions.
  if ((await readPull())?.head?.sha !== headSha) return moved;
  const expected = Number.isInteger(pull.changed_files) ? pull.changed_files : null;
  const whole = !!files && expected != null && files.length === expected;
  return {
    baseRef,
    moved: false,
    files,
    complete: whole,
    incomplete: whole || !files ? null : files.length >= MAX_FILES ? 'too_many_files' : 'list_incomplete',
    detail: whole || !files ? null : `${files.length} of ${expected ?? 'an unknown number of'} files listed`,
    filesError: filesError ? filesError.message : null,
    authors,
    authorsError,
  };
}

const retryDelay = (attempts) => Math.min(RETRY_FIRST_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
// What of an assessment no later read will change: GitHub lists no more files than it
// lists, however often it is asked.
const settled = (assessment) =>
  !!assessment && (!assessment.unknown || assessment.reasons?.[0]?.why === 'too_many_files');

/**
 * Bring what the server holds about a pull request's revision up to date, for a project
 * with an approval policy: the assessment of its changed files, who wrote it, and, when
 * the project accepts approvals given on GitHub, those. Resolves with the stored record,
 * or null for a project without a policy, for which nothing is read or written.
 *
 * Each part is read only while it is missing. An assessment made for this head and base
 * branch under these rules stands, and is never replaced by a worse one: a later read
 * that fails leaves a complete assessment complete. The reviews are read every time for
 * a project that accepts them, since an approval or its dismissal on GitHub changes
 * nothing the server would otherwise notice.
 *
 * A part that could not be read is read again: by the sweep when its next attempt is
 * due, a bounded number of times; after that whenever something computes the outcome
 * and the last attempt is an hour old; and sooner when a person is waiting on it
 * (`asked`). So neither an unknown assessment nor unknown authorship is a dead end, and
 * neither is hammered.
 *
 * Never throws for GitHub's sake: a failure is stored, with an unknown assessment
 * standing as the highest tier and unknown authorship counting no approval. A database
 * failure does throw.
 * @param {any} project @param {number} prNumber
 * @param {{ headSha?: string | null, baseRef?: string | null }} revision
 * @param {{
 *   cfg: { githubToken?: string }, now?: () => number, asked?: boolean,
 *   directory?: import('./review-approvals.js').ApprovalDirectory,
 *   labelStep?: { login?: string | null, known?: number[] | null, since?: number | null } | null,
 * }} options
 * `labelStep` describes a review's label step that just ran, so that an approval it
 * submitted is recorded as the review's own, whatever account it used.
 */
export async function observeRevision(
  project,
  prNumber,
  revision,
  { cfg, now = Date.now, asked = false, directory = NO_DIRECTORY, labelStep = null },
) {
  const policy = approvalPolicyOf(project);
  if (!policy) return null;
  const stored = await getCodeReviewRisk(project.repo, prNumber);
  const headSha = revision.headSha || null;
  if (!headSha) return stored;
  const policyHash = policyFingerprint(policy);
  const sameHead =
    !!stored &&
    stored.headSha === headSha &&
    (!revision.baseRef || !stored.baseRef || stored.baseRef === revision.baseRef);
  // Who wrote a head does not depend on the rules; how risky it is does.
  const kept = sameHead ? stored : null;
  let assessment = kept && kept.policyHash === policyHash ? kept.assessment : null;
  let authors = kept?.authors || null;
  let baseRef = revision.baseRef || kept?.baseRef || null;
  let reviewsSyncedAt = kept?.reviewsSyncedAt ? Date.parse(kept.reviewsSyncedAt) : null;
  const want = { files: !settled(assessment), authors: !authors };
  // The reviews are read for a project that counts approvals given on GitHub, and once
  // when a review's label step has just run, whatever the project counts: what that step
  // approved is recorded as the review's own while the server still knows it was, so that
  // it is not taken for a person's if the project comes to count GitHub approvals later.
  const readReviews = policy.acceptGithubApprovals || !!labelStep;

  // Whether a read that failed before is to be made again now.
  const last = kept?.observedAt ? Date.parse(kept.observedAt) : 0;
  const age = now() - last;
  const due = !!kept?.retryAt && Date.parse(kept.retryAt) <= now();
  const again =
    !kept || !kept.attempts
      ? true
      : due || (asked && age >= ASKED_RETRY_MS) || (!kept.retryAt && age >= RETRY_MAX_MS);
  const readFacts = (want.files || want.authors) && (again || !assessment);
  if (!readFacts && !readReviews) return stored;

  /** @type {string | null} */
  let failure = null;
  /** @type {any} */
  let limited = null;
  let observedAt = kept?.observedAt ? last : now();
  if (readFacts) {
    observedAt = now();
    try {
      if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
      const facts = await readRevisionFacts(cfg, project.repo, prNumber, { headSha }, want);
      baseRef ||= facts.baseRef;
      if (want.files) {
        if (facts.files && !facts.filesError) {
          assessment = await assessRiskInBatches({ policy, ...facts, files: facts.files });
          // A list GitHub cut short is worth asking for again, as a failure is.
          if (!settled(assessment)) failure = `the list of changed files was not whole (${facts.detail})`;
        } else {
          failure = facts.filesError || 'the changed files could not be read';
          assessment ||= assessRisk({ policy, complete: false, incomplete: 'github_error', detail: failure });
        }
        // The server's own idea of the head was behind GitHub's, or a push crossed the
        // read: worth another look, as a failure is.
        if (facts.moved) failure = 'the pull request moved on while it was being read';
      }
      if (want.authors) {
        if (facts.authors) authors = facts.authors;
        else failure ||= facts.authorsError || 'the pull request’s commits could not be read';
      }
    } catch (e) {
      failure = e.message;
      limited = e;
      assessment ||= assessRisk({ policy, complete: false, incomplete: 'github_error', detail: e.message });
    }
  }
  assessment ||= assessRisk({ policy, complete: false, incomplete: 'not_assessed' });
  if (readReviews && !limited) {
    try {
      // Without knowing which account is the server's, its approval could not be told
      // from a person's.
      const account = await serverGithubAccount(cfg);
      // When the list is asked for: a slower read that started earlier must not undo
      // what a later one stored.
      const seenAt = now();
      const reviews = await pullReviews(cfg, project.repo, prNumber);
      await syncGithubCodeReviewApprovals(project.repo, prNumber, {
        ...githubApprovalRows(reviews, {
          headSha,
          baseRef,
          server: account,
          linked: directory.linkedAccounts(),
          authors,
          labelStep,
        }),
        seenAt,
      });
      reviewsSyncedAt = seenAt;
    } catch (e) {
      // Only a project that counts those approvals waits for this read to be made again.
      if (policy.acceptGithubApprovals) {
        failure ||= e.message;
        limited ||= e;
        reviewsSyncedAt = null;
      } else console.error(`Reviews of ${project.repo}#${prNumber}: ${e.message}`);
    }
  }
  // A failure of a read that was not made this time still waits for its turn.
  const pending = !failure && !readFacts && !!kept?.attempts && (want.files || want.authors);
  const attempts = failure ? (kept?.attempts || 0) + 1 : pending ? kept.attempts : 0;
  return saveCodeReviewRisk(project.repo, prNumber, {
    headSha,
    baseRef,
    policyHash,
    tier: assessment.tier,
    complete: !assessment.unknown,
    assessment,
    authors,
    reviewsSyncedAt,
    error: failure || (pending ? kept.error : null),
    attempts,
    retryAt: pending
      ? kept.retryAt
        ? Date.parse(kept.retryAt)
        : null
      : !failure || attempts >= OBSERVE_ATTEMPTS
        ? null
        : limited?.rateLimited && limited.retryAt
          ? limited.retryAt
          : now() + retryDelay(attempts),
    observedAt,
  });
}
