import { describe, it, expect, vi, beforeEach } from 'vitest';

const stubs = vi.hoisted(() => ({
  latestReviewFindings: vi.fn(),
  getFindings: vi.fn(),
}));

vi.mock('../lib/findings.js', () => ({
  latestReviewFindings: stubs.latestReviewFindings,
  getFindings: stubs.getFindings,
}));

// The prompt builders are lib/prtasks.js's own business, tested there; here
// they only need to prove the action handed them the right facts.
vi.mock('../lib/prtasks.js', () => ({
  testSheetPrompt: vi.fn(() => 'SHEET'),
  testRunPrompt: vi.fn(() => 'RUN'),
  solveConflictsPrompt: vi.fn(() => 'CONFLICTS'),
  implementFeedbackPrompt: vi.fn(
    ({ findings }) => `IMPLEMENT:${(findings || []).map((f) => f.title).join(',')}`,
  ),
  deleteSelfCommentsPrompt: vi.fn(({ author }) => `DELETE:${author}`),
  fixFailingChecksPrompt: vi.fn(() => 'CHECKS'),
  customFeedbackPrompt: vi.fn(({ feedback }) => `FEEDBACK:${feedback}`),
  prBodyPrompt: vi.fn(() => 'BODY'),
}));

import { ACTIONS, getAction, listActions } from '../lib/actions.js';
import * as prtasks from '../lib/prtasks.js';

beforeEach(() => {
  prtasks.testSheetPrompt.mockClear();
  stubs.latestReviewFindings.mockReset().mockResolvedValue([]);
  stubs.getFindings.mockReset().mockResolvedValue({ findings: [] });
});

describe('the actions list', () => {
  it('has unique ids and a title and prompt for each', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of ACTIONS) {
      expect(typeof action.title).toBe('function');
      expect(typeof action.prompt).toBe('function');
      expect(['local', 'worktree']).toContain(action.workspace);
    }
  });

  // An errand that says everything it has on the pull request itself is read
  // there, not in its thread, so its session hands the clone and the database
  // server back (and its own record with them) the moment the turn ends. The
  // ones left open are the ones with something to come back to: a test run's
  // videos, feedback the user typed and may want to argue with, and
  // 🛠 Implement feedback, which stays for the review loop that follows its push.
  it('closes the errands whose answer lands on the pull request', () => {
    const closing = ACTIONS.filter((a) => a.autoClose).map((a) => a.id);
    expect(closing).toEqual([
      'pr-body-summary',
      'test-sheet',
      'solve-conflicts',
      'fix-checks',
      'delete-self-comments',
    ]);
    expect(ACTIONS.filter((a) => !a.autoClose).map((a) => a.id)).toEqual([
      'test-run',
      'implement-feedback',
      'custom-feedback',
    ]);
  });

  // The review loop needs a parent that is still around when the review
  // reports back, and a workspace clone to start that review in, so an
  // action that arms it cannot also auto-close or run locally.
  it('an action that arms the review loop stays open in a worktree for it', () => {
    const looping = ACTIONS.filter((a) => a.reviewLoop);
    expect(looping.map((a) => a.id)).toEqual(['implement-feedback']);
    for (const action of looping) {
      expect(action.autoClose).toBeFalsy();
      expect(action.workspace).toBe('worktree');
    }
  });

  it('getAction finds by id and answers null for a made-up one', () => {
    expect(getAction('test-sheet').label).toBe('Test sheet');
    expect(getAction('nope')).toBeNull();
  });

  it('listActions ships the menu, not the prompt builders', () => {
    const listed = listActions();
    expect(listed.map((a) => a.id)).toEqual(ACTIONS.map((a) => a.id));
    for (const entry of listed) {
      expect(entry).not.toHaveProperty('prompt');
      expect(entry).not.toHaveProperty('title');
    }
    // Only ✍ Give feedback asks the user a question first.
    const withInput = listed.filter((a) => a.input);
    expect(withInput.map((a) => a.id)).toEqual(['custom-feedback']);
    expect(withInput[0].input.required).toBe(true);
  });
});

describe('test-sheet', () => {
  const action = getAction('test-sheet');

  // The errand works on the pull request through gh alone, so the shared local
  // checkout is left on whatever branch the developer has out. That is only
  // safe while the prompt names the pull request itself; the facts below are
  // the ones that keep the sheet off the branch that happens to be checked out.
  it('runs in the local checkout without switching its branch', () => {
    expect(action.workspace).toBe('local');
    expect(action.checkout).toBe(false);
  });

  it('hands the prompt the pull request the board row was for, untouched', async () => {
    const project = { repo: 'acme/shop' };
    const prompt = await action.prompt({
      repo: 'acme/shop',
      prNumber: 11780,
      branch: 'patch/11734-fleet-locations-custom-field-filters',
      project,
    });
    expect(prompt).toBe('SHEET');
    expect(prtasks.testSheetPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 11780,
      branch: 'patch/11734-fleet-locations-custom-field-filters',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 11780 })).toBe('Test sheet: #11780');
  });
});

