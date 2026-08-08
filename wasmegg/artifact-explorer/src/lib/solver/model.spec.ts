// Regression coverage for the quantity guard in `buildModel`: a non-finite
// inventory or yield must not reach the LP matrix, the way a non-finite cost
// already can't (see the comment above the cost guard in model.ts).

import { describe, expect, it } from 'vitest';
import { buildModel } from './model';
import { solveWith } from './oa';
import { loadHighs } from './highs';
import { makeNode, makeOpt } from '../spec-helpers';
import type { RecipeDAG } from '../types';
import type { PlanProblem } from './types';

const dag: RecipeDAG = new Map([
  ['A1', makeNode('A1', false, [['B1', 1]], 0.5)],
  ['B1', makeNode('B1', true)],
]);

function problemWith(overrides: Partial<PlanProblem>): PlanProblem {
  return {
    options: [makeOpt(1, 1, [['B1', 1]])],
    dag,
    targets: ['A1'],
    fuelCapacity: 60,
    timeCapacity: 1000,
    slots: 3,
    baseYield: new Map(),
    ...overrides,
  };
}

describe('buildModel rejects non-finite quantities the way it rejects non-finite costs', () => {
  it('drops an option whose yieldVector entry for a consumed item is Infinity', () => {
    const bad = makeOpt(1, 1, [['B1', Infinity]]);
    const good = makeOpt(1, 1, [['B1', 1]]);
    const model = buildModel(problemWith({ options: [bad, good] }));
    expect(model.groupOfOption[0]).toBe(-1); // bad option dropped, no group
    expect(model.groupOfOption[1]).toBeGreaterThanOrEqual(0); // good option kept
  });

  it('drops an option whose legendaryYieldVector entry for a target is Infinity', () => {
    const bad = makeOpt(1, 1, [], [['A1', Infinity]]);
    const good = makeOpt(1, 1, [['B1', 1]]);
    const model = buildModel(problemWith({ options: [bad, good] }));
    expect(model.groupOfOption[0]).toBe(-1);
    expect(model.groupOfOption[1]).toBeGreaterThanOrEqual(0);
  });

  it('clamps a non-finite baseYield entry to 0 instead of writing it into the matrix', () => {
    const model = buildModel(problemWith({ baseYield: new Map([['B1', NaN]]) }));
    const itemIdx = model.items.indexOf('B1');
    expect(itemIdx).toBeGreaterThanOrEqual(0);
    expect(model.baseB[itemIdx]).toBe(0);
  });

  it('a solve survives Infinity in yieldVector, legendaryYieldVector, and baseYield together', async () => {
    const solve = await loadHighs();
    const problem = problemWith({
      options: [
        makeOpt(1, 1, [['B1', Infinity]]), // dropped: non-finite yield
        makeOpt(1, 1, [], [['A1', Infinity]]), // dropped: non-finite legendary yield
        makeOpt(1, 1, [['B1', 1]]), // the only usable option
      ],
      baseYield: new Map([['B1', NaN]]), // clamped to 0
    });
    const result = solveWith(problem, solve);
    expect(result.allocation).toHaveLength(problem.options.length);
    expect(result.allocation.every(n => Number.isFinite(n) && n >= 0)).toBe(true);
    // The surviving option must be the one actually used.
    expect(result.allocation[2]).toBeGreaterThan(0);
    expect(result.allocation[0]).toBe(0);
    expect(result.allocation[1]).toBe(0);
  });
});
