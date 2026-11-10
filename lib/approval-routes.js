// @ts-check
import { Router } from 'express';
import { NOTE_MAX, authorshipOf } from './review-approvals.js';
import { approvalPolicyOf } from './review-risk.js';

// A person's approval of a reviewed pull request, recorded and withdrawn through the
// client API (lib/api-v1.js), and the read of how the requirement stands.
//
// This is the one place an approval that counts as a person's is made, so who may reach
// it is the point: only a request the gateway authenticated as a user, with that user's
// own token, a manage permission and the project in its scope. An agent's session token
// opens /api/agent/* and nothing here; no agent route records an approval; and a request
// that reaches these handlers still carrying a credential did not come through the
// gateway, which strips it, and is refused.
//
// What the server cannot tell is who held the client: a script given a person's token
// approves as that person. The approval therefore has to name the head it approves, so
// that at least nothing approves "whatever is there now".

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const refused = (status, code, message, more = {}) =>
  Object.assign(new Error(message), { status, code, more });

/**
 * @param {{
 *   getProject: (repo: string) => any,
 *   outcome: {
 *     read: (project: any, prNumber: number) => Promise<any>,
 *     refresh: (project: any, prNumber: number, current?: { headSha: string, baseRef: string | null } | null) => Promise<any>,
 *   },
 *   store: {
 *     getCodeReviewRisk: (repo: string, prNumber: number) => Promise<any>,
 *     listCodeReviewApprovals: (repo: string, prNumber: number) => Promise<any[]>,
 *     addCodeReviewApproval: (repo: string, prNumber: number, approval: any) => Promise<{ approval: any, created: boolean }>,
 *     withdrawCodeReviewApproval: (repo: string, prNumber: number, id: number, userId: number, options?: { note?: string | null }) => Promise<{ approval: any, changed: boolean }>,
 *   },
 *   readPull: (project: any, prNumber: number) => Promise<{ state: string, headSha: string, baseRef: string, author: string | null }>,
 *   linkedLogin?: (user: { id: number }) => string | null,
 *   ownsWorkOn?: (user: { id: number }, repo: string, prNumber: number) => boolean,
 * }} deps
 * `outcome` reads and recomputes the pull request's outcome with its approval
 * requirement (lib/review-enforcement.js); `readPull` is the pull request as GitHub has
 * it now; `linkedLogin` the GitHub account a user connected, and `ownsWorkOn` whether a
 * session of theirs worked on the pull request, both for the rule on approving one's
 * own change.
 */
