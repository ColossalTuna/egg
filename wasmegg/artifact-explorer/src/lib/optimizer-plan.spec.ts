// The seam, not the search.
//
// `optimizeFull` is where the arena's planner meets production's pipeline, and
// the failures it is exposed to are seam failures: an allocation index meaning
// different things either side of the option filter, a wasm asset the loader
// cannot find in this environment, a model HiGHS will not read. The plan's
// *quality* is not this file's business — that is what the arena measures, over
// 40 instances, against recorded results.
//
// What this file pins is external to the planner. Nothing here asks the planner
// to confirm its own arithmetic; every expectation is either an input the caller
// supplied or a constant of a downstream consumer:
//
//   - The *rendered* plan fits the budgets the caller passed in. The launches in
//     `choiceHistory` are what the UI draws and what the user is told to fly, so
//     their fuel is re-summed from that list — not read off `fuelUsed` — and held
//     against `args.fuelCapacity`. Same for `timeCapacity`: an option too long
//     for one slot is dropped before indices are assigned, so its appearing in
//     the plan at all is the index-crossing bug showing itself.
//   - The packer and the assembler describe the same plan. `slots` comes out of
//     `slotsOfAllocation`, `choiceHistory` out of `assembleSolution`; they are
//     two independent walks of the allocation, so a mission count that disagrees
//     between them means one of them is reading the allocation wrong.
//   - The reply is shaped to the request: one `perTarget` row per requested
//     target, in order. Crossed indices produce a plan that scores like noise
//     rather than one that scores slightly worse, so a nonzero joint probability
//     is a floor, not a quality bar.
//   - Every matrix entry lands inside the window HiGHS will ingest — [1e-9,
//     1e15], its own `small_matrix_value`/`large_matrix_value`. Outside it the
//     model is silently mangled or refused, which is a crash on the production
//     path rather than a worse plan.

import { describe, expect, it } from 'vitest';
import { generateInstance } from '../oracle/arena/instances';
import { buildProblem } from '../oracle/arena/harness';
import { NUM_SLOTS, optimizeFull, type OptimizeArgs } from './optimizer-core';
import { buildModel } from './solver/model';
import { buildOaMilp, effectiveQs, layoutOf, scaleLps } from './solver/milp';
import { loadHighs } from './solver/highs';
import { makeNode, makeOpt } from './spec-helpers';
import type { RecipeDAG } from './types';

// A few instances, spread over target counts and menu widths. Deliberately not
// the whole sweep: this is a wiring check that has to stay fast enough to run
// with the rest of the unit tests.
const SEEDS = [2000, 2003, 2011];

function argsOf(seed: number): OptimizeArgs {
  const problem = buildProblem(generateInstance(seed));
  return {
    options: [...problem.options],
    recipeDag: problem.dag,
    desiredArtifactNodeIds: [...problem.targets],
    fuelCapacity: problem.fuelCapacity,
    timeCapacity: problem.timeCapacity,
    baseYield: new Map(problem.baseYield),
  };
}

// Slack in seconds. Slot loads are sums of raw durations; this only absorbs the
// float addition.
const TIME_TOL = 1e-6;