describe('delete-self-comments', () => {
  const action = getAction('delete-self-comments');

  it('refuses to run without a configured author to match on', () => {
    expect(() => action.prompt({ repo: 'a/b', prNumber: 1, project: {} })).toThrow(/no PR author configured/);
    expect(() => action.prompt({ repo: 'a/b', prNumber: 1, project: { reviewAuthor: '  ' } })).toThrow(
      /no PR author configured/,
    );
  });

  it('hands the trimmed author to the prompt', () => {
    const prompt = action.prompt({ repo: 'a/b', prNumber: 1, project: { reviewAuthor: ' bot ' } });
    expect(prompt).toBe('DELETE:bot');
  });
});

describe('pr-body-summary', () => {
  const action = getAction('pr-body-summary');

  it('needs only the project to compose from: the diff is read on the PR', async () => {
    const project = { repo: 'acme/shop' };

    expect(await action.prompt({ repo: 'acme/shop', prNumber: 5, project })).toBe('BODY');
    expect(prtasks.prBodyPrompt).toHaveBeenCalledWith({ project });
  });

  it('titles the session after the pull request', () => {
    expect(action.title({ prNumber: 5 })).toBe('PR body: #5');
  });
});

describe('test-run', () => {
  const action = getAction('test-run');

  it('runs in a prepared worktree: it has to start the app', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the pull request it is running the sheet for', async () => {
    const project = { repo: 'acme/shop' };

    expect(await action.prompt({ repo: 'acme/shop', prNumber: 7, branch: 'feat', project })).toBe('RUN');
    expect(prtasks.testRunPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 7,
      branch: 'feat',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 7 })).toBe('Test run: #7');
  });
});

describe('solve-conflicts', () => {
  const action = getAction('solve-conflicts');

  it('runs in a prepared worktree: the merge still has to build and pass', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the base branch it is merging in as well', async () => {
    const project = { repo: 'acme/shop' };

    expect(
      await action.prompt({ repo: 'acme/shop', prNumber: 9, branch: 'feat', baseBranch: 'main', project }),
    ).toBe('CONFLICTS');
    expect(prtasks.solveConflictsPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 9,
      branch: 'feat',
      baseBranch: 'main',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 9 })).toBe('Conflicts: #9');
  });
});

describe('fix-checks', () => {
  const action = getAction('fix-checks');

  it('runs in a prepared worktree: the errand is running the jobs CI ran', () => {
    expect(action.workspace).toBe('worktree');
  });

  it('hands the prompt the branch and its base', async () => {
    const project = { repo: 'acme/shop' };

    expect(
      await action.prompt({ repo: 'acme/shop', prNumber: 3, branch: 'feat', baseBranch: 'main', project }),
    ).toBe('CHECKS');
    expect(prtasks.fixFailingChecksPrompt).toHaveBeenCalledWith({
      repo: 'acme/shop',
      prNumber: 3,
      branch: 'feat',
      baseBranch: 'main',
      project,
    });
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 3 })).toBe('Fix checks: #3');
  });
});

describe('custom-feedback', () => {
  const action = getAction('custom-feedback');

  it('passes what the user typed through as the feedback', async () => {
    // The one action whose errand is not written in this file.
    expect(
      await action.prompt({
        repo: 'a/b',
        prNumber: 2,
        branch: 'feat',
        input: 'should 404, not 422',
        project: null,
      }),
    ).toBe('FEEDBACK:should 404, not 422');
  });

  it('titles the session after that pull request', () => {
    expect(action.title({ prNumber: 2 })).toBe('Feedback: #2');
  });
});

describe('the remaining titles', () => {
  it('names the pull request each errand is for', () => {
    expect(getAction('delete-self-comments').title({ prNumber: 4 })).toBe('Delete comments: #4');
    expect(getAction('implement-feedback').title({ prNumber: 6 })).toBe('Implement feedback: #6');
  });
});

describe('implement-feedback', () => {
  const action = getAction('implement-feedback');
  const args = { repo: 'a/b', prNumber: 1, branch: 'f', project: null };

  it('stays open with the review loop armed so the fixes it pushes get reviewed', () => {
    expect(action.reviewLoop).toBe(true);
    expect(action.autoClose).toBeFalsy();
    expect(action.workspace).toBe('worktree');
  });

  it("starts from the newest review's declared findings when there are any", async () => {
    stubs.latestReviewFindings.mockResolvedValue([{ title: 'Fresh' }]);
    expect(await action.prompt(args)).toBe('IMPLEMENT:Fresh');
    expect(stubs.getFindings).not.toHaveBeenCalled();
  });

  it('falls back to the undecided, unfixed set when the newest review declared none', async () => {
    stubs.getFindings.mockResolvedValue({
      findings: [
        { title: 'Open', decision: null, fixed: false },
        { title: 'Dismissed', decision: 'dismissed', fixed: false },
        { title: 'Done', decision: 'fix', fixed: true },
      ],
    });
    expect(await action.prompt(args)).toBe('IMPLEMENT:Open');
  });

  it('a GitHub that will not answer still produces a prompt, with no head start', async () => {
    stubs.latestReviewFindings.mockRejectedValue(new Error('rate limited'));
    expect(await action.prompt(args)).toBe('IMPLEMENT:');
  });
});
