// Independent evaluator: compute the legendary probability of an integer
// launch allocation from first principles, derived from the optimizer's
// documented objective (see optimizer-core.ts) rather than its implementation.
// A float simplex ranks the brute-force candidates cheaply; an exact
// BigInt-rational simplex produces the numbers that get asserted or reported.

import type { LaunchOption, RecipeDAG } from '../lib/types';
import { Frac } from './rational';
import { simplexMaximize, simplexMaximizeFloat, simplexMaximizeFloatFull, simplexMaximizeFull } from './simplex';

export interface OracleInstance {
  label: string;
  seed: number;
  options: LaunchOption[];
  dag: RecipeDAG;
  targets: string[]; // desired node ids; [0] is the primary target
  fuelCapacity: number;
  timeCapacity: number;
  baseYield: Map<string, number>;
}

export interface OracleEvaluation {
  score: number; // Q-weighted crafts + direct legendary drops
  lpScore: number; // Q-weighted crafts only
  drops: number; // total direct legendary drops
  probability: number; // 1 - exp(-score)
  expectedCrafts: number | null; // single-target instances only
}

export function targetQ(inst: OracleInstance, target: string): number {
  const node = inst.dag.get(target);
  if (!node) {
    throw new Error(`target ${target} missing from DAG`);
  }
  return -Math.log(1 - node.legendaryCraftProbability);
}

// Shared across allocations of one instance: only the right-hand side (the
// inventory) changes.
interface LpTemplate {
  craftables: string[];
  items: string[];
  A: number[][];
  c: number[];
  AFrac: Frac[][] | null;
  cFrac: Frac[] | null;
}

const templateCache = new WeakMap<OracleInstance, LpTemplate>();

function lpTemplate(inst: OracleInstance): LpTemplate {
  let template = templateCache.get(inst);
  if (template) {
    return template;
  }

  const craftables: string[] = [];
  for (const [id, node] of inst.dag) {
    if (!node.isLeaf) {
      craftables.push(id);
    }
  }
  const varIndex = new Map(craftables.map((id, i) => [id, i]));

  const ingredients = new Set<string>();
  for (const node of inst.dag.values()) {
    for (const child of node.children) {
      ingredients.add(child.nodeId);
    }
  }
  const items = [...ingredients];

  const A = items.map(item => {
    const row = new Array<number>(craftables.length).fill(0);
    for (const node of inst.dag.values()) {
      if (node.isLeaf) {
        continue;
      }
      const j = varIndex.get(node.id)!;
      for (const child of node.children) {
        if (child.nodeId === item) {
          row[j] += child.quantity;
        }
      }
    }
    const producer = varIndex.get(item);
    if (producer !== undefined) {
      row[producer] -= 1;
    }
    return row;
  });

  const c = new Array<number>(craftables.length).fill(0);
  for (const target of inst.targets) {
    const j = varIndex.get(target);
    if (j === undefined) {
      throw new Error(`target ${target} is not craftable`);
    }
    c[j] += targetQ(inst, target);
  }

  template = { craftables, items, A, c, AFrac: null, cFrac: null };
  templateCache.set(inst, template);
  return template;
}

function inventoryFor(inst: OracleInstance, allocation: number[]): Map<string, Frac> {
  const inv = new Map<string, Frac>();
  const bump = (item: string, amount: Frac) => {
    inv.set(item, (inv.get(item) ?? Frac.ZERO).add(amount));
  };
  for (const [item, qty] of inst.baseYield) {
    bump(item, Frac.fromNumber(qty));
  }
  inst.options.forEach((opt, i) => {
    if (allocation[i] === 0) {
      return;
    }
    const count = new Frac(BigInt(allocation[i]));
    for (const [item, qty] of opt.yieldVector) {
      bump(item, count.mul(Frac.fromNumber(qty)));
    }
  });
  return inv;
}

function directDrops(inst: OracleInstance, allocation: number[]): number {
  let drops = 0;
  inst.options.forEach((opt, i) => {
    for (const target of inst.targets) {
      drops += allocation[i] * (opt.legendaryYieldVector.get(target) ?? 0);
    }
  });
  return drops;
}

