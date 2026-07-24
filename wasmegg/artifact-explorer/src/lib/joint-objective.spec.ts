// Tests for the Phase 1 joint (product) objective: maximizing P(all selected
// targets) rather than the single-target weighted-sum score. See
// value-function.ts's JOINT_TANGENTS docs and optimizer-core.ts's
// optimizeFullJoint docs for the math.

import { describe, it, expect } from 'vitest';
import { optimizeFull, optimizeFullSingle, optimizeFullJoint } from './optimizer-core';
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
      // worst case among these midpoints is ~5e-3, well under 1e-2; this only
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
});

describe('joint path algebraic equivalence at n=1', () => {
  it('matches optimizeFullSingle when the joint code path is forced with a single target', () => {
    // Production code always routes a single target through optimizeFullSingle
    // (optimizeFull's length<=1 guard), but log P(all) reduces to g(score_1)
    // for n=1, and g is strictly increasing, so maximizing it is argmax-
    // equivalent to maximizing score_1 directly. This forces the joint path
    // directly (bypassing the guard) to confirm that equivalence holds in
    // practice, not just on paper.
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

    const single = optimizeFullSingle(args);
    const joint = optimizeFullJoint(args);

    expect(joint.jointProbability).toBeCloseTo(single.bestProbability, 9);
  });
});