export function approvalRoutes({
  getProject,
  outcome,
  store,
  readPull,
  linkedLogin = () => null,
  ownsWorkOn = () => false,
}) {
  const router = Router();
  router.use('/api/pr/approvals', (req, res, next) => {
    if (req.headers.authorization)
      return res.status(403).json({ error: 'Approvals go through /api/v1 with a person’s own token' });
    next();
  });

  const pullOf = (source) => {
    const project = getProject(String(source?.repo || ''));
    if (!project) throw refused(404, 'unknown_project', `Unknown project: ${source?.repo || ''}`);
    const prNumber = Number(source?.pr);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1)
      throw invalid('The PR number must be a whole number');
    return { project, prNumber };
  };
  const note = (value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw invalid('note must be text');
    if (value.length > NOTE_MAX) throw invalid(`note is longer than ${NOTE_MAX} characters`);
    return value.trim() || null;
  };
  const only = (body, allowed) => {
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw invalid(`Unknown approval fields: ${unknown.join(', ')}`);
  };
  const fail = (res, e) =>
    res
      .status(e.status || 503)
      .json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.more || {}) });
  // The requirement after a change, with the outcome it stands beside. A recomputation
  // that failed does not undo the change: it stays owed and the server computes it again
  // (lib/review-enforcement.js), and the answer is the stored reading meanwhile.
  const after = async (project, prNumber, current = null) =>
    outcome.refresh(project, prNumber, current).catch((e) => {
      console.error(`Approval requirement for ${project.repo}#${prNumber}: ${e.message}`);
      return outcome.read(project, prNumber).catch(() => null);
    });
  const answer = (reviewOutcome, id) => ({
    approval: reviewOutcome?.approvals?.approvals?.find((a) => a.id === id) ?? null,
    ...(reviewOutcome ? { approvals: reviewOutcome.approvals, reviewOutcome } : {}),
  });

  // How the requirement stands: the risk tier and why, how many approvals that asks
  // for, every approval on record with whether it counts, and what is missing.
  router.get('/api/pr/approvals', async (req, res) => {
    try {
      const { project, prNumber } = pullOf(req.query);
      const reviewOutcome = await outcome.read(project, prNumber);
      res.json({ approvals: reviewOutcome.approvals, reviewOutcome });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/pr/approvals', async (req, res) => {
    try {
      const user = res.locals.apiUser;
      if (!user) throw refused(401, 'no_user', 'Call this with a person’s own token');
      const body = req.body || {};
      const { project, prNumber } = pullOf(body);
      only(body, ['repo', 'pr', 'headSha', 'note']);
      const headSha = body.headSha;
      if (typeof headSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(headSha))
        throw invalid('headSha must be the full commit id of the head you approve');
      const said = note(body.note);
      const policy = approvalPolicyOf(project);
      if (!policy)
        throw refused(409, 'approvals_not_enabled', 'This project has no approval policy switched on');

      // What is approved is the pull request as it is now, and the caller has to have
      // meant that: an approval of a head that has moved on approves nothing.
      const pull = await readPull(project, prNumber).catch((e) => {
        throw refused(
          502,
          'github_unreadable',
          `The pull request could not be read from GitHub: ${e.message}`,
        );
      });
      if (pull.state !== 'open')
        throw refused(409, 'pull_not_open', `The pull request is ${pull.state || 'not open'}`);
      if (pull.headSha !== headSha)
        throw refused(
          409,
          'head_moved',
          `The pull request is at ${pull.headSha.slice(0, 7)}, not at ${headSha.slice(0, 7)}: look at what changed and approve that head`,
          { headSha: pull.headSha },
        );
      const current = { headSha, baseRef: pull.baseRef || null };
      // Nothing is computed or stored for a pull request no review ever covered.
      if (!(await outcome.read(project, prNumber)).reviewed)
        throw refused(
          409,
          'review_not_current',
          'No code review covers this pull request yet: an approval is for a reviewed revision',
        );
      // Computed for this revision first: it is what says whether the review covers it,
      // and what reads who wrote it.
      const before = await outcome.refresh(project, prNumber, current);
      const reviewed = before.reviewed;
      if (!reviewed || before.stale || reviewed.headSha !== headSha)
        throw refused(
          409,
          'review_not_current',
          `The code review covered ${reviewed ? reviewed.headSha.slice(0, 7) : 'no revision'}, not ${headSha.slice(0, 7)}: an approval is for a reviewed revision, so approve once this one is reviewed`,
        );
      if (before.execution === 'running')
        throw refused(
          409,
          'review_running',
          `A code review of ${headSha.slice(0, 7)} is still running: approve once it has ended`,
        );

      // Whether this is the approver's own change, from what the server can know. Not
      // known at all, the approval is not taken: it could not later be shown to be
      // somebody else's.
      const risk = await store.getCodeReviewRisk(project.repo, prNumber);
      const authors = risk?.headSha === headSha ? risk.authors : null;
      if (!authors)
        throw refused(
          503,
          'authorship_unknown',
          `Briareus could not read who wrote this pull request from GitHub${risk?.error ? ` (${risk.error})` : ''}; try again shortly`,
        );
      const login = linkedLogin(user);
      const authorship = authorshipOf({
        login,
        author: authors.author,
        commitAuthors: authors.commits || [],
        session: ownsWorkOn(user, project.repo, prNumber),
      });
      if (authorship && !policy.allowSelfApproval)
        throw refused(
          403,
          'own_change',
          {
            author: 'You opened this pull request',
            commits: 'Commits of this pull request carry your GitHub account',
            session: 'A session you own worked on this pull request',
          }[authorship] + ', and this project does not count an approval of one’s own change',
          { authorship },
        );

      const { approval, created } = await store.addCodeReviewApproval(project.repo, prNumber, {
        userId: user.id,
        approver: user.name ?? null,
        githubLogin: login,
        headSha,
        baseRef: pull.baseRef,
        codeReviewId: before.reviewId ?? null,
        reviewOutcome: before.outcome ?? null,
        note: said,
        authorship,
      });
      if (!approval) throw new Error('The approval could not be read back');
      res.status(created ? 201 : 200).json(answer(await after(project, prNumber, current), approval.id));
    } catch (e) {
      fail(res, e);
    }
  });

  // Taken back by the person who gave it, and by nobody else. It stays on record.
  router.post('/api/pr/approvals/:approvalId/withdraw', async (req, res) => {
    try {
      const user = res.locals.apiUser;
      if (!user) throw refused(401, 'no_user', 'Call this with a person’s own token');
      const body = req.body || {};
      const { project, prNumber } = pullOf(body);
      only(body, ['repo', 'pr', 'note']);
      const id = Number(req.params.approvalId);
      if (!Number.isSafeInteger(id) || id < 1) throw invalid('Approval id must be a positive integer');
      const said = note(body.note);
      const existing = (await store.listCodeReviewApprovals(project.repo, prNumber)).find((a) => a.id === id);
      if (!existing) throw refused(404, 'not_found', 'Approval not found on this pull request');
      if (existing.source !== 'briareus')
        throw refused(
          409,
          'github_approval',
          'This approval was given on GitHub: its author dismisses it there',
        );
      if (existing.userId !== user.id)
        throw refused(403, 'not_yours', 'Only the person who gave an approval can withdraw it');
      await store.withdrawCodeReviewApproval(project.repo, prNumber, id, user.id, { note: said });
      res.json(answer(await after(project, prNumber), id));
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}
