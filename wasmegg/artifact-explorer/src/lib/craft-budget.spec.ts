// The golden egg cap, at each of the three places it has to hold.
//
// The cap is one linear row, but it is written into three models, and only the
// last of them decides the number the UI prints: the MILP chooses which
// ingredients get gathered, `compileJointInnerLp` seeds the craft split, and
// `refineJointCraftSplit` produces the `craftPrimal` that `computePlanCraftingCost`
// prices. A row missing from any one of them is a cap that does not bind, which
// is what most of this file is guarding against.

import { describe, expect, it } from 'vitest';
import { ei, getArtifactTierPropsFromId, Inventory, multiCraftCost, perfectShipsConfig, singleCraftCost } from 'lib';

import { buildRecipeDag, computeBaseYield, computePlanCraftingCost, computeCraftUnitPrices, optimize } from '@/lib';
import { buildModel } from './solver/model';
import { compileInnerLp, compileJointInnerLp, refineJointCraftSplit } from './value-function';
import { makeNode, makeOpt } from './spec-helpers';
import type { CraftBudget, RecipeDAG } from './types';
import type { PlanProblem } from './solver/types';

const Name = ei.ArtifactSpec.Name;
const Level = ei.ArtifactSpec.Level;

// A1 = 2x B1, B1 = 2x C1, C1 only drops. Two priced columns, so a budget can
// bind on the split rather than only on the total.
const dag: RecipeDAG = new Map([
  ['A1', makeNode('A1', false, [['B1', 2]], 0.5)],
  ['B1', makeNode('B1', false, [['C1', 2]])],
  ['C1', makeNode('C1', true)],
]);

const prices = (a: number, b: number): ReadonlyMap<string, number> =>
  new Map([
    ['A1', a],
    ['B1', b],
  ]);

function problemWith(overrides: Partial<PlanProblem>): PlanProblem {
  return {
    options: [makeOpt(1, 1, [['C1', 8]])],
    dag,
    targets: ['A1'],
    fuelCapacity: 60,
    timeCapacity: 1000,
    slots: 3,
    baseYield: new Map(),
    ...overrides,
  };
}

describe('computeCraftUnitPrices', () => {
  const cubes = buildRecipeDag(['puzzle-cube-4'], 30);

  it('prices every craftable at the player next craft and skips the leaves', () => {
    const prices = computeCraftUnitPrices(cubes, null);
    for (const [nodeId, node] of cubes) {
      const params = getArtifactTierPropsFromId(nodeId).recipe?.crafting_price;
      if (node.isLeaf || !params) {
        expect(prices.has(nodeId)).toBe(false);
      } else {
        expect(prices.get(nodeId)).toBe(singleCraftCost(params, 0));
      }
    }
  });

  it('reads the crafted count out of the inventory, so a veteran is priced lower', () => {
    // artifactStatus.count is what Inventory reads as `crafted`; puzzle-cube-2
    // is the LESSER tier of the family.
    const inventory = new Inventory({
      artifactStatus: [
        {
          spec: { name: Name.PUZZLE_CUBE, level: Level.LESSER },
          count: 40,
          discovered: true,
          recipeDiscovered: true,
        },
      ],
    });
    const params = getArtifactTierPropsFromId('puzzle-cube-2').recipe!.crafting_price;
    const veteran = computeCraftUnitPrices(cubes, inventory);
    expect(veteran.get('puzzle-cube-2')).toBe(singleCraftCost(params, 40));
    expect(veteran.get('puzzle-cube-2')!).toBeLessThan(computeCraftUnitPrices(cubes, null).get('puzzle-cube-2')!);
  });

  it('never under-states the bill: the linear price dominates the real curve', () => {
    const unit = computeCraftUnitPrices(cubes, null);
    const params = getArtifactTierPropsFromId('puzzle-cube-3').recipe!.crafting_price;
    for (const crafts of [1, 2, 5, 20, 100]) {
      expect(unit.get('puzzle-cube-3')! * crafts).toBeGreaterThanOrEqual(multiCraftCost(params, 0, crafts));
    }
  });
});

