// Inner crafting LP: given an inventory, maximize sum over targets T of
// w_T * (crafts of T), subject to recipe conservation. Every node consumed by
// some parent gets a conservation row, targets included. A final target (no
// parents) has no row, so dropped copies of it don't count as crafts; a
// target that is also an ingredient keeps its row and its drops feed the
// parent recipe.
//
// Two LPs are built over that same conservation polytope. compileJointInnerLp
// (below) carries the search's actual objective and is what the outer search
// scores millions of candidate inventories against. compileInnerLp is the
// plain weighted-sum version, used for the linearized subproblems that
// refineJointCraftSplit's Frank-Wolfe iteration solves.

import type { RecipeDAG } from './types';
import { solveLp } from './lp';

export interface AlphaResult {
  alpha: number; // craftable count of targets[0]; 0 when it's a leaf
  score: number; // weighted objective at the optimum
  craftByTarget: Map<string, number>;
  duals: Map<string, number>; // shadow price per constraint node
  primalByNode: Map<string, number>; // crafted count per non-leaf node
}

export interface InnerLp {
  readonly nonLeafNodes: readonly string[]; // decision variable order
  readonly constraintNodes: readonly string[]; // constraint row order
  readonly varIndex: ReadonlyMap<string, number>;
  readonly root: string;
  readonly targets: readonly string[];
  readonly weightByTarget: ReadonlyMap<string, number>;

  solve(inventory: Map<string, number>): AlphaResult;
}

// `weights` is the per-target objective weight; targets without an entry get
// weight 1 (callers that just want craftable counts omit it entirely).
export function compileInnerLp(
  recipeDag: RecipeDAG,
  desiredArtifactNodeIds: string[],
  weights?: Map<string, number>
): InnerLp {
  if (desiredArtifactNodeIds.length === 0) {
    return makeTrivialLp('', [], new Map());
  }
  const targets = desiredArtifactNodeIds;
  const primary = targets[0];

  // Non-leaf nodes become decision variables p_n.
  const nonLeafNodes: string[] = [];
  const varIndex = new Map<string, number>();
  for (const [id, node] of recipeDag) {
    if (!node.isLeaf) {
      varIndex.set(id, nonLeafNodes.length);
      nonLeafNodes.push(id);
    }
  }

  // Objective weight per craftable target. A leaf target can't be crafted, so it
  // contributes no objective term (its legendary chance is drops-only).
  const weightByTarget = new Map<string, number>();
  for (const t of targets) {
    if (varIndex.has(t)) weightByTarget.set(t, weights?.get(t) ?? 1);
  }
  if (weightByTarget.size === 0) {
    // nothing craftable; fall back to holdings of the primary target
    return makeTrivialLp(primary, targets, weightByTarget);
  }

  // for each node, who consumes it and at what rate
  const parentsOf = new Map<string, { parent: string; q: number }[]>();
  for (const [parentId, parentNode] of recipeDag) {
    if (parentNode.isLeaf) continue;
    for (const child of parentNode.children) {
      let parents = parentsOf.get(child.nodeId);
      if (!parents) {
        parents = [];
        parentsOf.set(child.nodeId, parents);
      }
      parents.push({ parent: parentId, q: child.quantity });
    }
  }

  // One constraint per consumed node:
  //   sum_parents q * p_parent - (p_n if non-leaf) <= inventory[n]
  const constraintNodes: string[] = [];
  for (const id of recipeDag.keys()) {
    const parents = parentsOf.get(id);
    if (!parents || parents.length === 0) continue;
    constraintNodes.push(id);
  }

  const nVars = nonLeafNodes.length;
  const nCons = constraintNodes.length;

  const c = new Float64Array(nVars);
  for (const [t, w] of weightByTarget) c[varIndex.get(t)!] = w;

  const A: Float64Array[] = new Array(nCons);
  for (let i = 0; i < nCons; i++) {
    const id = constraintNodes[i];
    const row = new Float64Array(nVars);
    const parents = parentsOf.get(id) ?? [];
    for (const { parent, q } of parents) {
      const idx = varIndex.get(parent);
      if (idx !== undefined) row[idx] += q;
    }
    if (varIndex.has(id)) row[varIndex.get(id)!] -= 1;
    A[i] = row;
  }

  const bScratch = new Float64Array(nCons);

  return {
    nonLeafNodes,
    constraintNodes,
    varIndex,
    root: primary,
    targets,
    weightByTarget,

    solve(inventory: Map<string, number>): AlphaResult {
      for (let i = 0; i < nCons; i++) {
        const v = inventory.get(constraintNodes[i]);
        bScratch[i] = v !== undefined && v > 0 ? v : 0;
      }
      const r = solveLp(c, A, bScratch);
      if (r.status !== 'optimal') {
        return { alpha: 0, score: 0, craftByTarget: new Map(), duals: new Map(), primalByNode: new Map() };
      }
      const craftByTarget = new Map<string, number>();
      for (const t of weightByTarget.keys()) {
        craftByTarget.set(t, r.primal[varIndex.get(t)!]);
      }
      const alpha = craftByTarget.get(primary) ?? 0;
      const duals = new Map<string, number>();
      for (let i = 0; i < nCons; i++) {
        duals.set(constraintNodes[i], r.duals[i]);
      }
      const primalByNode = new Map<string, number>();
      for (let i = 0; i < nonLeafNodes.length; i++) {
        if (r.primal[i] > 1e-9) {
          primalByNode.set(nonLeafNodes[i], r.primal[i]);
        }
      }
      return { alpha, score: r.objective, craftByTarget, duals, primalByNode };
    },
  };
}

