import { describe, it, expect } from 'vitest';
import {
  absorbedOwners,
  absorbedRepricing,
  down,
} from '../migrations/2026_10_07_200000_measured_cache_pricing.js';

const catalog = { openai: { models: { gpt: { cost: { input: 4, output: 20, cache_read: 0.4 } } } } };
const child = { jobId: 'deleted', provider: 'codex', model: 'gpt', inputTokens: 10e6, costUsd: null };
const owners = new Map([['deleted', 'parent']]);
const parent = { absorbedEstimatedCostUsd: 14.8, absorbedEstimatedTurns: 1 };
const reconcile = (rows = [child], meta = parent, prices = catalog) =>
  absorbedRepricing(rows, owners, new Map([['parent', meta]]), prices);

describe('absorbed cache repricing', () => {
  it('reconciles the old 70% snapshot to the new default', () => {
    const change = reconcile().get('parent');
    expect(change.held).toBe(14.8);
    expect(change.next).toBeCloseTo(5.44);
  });
  it('uses genuine known-model measurements and the frozen old solve', () => {
    const paid = { provider: 'claude', model: 'gpt', inputTokens: 10e6, outputTokens: 0, costUsd: 22 };
    const measured = {
      ...child,
      jobId: 'live',
      inputTokens: 1e6,
      cachedInputTokens: 900000,
      cacheMeasured: true,
    };
    const inferred = { ...measured, inputTokens: 1e9, cachedInputTokens: 0, cacheMeasured: false };
    const unknown = { ...inferred, cacheMeasured: true, model: 'private' };
    const change = reconcile([child, paid, measured, inferred, unknown], {
      ...parent,
      absorbedEstimatedCostUsd: 22,
    }).get('parent');
    expect(change.next).toBeCloseTo(7.6);
  });
  it('preserves directly recorded cache pricing', () => {
    expect(
      reconcile([{ ...child, cachedInputTokens: 9e6 }], { ...parent, absorbedEstimatedCostUsd: 7.6 }).size,
    ).toBe(0);
  });
  it('does not transfer partial, missing, unpriceable or unrelated estimates', () => {
    expect(reconcile([], parent).size).toBe(0);
    expect(reconcile([child], { ...parent, absorbedEstimatedCostUsd: 1 }).size).toBe(0);
    expect(reconcile([child], { ...parent, absorbedEstimatedCostUsd: 25 }).size).toBe(0);
    expect(reconcile([child], { ...parent, absorbedEstimatedTurns: 2 }).size).toBe(0);
    expect(reconcile([child, { ...child, model: 'private' }]).size).toBe(0);
    expect(reconcile([child], parent, {}).size).toBe(0);
  });
  it('does not apply the same reconciliation twice', () => {
    expect(reconcile([child], { ...parent, absorbedPricingVersion: 'measured-cache-v1' }).size).toBe(0);
    expect(reconcile([child], { ...parent, absorbedEstimatedCostUsd: 5.44 }).size).toBe(0);
  });
  it('attributes nested deleted descendants, but excludes living sessions, cycles and missing links', () => {
    const links = new Map([
      ['deleted', 'intermediate'],
      ['intermediate', 'parent'],
      ['cycle', 'cycle'],
    ]);
    expect(
      absorbedOwners(['deleted', 'intermediate', 'parent', 'cycle', 'orphan'], new Set(['parent']), links),
    ).toEqual(
      new Map([
        ['deleted', 'parent'],
        ['intermediate', 'parent'],
      ]),
    );
  });
  it('refuses to roll reconciled dollar snapshots back', async () => {
    await expect(down()).rejects.toThrow('cannot be rolled back');
  });
});
