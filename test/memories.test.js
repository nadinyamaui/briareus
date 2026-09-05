import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/config.js', () => ({ getConfig: () => ({}) }));

// An in-memory stand-in for the project_memories table, so the module's cache
// refreshes from something after every write the way it does against MySQL.
const store = vi.hoisted(() => ({ rows: [], nextId: 1, clock: 1 }));

vi.mock('../lib/db.js', () => ({
  loadMemoryRows: vi.fn(async () => [...store.rows]),
  getMemoryRow: vi.fn(async (id) => store.rows.find((r) => r.id === Number(id)) || null),
  saveMemory: vi.fn(async (m) => {
    const updatedAt = new Date(store.clock++ * 1000).toISOString();
    if (m.id) {
      const i = store.rows.findIndex((r) => r.id === m.id);
      if (i < 0) throw new Error(`No memory with id ${m.id}`);
      store.rows[i] = { ...store.rows[i], ...m, updatedAt };
      return store.rows[i];
    }
    const row = { ...m, id: store.nextId++, updatedAt };
    store.rows.push(row);
    return row;
  }),
  deleteMemory: vi.fn(async (id) => {
    const before = store.rows.length;
    store.rows = store.rows.filter((r) => r.id !== Number(id));
    return before - store.rows.length;
  }),
}));

import {
  initMemories,
  listMemories,
  findMemory,
  createMemory,
  updateMemory,
  upsertMemory,
  removeMemory,
  removeMemoryByName,
  memoryBriefing,
  slugify,
  BODY_MAX,
  BRIEFING_BUDGET,
} from '../lib/memories.js';

beforeEach(async () => {
  store.rows = [];
  store.nextId = 1;
  store.clock = 1;
  await initMemories();
});

describe('slugify', () => {
  it('folds whatever was typed into a memory-file style name', () => {
    expect(slugify(' DB Naming  Rules! ')).toBe('db-naming-rules');
    expect(slugify('already-a-slug')).toBe('already-a-slug');
    expect(slugify('')).toBe('');
  });
});

describe('createMemory', () => {
  it('needs a repo, a name and a body, and a known type', async () => {
    await expect(createMemory({ name: 'x', body: 'y' })).rejects.toThrow(/belongs to a project/);
    await expect(createMemory({ repo: 'o/r', body: 'y' })).rejects.toThrow(/needs a name/);
    await expect(createMemory({ repo: 'o/r', name: 'x' })).rejects.toThrow(/needs a body/);
    await expect(createMemory({ repo: 'o/r', name: 'x', body: 'y', type: 'weird' })).rejects.toThrow(
      /type must be one of/,
    );
    await expect(createMemory({ repo: 'o/r', name: 'x', body: 'y'.repeat(BODY_MAX + 1) })).rejects.toThrow(
      /body is over/,
    );
  });

  it('defaults the type to project and slugs the name', async () => {
    const m = await createMemory({ repo: 'o/r', name: 'Prefers Small PRs', body: 'Keep them short.' });
    expect(m.type).toBe('project');
    expect(m.name).toBe('prefers-small-prs');
    expect(listMemories('o/r')).toHaveLength(1);
    expect(listMemories('other/repo')).toHaveLength(0);
  });

  it('refuses a second memory of the same name on the same project', async () => {
    await createMemory({ repo: 'o/r', name: 'a', body: '1' });
    await expect(createMemory({ repo: 'o/r', name: 'A', body: '2' })).rejects.toMatchObject({ status: 409 });
    // Another project is another namespace.
    await expect(createMemory({ repo: 'o/other', name: 'a', body: '2' })).resolves.toBeTruthy();
  });
});

describe('upsertMemory', () => {
  it('creates on a new name and replaces on a known one, keeping the writer', async () => {
    const first = await upsertMemory('o/r', { name: 'style', body: 'tabs', jobId: 'j1' });
    const second = await upsertMemory('o/r', {
      name: 'style',
      body: 'spaces',
      type: 'feedback',
      jobId: 'j2',
    });
    expect(second.id).toBe(first.id);
    expect(findMemory('o/r', 'style')).toMatchObject({ body: 'spaces', type: 'feedback', jobId: 'j2' });
    expect(listMemories()).toHaveLength(1);
  });

  it('cannot be steered onto another project by the body', async () => {
    await upsertMemory('o/r', { name: 'x', body: 'y', repo: 'evil/repo' });
    expect(listMemories('evil/repo')).toHaveLength(0);
    expect(listMemories('o/r')).toHaveLength(1);
  });
});

describe('updateMemory / removeMemory', () => {
  it('404s on an unknown id and 409s on a name clash', async () => {
    const a = await createMemory({ repo: 'o/r', name: 'a', body: '1' });
    await createMemory({ repo: 'o/r', name: 'b', body: '2' });
    await expect(updateMemory(99, { body: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(updateMemory(a.id, { name: 'b' })).rejects.toMatchObject({ status: 409 });
    const edited = await updateMemory(a.id, { body: 'edited', jobId: null });
    expect(edited.body).toBe('edited');
  });

  it('removes by id and by name', async () => {
    const a = await createMemory({ repo: 'o/r', name: 'a', body: '1' });
    await createMemory({ repo: 'o/r', name: 'b', body: '2' });
    expect(await removeMemory(a.id)).toBe(1);
    expect(await removeMemoryByName('o/r', 'nope')).toBe(0);
    expect(await removeMemoryByName('o/r', 'B')).toBe(1);
    expect(listMemories()).toHaveLength(0);
  });
});

describe('memoryBriefing', () => {
  it('is empty for a project with nothing remembered', () => {
    expect(memoryBriefing('o/r')).toBe('');
  });

  it('lists every memory whole, newest first', async () => {
    await createMemory({ repo: 'o/r', name: 'old', body: 'first', description: 'd1' });
    await createMemory({ repo: 'o/r', name: 'new', type: 'feedback', body: 'second' });
    await createMemory({ repo: 'x/y', name: 'elsewhere', body: 'not here' });
    const text = memoryBriefing('o/r');
    expect(text.indexOf('### new (feedback)')).toBeLessThan(text.indexOf('### old (project)'));
    expect(text).toContain('d1\n\nfirst');
    expect(text).not.toContain('elsewhere');
  });

  it('falls back to headlines once the budget is spent', async () => {
    const big = 'x'.repeat(BODY_MAX);
    for (let i = 0; i < Math.ceil(BRIEFING_BUDGET / BODY_MAX) + 1; i++) {
      await createMemory({ repo: 'o/r', name: `m${i}`, body: big, description: `about ${i}` });
    }
    const text = memoryBriefing('o/r');
    expect(text).toContain('listed by headline only');
    // The oldest is the one pushed out, and it is still named.
    expect(text).toContain('- m0 (project): about 0');
    expect(text).not.toContain('### m0 ');
  });
});