function makeTrivialLp(primary: string, targets: readonly string[], weightByTarget: Map<string, number>): InnerLp {
  return {
    nonLeafNodes: [],
    constraintNodes: [],
    varIndex: new Map(),
    root: primary,
    targets,
    weightByTarget,
    solve(inventory: Map<string, number>): AlphaResult {
      const v = inventory.get(primary) ?? 0;
      return { alpha: v > 0 ? v : 0, score: 0, craftByTarget: new Map(), duals: new Map(), primalByNode: new Map() };
    },
  };
}

export interface ProbabilityFields {
  bestProbability: number;
  craftProbability: number;
  dropProbability: number;
}

// Map a target's craftable count plus its legendary-drop rate into
// probabilities:
//   craft = 1 - (1 - pCraft)^alpha
//   drop  = 1 - e^(-lambda)   (Poisson on direct legendary drops)
//   best  = 1 - (1 - craft)(1 - drop)
export function alphaToProb(
  alpha: number,
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

  const a = alpha > 0 ? alpha : 0;
  let craftProbability = 0;
  if (pCraft > 0 && a > 0) {
    if (pCraft >= 1) craftProbability = 1;
    else craftProbability = 1 - Math.exp(a * Math.log(1 - pCraft));
  }

  const lambda = legendaryYield.get(root) ?? 0;
  const dropProbability = lambda > 0 ? 1 - Math.exp(-lambda) : 0;

  const bestProbability = 1 - (1 - craftProbability) * (1 - dropProbability);

  return { bestProbability, craftProbability: craftProbability, dropProbability };
}

// ---------------------------------------------------------------------------
// Joint (product) objective support -- the search's objective at every target
// count.
//
// Each target has a linear "score" S_T = Q_T*alpha_T + lambda_T, and
// 1 - e^-S_T is its probability. What we want is P(all) = product_T
// (1 - e^-score_T), i.e.
//   log P(all) = sum_T g(score_T),  g(s) = log(1 - e^-s).
// g is strictly increasing and concave. Strictly increasing is what makes this
// the only objective the solver needs: with one target, maximizing g(score_1)
// is identical in argmax to maximizing score_1 directly, so a plain
// weighted-sum search over a single target is this objective with one term
// rather than a separate mode.
//
// g's concavity lets us bound it from above by an "epigraph" of tangent
// lines: g(s) <= alpha_k + beta_k*s for every tangent point s_k, since a
// concave function always lies on or under each of its tangent lines, with
// equality at s_k. That turns "maximize sum_T g(score_T)" into a linear
// program: introduce one epigraph variable z_T per target with rows
// z_T <= alpha_k + beta_k*score_T for every breakpoint k, then maximize
// sum_T z_T. The LP drives each z_T up to min_k(...), the tightest bound the
// chosen breakpoints allow -- an upper envelope of the true g, so this always
// slightly OVER-estimates the true joint objective. That's fine for search
// ranking (concavity/monotonicity is all the ternary scans and dominance
// pruning need) as long as the FINAL reported probability is computed exactly
// (via alphaToProb per target, then multiplied), never via this
// approximation.
// Denser near s=0.1-3, where g's curvature (and therefore the tangent
// envelope's slack) is largest; sparser above ~10, where g is already close
// to flat and a handful of points suffice.
export const JOINT_TANGENT_BREAKPOINTS: readonly number[] = [
  0.05, 0.1, 0.2, 0.3, 0.45, 0.65, 0.9, 1.2, 1.6, 2.1, 2.7, 3.4, 4.2, 5.2, 6.5, 8, 10, 13, 17, 22, 28, 35,
];