describe('buildModel', () => {
  it('leaves the capacity infinite when there is no budget, so no row is written', () => {
    expect(buildModel(problemWith({})).craftBudgetCapacity).toBe(Infinity);
  });

  it('carries the prices dense over the craft columns', () => {
    const model = buildModel(problemWith({ craftBudget: { capacity: 500, unitPrices: prices(100, 25) } }));
    expect(model.craftBudgetCapacity).toBe(500);
    expect(model.craftPrices[model.craftables.indexOf('A1')]).toBe(100);
    expect(model.craftPrices[model.craftables.indexOf('B1')]).toBe(25);
  });

  it('drops a negative or non-finite price rather than letting a craft earn budget', () => {
    const model = buildModel(
      problemWith({
        craftBudget: {
          capacity: 500,
          unitPrices: new Map([
            ['A1', -100],
            ['B1', NaN],
          ]),
        },
      })
    );
    // every price rejected, so the cap cannot bind and no row is written
    expect(model.craftPrices).toEqual([0, 0]);
    expect(model.craftBudgetCapacity).toBe(Infinity);
  });

  it('ignores a capacity that is not a usable number', () => {
    for (const capacity of [NaN, -1]) {
      const model = buildModel(problemWith({ craftBudget: { capacity, unitPrices: prices(100, 25) } }));
      expect(model.craftBudgetCapacity).toBe(Infinity);
    }
  });
});

describe('the inner LPs', () => {
  const Q = new Map([['A1', -Math.log(1 - 0.5)]]);
  // 40 C1 in hand: enough for 20 B1 and 10 A1 if nothing else binds.
  const inventory = new Map([['C1', 40]]);
  const lambda = new Map<string, number>();

  const billOf = (primal: Map<string, number>, budget: CraftBudget) => {
    let total = 0;
    for (const [nodeId, crafts] of primal) total += (budget.unitPrices.get(nodeId) ?? 0) * crafts;
    return total;
  };

  it('crafts what the inventory allows when the budget is slack', () => {
    const lp = compileJointInnerLp(dag, ['A1'], Q, { capacity: 1e9, unitPrices: prices(100, 25) });
    expect(lp.solve(inventory, lambda).craftByTarget.get('A1')).toBeCloseTo(10, 9);
  });

  it('holds the seed split inside a tight budget', () => {
    const budget: CraftBudget = { capacity: 300, unitPrices: prices(100, 25) };
    const solved = compileJointInnerLp(dag, ['A1'], Q, budget).solve(inventory, lambda);
    // The full 10 A1 would cost 10*100 + 20*25 = 1500, five times the cap.
    expect(solved.craftByTarget.get('A1')!).toBeLessThan(10);
    expect(billOf(solved.primalByNode, budget)).toBeLessThanOrEqual(budget.capacity + 1e-6);
  });

  it('keeps the refined split inside the budget the seed was solved under', () => {
    const budget: CraftBudget = { capacity: 300, unitPrices: prices(100, 25) };
    const seed = compileJointInnerLp(dag, ['A1'], Q, budget).solve(inventory, lambda);
    const refined = refineJointCraftSplit(dag, ['A1'], Q, inventory, lambda, seed, budget);
    expect(billOf(refined.primalByNode, budget)).toBeLessThanOrEqual(budget.capacity + 1e-6);
  });

  it('is unconstrained when no budget is passed, exactly as before the cap existed', () => {
    const withoutBudget = compileInnerLp(dag, ['A1']).solve(inventory);
    const withSlack = compileInnerLp(dag, ['A1'], undefined, { capacity: 1e9, unitPrices: prices(100, 25) }).solve(
      inventory
    );
    expect(withoutBudget.craftByTarget.get('A1')).toBeCloseTo(withSlack.craftByTarget.get('A1')!, 9);
  });
});

describe('optimize', () => {
  const config = {
    desiredArtifactNodeIds: ['puzzle-cube-4'],
    includeNotEnoughData: false,
    fuelTankCapacity: 2_000_000_000,
    timeBudgetSeconds: 3 * 24 * 3600,
  };
  const cubes = buildRecipeDag(config.desiredArtifactNodeIds, 30);
  const baseYield = computeBaseYield(null, config.desiredArtifactNodeIds, cubes);
  const unitPrices = computeCraftUnitPrices(cubes, null);

  it('brings the priced plan under a cap that the uncapped plan blows', async () => {
    const [uncapped] = await optimize(config, perfectShipsConfig, cubes, baseYield);
    const uncappedCost = computePlanCraftingCost(uncapped, null).total;
    expect(uncappedCost).toBeGreaterThan(0);

    const capacity = uncappedCost / 4;
    const [capped] = await optimize(config, perfectShipsConfig, cubes, baseYield, 0, undefined, {
      capacity,
      unitPrices,
    });

    // The row is priced at the linear upper bound, so the real bill lands at or
    // under the cap — never above it, which is the property that makes the cap
    // mean anything.
    expect(computePlanCraftingCost(capped, null).total).toBeLessThanOrEqual(capacity);
    expect(capped.bestProbability).toBeLessThanOrEqual(uncapped.bestProbability + 1e-9);
  }, 60_000);
});
