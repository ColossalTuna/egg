import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import type { PlanProblem } from '@/lib/solver/types';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();

function problem(over: Partial<PlanProblem> & Pick<PlanProblem, 'options' | 'dag' | 'targets'>): PlanProblem {
  return { fuelCapacity: 1, timeCapacityPerSlot: 1000, slots: 3, ownedStock: new Map(), ...over };
}

describe('SOL-02 single saturated target', () => {
  const run = (cap: number) => {
    const dag = new Map([['T', makeNode('T', true)]]);
    const options = [makeOpt(0, 1, [], [['T', 1]])];
    return solveWith(problem({ options, dag, targets: ['T'], timeCapacityPerSlot: cap }), solve, undefined, {
      report: true,
    });
  };
  it('stated input (cap 1000 s, theta 3000) still plans', () => {
    const res = run(1000);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.99);
  });
  it('launches something when theta is 9000 (cap 3000 s)', () => {
    const res = run(3000);
    // BREAKAGE SOL-02
    expect(res.allocation[0]).toBeGreaterThan(0);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.99);
  });
});

describe('SOL-01 two targets, one saturating', () => {
  it('does not return the empty plan', () => {
    const dag = new Map([
      ['A', makeNode('A', true)],
      ['B', makeNode('B', true)],
    ]);
    const options = [makeOpt(0, 1, [], [['B', 1]]), makeOpt(0, 1.5, [], [['A', 1e-3]])];
    // slot capacity 10000 s, shared: 30000 s total
    const res = solveWith(problem({ options, dag, targets: ['A', 'B'], timeCapacityPerSlot: 10000 }), solve, undefined, {
      report: true,
    });
    console.log('SOL-01 alloc', res.allocation, res.reported);
    // BREAKAGE SOL-01
    expect(res.allocation.some(x => x > 0)).toBe(true);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.5);
  });
});
