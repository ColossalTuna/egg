import { describe, expect, it, vi } from 'vitest';
import { optimizeFull } from '@/lib/optimizer-core';
import { loadHighs } from '@/lib/solver/highs';
import { DEFAULT_TUNING, solveWith } from '@/lib/solver/solve';
import { makeNode, makeOpt } from './../unit/spec-helpers';

const LEAF = 'lunar-totem-1';

function leafProblem() {
  const dag = new Map([[LEAF, makeNode(LEAF, true, [], 0.05)]]);
  const options = [makeOpt(10, 1000, [[LEAF, 100]], [[LEAF, 0.001]])];
  return { dag, options };
}

describe('SOL-05 / SOL-20(a): leaf target with pCraft > 0', () => {
  it('SOL-05: printed probability equals the drop-only probability', async () => {
    const { dag, options } = leafProblem();
    const sol = await optimizeFull({
      options, recipeDag: dag, desiredArtifactNodeIds: [LEAF], fuelCapacity: 1000,
      timeCapacityPerSlot: 10000, maximumCost: undefined, ownedStock: new Map(),
    });
    const launches = sol.choiceHistory.reduce((s, c) => s + c.numShipsLaunched, 0);
    expect(launches).toBeGreaterThan(0);
    const lambda = 0.001 * launches;
    const dropOnly = -Math.expm1(-lambda);
    console.log('SOL-05 actual', { best: sol.bestProbability, craftP: sol.craftProbability, crafts: sol.expectedCrafts, dropOnly, launches });
    // BREAKAGE SOL-05
    expect(sol.bestProbability).toBeCloseTo(dropOnly, 6);
    // BREAKAGE SOL-05 (expectedCrafts must be 0 for a leaf: nothing is craftable)
    expect(sol.expectedCrafts).toBe(0);
  }, 60000);

  it('SOL-20(a): core joint equals the judge-reported joint', async () => {
    const { dag, options } = leafProblem();
    const sol = await optimizeFull({
      options, recipeDag: dag, desiredArtifactNodeIds: [LEAF], fuelCapacity: 1000,
      timeCapacityPerSlot: 10000, maximumCost: undefined, ownedStock: new Map(),
    });
    const solve = await loadHighs();
    const res = solveWith(
      { options, dag, targets: [LEAF], fuelCapacity: 1000, timeCapacityPerSlot: 10000, slots: 3, ownedStock: new Map() },
      solve, DEFAULT_TUNING, { report: true }
    );
    expect(res.reported).toBeDefined();
    console.log('SOL-20a', { core: sol.jointProbability, reported: res.reported!.jointProbability });
    // BREAKAGE SOL-20
    expect(Math.abs(sol.jointProbability - res.reported!.jointProbability)).toBeLessThan(1e-9);
  }, 60000);
});
