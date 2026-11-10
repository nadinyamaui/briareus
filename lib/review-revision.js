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
import { approvalPolicyOf, assessRisk, policyFingerprint } from './review-risk.js';

const PAGE = 100;
// GitHub lists no more of a pull request's files than this, however many it changes.
export const MAX_FILES = 3000;
// Nor more of its commits than 250.
const MAX_COMMIT_PAGES = 3;
// Far more reviews than a pull request gets; past it the read says it could not finish.
const MAX_REVIEW_PAGES = 10;
// GitHub is asked while a review waits to start: an answer that never comes is a failure.
const READ_TIMEOUT_MS = 20_000;
// A read that keeps failing is given up after this many attempts in a row, a minute
// apart at first and doubling: the assessment then stays unknown until the pull request
// moves or the policy changes.
export const OBSERVE_ATTEMPTS = 6;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

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
let server = { token: /** @type {string | undefined} */ (undefined), login: '' };
/** @param {{ githubToken?: string }} cfg */
export async function serverGithubLogin(cfg) {
  if (server.login && server.token === cfg.githubToken) return server.login;
  const login = (await readJson(cfg, '/user', 'the server’s GitHub account'))?.login;
  if (!login) throw new Error('GitHub did not say which account the server’s token is');
  server = { token: cfg.githubToken, login };
  return login;
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
 * The changed files of a pull request at `headSha`, and who wrote it.
 *
 * `complete` is true only when the list is known to be the whole change of that head:
 * the pull request was at that head before and after the pages were read, and as many
 * files were listed as it says it changes. Otherwise `incomplete` says why
 * (`head_moved`, `too_many_files`, `list_incomplete`), and whatever was read is returned
 * for what it is worth. A GitHub error throws.
 *
 * `authors` is the pull request's author and the accounts on its commits; its
 * `complete` is false when GitHub lists fewer commits than the pull request has.
 * @param {{ githubToken?: string }} cfg @param {string} repo @param {number} prNumber
 * @param {{ headSha: string }} revision
 */
export async function readRevisionFacts(cfg, repo, prNumber, { headSha }) {
  const readPull = () => readJson(cfg, `/repos/${repo}/pulls/${prNumber}`, 'the pull request');
  const pull = await readPull();
  const baseRef = pull?.base?.ref ?? null;
  const author = pull?.user?.login ?? null;
  const moved = {
    baseRef,
    files: [],
    complete: false,
    incomplete: 'head_moved',
    detail: null,
    authors: null,
  };
  if (pull?.head?.sha !== headSha) return moved;
  const files = [];
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
  const logins = new Set();
  let commits = 0;
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    const list = await readJson(
      cfg,
      `/repos/${repo}/pulls/${prNumber}/commits?per_page=${PAGE}&page=${page}`,
      'the pull request’s commits',
    );
    if (!Array.isArray(list)) throw new Error('GitHub answered no list of commits');
    commits += list.length;
    for (const commit of list)
      for (const login of [commit?.author?.login, commit?.committer?.login])
        // GitHub's own committer for what was done in its web interface.
        if (login && login !== 'web-flow') logins.add(String(login));
    if (list.length < PAGE) break;
  }
  // A push while the pages were being read leaves a list of two revisions.
  if ((await readPull())?.head?.sha !== headSha) return moved;
  const expected = Number.isInteger(pull.changed_files) ? pull.changed_files : null;
  const whole = expected != null && files.length === expected;
  return {
    baseRef,
    files,
    complete: whole,
    incomplete: whole ? null : files.length >= MAX_FILES ? 'too_many_files' : 'list_incomplete',
    detail: whole ? null : `${files.length} of ${expected ?? 'an unknown number of'} files listed`,
    authors: {
      author,
      commits: [...logins],
      complete: Number.isInteger(pull.commits) && commits >= pull.commits,
    },
  };
}

const retryDelay = (attempts) => Math.min(RETRY_FIRST_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);

