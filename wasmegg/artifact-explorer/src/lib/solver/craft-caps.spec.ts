// Upper bounds on the craft columns.
//
// The danger with a column bound is entirely one-sided: too loose merely wastes
// the optimisation, too tight silently cuts off the optimum and the solver
// reports a worse plan as though it were the best available. So these check the
// arithmetic exactly on a hand-built DAG, and check the relaxation property on
// the real instances.

import { describe, expect, it } from 'vitest';

import { buildModel } from './model';
import { makeNode, makeOpt } from '../spec-helpers';
import { buildRecipeDag, computeBaseYield, optimize } from '..';
import { enumerateLaunchOptions } from '../phases';
import { perfectShipsConfig } from 'lib';
import type { RecipeDAG } from '../types';
import type { PlanProblem } from './types';

// A1 = 2x B1, B1 = 2x C1, C1 only drops.
const dag: RecipeDAG = new Map([
  ['A1', makeNode('A1', false, [['B1', 2]], 0.5)],
  ['B1', makeNode('B1', false, [['C1', 2]])],
  ['C1', makeNode('C1', true)],
]);

function problemWith(over: Partial<PlanProblem>): PlanProblem {
  return {
    options: [makeOpt(1, 1, [['C1', 8]])],
    dag,
    targets: ['A1'],
    fuelCapacity: 60,
    timeCapacity: 1000,
    slots: 3,
    baseYield: new Map(),
    ...over,
  };
}

const capOf = (model: ReturnType<typeof buildModel>, id: string) => model.craftCaps[model.craftables.indexOf(id)];

describe('craftUpperBounds', () => {
  it('propagates the drop ceiling up through the recipe', () => {
    // fuel 1/60 per launch caps the group at 60 launches, so at most 480 C1.
    // 480 C1 -> 240 B1 -> 120 A1.
    const model = buildModel(problemWith({}));
    expect(capOf(model, 'B1')).toBe(240);
    expect(capOf(model, 'A1')).toBe(120);
  });

  it('counts owned inventory as supply', () => {
    const model = buildModel(problemWith({ baseYield: new Map([['C1', 40]]) }));
    expect(capOf(model, 'B1')).toBe((480 + 40) / 2);
  });

  it('does not floor: the craft columns are continuous', () => {
    // One launch affordable, dropping 5 C1: 2.5 B1 and 1.25 A1 are reachable
    // points of the LP, and a floored bound would cut them off.
    const model = buildModel(problemWith({ options: [makeOpt(60, 1, [['C1', 5]])], fuelCapacity: 60 }));
    expect(capOf(model, 'B1')).toBe(2.5);
    expect(capOf(model, 'A1')).toBe(1.25);
  });

  it('bounds to zero when an ingredient can never be obtained', () => {
    // Z9 is in no recipe and drops from nothing, so no A1 can ever be crafted.
    // Conservation says the same thing — Z9 gets a row with no producer and no
    // supply — so this agrees with the polytope rather than tightening it.
    const unobtainable: RecipeDAG = new Map([
      ['A1', makeNode('A1', false, [['Z9', 1]], 0.5)],
      ['Z9', makeNode('Z9', true)],
    ]);
    const model = buildModel(problemWith({ dag: unobtainable, targets: ['A1'] }));
    expect(capOf(model, 'A1')).toBe(0);
  });

  it('leaves a childless craftable unbounded rather than guessing', () => {
    const childless: RecipeDAG = new Map([['A1', makeNode('A1', false, [], 0.5)]]);
    const model = buildModel(problemWith({ dag: childless, targets: ['A1'] }));
    expect(capOf(model, 'A1')).toBe(Infinity);
  });

  it('handles two targets sharing an ingredient, whose post-order is not reverse discovery order', () => {
    // A2 is discovered after the shared node B1, so a reverse-first-visit walk
    // would read B1's bound before computing it.
    const shared: RecipeDAG = new Map([
      ['A1', makeNode('A1', false, [['B1', 2]], 0.5)],
      ['B1', makeNode('B1', false, [['C1', 2]])],
      ['C1', makeNode('C1', true)],
      ['A2', makeNode('A2', false, [['B1', 4]], 0.5)],
    ]);
    const model = buildModel(problemWith({ dag: shared, targets: ['A1', 'A2'] }));
    expect(capOf(model, 'B1')).toBe(240);
    expect(capOf(model, 'A1')).toBe(120);
    expect(capOf(model, 'A2')).toBe(60);
  });

  it('bounds every craft the solver actually makes, on real instances', async () => {
    for (const targets of [['puzzle-cube-4'], ['puzzle-cube-4', 'lunar-totem-4']]) {
      const realDag = buildRecipeDag(targets, 30);
      const baseYield = computeBaseYield(null, targets, realDag);
      const [solution] = await optimize(
        {
          desiredArtifactNodeIds: targets,
          includeNotEnoughData: false,
          fuelTankCapacity: 2_000_000_000,
          timeBudgetSeconds: 3 * 24 * 3600,
        },
        perfectShipsConfig,
        realDag,
        baseYield
      );
      const model = buildModel({
        // The same menu the solve ran on: a model built without the options is
        // a model in which nothing drops, and every bound is 0.
        options: enumerateLaunchOptions(perfectShipsConfig, realDag).filter(
          o => o.actualTime > 0 && o.actualTime <= 3 * 24 * 3600
        ),
        dag: realDag,
        targets,
        fuelCapacity: 2_000_000_000,
        timeCapacity: 3 * 24 * 3600,
        slots: 3,
        baseYield,
      });
      // Necessary condition for the bound to be a relaxation: the plan the
      // solver returned has to sit inside it.
      for (const [nodeId, crafts] of solution.craftPrimal) {
        const idx = model.craftables.indexOf(nodeId);
        if (idx < 0) continue;
        expect(crafts).toBeLessThanOrEqual(model.craftCaps[idx] + 1e-6);
      }
    }
  }, 120_000);
});
