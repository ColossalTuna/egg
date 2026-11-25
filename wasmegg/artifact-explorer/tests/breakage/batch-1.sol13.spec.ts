import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();

describe('SOL-13 unbounded scale LP', () => {
  it('a childless craftable target with legendary drops still gets a plan', () => {
    // T is a craftable (isLeaf false) with no ingredients, so its craft column has no upper bound.
    const dag = new Map([['T', makeNode('T', false, [], 0.1)]]);
    const options = [makeOpt(0, 1, [], [['T', 0.01]])];
    const statuses: string[] = [];
    const spy: typeof solve = (m, l) => {
      const r = solve(m, l);
      statuses.push(r.status);
      return r;
    };
    const res = solveWith(
      { options, dag, targets: ['T'], fuelCapacity: 1, timeCapacityPerSlot: 100, slots: 3, ownedStock: new Map() },
      spy,
      undefined,
      { report: true }
    );
    // Mechanism check, changed with the SOL-13 fix: before it, the very first (scale) LP reported no finite
    // optimum (statuses were exactly ['unbounded']) and the solve stopped there. An ingredient-less craftable
    // now gets no craft column, so the solve runs and no LP in it is unbounded.
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain('unbounded');
    // BREAKAGE SOL-13
    expect(res.allocation[0]).toBeGreaterThan(0);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.5);
  });
});