// Cheap ranking path; ~1e-9 accuracy against gaps asserted at 1e-3 scale.
export function evaluateAllocationFloat(inst: OracleInstance, allocation: number[]): number {
  const template = lpTemplate(inst);
  const inv = new Map<string, number>();
  for (const [item, qty] of inst.baseYield) {
    inv.set(item, (inv.get(item) ?? 0) + qty);
  }
  inst.options.forEach((opt, i) => {
    if (allocation[i] === 0) {
      return;
    }
    for (const [item, qty] of opt.yieldVector) {
      inv.set(item, (inv.get(item) ?? 0) + allocation[i] * qty);
    }
  });
  const b = template.items.map(item => inv.get(item) ?? 0);
  return simplexMaximizeFloat(template.A, b, template.c) + directDrops(inst, allocation);
}

export function evaluateAllocation(inst: OracleInstance, allocation: number[]): OracleEvaluation {
  const template = lpTemplate(inst);
  if (!template.AFrac || !template.cFrac) {
    template.AFrac = template.A.map(row => row.map(x => Frac.fromNumber(x)));
    template.cFrac = template.c.map(x => Frac.fromNumber(x));
  }
  const inv = inventoryFor(inst, allocation);
  const b = template.items.map(item => inv.get(item) ?? Frac.ZERO);

  const lpScore = simplexMaximize(template.AFrac, b, template.cFrac).toNumber();
  const drops = directDrops(inst, allocation);
  const score = lpScore + drops;
  return {
    score,
    lpScore,
    drops,
    probability: 1 - Math.exp(-score),
    expectedCrafts: inst.targets.length === 1 ? lpScore / targetQ(inst, inst.targets[0]) : null,
  };
}

// ---------------------------------------------------------------------------
// Joint (product) probability evaluator -- independent of value-function.ts's
// tangent-line epigraph LP (compileJointInnerLp/JOINT_TANGENTS/EPIGRAPH_SHIFT).
// The production algorithm approximates maximize sum_T g(score_T),
// g(s) = log(1 - e^-s), with a concave-envelope LP relaxation over tangent
// lines; this file instead solves the TRUE objective directly, with no LP
// relaxation and no tangent lines, so it can catch bugs in that
// approximation instead of repeating its logic.
//
// For exactly two targets, the achievable (score_0, score_1) pairs are the
// linear image (allocation -> (Q_0*craft_t0, Q_1*craft_t1)) of the SAME
// bounded craft-conservation polytope the union evaluator above already
// solves -- a linear image of a (bounded, since the recipe DAG is acyclic)
// polytope is itself a polytope, so its upper-right (Pareto) boundary is a
// concave, piecewise-linear function of score_0. Maximizing
// g(score_0) + g(score_1) over that boundary is therefore a 1-D concave
// problem, solved here with NO notion of "splitting a shared ingredient"
// (which would mishandle a case the generator genuinely produces: one
// target itself consumed as an ingredient by the other's recipe, ~9% of
// random-multi instances -- see the oracle PR notes). Instead:
//
//   1. trace the polytope's Pareto frontier by solving the ordinary LP
//      "maximize w*Q_0*craft_t0 + (1-w)*Q_1*craft_t1" for a sweep of
//      weights w, recursively bisecting whenever two neighboring weights
//      land on different vertices, until no further distinct vertex turns
//      up between them (a polytope has finitely many vertices, so this
//      terminates well inside the depth/budget caps on any instance this
//      generator produces -- the caps exist only to bound pathological float
//      near-ties);
//   2. golden-section search the true joint objective along each frontier
//      EDGE -- the straight segment between two adjacent vertices' PRIMAL
//      solutions, valid because a convex combination of two feasible
//      allocations is itself feasible and score_0/score_1 are linear in the
//      allocation -- which recovers the exact optimum even when it falls
//      strictly inside an edge rather than exactly at a vertex.
//
// The frontier trace runs on the float simplex (cheap: used to rank many
// candidate allocations); the winning edge's two weights are then re-solved
// with the exact BigInt-rational simplex for the numbers actually asserted,
// mirroring the float-ranks/exact-reports split used everywhere else in this
// file.

