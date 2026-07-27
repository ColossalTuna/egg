// Tests for the solver's joint (product) objective: maximizing P(all selected
// targets). See value-function.ts's JOINT_TANGENTS docs and optimizer-core.ts's
// file header for the math, including why a single target is this same
// objective with one term rather than a separate weighted-sum mode.

import { describe, it, expect } from 'vitest';
import { optimizeFull } from './optimizer-core';
import {
  compileInnerLp,
  alphaToProb,
  exactLogHitProbability,
  tangentLogHitProbability,
  JOINT_TANGENT_BREAKPOINTS,
} from './value-function';
import { makeNode, makeOpt } from './spec-helpers';
import type { RecipeDAG } from './types';

function craftDag(pCraft = 0.1): RecipeDAG {
  return new Map([
    ['A', makeNode('A', false, [['B', 1]], pCraft)],
    ['B', makeNode('B', true)],
  ]);
}

describe('joint objective: balanced split vs. weighted-sum winner-take-all', () => {
  it('splits a shared scarce ingredient between two equal-weight targets', () => {
    // A1 and A2 both craft from a single shared leaf Z, with identical craft
    // probability (so identical Q weights): a textbook case for the plain
    // weighted-sum inner LP's winner-take-all behavior (an all-or-nothing
    // vertex of the c1+c2<=10 feasible region -- ties in the objective don't
    // make the LP pick the balanced interior point). The product objective
    // must instead balance, since crafting zero of either target sends the
    // AND-probability straight to zero.
    const dag: RecipeDAG = new Map([
      ['A1', makeNode('A1', false, [['Z', 1]], 0.5)],
      ['A2', makeNode('A2', false, [['Z', 1]], 0.5)],
      ['Z', makeNode('Z', true)],
    ]);

    const sol = optimizeFull({
      options: [],
      recipeDag: dag,
      desiredArtifactNodeIds: ['A1', 'A2'],
      fuelCapacity: 1000,
      timeCapacity: 100,
      baseYield: new Map([['Z', 10]]),
    });

    const crafts = sol.perTarget.map(t => t.expectedCrafts);
    expect(crafts[0]).toBeGreaterThan(0);
    expect(crafts[1]).toBeGreaterThan(0);
    // Symmetric problem => a roughly balanced split (the finite tangent
    // breakpoint set can flatten the true optimum over a small interval, so
    // this doesn't land on an exact 5/5 split -- see joint-objective report).
    expect(Math.min(crafts[0], crafts[1])).toBeGreaterThan(3);
    expect(sol.jointProbability).toBeGreaterThan(0);
    expect(sol.jointProbability).toBeCloseTo(sol.perTarget[0].bestProbability * sol.perTarget[1].bestProbability, 9);

    // Contrast: the plain weighted-sum inner LP (equal weights => tied
    // objective across the whole c1+c2<=10 edge) lands on an all-or-nothing
    // vertex, leaving at least one target at zero crafts.
    const naive = compileInnerLp(
      dag,
      ['A1', 'A2'],
      new Map([
        ['A1', 1],
        ['A2', 1],
      ])
    ).solve(new Map([['Z', 10]]));
    const naiveCrafts = [naive.craftByTarget.get('A1') ?? 0, naive.craftByTarget.get('A2') ?? 0];
    expect(Math.min(...naiveCrafts)).toBeCloseTo(0, 6);
    expect(Math.max(...naiveCrafts)).toBeCloseTo(10, 6);
  });

  it('picks a more balanced fuel split across two options than a sum-maximizing greedy, raising jointProbability', () => {
    // Two independent targets, each fed by its own dedicated option, competing
    // only for a shared fuel budget. Maximizing sum(Q*crafts) is indifferent
    // to how the budget splits (equal Q, equal cost), so a naive "maximize the
    // sum" greedy has no reason to avoid dumping the whole budget into one
    // option -- which zeroes out the other target and its AND-probability.
    // The joint search must instead balance the split.
    const dag: RecipeDAG = new Map([
      ['A1', makeNode('A1', false, [['B1', 1]], 0.5)],
      ['A2', makeNode('A2', false, [['B2', 1]], 0.5)],
      ['B1', makeNode('B1', true)],
      ['B2', makeNode('B2', true)],
    ]);
    const optB1 = makeOpt(1, 1, [['B1', 1]]);
    const optB2 = makeOpt(1, 1, [['B2', 1]]);

    const sol = optimizeFull({
      options: [optB1, optB2],
      recipeDag: dag,
      desiredArtifactNodeIds: ['A1', 'A2'],
      fuelCapacity: 60,
      timeCapacity: 1000,
      baseYield: new Map(),
    });

    const crafts = sol.perTarget.map(t => t.expectedCrafts);
    // Both targets get a meaningful share of the 60-fuel budget (loose bound:
    // a genuinely balanced water-filling split lands near 30/30).
    expect(Math.min(...crafts)).toBeGreaterThan(10);
    expect(sol.jointProbability).toBeGreaterThan(0.9);

    // Naive comparison: dump the entire budget into one option (the
    // sum-maximizing greedy's tied-objective, all-or-nothing choice), then
    // compute what jointProbability that allocation would have produced.
    const naiveA1 = alphaToProb(60, new Map(), ['A1'], dag).bestProbability;
    const naiveA2 = alphaToProb(0, new Map(), ['A2'], dag).bestProbability;
    const naiveJoint = naiveA1 * naiveA2;
    expect(naiveJoint).toBeCloseTo(0, 9);
    expect(sol.jointProbability).toBeGreaterThan(naiveJoint);
  });
});

