// Golden-snapshot regression gate for the single-target (n=1) optimizer path.
//
// This spec exists to prove that Phase 1's introduction of a joint/product
// objective for multi-target search (n>=2) leaves the existing n=1 behavior
// completely unchanged. It replays every deterministic fixture from
// optimizer-core.spec.ts plus two production-scale instances (puzzle-cube-4,
// used elsewhere in pipeline.spec.ts, and tachyon-deflector-4, used in
// optimizer-perf.spec.ts) through optimizeFull and snapshots the full
// OptimizerSolution. The snapshot committed alongside the pristine (pre-Phase-1)
// code is ground truth: any later diff here is a regression, full stop — never
// "fix" a diff by updating the snapshot to match new output.
//
// jointProbability (added to OptimizerSolution by Phase 1) is deliberately
// EXCLUDED from the serialized shape below: it did not exist when this
// snapshot was first captured, so including it would make every case show a
// spurious "undefined -> number" diff. Its correctness is covered separately
// by joint-objective.spec.ts.

import { describe, it, expect } from 'vitest';
import { ei, perfectShipsConfig } from 'lib';
import { optimizeFull } from './optimizer-core';
import { buildRecipeDag, computeBaseYield } from '.';
import { enumerateLaunchOptions } from './phases';
import { makeNode, makeOpt } from './spec-helpers';
import type { LaunchOption, OptimizerSolution, RecipeDAG } from './types';

const Name = ei.ArtifactSpec.Name;

function craftDag(pCraft = 0.1): RecipeDAG {
  return new Map([
    ['A', makeNode('A', false, [['B', 1]], pCraft)],
    ['B', makeNode('B', true)],
  ]);
}

