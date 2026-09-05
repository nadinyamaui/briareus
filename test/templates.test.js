import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({
  loadAppSetting: vi.fn(async () => null),
  saveAppSetting: vi.fn(async () => {}),
}));

import {
  fill,
  normalize,
  renderTemplate,
  templateText,
  templateSource,
  templateCatalog,
  saveGlobalTemplates,
  TEMPLATE_IDS,
} from '../lib/templates.js';

describe('fill', () => {
  it('replaces known tokens', () => {
    expect(fill('review {{PR_REF}} in {{REPO}}', { PR_REF: 'pull request #7', REPO: 'a/b' })).toBe(
      'review pull request #7 in a/b',
    );
  });

  it('leaves unknown tokens alone so a typo shows up in the prompt', () => {
    expect(fill('hello {{NOT_A_TOKEN}}', { REPO: 'a/b' })).toBe('hello {{NOT_A_TOKEN}}');
  });

  it("leaves the deploy system's own placeholders untouched", () => {
    // lowercase tokens are not this app's: {{pull_branch}} belongs to a
    // deploy pipeline the PR body template may legitimately mention.
    expect(fill('deploy @{{pull_branch}}', {})).toBe('deploy @{{pull_branch}}');
  });

  it('renders a null or undefined value as an empty string', () => {
    expect(fill('a[{{X}}]b', { X: null })).toBe('a[]b');
    expect(fill('a[{{X}}]b', { X: undefined })).toBe('a[]b');
  });

  it('stringifies non-string values', () => {
    expect(fill('#{{PR_NUMBER}}', { PR_NUMBER: 42 })).toBe('#42');
  });
});

describe('normalize', () => {
  it('drops empty and whitespace-only overrides so clearing a field falls back', () => {
    expect(normalize({ prBody: '   ', testSheet: '' })).toEqual({});
  });

  it('keeps only known template ids', () => {
    expect(normalize({ prBody: 'x', nonsense: 'y' })).toEqual({ prBody: 'x' });
  });

  it('normalizes CRLF to LF and trims', () => {
    expect(normalize({ prBody: '  a\r\nb\r\n ' })).toEqual({ prBody: 'a\nb' });
  });

  it('answers an empty set for a non-object', () => {
    expect(normalize(null)).toEqual({});
    expect(normalize('text')).toEqual({});
  });
});

describe('templateText / templateSource', () => {
  it('throws on a template id that does not exist', () => {
    expect(() => templateText('nope')).toThrow(/No such template/);
  });

  it('falls back to the built-in text when nothing overrides it', () => {
    expect(templateSource('testSheet')).toBe('built-in');
    expect(templateText('testSheet')).toContain('{{TEST_SHEET_ANCHOR}}');
  });

  it('prefers a global override over the built-in', async () => {
    await saveGlobalTemplates({ testSheet: 'GLOBAL SHEET {{REPO}}' });
    expect(templateSource('testSheet')).toBe('global');
    expect(templateText('testSheet')).toBe('GLOBAL SHEET {{REPO}}');
    await saveGlobalTemplates({}); // leave no state behind for other tests
  });

  it('prefers a project override over global and built-in', async () => {
    await saveGlobalTemplates({ testSheet: 'GLOBAL' });
    const project = { promptTemplates: { testSheet: 'PROJECT SHEET' } };
    expect(templateSource('testSheet', project)).toBe('project');
    expect(templateText('testSheet', project)).toBe('PROJECT SHEET');
    await saveGlobalTemplates({});
  });

  it('treats a project without templates like no project at all', () => {
    expect(templateSource('prBody', { promptTemplates: null })).toBe('built-in');
  });
});

describe('renderTemplate', () => {
  it('substitutes and trims the result', async () => {
    await saveGlobalTemplates({ prBody: '  hello {{REPO}}  ' });
    expect(renderTemplate('prBody', { REPO: 'a/b' })).toBe('hello a/b');
    await saveGlobalTemplates({});
  });

  it('collapses the blank lines an empty optional block leaves behind', async () => {
    await saveGlobalTemplates({ prBody: 'top\n\n{{QA_NOTES}}\n\nbottom' });
    expect(renderTemplate('prBody', { QA_NOTES: '' })).toBe('top\n\nbottom');
    await saveGlobalTemplates({});
  });

  it('strips trailing whitespace per line', async () => {
    await saveGlobalTemplates({ prBody: 'a   \nb\t' });
    expect(renderTemplate('prBody', {})).toBe('a\nb');
    await saveGlobalTemplates({});
  });
});

describe('the orchestrator instructions', () => {
  it('appends nothing by default and resolves project over global', async () => {
    expect(templateText('orchestrator')).toBe('');
    await saveGlobalTemplates({ orchestrator: 'GLOBAL RULES' });
    expect(templateText('orchestrator')).toBe('GLOBAL RULES');
    expect(templateText('orchestrator', { promptTemplates: { orchestrator: 'PROJECT RULES' } })).toBe(
      'PROJECT RULES',
    );
    await saveGlobalTemplates({});
  });
});

describe('templateCatalog', () => {
  it('lists every template with its built-in text and token hints', () => {
    const catalog = templateCatalog();
    expect(catalog.map((t) => t.id)).toEqual(TEMPLATE_IDS);
    for (const entry of catalog) {
      expect(entry.label).toBeTruthy();
      // The orchestrator instructions are deliberately empty built-in: there
      // is no generic text worth appending to every install's briefing.
      if (entry.id !== 'orchestrator') expect(entry.builtIn).toBeTruthy();
      if (entry.id === 'zeusEpic') {
        // The epic's four sections are what Zeus, its analysts and its
        // validator all work to; a template that lost one would silently
        // drop that part of every epic.
        for (const h of ['# Context', '# Requirements', '# Implementation Plan', '# Definition of Done']) {
          expect(entry.builtIn).toContain(h);
        }
      }
      for (const v of entry.vars) {
        expect(v.name).toMatch(/^[A-Z0-9_]+$/);
        expect(v.hint).toBeTruthy();
        // Every advertised token must actually do something in the built-in
        // text or be provided by lib/prtasks.js; at minimum it must be
        // well-formed enough for fill() to match it.
        expect(fill(`{{${v.name}}}`, { [v.name]: 'x' })).toBe('x');
      }
    }
  });
});