/**
 * Bring what the server holds about a pull request's revision up to date, for a project
 * with an approval policy: the assessment of its changed files, who wrote it, and, when
 * the project accepts approvals given on GitHub, those. Resolves with the stored record,
 * or null for a project without a policy, for which nothing is read or written.
 *
 * The files are read once per revision and policy: an assessment already stored for
 * this head and base branch under these rules stands, unless its read failed and is due
 * again. The reviews are read every time for a project that accepts them, since an
 * approval or its dismissal on GitHub changes nothing the server would otherwise notice.
 *
 * Never throws for GitHub's sake: a failure is stored as an unknown assessment (the
 * highest tier), with when to try again. A database failure does throw.
 * @param {any} project @param {number} prNumber
 * @param {{ headSha?: string | null, baseRef?: string | null }} revision
 * @param {{
 *   cfg: { githubToken?: string }, now?: () => number,
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
  { cfg, now = Date.now, directory = NO_DIRECTORY, labelStep = null },
) {
  const policy = approvalPolicyOf(project);
  if (!policy) return null;
  const stored = await getCodeReviewRisk(project.repo, prNumber);
  const headSha = revision.headSha || null;
  if (!headSha) return stored;
  const policyHash = policyFingerprint(policy);
  const same =
    !!stored &&
    stored.headSha === headSha &&
    (!revision.baseRef || !stored.baseRef || stored.baseRef === revision.baseRef) &&
    stored.policyHash === policyHash;
  const due = same && !!stored.retryAt && Date.parse(stored.retryAt) <= now();
  // The reviews are read for a project that counts approvals given on GitHub, and once
  // when a review's label step has just run, whatever the project counts: what that step
  // approved is recorded as the review's own while the server still knows it was, so that
  // it is not taken for a person's if the project comes to count GitHub approvals later.
  const readReviews = policy.acceptGithubApprovals || !!labelStep;
  if (same && !due && !readReviews) return stored;

  let { assessment = null, authors = null } = same ? stored : {};
  let baseRef = revision.baseRef || (same ? stored.baseRef : null);
  let reviewsSyncedAt = null;
  /** @type {any} */
  let failure = null;
  if (!same || due) {
    try {
      if (!cfg.githubToken) throw new Error('No GITHUB_TOKEN is configured');
      const facts = await readRevisionFacts(cfg, project.repo, prNumber, { headSha });
      assessment = assessRisk({ policy, ...facts });
      authors = facts.authors;
      baseRef ||= facts.baseRef;
    } catch (e) {
      failure = e;
      assessment = assessRisk({ policy, complete: false, incomplete: 'github_error', detail: e.message });
    }
  }
  if (readReviews && !failure) {
    try {
      // Without knowing which account is the server's, its approval could not be told
      // from a person's.
      const serverLogin = await serverGithubLogin(cfg);
      const reviews = await pullReviews(cfg, project.repo, prNumber);
      await syncGithubCodeReviewApprovals(
        project.repo,
        prNumber,
        githubApprovalRows(reviews, {
          headSha,
          baseRef,
          serverLogin,
          linkedLogins: directory.linkedLogins(),
          author: authors?.author ?? null,
          commitAuthors: authors?.commits || [],
          labelStep,
        }),
      );
      reviewsSyncedAt = now();
    } catch (e) {
      // Only a project that counts those approvals waits for this read to be made again.
      if (policy.acceptGithubApprovals) failure = e;
      else console.error(`Reviews of ${project.repo}#${prNumber}: ${e.message}`);
    }
  }
  // A read of the files that failed and is not due again yet still waits for its turn:
  // reading the reviews in between settles nothing about it.
  if (!failure && same && !due && stored.retryAt)
    return saveCodeReviewRisk(project.repo, prNumber, {
      ...stored,
      reviewsSyncedAt,
      retryAt: Date.parse(stored.retryAt),
    });
  const attempts = failure ? (same ? stored.attempts : 0) + 1 : 0;
  return saveCodeReviewRisk(project.repo, prNumber, {
    headSha,
    baseRef,
    policyHash,
    tier: assessment.tier,
    complete: !assessment.unknown,
    assessment,
    authors,
    reviewsSyncedAt,
    error: failure ? failure.message : null,
    attempts,
    retryAt: !failure
      ? null
      : attempts >= OBSERVE_ATTEMPTS
        ? null
        : failure.rateLimited && failure.retryAt
          ? failure.retryAt
          : now() + retryDelay(attempts),
  });
}
