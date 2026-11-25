import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { buildModel } from '@/lib/solver/model';
import { evaluateCounts, EXACT_PRECISION } from '@/lib/solver/evaluator';
import { craftDag, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();
const Q = -Math.log(1 - 0.1);
// Owned leaf stock giving crafts * Q = ln 2, i.e. P = 0.5 before any launch.
const OWNED = Math.LN2 / Q;

function run(deltaNats: number) {
  // d(nats)/d(crafts) at s = ln2 is Q * g'(ln2) = Q * 1. Three 1-second launches (slot 1 s), one per slot.
  const perLaunch = deltaNats / Q / 3;
  const problem = {
    options: [makeOpt(0, 1, [['B', perLaunch]])],
    dag: craftDag(0.1),
    targets: ['A'],
    fuelCapacity: 1,
    timeCapacityPerSlot: 1,
    slots: 3,
    ownedStock: new Map([['B', OWNED]]),
  };
  const res = solveWith(problem, solve, undefined, { report: true });
  const model = buildModel(problem);
  const full = evaluateCounts(model, [3], EXACT_PRECISION).logJoint;
  const empty = evaluateCounts(model, [0], EXACT_PRECISION).logJoint;
  return { res, gain: full - empty };
}

describe('SOL-27 marginal improvement over the empty plan', () => {
  for (const delta of [1e-5, 1e-6, 1e-7, 5e-8, 1e-8, 1e-9]) {
    it(`true gain ~ ${delta} nats`, () => {
      const { res, gain } = run(delta);
      expect(gain).toBeGreaterThan(delta * 0.5); // the better plan genuinely exists
      // SOL-27 hypothesis (plan thrown away when gain < 1e-7 nats)
      expect(res.allocation[0], `gain ${gain}`).toBe(3);
    });
  }
});