export interface Tangent {
  alpha: number;
  beta: number;
}

// beta_k = g'(s_k) = 1/(e^s_k - 1); alpha_k = g(s_k) - beta_k*s_k, so the line
// alpha_k + beta_k*s is tangent to g at s_k.
export const JOINT_TANGENTS: readonly Tangent[] = JOINT_TANGENT_BREAKPOINTS.map(s => {
  const beta = 1 / Math.expm1(s);
  const g = Math.log(-Math.expm1(-s));
  return { alpha: g - beta * s, beta };
});

// The tangent epigraph variables z_T can be negative (g(s) < 0 for s below
// ln(2)), but this file's LP solver assumes x >= 0. Shifting every epigraph
// row's RHS up by this constant keeps z_T comfortably positive without
// changing the argmax; solveScore/solve subtract targets.length * shift back
// out of the objective before returning, and callers building their own
// epigraph rows (the joint outer LP relaxation in optimizer-core.ts) must do
// the same.
export const EPIGRAPH_SHIFT = 50;

// Exact g(s) = log(1 - e^-s) = log P(hit at least once | score s). Used only
// for the FINAL reported numbers and for tests -- never inside the search.
export function exactLogHitProbability(s: number): number {
  return s > 0 ? Math.log(-Math.expm1(-s)) : -Infinity;
}

// The tangent-envelope over-estimate of g(s) described above. Exposed for
// tests that check the approximation's accuracy and over-estimate direction.
export function tangentLogHitProbability(s: number): number {
  let best = Infinity;
  for (const t of JOINT_TANGENTS) {
    const v = t.alpha + t.beta * s;
    if (v < best) best = v;
  }
  return best;
}

export interface JointAlphaResult {
  craftByTarget: Map<string, number>; // absent for a leaf target, mirroring compileInnerLp
  primalByNode: Map<string, number>;
}

export interface JointInnerLp {
  readonly nonLeafNodes: readonly string[];
  readonly constraintNodes: readonly string[]; // conservation rows only, in b's row order
  readonly varIndex: ReadonlyMap<string, number>;
  readonly targets: readonly string[];

  // Hot path: b is the inventory RHS (constraintNodes order); lambda is the
  // per-target direct-legendary offset (targets order). Returns the
  // tangent-approximated sum_T g(Q_T*craft_T + lambda_T), an over-estimate of
  // the true joint log-probability objective -- safe for search ranking only.
  solveScore(b: Float64Array, lambda: Float64Array): number;

  // Full solve at a fixed inventory: recovers the per-target craft split (for
  // final reporting) alongside the crafted count of every non-leaf node.
  solve(inventory: Map<string, number>, lambda: Map<string, number>): JointAlphaResult;
}

