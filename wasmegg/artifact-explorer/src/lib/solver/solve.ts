// The outer approximation: holds each concave g(s_T) under a tangent grid so HiGHS sees a MILP, refines
// that grid at the incumbent for a few rounds, and returns an incumbent only once `./evaluator` certifies it.

import type { CraftSplitReport, MilpLimits, MilpSolve, PlanProblem, PlanResult } from './types';
import {
  EXACT_PRECISION,
  STEERING_PRECISION,
  evaluateCounts,
  exceedsLaunchBudgets,
  type EvalResult,
} from './evaluator';
import { buildModel, maxLaunches, type Model } from './model';
import {
  RowRangeError,
  buildOaMilp,
  decodeCounts,
  effectiveQs,
  layoutOf,
  nCol,
  oaUnits,
  scaleLps,
  type Layout,
} from './milp';
import { logHit } from '../objective';

export interface Tuning {
  maxNodes: number;
  // Tangent points per target, in units of theta, each in (0, 1].
  sigmaGrid: readonly number[];
}

const SIGMA_FLOOR = 1e-2;
const SIGMA_CUTS = 50;

export function logGrid(floor: number, count: number): number[] {
  // Two points is the smallest grid there is: one would divide by zero, and every NaN tangent that
  // produced would be skipped by `buildOaMilp`, leaving the objective with no cuts and every plan
  // scoring the same. `Tuning` is a caller's to set, so this is checked rather than assumed.
  if (!Number.isInteger(count) || count < 2) throw new Error(`tangent grid needs at least 2 points, got ${count}`);
  if (!(floor > 0) || floor >= 1) throw new Error(`tangent grid floor must lie in (0, 1), got ${floor}`);
  const decades = Math.log10(floor);
  return Array.from({ length: count }, (_, i) => 10 ** ((decades * i) / (count - 1)));
}

// Worst-case gap between g and its tangent envelope on such a grid, in nats.
export function envelopeErrorNats(floor: number, count: number): number {
  const decadesPerCut = Math.abs(Math.log10(floor)) / (count - 1);
  return (decadesPerCut * Math.LN10) ** 2 / 8;
}

export const DEFAULT_TUNING: Tuning = { maxNodes: 1200, sigmaGrid: logGrid(SIGMA_FLOOR, SIGMA_CUTS) };

const MIP_REL_GAP = 1e-6;

// Envelope refinement (SPEC.md section 4). After each OA solve, a target whose envelope value z_t sits more
// than `REFINE_TOL` nats above g at the incumbent's own score gets a tangent there, and the MILP is solved
// again; at most `REFINE_ROUNDS` times. Every incumbent is judged and the best one kept, so a round can
// only help. Kelley's argument: a round that adds no cut has an incumbent the envelope already prices
// exactly, which makes it optimal for the true objective up to the MILP's own gap.
const REFINE_ROUNDS = 4;
const REFINE_TOL = 1e-9;
// The lowest point a round extends the grid down to, for a target the incumbent leaves unscored.
const REFINE_SIGMA_FLOOR = 1e-12;
// A point this close (relatively) to one already cut adds nothing. HiGHS's primal comes back through its
// text interface rounded to about six significant digits, so the incumbent's sigma is never exactly the
// point a previous round cut at, and without this the same tangent would be added every round.
const REFINE_POINT_RTOL = 1e-5;

function nearExisting(points: readonly number[], sigma: number): boolean {
  return points.some(p => Math.abs(p - sigma) <= REFINE_POINT_RTOL * Math.max(p, sigma));
}

// Slack on a slot row, in seconds. Pinned to the tolerance the arena's packer
// works to, and never above it — see `fitsBudgets` below.
const SLOT_TOL = 1e-9;

// The per-slot launch counts the incumbent's class columns describe, rounded, or null when they are
// not a packing of `counts`: a column outside [0, its cap], or a class whose slot columns do not add up
// to the decoded totals of its groups. That second case is what a fractional point rounds into (SOL-10):
// group totals and slot columns round independently, and a plan that agrees with neither is not packed.
function slotCountsOf(
  model: Model,
  layout: Layout,
  columnValues: Float64Array,
  counts: readonly number[]
): number[][] | null {
  const classTotals = new Array<number>(layout.classes).fill(0);
  for (let g = 0; g < layout.groups; g++) classTotals[layout.classOf[g]] += counts[g];
  const perClass: number[][] = [];
  for (let c = 0; c < layout.classes; c++) {
    const row: number[] = [];
    let total = 0;
    for (let k = 0; k < model.slots; k++) {
      const raw = columnValues[nCol(layout, c, k)];
      const v = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
      if (v > layout.classCap[c]) return null;
      row.push(v);
      total += v;
    }
    if (total !== classTotals[c]) return null;
    perClass.push(row);
  }
  return perClass;
}

