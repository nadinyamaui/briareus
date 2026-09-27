// @vitest-environment happy-dom
/* global document, window */
// The in-app PR viewer (public/pr-viewer.js) is a browser script, so these
// tests run it in happy-dom with a stubbed api() standing in for the server.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const STALE = 'This pull request changed. Refresh to load its latest revision.';

const basePr = {
  number: 7,
  title: 'Example',
  body: 'Body',
  url: 'https://github.com/owner/repo/pull/7',
  author: 'octo',
  state: 'open',
  headRef: 'owner:feature',
  baseRef: 'main',
  headSha: HEAD,
  baseSha: 'c'.repeat(40),
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  mergeable: true,
  mergeableState: 'clean',
  mergeMethods: ['squash', 'merge'],
};
const check = (name, conclusion, status = 'completed') => ({ name, status, conclusion, app: 'CI' });

// Each call is answered by the handler for its section (or 'merge'): a value,
// an Error to throw, or a function of the request.
let handlers;
let calls;
let viewer;
let onMerged;
let onMergeFailed;
const api = vi.fn(async (url, opts) => {
  const u = new URL(url, 'http://x');
  const key = u.pathname === '/api/pr/merge' ? 'merge' : u.searchParams.get('section');
  calls.push({ key, params: u.searchParams, body: opts?.body ? JSON.parse(opts.body) : null });
  const answer = typeof handlers[key] === 'function' ? await handlers[key](u) : handlers[key];
  if (answer instanceof Error) throw answer;
  return structuredClone(answer);
});
const fail = (message, status) => Object.assign(new Error(message), { status });
const held = () => {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { run: () => promise, release };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const $ = (selector) => document.querySelector(selector);
const click = (selector) => $(selector).click();
const badge = () =>
  $('#pr-viewer-checks').hidden ? null : $('#pr-viewer-checks').getAttribute('aria-label');
const warnings = () => [...document.querySelectorAll('#prv-merge-warnings p')].map((p) => p.textContent);

beforeAll(() => {
  // happy-dom's URL is not Node's, so the path is joined rather than resolved.
  new Function(readFileSync(join(import.meta.dirname, '../public/pr-viewer.js'), 'utf8'))();
});

beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  handlers = {
    description: { pr: basePr },
    checks: { pr: basePr, checks: [check('test', 'success')], warnings: [] },
    files: { pr: basePr, files: [], nextPage: null, truncated: false },
  };
  onMerged = vi.fn();
  onMergeFailed = vi.fn();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  viewer = window.createPrViewer({ api, esc, md: esc, onMerged, onMergeFailed });
});

afterEach(() => vi.useRealTimers());

async function openViewer(tab) {
  viewer.open('owner/repo', 7, tab);
  await flush();
}

describe('checks rollup', () => {
  it('marks every check that did not pass as failed, in the title and in its row', async () => {
    handlers.checks = {
      pr: basePr,
      checks: [check('unit', 'success'), check('lint', 'skipped'), check('deploy', 'cancelled')],
      warnings: [],
    };
    await openViewer('checks');
    expect($('#pr-viewer-checks').textContent).toBe('✗');
    expect(badge()).toBe('1 of 3 checks did not pass');
    expect($('.prv-check-summary').textContent).toContain('2 of 3 checks passed');
    const icons = [...document.querySelectorAll('.prv-check-icon')].map((i) => i.textContent);
    expect(icons).toEqual(['✓', '○', '✗']);
  });

  it('shows ✓ when every check passed and ● while any still runs', async () => {
    await openViewer();
    expect(badge()).toBe('All 1 checks passed');
    handlers.checks = { pr: basePr, checks: [check('unit', null, 'in_progress')], warnings: [] };
    click('.prv-toolbar [data-refresh]');
    await flush();
    expect($('#pr-viewer-checks').textContent).toBe('●');
  });

  it('says CI status is unknown when the checks could not be loaded', async () => {
    handlers.checks = fail('GitHub answered 500 reading the pull request checks', 502);
    await openViewer();
    expect(badge()).toBe('Checks could not be loaded, so CI status is unknown');
  });

  it('asks for a refresh when the head moved before the checks loaded', async () => {
    handlers.checks = fail(STALE, 409);
    await openViewer();
    expect(badge()).toMatch(/changed since it loaded\. Refresh/);
  });
});