describe('the planner returns a plan production can render', () => {
  for (const seed of SEEDS) {
    it(`respects both budgets on arena:${seed}`, async () => {
      const args = argsOf(seed);
      const solution = await optimizeFull(args);

      // Re-summed from the launches the UI renders, against the budget the
      // caller passed in. `solution.fuelUsed` is deliberately not consulted.
      let fuel = 0;
      for (const launch of solution.choiceHistory) fuel += launch.numShipsLaunched * launch.actualFuel;
      expect(fuel).toBeLessThanOrEqual(args.fuelCapacity * (1 + 1e-9));

      // No single launch may exceed one slot's horizon: options that do are
      // filtered out before allocation indices are assigned, so one surfacing
      // here is that filter and the solver disagreeing about what index i means.
      for (const launch of solution.choiceHistory) {
        expect(launch.actualTime).toBeLessThanOrEqual(args.timeCapacity + TIME_TOL);
      }

      const slots = solution.slots ?? [];
      expect(slots.length).toBeLessThanOrEqual(NUM_SLOTS);
      for (const slot of slots) {
        expect(slot.loadSeconds).toBeLessThanOrEqual(args.timeCapacity + TIME_TOL);
      }
    }, 30_000);

    it(`packs exactly the launches it reports on arena:${seed}`, async () => {
      // `slots` and `choiceHistory` are separate walks of the allocation — the
      // packer and the assembler. They have to be describing the same plan.
      const solution = await optimizeFull(argsOf(seed));
      const launched = solution.choiceHistory.reduce((n, l) => n + l.numShipsLaunched, 0);
      const packed = (solution.slots ?? []).reduce((n, s) => n + s.missionCount, 0);
      expect(packed).toBe(launched);
    }, 30_000);

    it(`plans something worth launching on arena:${seed}`, async () => {
      // Every one of these seeds is solvable and the arena's recorded result for
      // each sits far above this floor. A seam that crossed option indices would
      // not miss by a factor of two — it would collapse to zero or to noise.
      const args = argsOf(seed);
      const solution = await optimizeFull(args);
      expect(solution.jointProbability).toBeGreaterThan(0);
      expect(solution.choiceHistory.length).toBeGreaterThan(0);
      // Shaped to the request: one row per requested target, in order.
      expect(solution.perTarget.map(r => r.nodeId)).toEqual(args.desiredArtifactNodeIds);
    }, 30_000);
  }
});

// The model has to survive being *read*, which is a separate hurdle from being
// solved. HiGHS filters matrix entries on ingestion at both ends: anything at or
// below `small_matrix_value` (1e-9) is silently deleted, and anything above
// `large_matrix_value` (1e15) makes the reader fail outright. Neither option can
// be set from here — the wasm build applies options after `Highs_readModel` — so
// the model has to land inside the window on its own.
//
// This is a property of every row the builder emits, so it is asserted as one.
// The regression it guards: normalizing a tangent cut's small coefficient up to
// 1 used to push its other coefficient to 2.8e16, and the whole model became
// unreadable — a crash on the production path, not a worse plan.
describe('every matrix entry lands inside the range HiGHS will ingest', () => {
  const SMALL = 1e-9;
  const LARGE = 1e15;

  it('holds for the scale LPs and the outer-approximation MILP', async () => {
    const solve = await loadHighs();
    const dag: RecipeDAG = new Map([
      ['A1', makeNode('A1', false, [['B1', 1]], 0.5)],
      ['A2', makeNode('A2', false, [['B2', 1]], 0.5)],
      ['B1', makeNode('B1', true)],
      ['B2', makeNode('B2', true)],
    ]);
    const model = buildModel({
      options: [makeOpt(1, 1, [['B1', 1]]), makeOpt(1, 1, [['B2', 1]])],
      dag,
      targets: ['A1', 'A2'],
      fuelCapacity: 60,
      timeCapacity: 1000,
      slots: 3,
      baseYield: new Map(),
    });
    const qs = effectiveQs(model);
    const layout = layoutOf(model, false);

    const scaleLp = scaleLps(model, qs);
    const theta = model.targets.map((_, t) => {
      const sol = solve(scaleLp(t), { maxNodes: 5, relGap: 1e-6 });
      return sol.columnValues[layout.sBase + t];
    });
    // The grid `oa.ts` starts from; its deepest points are where the ratio
    // between a cut's two coefficients gets extreme.
    const grid = [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 3e-3, 1e-3, 3e-4, 1e-4, 3e-5, 1e-5, 1e-6, 1e-7];
    const cuts = model.targets.flatMap((_, target) => grid.map(at => ({ target, at })));

    const models = [...model.targets.map((_, t) => scaleLp(t)), buildOaMilp(model, qs, theta, cuts)];
    for (const m of models) {
      for (const v of m.values) {
        expect(Math.abs(v)).toBeGreaterThan(SMALL);
        expect(Math.abs(v)).toBeLessThan(LARGE);
      }
    }
  });
});
