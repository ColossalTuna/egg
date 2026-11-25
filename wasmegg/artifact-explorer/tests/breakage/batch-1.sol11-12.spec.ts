import { describe, it, expect } from 'vitest';
import { optimizeFull } from '@/lib/optimizer-core';
import { makeNode, makeOpt, craftDag } from '../unit/spec-helpers';

// Every case here is a legal, finite problem; the intended behaviour is "returns a plan (possibly empty)",
// never "rejects".

describe('SOL-11/12 Rows.end throws outside any guard', () => {
  it('SOL-11a: fuel axis 1e21 with option fuel costs 1 and 1e21', async () => {
    const dag = new Map([
      ['A', makeNode('A', true)],
      ['B', makeNode('B', true)],
    ]);
    const options = [makeOpt(1, 10, [], [['A', 0.1]]), makeOpt(1e21, 10, [], [['B', 0.1]])];
    // BREAKAGE SOL-11a
    await expect(
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: ['A', 'B'],
        fuelCapacity: 1e21,
        timeCapacityPerSlot: 1000,
        maximumCost: undefined,
        ownedStock: new Map(),
      })
    ).resolves.toBeDefined();
  });

  it('SOL-11b: craft unit price 1e15 with a finite craft budget', async () => {
    const dag = craftDag(0.1);
    const options = [makeOpt(1, 10, [['B', 1]])];
    // BREAKAGE SOL-11b
    await expect(
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: ['A'],
        fuelCapacity: 1000,
        timeCapacityPerSlot: 1000,
        maximumCost: undefined,
        ownedStock: new Map(),
        craftBudget: { capacity: 1e20, unitPrices: new Map([['A', 1e15]]) },
      })
    ).resolves.toBeDefined();
  });

  it('SOL-12: owned stock 1e16 of the leaf ingredient (theta ~ 1e15)', async () => {
    const dag = craftDag(0.1);
    const options = [makeOpt(1, 10, [['B', 1]])];
    // BREAKAGE SOL-12
    await expect(
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: ['A'],
        fuelCapacity: 1000,
        timeCapacityPerSlot: 1000,
        maximumCost: undefined,
        ownedStock: new Map([['B', 1e16]]),
      })
    ).resolves.toBeDefined();
  });

  it('control: ordinary owned stock does not throw', async () => {
    const dag = craftDag(0.1);
    const options = [makeOpt(1, 10, [['B', 1]])];
    await expect(
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: ['A'],
        fuelCapacity: 1000,
        timeCapacityPerSlot: 1000,
        maximumCost: undefined,
        ownedStock: new Map([['B', 5]]),
      })
    ).resolves.toBeDefined();
  });
});