describe('pinned reads', () => {
  it('pins the background checks load to the head only, and a diff to the base too', async () => {
    await openViewer();
    const [first, checks] = calls;
    expect(first.params.has('headSha')).toBe(false);
    expect(checks.key).toBe('checks');
    expect(checks.params.get('headSha')).toBe(HEAD);
    expect(checks.params.has('baseSha')).toBe(false);
    click('[data-tab="files"]');
    await flush();
    const files = calls.at(-1);
    expect(files.params.get('headSha')).toBe(HEAD);
    expect(files.params.get('baseSha')).toBe(basePr.baseSha);
  });

  it('re-reads a still-computing mergeable once, pinned to the head only', async () => {
    vi.useFakeTimers();
    handlers.description = { pr: { ...basePr, mergeable: null, mergeableState: 'unknown' } };
    viewer.open('owner/repo', 7);
    await vi.advanceTimersByTimeAsync(0);
    click('[data-merge]');
    expect(warnings()).toContain('GitHub is still checking whether this branch can merge.');
    handlers.description = { pr: { ...basePr, mergeable: true } };
    await vi.advanceTimersByTimeAsync(3000);
    const recheck = calls.at(-1);
    expect(recheck.key).toBe('description');
    expect(recheck.params.get('headSha')).toBe(HEAD);
    expect(recheck.params.has('baseSha')).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('drops an unpinned tab read that resolves with a newer head than the PR shown', async () => {
    const description = held();
    const checks = held();
    handlers.description = description.run;
    handlers.checks = checks.run;
    viewer.open('owner/repo', 7);
    click('[data-tab="checks"]');
    expect(calls.map((c) => c.params.has('headSha'))).toEqual([false, false]);
    description.release({ pr: basePr });
    await flush();
    // A push landed between the two reads: the checks describe NEW_HEAD,
    // while Confirm would merge HEAD.
    checks.release({ pr: { ...basePr, headSha: NEW_HEAD }, checks: [check('x', 'success')], warnings: [] });
    await flush();
    expect(badge()).toMatch(/changed since it loaded\. Refresh/);
    expect($('#prv-content').textContent).toContain(STALE);
    expect($('#prv-content [data-refresh]')).not.toBeNull();
  });
});

describe('merge box', () => {
  it('builds its controls once, so background loads keep focus and the chosen method', async () => {
    const checks = held();
    handlers.checks = checks.run;
    await openViewer();
    click('[data-merge]');
    const confirm = $('[data-merge-confirm]');
    const select = $('#prv-merge-method');
    expect([...select.options].map((o) => o.value)).toEqual(['squash', 'merge']);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.textContent).toBe(`Confirm merge of ${HEAD.slice(0, 7)}`);
    expect(warnings()).toEqual(['Checks are still loading.']);
    select.value = 'merge';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    checks.release({ pr: basePr, checks: [check('unit', 'failure')], warnings: [] });
    await flush();
    expect(warnings()).toEqual(['1 of 1 checks did not pass.']);
    expect($('[data-merge-confirm]')).toBe(confirm);
    expect($('#prv-merge-method')).toBe(select);
    expect(document.activeElement).toBe(confirm);
    handlers.merge = { merged: true };
    click('[data-merge-confirm]');
    await flush();
    expect(calls.find((c) => c.key === 'merge').body).toEqual({
      repo: 'owner/repo',
      pr: 7,
      method: 'merge',
      headSha: HEAD,
      baseRef: 'main',
    });
  });

  it('holds Close, Refresh and Escape while merging, then reports success and reloads', async () => {
    await openViewer();
    click('[data-merge]');
    const merge = held();
    handlers.merge = merge.run;
    click('[data-merge-confirm]');
    const confirm = $('[data-merge-confirm]');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(confirm.textContent).toBe('Merging…');
    expect(document.activeElement).toBe(confirm);
    expect($('.prv-toolbar [data-refresh]').disabled).toBe(true);
    expect($('[data-close]').disabled).toBe(true);
    expect($('[data-merge-cancel]').disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    $('dialog').dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    // A second click while busy must not send a second merge.
    click('[data-merge-confirm]');
    expect(calls.filter((c) => c.key === 'merge')).toHaveLength(1);
    const before = calls.length;
    merge.release({ merged: true });
    await flush();
    expect(onMerged).toHaveBeenCalledWith('owner/repo', 7);
    expect(calls[before].key).toBe('description');
    expect(calls[before].params.has('headSha')).toBe(false);
    expect($('#pr-viewer-merge').hidden).toBe(true);
    expect($('dialog').contains(document.activeElement)).toBe(true);
  });

  it('swaps Confirm for Refresh after a 409, with focus on it', async () => {
    await openViewer();
    click('[data-merge]');
    handlers.merge = fail('GitHub refused the merge: Head branch was modified.', 409);
    click('[data-merge-confirm]');
    await flush();
    expect($('[data-merge-confirm]').hidden).toBe(true);
    const refresh = $('#pr-viewer-merge [data-refresh]');
    expect(refresh.hidden).toBe(false);
    expect(document.activeElement).toBe(refresh);
    expect($('#prv-merge-error').textContent).toBe('GitHub refused the merge: Head branch was modified.');
    expect($('.prv-toolbar [data-refresh]').disabled).toBe(false);
    refresh.click();
    await flush();
    expect(calls.at(-2).params.has('headSha')).toBe(false);
    expect($('#pr-viewer-merge').hidden).toBe(true);
  });

  it('keeps Confirm, focused, after another refusal so it can be retried', async () => {
    await openViewer();
    click('[data-merge]');
    handlers.merge = fail('GitHub refused the merge: GitHub answered 500', 502);
    click('[data-merge-confirm]');
    await flush();
    const confirm = $('[data-merge-confirm]');
    expect(confirm.hidden).toBe(false);
    expect(confirm.disabled).toBe(false);
    expect(confirm.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(confirm);
    expect($('#prv-merge-error').hidden).toBe(false);
    expect(onMergeFailed).not.toHaveBeenCalled();
  });

  it('hands a failure to onMergeFailed when the dialog closed mid-merge', async () => {
    await openViewer();
    click('[data-merge]');
    const merge = held();
    handlers.merge = merge.run;
    click('[data-merge-confirm]');
    $('dialog').close();
    merge.release(fail('GitHub refused the merge: Base branch was modified.', 405));
    await flush();
    expect(onMergeFailed).toHaveBeenCalledWith(
      'owner/repo',
      7,
      'GitHub refused the merge: Base branch was modified.',
    );
  });

  it('disables Confirm on conflicts, and Cancel returns focus to Merge', async () => {
    handlers.description = { pr: { ...basePr, mergeable: false, mergeableState: 'dirty' } };
    await openViewer();
    click('[data-merge]');
    expect($('[data-merge-confirm]').disabled).toBe(true);
    expect(warnings()).toContain('This branch has conflicts that must be resolved before it can merge.');
    expect(document.activeElement).toBe($('[data-merge-cancel]'));
    click('[data-merge-cancel]');
    expect($('#pr-viewer-merge').hidden).toBe(true);
    expect(document.activeElement).toBe($('[data-merge]'));
  });

  it('keeps GitHub’s unstable warning unless a ✗ rollup already says it', async () => {
    handlers.description = { pr: { ...basePr, mergeableState: 'unstable' } };
    handlers.checks = fail('GitHub answered 500 reading the pull request checks', 502);
    await openViewer();
    click('[data-merge]');
    expect(warnings()).toEqual([
      'Checks could not be loaded, so CI status is unknown.',
      'GitHub reports some checks on this branch as not passing.',
    ]);
    handlers.checks = {
      pr: { ...basePr, mergeableState: 'unstable' },
      checks: [check('u', 'failure')],
      warnings: [],
    };
    click('.prv-toolbar [data-refresh]');
    await flush();
    click('[data-merge]');
    expect(warnings()).toEqual(['1 of 1 checks did not pass.']);
  });
});
