import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));

// An in-memory stand-in for the saved_prompts table, so the module's cache
// refreshes from something after every write the way it does against MySQL.
const store = vi.hoisted(() => ({ rows: [], nextId: 1 }));

vi.mock('../lib/db.js', () => ({
  loadSavedPromptRows: vi.fn(async () =>
    [...store.rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
  ),
  getSavedPromptRow: vi.fn(async (id) => store.rows.find((r) => r.id === Number(id)) || null),
  saveSavedPrompt: vi.fn(async (p) => {
    if (p.id) {
      const i = store.rows.findIndex((r) => r.id === p.id);
      if (i < 0) throw new Error(`No saved prompt with id ${p.id}`);
      store.rows[i] = { ...store.rows[i], ...p };
      return store.rows[i];
    }
    const row = { ...p, id: store.nextId++ };
    store.rows.push(row);
    return row;
  }),
  deleteSavedPrompt: vi.fn(async (id) => {
    const before = store.rows.length;
    store.rows = store.rows.filter((r) => r.id !== Number(id));
    return before - store.rows.length;
  }),
}));

import {
  initSavedPrompts,
  listSavedPrompts,
  getSavedPrompt,
  createSavedPrompt,
  updateSavedPrompt,
  removeSavedPrompt,
  TITLE_MAX,
  BODY_MAX,
} from '../lib/savedprompts.js';

beforeEach(async () => {
  store.rows = [];
  store.nextId = 1;
  await initSavedPrompts();
});

describe('validation', () => {
  it('refuses a prompt without a title or a body', async () => {
    await expect(createSavedPrompt({ title: '  ', body: 'x' })).rejects.toThrow(/needs a title/);
    await expect(createSavedPrompt({ title: 'Fix', body: '\n  \n' })).rejects.toThrow(/needs a body/);
  });

  it('caps the title and body lengths', async () => {
    await expect(createSavedPrompt({ title: 'a'.repeat(TITLE_MAX + 1), body: 'x' })).rejects.toThrow(/title/);
    await expect(createSavedPrompt({ title: 'ok', body: 'x'.repeat(BODY_MAX + 1) })).rejects.toThrow(/body/);
  });

  it('trims the title and the blank lines around the body, but not its layout', async () => {
    const p = await createSavedPrompt({ title: '  Refactor ', body: '\n\n- one\n  - two\n\n' });
    expect(p.title).toBe('Refactor');
    expect(p.body).toBe('- one\n  - two');
  });

  it('stores an empty repo as null, meaning every project', async () => {
    const p = await createSavedPrompt({ title: 'Any', body: 'x', repo: '  ' });
    expect(p.repo).toBeNull();
  });
});

describe('CRUD', () => {
  it('appends a new prompt after the existing ones', async () => {
    await createSavedPrompt({ title: 'A', body: 'x', sortOrder: 5 });
    const b = await createSavedPrompt({ title: 'B', body: 'y' });
    expect(b.sortOrder).toBe(6);
    expect(listSavedPrompts().map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('keeps an explicit sortOrder of 0 instead of appending', async () => {
    await createSavedPrompt({ title: 'Later', body: 'x', sortOrder: 5 });
    const first = await createSavedPrompt({ title: 'First', body: 'y', sortOrder: 0 });
    expect(first.sortOrder).toBe(0);
    expect(listSavedPrompts().map((p) => p.title)).toEqual(['First', 'Later']);
  });

  it('updates only the fields sent, and re-validates the result', async () => {
    const a = await createSavedPrompt({ title: 'A', body: 'x', repo: 'acme/shop' });
    const u = await updateSavedPrompt(a.id, { body: 'y' });
    expect(u).toMatchObject({ title: 'A', body: 'y', repo: 'acme/shop' });
    await expect(updateSavedPrompt(a.id, { title: '' })).rejects.toThrow(/needs a title/);
    expect(getSavedPrompt(a.id).body).toBe('y');
  });

  it('leaves the sort order alone when the Order field is cleared', async () => {
    const a = await createSavedPrompt({ title: 'A', body: 'x', sortOrder: 7 });
    const u = await updateSavedPrompt(a.id, { body: 'y', sortOrder: null });
    expect(u.sortOrder).toBe(7);
    expect(await updateSavedPrompt(a.id, { sortOrder: '' })).toMatchObject({ sortOrder: 7 });
    expect(await updateSavedPrompt(a.id, { sortOrder: 0 })).toMatchObject({ sortOrder: 0 });
  });

  it('reports a missing prompt as 404 on update', async () => {
    await expect(updateSavedPrompt(99, { title: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('deletes and drops the prompt from the cache', async () => {
    const a = await createSavedPrompt({ title: 'A', body: 'x' });
    expect(await removeSavedPrompt(a.id)).toBe(1);
    expect(await removeSavedPrompt(a.id)).toBe(0);
    expect(listSavedPrompts()).toEqual([]);
  });
});

describe('listing for a project', () => {
  it("puts the project's own prompts before the shared ones and hides other projects'", async () => {
    await createSavedPrompt({ title: 'Shared', body: 'x' });
    await createSavedPrompt({ title: 'Other', body: 'x', repo: 'acme/other' });
    await createSavedPrompt({ title: 'Mine', body: 'x', repo: 'acme/shop' });
    expect(listSavedPrompts('acme/shop').map((p) => p.title)).toEqual(['Mine', 'Shared']);
    expect(listSavedPrompts().map((p) => p.title)).toEqual(['Shared', 'Other', 'Mine']);
  });
});