function sortedEntries<K, V>(m: ReadonlyMap<K, V>): [K, V][] {
  return [...m.entries()].sort((a, b) => {
    const ka = String(a[0]);
    const kb = String(b[0]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function serializeDag(dag: RecipeDAG) {
  return [...dag.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, node]) => ({
      id,
      isLeaf: node.isLeaf,
      legendaryCraftProbability: node.legendaryCraftProbability,
      children: node.children.map(c => ({ nodeId: c.nodeId, quantity: c.quantity })),
    }));
}

// Stable, deterministic projection of an OptimizerSolution for snapshotting.
// Every Map-valued field is converted to a sorted array of entries so
// iteration order (never contractually guaranteed) can't cause a spurious
// diff.
function serializeSolution(sol: OptimizerSolution) {
  return {
    bestProbability: sol.bestProbability,
    craftProbability: sol.craftProbability,
    dropProbability: sol.dropProbability,
    expectedCrafts: sol.expectedCrafts,
    fuelUsed: sol.fuelUsed,
    fuelByEgg: sortedEntries(sol.fuelByEgg),
    timeUnitsUsed: sol.timeUnitsUsed,
    runningTimeSeconds: sol.runningTimeSeconds,
    slots: sol.slots,
    choiceHistory: sol.choiceHistory.map(c => ({
      ship: c.ship.missionTypeId,
      actualFuel: c.actualFuel,
      actualFuelByEgg: sortedEntries(c.actualFuelByEgg),
      actualTime: c.actualTime,
      target: c.target,
      targetAfxId: c.targetAfxId,
      numShipsLaunched: c.numShipsLaunched,
      supplyVector: sortedEntries(c.supplyVector),
      legendarySupplyVector: sortedEntries(c.legendarySupplyVector),
    })),
    expectedDrops: sol.expectedDrops,
    finalYieldVector: sortedEntries(sol.finalYieldVector),
    baseYield: sortedEntries(sol.baseYield),
    recipeDag: serializeDag(sol.recipeDag),
    craftPrimal: sortedEntries(sol.craftPrimal),
    perTarget: sol.perTarget,
  };
}

function run(name: string, options: LaunchOption[], recipeDag: RecipeDAG, args: Record<string, unknown>) {
  it(name, () => {
    const sol = optimizeFull({
      options,
      recipeDag,
      desiredArtifactNodeIds: ['A'],
      fuelCapacity: 1000,
      timeCapacity: 100,
      baseYield: new Map(),
      ...args,
    } as Parameters<typeof optimizeFull>[0]);
    expect(serializeSolution(sol)).toMatchSnapshot();
  });
}

describe('optimizeFull regression snapshot (n=1, must match pristine main byte-for-byte)', () => {
  run('handles an empty option list', [], craftDag(), {});

  run('uses the full time budget for a zero-fuel option', [makeOpt(0, 10, [['B', 1]])], craftDag(0.1), {
    fuelCapacity: 1_000_000,
    timeCapacity: 100,
  });

  run('respects a tighter time budget exactly', [makeOpt(0, 10, [['B', 1]])], craftDag(0.1), {
    fuelCapacity: 1_000_000,
    timeCapacity: 50,
  });

  run('respects the fuel budget', [makeOpt(100, 1, [['B', 1]])], craftDag(0.1), {
    fuelCapacity: 300,
    timeCapacity: 10_000,
  });

  {
    const opt0 = makeOpt(10, 10, [['B', 1]], [], Name.LUNAR_TOTEM);
    const opt1 = makeOpt(10, 10, [['B', 2]], [], Name.TUNGSTEN_ANKH);
    run('prunes an option dominated on yield', [opt0, opt1], craftDag(0.1), {
      fuelCapacity: 100,
      timeCapacity: 100,
    });
  }

  {
    const dag: RecipeDAG = new Map([
      [
        'A',
        makeNode(
          'A',
          false,
          [
            ['B', 1],
            ['C', 1],
          ],
          0.5
        ),
      ],
      ['B', makeNode('B', true)],
      ['C', makeNode('C', true)],
    ]);
    const optB = makeOpt(10, 10, [['B', 1]], [], Name.LUNAR_TOTEM);
    const optC = makeOpt(10, 10, [['C', 1]], [], Name.TUNGSTEN_ANKH);
    run('allocates complementary options together', [optB, optC], dag, { fuelCapacity: 200, timeCapacity: 200 });
  }

  {
    const dag: RecipeDAG = new Map([
      [
        'A',
        makeNode(
          'A',
          false,
          [
            ['B', 1],
            ['C', 1],
            ['D', 1],
          ],
          0.1
        ),
      ],
      ['B', makeNode('B', true)],
      ['C', makeNode('C', true)],
      ['D', makeNode('D', true)],
    ]);
    const optB = makeOpt(10, 10, [['B', 1]], [], Name.LUNAR_TOTEM);
    const optC = makeOpt(10, 10, [['C', 1]], [], Name.TUNGSTEN_ANKH);
    const optD = makeOpt(10, 10, [['D', 1]], [], Name.DEMETERS_NECKLACE);
    run('falls back to triples when pairs are not enough', [optB, optC, optD], dag, {
      fuelCapacity: 300,
      timeCapacity: 300,
    });
  }

  {
    const optExpensive = makeOpt(20, 10, [['B', 1]], [], Name.LUNAR_TOTEM);
    const optCheap = makeOpt(10, 10, [['B', 1]], [], Name.TUNGSTEN_ANKH);
    run('prunes an option dominated on cost alone', [optExpensive, optCheap], craftDag(0.1), {
      fuelCapacity: 100,
      timeCapacity: 100,
    });
  }

  {
    const dag: RecipeDAG = new Map([
      ['A', makeNode('A', false, [['B', 1]], 0)],
      ['B', makeNode('B', true)],
    ]);
    const optLeg = makeOpt(10, 10, [['B', 1]], [['A', 0.1]]);
    run('values direct legendary drops when crafting is impossible', [optLeg], dag, {
      fuelCapacity: 100,
      timeCapacity: 100,
    });
  }

  {
    const dag: RecipeDAG = new Map([
      [
        'A',
        makeNode(
          'A',
          false,
          [
            ['B', 1],
            ['C', 1],
          ],
          0.1
        ),
      ],
      ['B', makeNode('B', true)],
      ['C', makeNode('C', true)],
    ]);
    const optZ = makeOpt(0, 10, [['B', 1]], [], Name.LUNAR_TOTEM);
    const optP = makeOpt(10, 10, [['C', 1]], [], Name.TUNGSTEN_ANKH);
    run('pairs a zero-fuel option with a fueled one', [optZ, optP], dag, { fuelCapacity: 100, timeCapacity: 200 });
  }

  {
    const dag: RecipeDAG = new Map([
      [
        'A',
        makeNode(
          'A',
          false,
          [
            ['B', 1],
            ['C', 1],
          ],
          0.1
        ),
      ],
      ['B', makeNode('B', true)],
      ['C', makeNode('C', true)],
    ]);
    const opt0 = makeOpt(
      0,
      3,
      [
        ['B', 0.8],
        ['C', 1.5],
      ],
      [],
      Name.LUNAR_TOTEM
    );
    const opt1 = makeOpt(
      1,
      3,
      [
        ['B', 2.43],
        ['C', 2.03],
      ],
      [],
      Name.TUNGSTEN_ANKH
    );
    const opt2 = makeOpt(
      2,
      2,
      [
        ['B', 1.36],
        ['C', 0.61],
      ],
      [],
      Name.DEMETERS_NECKLACE
    );
    run('reaches the brute-force optimum on a tight-fuel mix', [opt0, opt1, opt2], dag, {
      fuelCapacity: 6,
      timeCapacity: 8,
    });
  }

  {
    const root = 'puzzle-cube-2';
    const leaf = 'puzzle-cube-1';
    const dag: RecipeDAG = new Map([
      [root, makeNode(root, false, [[leaf, 1]], 0.1)],
      [leaf, makeNode(leaf, true)],
    ]);
    it('snapshots base_yield and keeps it out of the dropped column', () => {
      const sol = optimizeFull({
        options: [makeOpt(0, 10, [[leaf, 1]])],
        recipeDag: dag,
        desiredArtifactNodeIds: [root],
        fuelCapacity: 1_000_000,
        timeCapacity: 50,
        baseYield: new Map([[leaf, 5]]),
      });
      expect(serializeSolution(sol)).toMatchSnapshot();
    });
  }

  {
    const opts = [makeOpt(40, 5, [['B', 1]]), makeOpt(60, 8, [['B', 2]]), makeOpt(0, 3, [['B', 1]])];
    run('never exceeds either budget', opts, craftDag(0.1), { fuelCapacity: 100, timeCapacity: 50 });
  }

  {
    const opts = [makeOpt(10, 10, [['B', 1]]), makeOpt(0, 3, [['B', 1]])];
    for (const timeCapacity of [NaN, -5, Infinity]) {
      run(`treats a NaN or negative time budget as zero (${timeCapacity})`, opts, craftDag(0.1), {
        fuelCapacity: 1000,
        timeCapacity,
      });
    }
    run('treats a NaN fuel budget as zero', opts, craftDag(0.1), { fuelCapacity: NaN, timeCapacity: 100 });
  }

  it('matches the puzzle-cube-4 production-scale instance', () => {
    const desiredArtifactNodeIds = ['puzzle-cube-4'];
    const fuelTankCapacity = 2_000_000_000;
    const timeBudgetSeconds = 3 * 24 * 3600;
    const dag = buildRecipeDag(desiredArtifactNodeIds, 30);
    const baseYield = computeBaseYield(null, desiredArtifactNodeIds, dag);
    const options = enumerateLaunchOptions(perfectShipsConfig, dag);
    const sol = optimizeFull({
      options,
      recipeDag: dag,
      desiredArtifactNodeIds,
      fuelCapacity: fuelTankCapacity,
      timeCapacity: timeBudgetSeconds,
      baseYield,
    });
    expect(serializeSolution(sol)).toMatchSnapshot();
  });

  it('matches the tachyon-deflector-4 production-scale instance', () => {
    const desiredArtifactNodeIds = ['tachyon-deflector-4'];
    const HORIZON_SECONDS = 30 * 24 * 3600;
    const dag = buildRecipeDag(desiredArtifactNodeIds, 30);
    const baseYield = computeBaseYield(null, desiredArtifactNodeIds, dag);
    const options = enumerateLaunchOptions(perfectShipsConfig, dag);
    const sol = optimizeFull({
      options,
      recipeDag: dag,
      desiredArtifactNodeIds,
      fuelCapacity: 1e18,
      timeCapacity: HORIZON_SECONDS,
      baseYield,
    });
    expect(serializeSolution(sol)).toMatchSnapshot();
  });
});
