import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith, envelopeErrorNats } from '@/lib/solver/solve';
import { logHit } from '@/lib/objective';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();
const N = 10000; // launches of 1 s: 3 slots x 3334 s ~ 10002

function inst(rateA: number, rateB: number) {
  const dag = new Map([
    ['A', makeNode('A', true)],
    ['B', makeNode('B', true)],
  ]);
  return {
    // option 0 feeds A, option 1 feeds B
    options: [makeOpt(0, 1, [], [['A', rateA]]), makeOpt(0, 1, [], [['B', rateB]])],
    dag,
    targets: ['A', 'B'],
    fuelCapacity: 1,
    timeCapacityPerSlot: 3334,
    slots: 3,
    ownedStock: new Map<string, number>(),
  };
}

function value(x: number, y: number, a: number, b: number) {
  return logHit(a * x) + logHit(b * y);
}

describe('SOL-04 mid theta target', () => {
  for (const [a, b] of [
    [1e-5, 0.02],
    [1e-4, 0.02],
    [1e-6, 0.02],
    [3e-5, 0.02],
    [1e-3, 0.02],
    [3e-3, 0.02],
    [1e-2, 0.02],
    [3e-2, 0.02],
    [0.1, 0.02],
    [1e-3, 0.002],
    [1e-3, 0.005],
    [1e-4, 0.05],
    [1e-3, 0.05],
  ]) {
    it(`A rate ${a}, B rate ${b} (theta_B=200)`, () => {
      const res = solveWith(inst(a, b), solve, undefined, { report: true });
      const x = res.allocation[0];
      const y = res.allocation[1];
      let best = -Infinity;
      let bestX = 0;
      for (let k = 0; k <= N; k++) {
        const v = value(k, N - k, a, b);
        if (v > best) {
          best = v;
          bestX = k;
        }
      }
      const got = value(x, y, a, b);
      fs.appendFileSync(
        '/tmp/claude-0/-home-user/a22aedd7-088d-5d1b-95b1-bf2c8e0a0a97/scratchpad/sol04.txt',
        JSON.stringify({ a, b, x, y, got, best, bestX, tol: envelopeErrorNats(0.01, 50) }) + '\n'
      );
      // SOL-04 hypothesis (gap >> envelope error): not reproduced
      expect(best - got).toBeLessThan(10 * envelopeErrorNats(0.01, 50));
    });
  }
});
