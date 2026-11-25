// The per-target objective g(s) = log(1 - e^-s), its derivative, and the line search Frank-Wolfe runs on
// it. A leaf module: the judge maximizes this over the craft polytope (`solver/evaluator.ts`) and the
// MILP writer linearizes it (`solver/milp.ts`), and the two have to agree to the last bit on what the
// quantity is. Also the step from a craft count to the probability the card prints, off the same
// underlying quantity: the judge's LP settles a craft count, and `craftsToProbability` is the closed
// form from there to a number a player reads; nothing here re-derives the LP's own answer.

import type { RecipeDAG } from './types';

// g(s) = log(1 - exp(-s)), computed as log(-expm1(-s)). The form matters: evaluating `1 - exp(-s)` directly
// cancels in the s ~ 1e-13 regime the arena scores in.
export function logHit(s: number): number {
  return s > 0 ? Math.log(-Math.expm1(-s)) : -Infinity;
}

// g'(s); grows like 1/s as s -> 0, capped to keep linearizations finite. The cut generator in
// `solver/milp.ts` deliberately does *not* use this — at s ~ 1e-13 the cap is active at every tangent point.
export const GPRIME_CAP = 1e12;

export function gPrime(s: number): number {
  return s <= 0 ? GPRIME_CAP : Math.min(1 / Math.expm1(s), GPRIME_CAP);
}

// Q = -log(1 - p), a target's score per unit of expected drop. Certainty is +Infinity, which no LP matrix
// can carry, so every matrix substitutes the same proxy for it; see SPEC.md section 4. Both live here,
// with `logHit`, because the pipeline and the MILP writer have to agree to the bit on what a target is
// worth; neither is the other's caller.
export const Q_CERTAIN_PROXY = 1e4;

export function qOf(craftProbability: number): number {
  if (!(craftProbability > 0)) return 0;
  return craftProbability >= 1 ? Infinity : -Math.log(1 - craftProbability);
}

export function finiteQ(q: number): number {
  return Number.isFinite(q) ? q : Q_CERTAIN_PROXY;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

// argmax over [0, 1] of a unimodal (concave) f. Robust to f returning
// -Infinity on part of the interval.
export function goldenSectionArgmax(f: (x: number) => number, iters = 100): number {
  let a = 0;
  let b = 1;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

export interface ProbabilityFields {
  bestProbability: number;
  craftProbability: number;
  dropProbability: number;
}

// 1 - exp(logMiss) for logMiss <= 0, with a positive zero where nothing can miss: `-Math.expm1(0)` is -0.
function hitOf(logMiss: number): number {
  return logMiss < 0 ? -Math.expm1(logMiss) : 0;
}

export function craftsToProbability(
  craftCount: number,
  legendaryYield: Map<string, number>,
  desiredArtifactNodeIds: string[],
  recipeDag: RecipeDAG
): ProbabilityFields {
  if (desiredArtifactNodeIds.length === 0) {
    return { bestProbability: 0, craftProbability: 0, dropProbability: 0 };
  }
  const root = desiredArtifactNodeIds[0];
  const node = recipeDag.get(root);
  const pCraft = node?.legendaryCraftProbability ?? 0;

  // Every probability here is 1 - exp(-x) for some x >= 0, so each is computed as -expm1(-x) off the
  // log of its miss probability, as `logHit` is: `1 - exp(...)` cancels to a few digits at the ~1e-13
  // probabilities the judge resolves, and the card would then print a figure the judge never graded.
  const crafts = craftCount > 0 ? craftCount : 0;
  const certainCraft = pCraft >= 1 && crafts > 0;
  const logCraftMiss = pCraft > 0 && crafts > 0 && !certainCraft ? crafts * Math.log1p(-pCraft) : 0;
  const craftProbability = certainCraft ? 1 : hitOf(logCraftMiss);

  const lambda = legendaryYield.get(root) ?? 0;
  const logDropMiss = lambda > 0 ? -lambda : 0;
  const dropProbability = hitOf(logDropMiss);

  const bestProbability = certainCraft ? 1 : hitOf(logCraftMiss + logDropMiss);

  return { bestProbability, craftProbability: craftProbability, dropProbability };
}