describe('tangent approximation accuracy', () => {
  it('over-estimates the exact g(s) = log(1 - e^-s) by a small margin', () => {
    // Midpoints between the fixed breakpoints, where the piecewise-linear
    // envelope is furthest from exact.
    const sValues = [0.15, 0.3, 0.6, 1, 2.2, 4, 6.5, 10, 16, 27];
    for (const s of sValues) {
      const exact = exactLogHitProbability(s);
      const approx = tangentLogHitProbability(s);
      const exactProb = Math.exp(exact);
      const approxProb = Math.exp(Math.min(approx, 0));
      // Tangent lines of a concave function lie on or above it everywhere.
      expect(approx).toBeGreaterThanOrEqual(exact - 1e-12);
      // The over-estimate is small in probability-space terms. (The fixed
      // breakpoint set trades some accuracy for a small, constant-size LP --
      // worst case among these midpoints is ~8.3e-3, under 1e-2; this only
      // affects search ranking, never the exact final reported probability.)
      expect(approxProb - exactProb).toBeGreaterThanOrEqual(-1e-9);
      expect(approxProb - exactProb).toBeLessThan(1e-2);
    }
  });

  it('is exact at the tangent breakpoints themselves', () => {
    for (const s of JOINT_TANGENT_BREAKPOINTS) {
      expect(tangentLogHitProbability(s)).toBeCloseTo(exactLogHitProbability(s), 6);
    }
  });

  it('degrades sharply below the first breakpoint (s < 0.05), where the split bug originated', () => {
    // The fixed grid starts at s = 0.05; for smaller scores the nearest tangent
    // is a poor local approximation of g, and the over-estimate balloons well
    // past the <1e-2 bound the tested [0.15, 27] range enjoys. This is a
    // documentation/defense test: it asserts the KNOWN, large error in this
    // region rather than pretending the grid is accurate here. It is precisely
    // this coarseness that made the SEARCH-time split biased for targets landing
    // on a tiny craft count -- which is why the FINAL reported split is refined
    // independently of this grid (see refineJointCraftSplit); that refinement is
    // not exercised here.
    // Measured errors are ~2.93, ~0.81, ~0.11 in log-space at these points; the
    // thresholds sit safely below the observed values.
    const cases: { s: number; minLogErr: number }[] = [
      { s: 0.001, minLogErr: 2.5 }, // enormous in log-space this close to 0
      { s: 0.01, minLogErr: 0.5 },
      { s: 0.03, minLogErr: 0.08 },
    ];
    let maxProbErr = 0;
    for (const { s, minLogErr } of cases) {
      const exact = exactLogHitProbability(s);
      const approx = tangentLogHitProbability(s);
      // Still a valid upper envelope: the tangent lies on or above g everywhere.
      expect(approx).toBeGreaterThanOrEqual(exact - 1e-12);
      // ...but the gap is large here, unlike the well-sampled mid-range.
      const logErr = approx - exact;
      expect(logErr).toBeGreaterThan(minLogErr);
      maxProbErr = Math.max(maxProbErr, Math.exp(Math.min(approx, 0)) - Math.exp(exact));
    }
    // The worst-case probability-space over-estimate in this region (~1.8e-2 at
    // s = 0.001) exceeds the 1e-2 the [0.15, 27] band stays under. Assert it
    // blows past the mid-range bound to document that the grid is unusable here
    // for final reporting.
    expect(maxProbErr).toBeGreaterThan(1e-2);
  });
});

describe('the product objective reduces to the linear score at n=1', () => {
  // The solver has one objective, sum_T g(score_T), for every target count.
  // That is only legitimate at n=1 because g is strictly increasing, making
  // argmax g(score_1) = argmax score_1 -- i.e. the product objective is not an
  // approximation of the old weighted-sum search, it is the same search. These
  // check the reduction against independently computed answers rather than
  // against a second code path.
  const dag = craftDag(0.1);
  const opt = makeOpt(10, 10, [['B', 1]]);
  const args = {
    options: [opt],
    recipeDag: dag,
    desiredArtifactNodeIds: ['A'],
    fuelCapacity: 65,
    timeCapacity: 40,
    baseYield: new Map<string, number>(),
  };

  it('lands on the plain linear score optimum', () => {
    const sol = optimizeFull(args);

    // Brute force the linear score S = Q*alpha over every 3-slot-packable
    // multiplicity of the single option, and convert once at the end. This is
    // exactly what the pre-consolidation weighted-sum search computed.
    const Q = -Math.log(1 - 0.1);
    const perSlot = Math.floor(args.timeCapacity / opt.actualTime);
    const maxK = Math.min(Math.floor(args.fuelCapacity / opt.actualFuel), 3 * perSlot);
    let bestScore = 0;
    for (let k = 0; k <= maxK; k++) {
      // packable into 3 slots of equal capacity
      if (k > 3 * perSlot) continue;
      const alpha = compileInnerLp(dag, ['A']).solve(new Map([['B', k]])).alpha;
      bestScore = Math.max(bestScore, Q * alpha);
    }

    expect(sol.bestProbability).toBeCloseTo(1 - Math.exp(-bestScore), 9);
  });

  it('reports jointProbability as that one target’s own probability', () => {
    const sol = optimizeFull(args);
    expect(sol.perTarget).toHaveLength(1);
    expect(sol.jointProbability).toBeCloseTo(sol.bestProbability, 12);
  });
});
