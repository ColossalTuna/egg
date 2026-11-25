import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { layoutOf } from '@/lib/solver/milp';
import { buildModel } from '@/lib/solver/model';
import { packWitness } from '@/lib/packing';
import type { MilpSolve, PlanProblem } from '@/lib/solver/types';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const real = await loadHighs();

describe('SOL-10 fractional HiGHS point is rounded into an unpackable plan', () => {
  it('never emits an allocation that does not pack', () => {
    const ids = ['A', 'B', 'C', 'D'];
    const dag = new Map(ids.map(id => [id, makeNode(id, true)]));
    const options = ids.map(id => makeOpt(0, 1, [], [[id, 0.5]]));
    const problem: PlanProblem = {
      options,
      dag,
      targets: ids,
      fuelCapacity: 1,
      timeCapacityPerSlot: 1, // one 1-second launch per slot: 3 launches fit in total
      slots: 3,
      ownedStock: new Map(),
    };
    const layout = layoutOf(buildModel(problem), 'oa');
    expect(layout.classes).toBe(1);
    expect(layout.groups).toBe(4);

    // Real HiGHS for the scale LPs; the OA MILP (the one with integer columns) answers with a fractional
    // point: four groups at 0.5 each, the shared class column [1, 1, 0] -- sums agree (2 == 2), slots fit.
    const solve: MilpSolve = (model, limits) => {
      if (!model.columnIsInteger.some(x => x === 1)) return real(model, limits);
      const v = new Float64Array(model.columnCount);
      v[0] = 1;
      v[1] = 1;
      for (let g = 0; g < 4; g++) v[layout.groupTotalBase + g] = 0.5;
      return { status: 'feasible', objective: 0, columnValues: v };
    };

    const res = solveWith(problem, solve, undefined, { report: false });
    const launches = res.allocation.reduce((a, b) => a + b, 0);
    const durations = options.map(() => 1);
    const w = packWitness(durations, res.allocation, 1);
    // BREAKAGE SOL-10
    expect(w, `allocation ${JSON.stringify(res.allocation)} (${launches} launches, 3 fit)`).not.toBeNull();
  });
});