export interface OracleJointTargetResult {
  nodeId: string;
  score: number; // Q_T * craftCount_T + direct-drop lambda_T
  bestProbability: number; // 1 - exp(-score)
  expectedCrafts: number;
}

export interface OracleJointEvaluation {
  jointProbability: number; // product over targets of bestProbability
  perTarget: OracleJointTargetResult[];
}

function directDropsFor(inst: OracleInstance, allocation: number[], target: string): number {
  let drops = 0;
  inst.options.forEach((opt, i) => {
    drops += allocation[i] * (opt.legendaryYieldVector.get(target) ?? 0);
  });
  return drops;
}

// g(s) = log(1 - e^-s). Deliberately re-derived here rather than imported
// from value-function.ts, to keep this evaluator independent of production
// code (the formula itself is elementary math, not part of the tangent-plane
// machinery this file must avoid reusing).
function logHitProbability(s: number): number {
  return s > 0 ? Math.log(-Math.expm1(-s)) : -Infinity;
}

function inventoryFloat(inst: OracleInstance, allocation: number[]): Map<string, number> {
  const inv = new Map<string, number>();
  for (const [item, qty] of inst.baseYield) {
    inv.set(item, (inv.get(item) ?? 0) + qty);
  }
  inst.options.forEach((opt, i) => {
    if (!allocation[i]) return;
    for (const [item, qty] of opt.yieldVector) {
      inv.set(item, (inv.get(item) ?? 0) + allocation[i] * qty);
    }
  });
  return inv;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

// argmax of a unimodal (here: concave) f over [0, 1].
function goldenSectionArgmax(f: (x: number) => number, iters = 80): number {
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

interface FrontierVertexFloat {
  w: number;
  s0: number;
  s1: number;
  primal: number[];
}

function solveWeightedFloat(
  template: LpTemplate,
  b: number[],
  idx0: number,
  idx1: number,
  Q0: number,
  Q1: number,
  w: number
): FrontierVertexFloat {
  const c = new Array<number>(template.craftables.length).fill(0);
  c[idx0] = w * Q0;
  c[idx1] = (1 - w) * Q1;
  const { primal } = simplexMaximizeFloatFull(template.A, b, c);
  return { w, s0: Q0 * primal[idx0], s1: Q1 * primal[idx1], primal };
}

function sameVertex(a: { s0: number; s1: number }, b: { s0: number; s1: number }): boolean {
  const EPS = 1e-9;
  const scale0 = Math.max(1, Math.abs(a.s0), Math.abs(b.s0));
  const scale1 = Math.max(1, Math.abs(a.s1), Math.abs(b.s1));
  return Math.abs(a.s0 - b.s0) < EPS * scale0 && Math.abs(a.s1 - b.s1) < EPS * scale1;
}

function traceParetoFrontier(
  template: LpTemplate,
  b: number[],
  idx0: number,
  idx1: number,
  Q0: number,
  Q1: number,
  maxDepth: number,
  budget: number
): FrontierVertexFloat[] {
  const solve = (w: number) => solveWeightedFloat(template, b, idx0, idx1, Q0, Q1, w);
  const v0 = solve(0);
  const v1 = solve(1);
  const found = [v0, v1];
  let remaining = budget;

  const recurse = (lo: FrontierVertexFloat, hi: FrontierVertexFloat, depth: number) => {
    if (depth >= maxDepth || remaining <= 0 || sameVertex(lo, hi)) {
      return;
    }
    remaining--;
    const mid = solve((lo.w + hi.w) / 2);
    if (sameVertex(mid, lo) || sameVertex(mid, hi)) {
      return; // no further vertex between lo and hi: they bound a single edge
    }
    found.push(mid);
    recurse(lo, mid, depth + 1);
    recurse(mid, hi, depth + 1);
  };
  recurse(v0, v1, 0);

  found.sort((x, y) => x.s0 - y.s0);
  const dedup: FrontierVertexFloat[] = [];
  for (const v of found) {
    if (dedup.length === 0 || !sameVertex(dedup[dedup.length - 1], v)) {
      dedup.push(v);
    }
  }
  return dedup;
}

// Maximizes g(s0)+g(s1) along the straight segment between two adjacent
// frontier vertices (concave in the segment parameter t, since g is concave
// increasing and s0(t), s1(t) are linear in t).
function bestOnSegment(
  v0: { s0: number; s1: number },
  v1: { s0: number; s1: number },
  lambda0: number,
  lambda1: number
): { t: number; s0: number; s1: number; logProb: number } {
  const at = (t: number) => ({ s0: v0.s0 + t * (v1.s0 - v0.s0), s1: v0.s1 + t * (v1.s1 - v0.s1) });
  const phi = (t: number) => {
    const p = at(t);
    return logHitProbability(p.s0 + lambda0) + logHitProbability(p.s1 + lambda1);
  };
  const t = goldenSectionArgmax(phi);
  const p = at(t);
  return { t, s0: p.s0, s1: p.s1, logProb: phi(t) };
}

interface JointSplitFloat {
  loW: number;
  hiW: number;
  t: number;
  s0: number;
  s1: number;
  logProb: number;
}

function bestJointSplitFloat(
  template: LpTemplate,
  b: number[],
  idx0: number,
  idx1: number,
  Q0: number,
  Q1: number,
  lambda0: number,
  lambda1: number,
  maxDepth: number,
  budget: number
): JointSplitFloat {
  const vertices = traceParetoFrontier(template, b, idx0, idx1, Q0, Q1, maxDepth, budget);
  let best: JointSplitFloat | null = null;
  for (let i = 0; i + 1 < vertices.length; i++) {
    const seg = bestOnSegment(vertices[i], vertices[i + 1], lambda0, lambda1);
    if (best === null || seg.logProb > best.logProb) {
      best = { loW: vertices[i].w, hiW: vertices[i + 1].w, t: seg.t, s0: seg.s0, s1: seg.s1, logProb: seg.logProb };
    }
  }
  if (best === null) {
    // Degenerate: a single vertex found (e.g. neither target can be crafted
    // at all), so there is no edge to search -- just score that lone point.
    const v = vertices[0];
    best = {
      loW: v.w,
      hiW: v.w,
      t: 0,
      s0: v.s0,
      s1: v.s1,
      logProb: logHitProbability(v.s0 + lambda0) + logHitProbability(v.s1 + lambda1),
    };
  }
  return best;
}

// Budgets for the frontier trace: modest for ranking many brute-force
// candidates, generous for the handful of finalists that get exact treatment.
const RANK_MAX_DEPTH = 14;
const RANK_BUDGET = 40;
const FINAL_MAX_DEPTH = 24;
const FINAL_BUDGET = 200;

function jointContext(inst: OracleInstance): {
  template: LpTemplate;
  idx0: number;
  idx1: number;
  Q0: number;
  Q1: number;
  t0: string;
  t1: string;
} {
  if (inst.targets.length !== 2) {
    throw new Error(
      `evaluateAllocationJoint(Float) only supports exactly 2 targets (got ${inst.targets.length}); ` +
        `n=1 is handled separately and n>=3 is out of this oracle's current scope`
    );
  }
  const [t0, t1] = inst.targets;
  const template = lpTemplate(inst);
  const idx0 = template.craftables.indexOf(t0);
  const idx1 = template.craftables.indexOf(t1);
  if (idx0 === -1 || idx1 === -1) {
    throw new Error(`target ${idx0 === -1 ? t0 : t1} is not craftable`);
  }
  return { template, idx0, idx1, Q0: targetQ(inst, t0), Q1: targetQ(inst, t1), t0, t1 };
}

// Cheap ranking path (float simplex): plays the same role for the joint
// objective that evaluateAllocationFloat plays for the union objective.
export function evaluateAllocationJointFloat(inst: OracleInstance, allocation: number[]): number {
  if (inst.targets.length === 1) {
    return 1 - Math.exp(-evaluateAllocationFloat(inst, allocation));
  }
  const { template, idx0, idx1, Q0, Q1, t0, t1 } = jointContext(inst);
  const inv = inventoryFloat(inst, allocation);
  const b = template.items.map(item => inv.get(item) ?? 0);
  const lambda0 = directDropsFor(inst, allocation, t0);
  const lambda1 = directDropsFor(inst, allocation, t1);
  const { logProb } = bestJointSplitFloat(template, b, idx0, idx1, Q0, Q1, lambda0, lambda1, RANK_MAX_DEPTH, RANK_BUDGET);
  return Math.exp(logProb);
}

export function evaluateAllocationJoint(inst: OracleInstance, allocation: number[]): OracleJointEvaluation {
  if (inst.targets.length === 1) {
    const single = evaluateAllocation(inst, allocation);
    return {
      jointProbability: single.probability,
      perTarget: [
        {
          nodeId: inst.targets[0],
          score: single.score,
          bestProbability: single.probability,
          expectedCrafts: single.expectedCrafts ?? 0,
        },
      ],
    };
  }

  const { template, idx0, idx1, Q0, Q1, t0, t1 } = jointContext(inst);
  const inv = inventoryFloat(inst, allocation);
  const b = template.items.map(item => inv.get(item) ?? 0);
  const lambda0 = directDropsFor(inst, allocation, t0);
  const lambda1 = directDropsFor(inst, allocation, t1);

  // Locate the winning edge cheaply in float, then resolve its two endpoint
  // weights EXACTLY and interpolate at the float-found segment position --
  // the same "float ranks, exact reports" split the rest of this file uses.
  const split = bestJointSplitFloat(template, b, idx0, idx1, Q0, Q1, lambda0, lambda1, FINAL_MAX_DEPTH, FINAL_BUDGET);

  if (!template.AFrac || !template.cFrac) {
    template.AFrac = template.A.map(row => row.map(x => Frac.fromNumber(x)));
    template.cFrac = template.c.map(x => Frac.fromNumber(x));
  }
  const invFrac = inventoryFor(inst, allocation);
  const bFrac = template.items.map(item => invFrac.get(item) ?? Frac.ZERO);
  const Q0Frac = Frac.fromNumber(Q0);
  const Q1Frac = Frac.fromNumber(Q1);

  const solveExactAt = (w: number): Frac[] => {
    const c = new Array<Frac>(template.craftables.length).fill(Frac.ZERO);
    c[idx0] = Frac.fromNumber(w).mul(Q0Frac);
    c[idx1] = Frac.fromNumber(1 - w).mul(Q1Frac);
    return simplexMaximizeFull(template.AFrac!, bFrac, c).primal;
  };
  const loPrimal = solveExactAt(split.loW);
  const hiPrimal = split.hiW === split.loW ? loPrimal : solveExactAt(split.hiW);
  const tFrac = Frac.fromNumber(split.t);
  const oneMinusT = Frac.ONE.sub(tFrac);
  const craft0 = loPrimal[idx0].mul(oneMinusT).add(hiPrimal[idx0].mul(tFrac));
  const craft1 = loPrimal[idx1].mul(oneMinusT).add(hiPrimal[idx1].mul(tFrac));
  const s0 = craft0.mul(Q0Frac).toNumber() + lambda0;
  const s1 = craft1.mul(Q1Frac).toNumber() + lambda1;
  const p0 = s0 > 0 ? 1 - Math.exp(-s0) : 0;
  const p1 = s1 > 0 ? 1 - Math.exp(-s1) : 0;

  return {
    jointProbability: p0 * p1,
    perTarget: [
      { nodeId: t0, score: s0, bestProbability: p0, expectedCrafts: craft0.toNumber() },
      { nodeId: t1, score: s1, bestProbability: p1, expectedCrafts: craft1.toNumber() },
    ],
  };
}
