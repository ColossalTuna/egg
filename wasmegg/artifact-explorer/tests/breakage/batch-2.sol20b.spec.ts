// SOL-20(b): the exact evaluation throws during emit, so craftSplit is dropped while the allocation stands.
import { describe, expect, it, vi } from 'vitest';
import { optimizeFull } from '@/lib/optimizer-core';
import { craftDag, makeOpt } from '../unit/spec-helpers';

const state = vi.hoisted(() => ({ failExact: false }));

vi.mock('@/lib/solver/evaluator', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/solver/evaluator')>();
  return {
    ...real,
    evaluateCounts: (model: any, counts: any, precision: any) => {
      if (state.failExact && precision === real.EXACT_PRECISION) throw new Error('simplex iteration cap');
      return real.evaluateCounts(model, counts, precision);
    },
  };
});

describe('SOL-20(b): dropped report', () => {
  it('printed joint is the same whether or not the exact evaluation succeeded', async () => {
    const run = () =>
      optimizeFull({
        options: [makeOpt(10, 1000, [['B', 5]])], recipeDag: craftDag(0.1), desiredArtifactNodeIds: ['A'],
        fuelCapacity: 1000, timeCapacityPerSlot: 10000, maximumCost: undefined, ownedStock: new Map(),
      });
    state.failExact = false;
    const ok = await run();
    state.failExact = true;
    const dropped = await run();
    console.log('SOL-20b ok', ok.jointProbability, ok.expectedCrafts, 'dropped', dropped.jointProbability, dropped.expectedCrafts, 'launches', dropped.choiceHistory.length);
    expect(dropped.choiceHistory.length).toBeGreaterThan(0);
    // BREAKAGE SOL-20
    expect(Math.abs(dropped.jointProbability - ok.jointProbability)).toBeLessThan(1e-9);
  });
});
