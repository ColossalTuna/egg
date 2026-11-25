import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();

function run(pCraft: number, cap: number, withSecond: boolean) {
  const dag = new Map([
    ['T', makeNode('T', false, [['L', 1]], pCraft)],
    ['L', makeNode('L', true)],
    ['U', makeNode('U', true)],
  ]);
  const options = [makeOpt(0, 1, [['L', 1]]), makeOpt(0, 1, [], [['U', 0.01]])];
  return solveWith(
    {
      options,
      dag,
      targets: withSecond ? ['T', 'U'] : ['T'],
      fuelCapacity: 1,
      timeCapacityPerSlot: cap,
      slots: 3,
      ownedStock: new Map(),
    },
    solve,
    undefined,
    { report: true }
  );
}

describe('SOL-03 certain craft proxy', () => {
  it('plans for a pCraft=1 target (single target)', () => {
    const res = run(1, 100, false);
    // BREAKAGE SOL-03
    expect(res.allocation[0]).toBeGreaterThan(0);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.99);
  });
  it('plans for a pCraft=1 target alongside a second target', () => {
    const res = run(1, 100, true);
    // BREAKAGE SOL-03
    expect(res.reported!.jointProbability).toBeGreaterThan(0.5);
  });
  it('pCraft=1 fails even with only 3 launches of budget (theta=3e4 from the proxy)', () => {
    const res = run(1, 1, false);
    // BREAKAGE SOL-03
    expect(res.reported!.jointProbability).toBeGreaterThan(0.9);
  });
  it('control: pCraft=0.99 with the same menu but only 3 launches of budget plans fine', () => {
    const res = run(0.99, 1, false);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.9);
  });
  it('control: pCraft=0.1 with the two-target menu plans fine', () => {
    const res = run(0.1, 100, true);
    expect(res.reported!.jointProbability).toBeGreaterThan(0.5);
  });
});
