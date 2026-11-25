import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { logHit } from '@/lib/objective';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();

function inst(ra: number, rb: number, cap: number) {
  const dag = new Map([
    ['A', makeNode('A', true)],
    ['B', makeNode('B', true)],
  ]);
  return {
    options: [makeOpt(0, 1, [], [['A', ra]]), makeOpt(0, 1, [], [['B', rb]])],
    dag,
    targets: ['A', 'B'],
    fuelCapacity: 1,
    timeCapacityPerSlot: cap,
    slots: 3,
    ownedStock: new Map<string, number>(),
  };
}

describe('SOL-23 near-certain targets', () => {
  // theta_A = ra * 3 * cap ~ 15 for each
  for (const [ra, rb, cap] of [
    [0.05, 0.05, 100],
    [0.05, 0.04, 100],
    [0.03, 0.05, 100],
    [0.1, 0.1, 50],
    [0.06, 0.05, 90],
  ]) {
    it(`rates ${ra}/${rb}, cap ${cap}`, () => {
      const N = 3 * cap;
      const res = solveWith(inst(ra, rb, cap), solve, undefined);
      const [x, y] = res.allocation;
      let best = -Infinity;
      let bx = 0;
      for (let k = 0; k <= N; k++) {
        const v = logHit(ra * k) + logHit(rb * (N - k));
        if (v > best) {
          best = v;
          bx = k;
        }
      }
      const got = logHit(ra * x) + logHit(rb * y);
      fs.appendFileSync(
        '/tmp/claude-0/-home-user/a22aedd7-088d-5d1b-95b1-bf2c8e0a0a97/scratchpad/sol23.txt',
        JSON.stringify({ ra, rb, cap, x, y, bx, got, best, gap: best - got, thetaA: ra * N }) + '\n'
      );
      // SOL-23: fails, but NOT because of HiGHS abs gap (see attribution test below): same gaps with mip_abs_gap=1e-12.
      expect(best - got).toBeLessThan(1e-7);
    });
  }
});

// Attribution probe: same instances with HiGHS's absolute gap tightened (SOLVER_OPTIONS is spread into every
// solve call, so mutating it in this file's module instance is enough). Records whether the gap closes.
import { SOLVER_OPTIONS } from '@/lib/solver/types';

describe('SOL-23 attribution: mip_abs_gap tightened to 1e-12', () => {
  it('records gaps', () => {
    (SOLVER_OPTIONS as Record<string, number>).mip_abs_gap = 1e-12;
    const out: unknown[] = [];
    for (const [ra, rb, cap] of [
      [0.05, 0.05, 100],
      [0.05, 0.04, 100],
      [0.03, 0.05, 100],
    ]) {
      const N = 3 * cap;
      const res = solveWith(inst(ra, rb, cap), solve, undefined);
      const [x, y] = res.allocation;
      let best = -Infinity;
      for (let k = 0; k <= N; k++) best = Math.max(best, logHit(ra * k) + logHit(rb * (N - k)));
      out.push({ ra, rb, cap, x, y, gap: best - (logHit(ra * x) + logHit(rb * y)) });
    }
    delete (SOLVER_OPTIONS as Record<string, number>).mip_abs_gap;
    fs.appendFileSync('/tmp/claude-0/-home-user/a22aedd7-088d-5d1b-95b1-bf2c8e0a0a97/scratchpad/sol23.txt', 'TIGHT ' + JSON.stringify(out) + '\n');
    expect(true).toBe(true);
  });
});