// Builds the craft-conservation LP shared by the search's hot eval path and its
// final reporting solve, augmented with one epigraph variable z_T per target and
// the tangent rows described above. lambda enters *inside* each tangent
// expression (Q_T*craft_T + lambda_T) rather than being added outside the LP as
// one pooled scalar -- the product objective needs each target's direct
// legendary drops attributed to that target's own g term.
export function compileJointInnerLp(
  recipeDag: RecipeDAG,
  desiredArtifactNodeIds: string[],
  QByTarget: ReadonlyMap<string, number>
): JointInnerLp {
  const targets = desiredArtifactNodeIds;
  const nt = targets.length;

  const nonLeafNodes: string[] = [];
  const varIndex = new Map<string, number>();
  for (const [id, node] of recipeDag) {
    if (!node.isLeaf) {
      varIndex.set(id, nonLeafNodes.length);
      nonLeafNodes.push(id);
    }
  }

  const parentsOf = new Map<string, { parent: string; q: number }[]>();
  for (const [parentId, parentNode] of recipeDag) {
    if (parentNode.isLeaf) continue;
    for (const child of parentNode.children) {
      let parents = parentsOf.get(child.nodeId);
      if (!parents) {
        parents = [];
        parentsOf.set(child.nodeId, parents);
      }
      parents.push({ parent: parentId, q: child.quantity });
    }
  }

  const constraintNodes: string[] = [];
  for (const id of recipeDag.keys()) {
    const parents = parentsOf.get(id);
    if (!parents || parents.length === 0) continue;
    constraintNodes.push(id);
  }

  const nVars = nonLeafNodes.length;
  const nCons = constraintNodes.length;
  const totalVars = nVars + nt;
  const zBase = nVars;

  const c = new Float64Array(totalVars);
  for (let i = 0; i < nt; i++) c[zBase + i] = 1;

  const A: Float64Array[] = [];
  for (let i = 0; i < nCons; i++) {
    const id = constraintNodes[i];
    const row = new Float64Array(totalVars);
    const parents = parentsOf.get(id) ?? [];
    for (const { parent, q } of parents) {
      const idx = varIndex.get(parent);
      if (idx !== undefined) row[idx] += q;
    }
    if (varIndex.has(id)) row[varIndex.get(id)!] -= 1;
    A.push(row);
  }

  // One row per (target, tangent breakpoint): z_T - beta_k*Q_T*craft_T <=
  // alpha_k + EPIGRAPH_SHIFT + beta_k*lambda_T (lambda term folded into b at
  // solve time, since it varies per call; the row coefficients are static).
  const rowTargetIdx: number[] = [];
  const rowTangentIdx: number[] = [];
  for (let ti = 0; ti < nt; ti++) {
    const t = targets[ti];
    const q = QByTarget.get(t) ?? 0;
    const pIdx = varIndex.get(t);
    for (let k = 0; k < JOINT_TANGENTS.length; k++) {
      const row = new Float64Array(totalVars);
      row[zBase + ti] = 1;
      if (pIdx !== undefined && q !== 0) row[pIdx] = -JOINT_TANGENTS[k].beta * q;
      A.push(row);
      rowTargetIdx.push(ti);
      rowTangentIdx.push(k);
    }
  }

  const nRows = A.length;
  const bScratch = new Float64Array(nRows);

  function fillEpigraphB(lambda: Float64Array) {
    for (let r = 0; r < rowTargetIdx.length; r++) {
      const ti = rowTargetIdx[r];
      const k = rowTangentIdx[r];
      bScratch[nCons + r] = JOINT_TANGENTS[k].alpha + EPIGRAPH_SHIFT + JOINT_TANGENTS[k].beta * lambda[ti];
    }
  }

  return {
    nonLeafNodes,
    constraintNodes,
    varIndex,
    targets,

    solveScore(b: Float64Array, lambda: Float64Array): number {
      for (let i = 0; i < nCons; i++) bScratch[i] = b[i] ?? 0;
      fillEpigraphB(lambda);
      const r = solveLp(c, A, bScratch);
      return r.status === 'optimal' ? r.objective - nt * EPIGRAPH_SHIFT : -Infinity;
    },

    solve(inventory: Map<string, number>, lambdaMap: Map<string, number>): JointAlphaResult {
      for (let i = 0; i < nCons; i++) {
        const v = inventory.get(constraintNodes[i]);
        bScratch[i] = v !== undefined && v > 0 ? v : 0;
      }
      const lambda = new Float64Array(nt);
      for (let i = 0; i < nt; i++) lambda[i] = lambdaMap.get(targets[i]) ?? 0;
      fillEpigraphB(lambda);
      const r = solveLp(c, A, bScratch);
      const craftByTarget = new Map<string, number>();
      const primalByNode = new Map<string, number>();
      if (r.status === 'optimal') {
        for (let ti = 0; ti < nt; ti++) {
          const idx = varIndex.get(targets[ti]);
          if (idx !== undefined) craftByTarget.set(targets[ti], r.primal[idx]);
        }
        for (let i = 0; i < nVars; i++) {
          if (r.primal[i] > 1e-9) primalByNode.set(nonLeafNodes[i], r.primal[i]);
        }
      }
      return { craftByTarget, primalByNode };
    },
  };
}

