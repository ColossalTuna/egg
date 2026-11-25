import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();

describe('SOL-24 huge slot capacity', () => {
  it('uses more than 1e6 launches per slot when time allows (S = 1e10 s, 600 s missions)', () => {
    const dag = new Map([['T', makeNode('T', true)]]);
    // Tiny per-launch yield: more launches is strictly better all the way to the time limit.
    const options = [makeOpt(0, 600, [], [['T', 1e-10]])];
    const S = 1e10;
    const maxTotal = 3 * Math.floor(S / 600); // 50,000,000
    const res = solveWith(
      { options, dag, targets: ['T'], fuelCapacity: 1, timeCapacityPerSlot: S, slots: 3, ownedStock: new Map() },
      solve,
      undefined,
      { report: true }
    );
    // BREAKAGE SOL-24
    expect(res.allocation[0], `limit ${maxTotal}`).toBeGreaterThan(3e6);
  });
});
