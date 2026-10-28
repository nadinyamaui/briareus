import { describe, it, expect, vi, beforeEach } from 'vitest';

const stubs = vi.hoisted(() => ({
  readFeedbackSnapshot: vi.fn(),
  feedbackAssessmentSpec: vi.fn(),
}));
vi.mock('../lib/feedback-assessment.js', () => stubs);

// The prompt builders are lib/prtasks.js's own business, tested there; here
// they only need to prove the action handed them the right facts.
vi.mock('../lib/prtasks.js', () => ({
  testSheetPrompt: vi.fn(() => 'SHEET'),
  testRunPrompt: vi.fn(() => 'RUN'),
  solveConflictsPrompt: vi.fn(() => 'CONFLICTS'),
  feedbackAssessmentPrompt: vi.fn(() => 'ASSESS'),
  deleteSelfCommentsPrompt: vi.fn(({ author }) => `DELETE:${author}`),
  fixFailingChecksPrompt: vi.fn(() => 'CHECKS'),
  customFeedbackPrompt: vi.fn(({ feedback }) => `FEEDBACK:${feedback}`),
  prBodyPrompt: vi.fn(() => 'BODY'),
}));

import { ACTIONS, getAction, listActions, actionSessionSpec } from '../lib/actions.js';
import * as prtasks from '../lib/prtasks.js';

beforeEach(() => {
  prtasks.testSheetPrompt.mockClear();
  stubs.readFeedbackSnapshot.mockReset().mockResolvedValue({ sha: 'abc', sources: [] });
  stubs.feedbackAssessmentSpec
    .mockReset()
    .mockReturnValue({ prompt: 'ASSESS', autoClose: true, reviewLoop: false });
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

  // Completed errands release their clone and database; an assessment keeps only
  // its Findings card, while test videos and typed feedback keep a session open.
  it('closes the errands whose answer lands on the pull request', () => {
    const closing = ACTIONS.filter((a) => a.autoClose).map((a) => a.id);
    expect(closing).toEqual([
      'pr-body-summary',
      'test-sheet',
      'solve-conflicts',
      'fix-checks',
      'implement-feedback',
      'delete-self-comments',
    ]);
    expect(ACTIONS.filter((a) => !a.autoClose).map((a) => a.id)).toEqual(['test-run', 'custom-feedback']);
  });

  it('leaves board errands outside the review loop until the user triages findings', () => {
    expect(ACTIONS.filter((a) => a.reviewLoop)).toEqual([]);
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

  // The errand works on the PR through gh alone, leaving the shared checkout on whatever branch
  // is out; that is only safe while the prompt names the PR, as the facts below ensure.
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

  it('passes the target repository and PR number because the checkout may be on another branch', async () => {
    const project = { repo: 'acme/shop' };

    expect(await action.prompt({ repo: 'acme/shop', prNumber: 5, project })).toBe('BODY');
    expect(prtasks.prBodyPrompt).toHaveBeenCalledWith({ repo: 'acme/shop', prNumber: 5, project });
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
    expect(getAction('implement-feedback').title({ prNumber: 6 })).toBe('Assess feedback: #6');
  });
});

describe('implement-feedback', () => {
  it('assesses feedback without arming the review loop', () => {
    const action = getAction('implement-feedback');
    expect(action.reviewLoop).toBeFalsy();
    expect(action.autoClose).toBe(true);
    expect(action.workspace).toBe('worktree');
  });
});

describe('actionSessionSpec', () => {
  const context = {
    repo: 'a/b',
    prNumber: 4,
    branch: 'feature/x',
    baseBranch: 'main',
    title: 'T',
    project: null,
    input: '',
  };

  it('checks out the PR branch in a worktree for an errand that pushes, and closes it when done', async () => {
    expect(await actionSessionSpec(getAction('fix-checks'), context)).toEqual({
      repo: 'a/b',
      branch: 'feature/x',
      local: false,
      prompt: 'CHECKS',
      prNumber: 4,
      prBranch: 'feature/x',
      autoClose: true,
      reviewLoop: false,
      title: 'Fix checks: #4',
      activity: 'fix-checks',
    });
  });

  it('keeps allocated video runs with the session specification', async () => {
    prtasks.testRunPrompt.mockImplementationOnce(({ onVideoRun }) => {
      onVideoRun('a__b/pr-<pr-number>-0123456789abcdef0123456789abcdef');
      return 'RUN';
    });
    expect(await actionSessionSpec(getAction('test-run'), context)).toMatchObject({
      prompt: 'RUN',
      videoRuns: ['a__b/pr-<pr-number>-0123456789abcdef0123456789abcdef'],
    });
  });

  it.each(['pr-body-summary', 'test-sheet', 'delete-self-comments'])(
    '%s leaves the local checkout alone even when the PR branch is unavailable locally',
    async (id) => {
      const spec = await actionSessionSpec(getAction(id), {
        ...context,
        project: { reviewAuthor: 'morgan' },
      });
      expect(spec).toMatchObject({
        branch: undefined,
        local: true,
        prNumber: 4,
        prBranch: 'feature/x',
        autoClose: true,
      });
    },
  );

  it('requires a canonical feedback snapshot and prepares an assessment instead of a fix', async () => {
    const spec = await actionSessionSpec(getAction('implement-feedback'), context);
    expect(stubs.readFeedbackSnapshot).toHaveBeenCalledWith('a/b', 4);
    expect(stubs.feedbackAssessmentSpec).toHaveBeenCalledWith(null, { sha: 'abc', sources: [] });
    expect(spec).toEqual({ reviewLoop: false, autoClose: true, prompt: 'ASSESS' });
    stubs.readFeedbackSnapshot.mockRejectedValueOnce(new Error('rate limited'));
    await expect(actionSessionSpec(getAction('implement-feedback'), context)).rejects.toThrow('rate limited');
  });
});
