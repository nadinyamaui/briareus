// @ts-check
// Whether a pull request that moved on from its reviewed revision still holds the same
// change, so that the review carries over to the head it has now.
//
// GitHub rebases a pull request by itself: when the one below it in a stack is merged,
// it retargets the one above and replays its commits onto the new base, under new SHAs.
// A person's rebase or "Update branch" with rebase does the same. The code the review
// read is then still the change, line for line, but the outcome compares SHAs and
// would ask for another paid round to read it again.
//
// The change is what the pull request adds to its merge base: the diff GitHub shows as
// "Files changed". The reviewed change is read from the merge base the review's round
// recorded, the current one from the base branch the pull request targets now. The two
// are the same when every file has the same status, name and hunks; the line numbers in
// the hunk headers are left out (what moved above a hunk is not the change), and the
// context lines are kept, so code the base changed right beside the change makes it a
// different change. A file GitHub gives no patch for (a binary, or a diff too large to
// show) is compared by the blob it leaves at the head, which differs whenever anything
// in it does. What cannot be read whole (GitHub lists at most 300 files in a
// comparison) is never the same change.
//
// What is not compared, by design: what the base branch gained around the change. The
// outcome already ignores the base branch gaining commits under an unchanged head; a
// rebase onto those commits is held to the same rule.
import crypto from 'node:crypto';
import { readJson } from './review-revision.js';

// GitHub's comparison lists no more files than this; a list that long may be cut short.
export const MAX_COMPARE_FILES = 300;

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;

/**
 * What a comparison's files amount to as a change, or null when GitHub did not give
 * all of it.
 * @param {any[] | null | undefined} files the `files` of a compare answer
 * @returns {string | null}
 */
export function changeDigest(files) {
  if (!Array.isArray(files) || files.length >= MAX_COMPARE_FILES) return null;
  const parts = [];
  for (const file of files) {
    if (!file?.filename || !file.status) return null;
    let body;
    if (typeof file.patch === 'string') body = `patch\n${file.patch.replace(HUNK, '@@')}`;
    // No patch: a binary, a rename without changes, or a diff GitHub would not show.
    else if (file.status === 'removed') body = 'removed';
    else if (file.sha) body = `blob\n${file.sha}`;
    else return null;
    parts.push([file.status, file.filename, file.previous_filename || '', body].join('\0'));
  }
  parts.sort();
  return crypto.createHash('sha256').update(parts.join('\0\0')).digest('hex');
}

// A ref or a SHA as one side of a compare path: a branch may hold slashes, which
// GitHub reads as part of the name.
const side = (ref) => String(ref).split('/').map(encodeURIComponent).join('/');

/** @param {{ githubToken?: string }} cfg @param {string} repo @param {string} base @param {string} head */
async function compared(cfg, repo, base, head) {
  const answer = await readJson(
    cfg,
    `/repos/${repo}/compare/${side(base)}...${side(head)}`,
    'the change the pull request makes',
  );
  return changeDigest(answer?.files);
}

/**
 * Whether the pull request at `current` makes the change the review read at `reviewed`.
 * Answers the digest both share, or null when they differ or either cannot be read
 * whole. Throws when GitHub cannot be asked; callers treat that as not the same.
 * @param {{ githubToken?: string }} cfg @param {string} repo
 * @param {{ headSha: string, mergeBaseSha: string }} reviewed
 * @param {{ headSha: string, baseRef: string }} current
 * @returns {Promise<string | null>}
 */
export async function sameChange(cfg, repo, reviewed, current) {
  const before = await compared(cfg, repo, reviewed.mergeBaseSha, reviewed.headSha);
  if (!before) return null;
  const after = await compared(cfg, repo, current.baseRef, current.headSha);
  return after === before ? after : null;
}

/**
 * The carry-over that makes the review stand for `current`, among those stored for it,
 * or null. Only one recorded for the review that governs, from its reviewed revision,
 * to this head on this base branch.
 * @param {any[] | null | undefined} carryovers
 * @param {{ id?: number, headSha?: string | null, baseRef?: string | null } | null | undefined} review
 * @param {{ headSha?: string | null, baseRef?: string | null } | null | undefined} current
 */
export function carryoverFor(carryovers, review, current) {
  if (!review?.id || !review.headSha || !current?.headSha || !current.baseRef) return null;
  return (
    (carryovers || []).find(
      (c) =>
        c.codeReviewId === review.id &&
        c.reviewedSha === review.headSha &&
        (c.reviewedBaseRef ?? null) === (review.baseRef ?? null) &&
        c.headSha === current.headSha &&
        c.baseRef === current.baseRef,
    ) || null
  );
}