// The craft budget is not re-checked here because no allocation can breach it: it binds on the craft
// split, which the judge re-solves for itself over a polytope carrying the same row (`evaluator.ts`,
// `craftLpOf`). See `tests/arena/ARENA.md`, "Feasibility". Fuel and the total gem cap are the judge's
// `exceedsLaunchBudgets`, the same check the fallback plans below pass through.
function fitsBudgets(model: Model, layout: Layout, columnValues: Float64Array, counts: readonly number[]): boolean {
  if (exceedsLaunchBudgets(model, counts)) return false;
  const perClass = slotCountsOf(model, layout, columnValues, counts);
  if (!perClass) return false;
  const capacity = model.timeCapacitySeconds;
  for (let k = 0; k < model.slots; k++) {
    let load = 0;
    for (let c = 0; c < layout.classes; c++) load += perClass[c][k] * layout.classSeconds[c];
    if (load > capacity + SLOT_TOL) return false;
  }
  return true;
}

export interface SolveOptions {
  report?: boolean;
}

function emit(problem: PlanProblem, model: Model, counts: readonly number[], report: boolean): PlanResult {
  const allocation = new Array<number>(problem.options.length).fill(0);
  for (let g = 0; g < model.groups.length; g++) {
    if (counts[g] > 0) allocation[model.groups[g].members[0]] += counts[g];
  }
  if (!report) return { allocation };

  // Inside the guard the rest of the pass works under: `evaluateCounts` runs a simplex that throws on
  // an unbounded column, a lost basis or its iteration cap. The exact pass is retried at the steering
  // precision the plan was selected under, which is a looser stop on the same judge, so the printed
  // figures and the craft split survive a numerical failure of the tighter pass (SOL-20(b)). Only when
  // both throw is the report dropped; the allocation stands either way, and omitting `reported` says
  // the figures could not be re-derived rather than inventing them.
  let finalEval: ReturnType<typeof evaluateCounts>;
  try {
    finalEval = evaluateCounts(model, counts, EXACT_PRECISION);
  } catch {
    try {
      finalEval = evaluateCounts(model, counts, STEERING_PRECISION);
    } catch {
      return { allocation };
    }
  }
  const scored = finalEval.scores.map(s => (s > 0 ? -Math.expm1(-s) : 0));
  const craftSplit = splitOf(model, finalEval.crafts);
  const perTarget = new Array<number>(scored.length);
  for (let t = 0; t < scored.length; t++) perTarget[model.requestedOrder[t]] = scored[t];
  // Folded in the model's own order, not the caller's: float multiplication is not
  // associative, so the caller's order would leak back into the reported joint.
  let jointProbability = 1;
  for (const p of scored) jointProbability *= p;
  return { allocation, reported: { jointProbability, perTarget }, craftSplit };
}

// Below this a craft is the LP's way of writing zero, and a node the plan does not craft has no
// place in a breakdown of what it crafts.
const CRAFT_EPS = 1e-9;

function splitOf(model: Model, crafts: EvalResult['crafts']): CraftSplitReport {
  const byNode = new Map<string, number>();
  for (let p = 0; p < model.craftables.length; p++) {
    if (crafts.byCraftable[p] > CRAFT_EPS) byNode.set(model.craftables[p], crafts.byCraftable[p]);
  }
  // Keyed by node id rather than position, so neither side has to know the model sorted the targets.
  // Every craftable target gets an entry, zero included: absent means "no craft column", which is
  // what sends a leaf target to its own reporting path.
  const byTarget = new Map<string, number>();
  for (let t = 0; t < model.sortedTargets.length; t++) {
    if (model.targetCraftIdx[t] >= 0) byTarget.set(model.sortedTargets[t], crafts.byTarget[t]);
  }
  return { byNode, byTarget };
}

// Returns null when no usable scale came back for some target. Two different reasons land here: the
// target cannot be scored at all, so every allocation has joint probability zero and no plan beats the
// empty one; or the LP had no finite optimum, in which case the target has no ceiling to measure sigma
// against and section 4's whole normalization is undefined. Either way there is no MILP to write.
function scales(model: Model, qs: readonly number[], solve: MilpSolve, limits: MilpLimits): number[] | null {
  const layout = layoutOf(model, 'scale');
  const scaleLp = scaleLps(model, qs);
  // Each target's LP-maximal score subject to the budgets, used as the unit for that
  // target's tangent grid.
  const theta: number[] = [];
  for (let t = 0; t < model.sortedTargets.length; t++) {
    const solution = solve(scaleLp(t), limits);
    if (solution.status !== 'optimal' && solution.status !== 'feasible') return null;
    const value = solution.columnValues[layout.scoreBase + t];
    if (!(value > 0) || !Number.isFinite(value)) return null;
    theta.push(value);
  }
  return theta;
}

interface Incumbent {
  counts: number[];
  value: number;
}

// Judged at steering precision, as every candidate is. A judge that throws (`simplexMax` on an unbounded
// column, a lost basis or its iteration cap) leaves the candidate unjudgeable, which ranks it below
// everything, the empty plan included.
function judge(model: Model, counts: readonly number[]): number {
  try {
    return evaluateCounts(model, counts, STEERING_PRECISION).logJoint;
  } catch {
    return -Infinity;
  }
}