// argmax over t in [0, 1] of a concave (hence unimodal) function. Golden-section
// search; robust to phi returning -Infinity on part of the interval (comparisons
// against a finite value simply steer away from it).
function goldenSectionArgmax01(phi: (t: number) => number, iters = 100): number {
  const GOLDEN = (Math.sqrt(5) - 1) / 2;
  let a = 0;
  let b = 1;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = phi(c);
  let fd = phi(d);
  for (let i = 0; i < iters; i++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = phi(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = phi(d);
    }
  }
  return (a + b) / 2;
}

// Recover the per-target craft split that maximizes the EXACT concave joint
// objective sum_T g(Q_T*craft_T + lambda_T), g(s) = log(1 - e^-s), at a FIXED
// inventory, subject to the recipe's craft-conservation polytope.
//
// The hot search loop ranks candidate inventories with compileJointInnerLp's
// fixed-grid tangent envelope of g -- fast, but the grid starts at s=0.05 and
// its nearest-tangent approximation of g is poor for s < 0.05, so the split it
// recovers is biased whenever a target lands on a tiny craft count. That is
// tolerable for ranking, but the FINAL reported split must be exact. This runs
// ONCE per returned solution (never in the search loop) and is free to be
// slower.
//
// Method: Frank-Wolfe (conditional gradient) with an exact 1-D line search.
// From the current feasible split we linearize g at each target's current score
// -- weight_T = g'(score_T) -- and maximize the resulting weighted-sum craft LP
// (the ordinary compileInnerLp, whose polytope is identical to the joint LP's
// conservation rows). Its optimum is a vertex of the polytope; the segment from
// the current point to that vertex is an ascent direction for the true concave
// objective, and an exact golden-section line search along it lands on the
// best point of the segment. Because g is concave, each iterate's TRUE objective
// is non-decreasing, and the iteration converges to the polytope's global
// optimum (for n=2 the effective problem is 1-D and it converges in a handful of
// iterations). Seeding from the tangent-LP split guarantees the result never
// scores below the previous behavior.
export function refineJointCraftSplit(
  recipeDag: RecipeDAG,
  targets: readonly string[],
  QByTarget: ReadonlyMap<string, number>,
  inventory: Map<string, number>,
  lambda: ReadonlyMap<string, number>,
  seed: JointAlphaResult
): JointAlphaResult {
  // Only non-leaf targets with a positive craft weight participate in the
  // split: a leaf (uncraftable) target, or one with Q=0, has a score that does
  // not depend on the craft allocation, so it contributes a constant to the
  // objective and its seed value is reported unchanged.
  const craftTargets = targets.filter(t => !(recipeDag.get(t)?.isLeaf ?? true) && (QByTarget.get(t) ?? 0) > 0);
  if (craftTargets.length === 0) {
    return { craftByTarget: new Map(seed.craftByTarget), primalByNode: new Map(seed.primalByNode) };
  }

  const Q = (t: string) => QByTarget.get(t) ?? 0;
  const lam = (t: string) => lambda.get(t) ?? 0;
  const G_PRIME_CAP = 1e12; // guards g'(s) -> Infinity as s -> 0
  const gPrime = (s: number) => (s <= 0 ? G_PRIME_CAP : Math.min(1 / Math.expm1(s), G_PRIME_CAP));
  const g = (s: number) => (s > 0 ? Math.log(-Math.expm1(-s)) : -Infinity);

  let currentPrimal = new Map(seed.primalByNode);
  let currentCraft = new Map<string, number>();
  for (const t of craftTargets) {
    currentCraft.set(t, seed.craftByTarget.get(t) ?? currentPrimal.get(t) ?? 0);
  }

  const TIGHT = 1e-11; // convergence when no target's score moves more than this
  const MAX_ITERS = 100;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Linearize g at the current scores: since score_T = Q_T*craft_T + lambda_T,
    // d/d(craft_T) g(score_T) = g'(score_T)*Q_T by the chain rule, so the FW
    // subproblem is the weighted-sum craft LP with weight_T = g'(score_T)*Q_T
    // (dropping the Q_T factor would linearize against the wrong gradient and
    // risk the line search stalling on a non-optimal split whenever targets
    // have different Q values).
    const weights = new Map<string, number>();
    for (const t of craftTargets) {
      const s = Q(t) * (currentCraft.get(t) ?? 0) + lam(t);
      weights.set(t, gPrime(s) * Q(t));
    }
    const lp = compileInnerLp(recipeDag, [...craftTargets], weights);
    const nonLeafNodes = lp.nonLeafNodes;
    const vertex = lp.solve(inventory);

    // True-objective scores at the two segment endpoints (linear in t).
    const s0 = craftTargets.map(t => Q(t) * (currentCraft.get(t) ?? 0) + lam(t));
    const s1 = craftTargets.map(t => Q(t) * (vertex.craftByTarget.get(t) ?? 0) + lam(t));
    const phi = (t: number) => {
      let sum = 0;
      for (let i = 0; i < craftTargets.length; i++) {
        const gv = g(s0[i] + t * (s1[i] - s0[i]));
        if (gv === -Infinity) return -Infinity;
        sum += gv;
      }
      return sum;
    };
    // Golden section only ever converges *toward* an endpoint, so when the
    // segment optimum is an endpoint it stops a few ULPs short. That matters
    // because the endpoints are the common case, not a corner: whenever one
    // target's gradient dominates -- always, when there is only one craftable
    // target, since more of it is unambiguously better -- the answer is the FW
    // vertex itself. Probe both endpoints and prefer them on ties so the
    // reported craft counts are the LP's exact vertex rather than a rounded
    // approach to it.
    const tInterior = goldenSectionArgmax01(phi);
    const fInterior = phi(tInterior);
    let tStar = tInterior;
    if (phi(1) >= fInterior) tStar = 1;
    else if (phi(0) >= fInterior) tStar = 0;

    // Interpolate craft counts and the full per-node primal along the segment
    // (a convex combination of two feasible points stays feasible). At an
    // endpoint take that endpoint's value verbatim: a + 1*(b - a) is not
    // exactly b in floating point.
    const lerp = (a: number, b: number) => (tStar === 1 ? b : tStar === 0 ? a : a + tStar * (b - a));
    let maxMove = 0;
    const newCraft = new Map<string, number>();
    for (let i = 0; i < craftTargets.length; i++) {
      const t = craftTargets[i];
      const c0 = currentCraft.get(t) ?? 0;
      const cNew = lerp(c0, vertex.craftByTarget.get(t) ?? 0);
      newCraft.set(t, cNew);
      maxMove = Math.max(maxMove, Math.abs(Q(t) * (cNew - c0)));
    }
    const newPrimal = new Map<string, number>();
    for (const node of nonLeafNodes) {
      const p0 = currentPrimal.get(node) ?? 0;
      const pNew = lerp(p0, vertex.primalByNode.get(node) ?? 0);
      if (pNew > 1e-9) newPrimal.set(node, pNew);
    }
    currentCraft = newCraft;
    currentPrimal = newPrimal;
    if (maxMove < TIGHT || tStar < 1e-12) break;
  }

  // Report the refined craftable targets over the seed's other entries (leaf /
  // Q=0 targets keep their seed craft counts).
  const craftByTarget = new Map(seed.craftByTarget);
  for (const t of craftTargets) craftByTarget.set(t, currentCraft.get(t) ?? 0);
  return { craftByTarget, primalByNode: currentPrimal };
}