function offer(model: Model, best: Incumbent, counts: number[]): void {
  const value = judge(model, counts);
  if (value > best.value) {
    best.counts = counts;
    best.value = value;
  }
}

// The OA search proper: theta per target, then up to `REFINE_ROUNDS + 1` MILP solves, every fitting
// incumbent offered to `best`. Returns without a plan where the scale LPs give no usable theta or HiGHS
// returns no point.
function outerApproximation(model: Model, solve: MilpSolve, tuning: Tuning, best: Incumbent): void {
  const qs = effectiveQs(model);
  const limits: MilpLimits = { maxNodes: tuning.maxNodes, relGap: MIP_REL_GAP };
  const theta = scales(model, qs, solve, limits);
  if (!theta) return;

  const units = oaUnits(theta);
  const layout = layoutOf(model, 'oa');
  const extra: number[][] = theta.map(() => []);
  const lowest = theta.map(() => Math.min(...tuning.sigmaGrid));
  // One target: the envelope is increasing in sigma whatever its tangents, so the MILP maximizes the
  // target's score under any grid and a refinement round cannot move the argmax. Only the first solve
  // runs, as it always did.
  const rounds = layout.targets > 1 ? REFINE_ROUNDS : 0;
  for (let round = 0; round <= rounds; round++) {
    const solution = solve(buildOaMilp(model, qs, theta, tuning.sigmaGrid, extra), limits);
    // A whitelist, not a blacklist of the failures known today: only these two carry a point that is a
    // plan rather than a waypoint on a ray or a leftover from an errored solve.
    if (solution.status !== 'optimal' && solution.status !== 'feasible') return;

    const counts = decodeCounts(model, layout, solution.columnValues);
    if (fitsBudgets(model, layout, solution.columnValues, counts)) offer(model, best, counts);

    let added = false;
    for (let t = 0; t < layout.targets; t++) {
      const sigma = solution.columnValues[layout.scoreBase + t];
      const z = solution.columnValues[layout.envelopeBase + t];
      if (!(sigma > 0) || !Number.isFinite(sigma)) {
        // Unscored at the incumbent: g is -Infinity there, and only the extrapolated bottom tangent
        // stands between the MILP and that point. A lower tangent pulls the extrapolation down.
        const next = lowest[t] / 100;
        if (next >= REFINE_SIGMA_FLOOR) {
          extra[t].push(next);
          lowest[t] = next;
          added = true;
        }
      } else if (
        sigma <= 1 &&
        z - logHit(units[t] * sigma) > REFINE_TOL &&
        !nearExisting(tuning.sigmaGrid, sigma) &&
        !nearExisting(extra[t], sigma)
      ) {
        extra[t].push(sigma);
        if (sigma < lowest[t]) lowest[t] = sigma;
        added = true;
      }
    }
    if (!added) return;
  }
}

// The plans that need no MILP: each group alone, flown as often as its own budgets and the slots allow.
// Tried only when nothing else scored above -Infinity, so that a numerically unwritable model, an
// unusable scale LP or an empty OA incumbent never stands as the answer while a single-group plan
// scores positive.
function singleGroupPlans(model: Model, best: Incumbent): void {
  const capacity = model.timeCapacitySeconds;
  for (let g = 0; g < model.groups.length; g++) {
    const grp = model.groups[g];
    const perSlot = grp.timeSeconds > 0 ? maxLaunches(capacity, grp.timeSeconds) : Infinity;
    const n = Math.floor(Math.min(grp.cap, model.slots * perSlot));
    if (!(n >= 1)) continue;
    const counts = new Array<number>(model.groups.length).fill(0);
    counts[g] = n;
    if (exceedsLaunchBudgets(model, counts)) continue;
    offer(model, best, counts);
  }
}

export function solveWith(
  problem: PlanProblem,
  solve: MilpSolve,
  tuning: Tuning = DEFAULT_TUNING,
  { report = false }: SolveOptions = {}
): PlanResult {
  const model = buildModel(problem);
  const empty = new Array<number>(model.groups.length).fill(0);
  if (model.groups.length === 0 || model.sortedTargets.length === 0) return emit(problem, model, empty, report);

  const best: Incumbent = { counts: empty, value: judge(model, empty) };
  try {
    outerApproximation(model, solve, tuning, best);
  } catch (error: unknown) {
    // A row no scale can write (SOL-11/12) is a property of the inputs' magnitudes, not a failed solve:
    // the MILP-free plans below still apply. Anything else, a HiGHS failure above all, propagates, so
    // the caller reports an error rather than recording an empty plan as an answer (STA-13).
    if (!(error instanceof RowRangeError)) throw error;
  }
  if (!(best.value > -Infinity)) singleGroupPlans(model, best);

  return emit(problem, model, best.counts, report);
}
