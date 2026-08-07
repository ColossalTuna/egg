// The mixed-integer program handed to HiGHS.
//
// Two models are built from the same core (SPEC.md sections 3 and 4):
//
//   scaleLp(t)   continuous, maximize s_t alone. Gives theta_t, the largest
//                score target t can reach at all, which is what every score is
//                measured in afterwards.
//   oaMilp       integer, maximize sum_t z_t with z_t held under a set of
//                tangents of g(s) = log(1 - e^-s). The outer approximation of a
//                concave objective, refined by the loop in `oa.ts`.
//
// Two things about this formulation are worth calling out, because they are
// where a MILP earns its keep over the incumbent's LP-plus-search:
//
//   * Missions are allocated *per slot*, not in aggregate. The three slot rows
//     are the packing constraint, stated exactly. A plan that solves this model
//     packs by construction — there is no volume bound to pass and then fail,
//     and no repair heuristic quietly doing the last of the optimisation.
//   * The craft split is a variable, not a post-hoc accounting step. The judge
//     re-optimises crafts over the conservation polytope for whatever
//     allocation it is given; so does this model, in the same LP, at the same
//     time as it chooses the missions.

import type { Model } from './model';
import { logHit } from './evaluator';
import { INF, type MilpModel } from './types';

// Q = -log(1 - p) is +Infinity when a craft is certain. Infinity cannot enter a
// matrix, so certainty is proxied by a rate large enough that a single craft
// saturates g (g(1e4) is 0 to every bit of a double). The *judge* still sees the
// real Infinity — this only steers the search.
export const Q_CERTAIN_PROXY = 1e4;

// Fallback per-slot count bound for the degenerate case of a zero-duration
// option. Real missions take days, so this never binds in practice; it exists
// so no column is unbounded.
const MAX_PER_SLOT = 1e6;

// g'(s) = 1 / expm1(s), *uncapped*.
//
// `evaluator.gPrime` clamps at 1e12 so the judge's Frank-Wolfe linearizations
// stay finite. Reusing that clamp here would be a bug rather than a shortcut:
// the arena's scores run to s ~ 1e-13, where the clamp is active for every
// tangent point at once, so every cut would come back with the same slope and
// the outer approximation would carry no curvature at all.
function slopeAt(s: number): number {
  return 1 / Math.expm1(s);
}

export interface Layout {
  slots: number;
  groups: number;
  crafts: number;
  targets: number;
  // n[g][k] — missions of group g launched into slot k. Integer in the MILP,
  // continuous in the scale LP.
  nBase: number;
  // N[g] — the same missions summed over slots, tied to n by one row each.
  //
  // Redundant as modelling and load-bearing as arithmetic: everything that does
  // not care *which* slot a mission went in (conservation, scores, fuel) reads
  // N instead of the three n columns, which takes those rows from 3G nonzeros
  // to G. On the widest instances that is the difference between a 35k-nonzero
  // matrix and a 12k one, and the LP relaxation — not the branching — is where
  // this candidate's time goes.
  aBase: number;
  // c[p] — crafts of craftable p. Always continuous: the judge's craft split is
  // an LP too, so rounding crafts would score a different objective.
  cBase: number;
  // sigma[t] — target t's score in units of theta_t.
  sBase: number;
  // z[t] — the outer-approximation stand-in for g(s_t). Absent in the scale LP.
  zBase: number;
  columnCount: number;
}

export function layoutOf(model: Model, withZ: boolean): Layout {
  const slots = model.slots;
  const groups = model.groups.length;
  const crafts = model.craftables.length;
  const targets = model.targets.length;
  const nBase = 0;
  const aBase = nBase + groups * slots;
  const cBase = aBase + groups;
  const sBase = cBase + crafts;
  const zBase = sBase + targets;
  return {
    slots,
    groups,
    crafts,
    targets,
    nBase,
    aBase,
    cBase,
    sBase,
    zBase: withZ ? zBase : -1,
    columnCount: withZ ? zBase + targets : zBase,
  };
}

export function nCol(layout: Layout, group: number, slot: number): number {
  return layout.nBase + group * layout.slots + slot;
}

// Effective craft rates: the judge's, with certainty proxied (see above).
export function effectiveQs(model: Model): number[] {
  return model.Qs.map(q => (Number.isFinite(q) ? q : Q_CERTAIN_PROXY));
}

// Smallest matrix entry a row is allowed to keep before it gets scaled up.
//
// HiGHS silently discards any entry at or below `small_matrix_value` while
// *ingesting* a model — default 1e-9 — and a discarded entry does not weaken a
// row, it deletes a term. Lose the coefficients from the fuel row and the fuel
// budget simply stops existing.
//
// That option cannot be relied on to fix it, because the wasm build's one-shot
// `solve(text, options)` reads the model *before* applying any option (see
// `highs.ts`), so `small_matrix_value` is inert: it is set too late to affect the
// ingestion it governs.
//
// The margin is not comfortable either, and the fuel row is where it is
// thinnest, so here is the whole arithmetic with real numbers.
//
// The tank capacity itself never reaches the matrix. `model.ts` divides every
// mission's `actualFuel` by `fuelCapacity`, so what the fuel row carries is a
// dimensionless ratio, and a 1e14 tank is not on its own a large coefficient —
// it is a large *denominator*. Both ends of the ratio are bounded:
//
//   upper  an option costing more than the whole tank is dropped by
//          `buildModel` (`cap = floor(1 / fuel)`, and `cap < 1` returns), so
//          every surviving coefficient is <= 1. Whatever the tank, this row
//          cannot approach `large_matrix_value` = 1e15.
//   lower  the smallest ratio the game admits is the cheapest launch over the
//          largest tank: 1.0e7 / 5.0e14 = 2.0e-8. (`fuelTankSizes` tops out at
//          5e14; 1e7 is the cheapest `actualFuel` in the enumerated menu across
//          the sweep.) A1-fuel doubles the tank, which halves it to 1e-8.
//
// 2e-8 is twenty times `small_matrix_value`. Twenty is not a margin, which is
// why this constant is 1e-6 and not 1e-9: at 1e-6 the row is rescaled while the
// filter is still two decades away. What the rescale then does with those
// numbers: `smallest = 2e-8 < 1e-6`, so `scale = min(1/2e-8, 1e12/largest)`,
// and since `largest <= 1` the headroom term is >= 1e12 while `1/smallest` is
// 5e7 — the cap cannot bind on this row, and the scale is exactly `1/smallest`.
// The smallest entry lands on 1 and the largest on at most 5e7, both sitting
// mid-window with eight decades of clearance below and seven above.
//
// Measured, forcing all 40 sweep instances to the largest tank: normalized fuel
// coefficients span [2.0e-8, 3.3e-1], and the smallest entry any fuel row
// actually hands HiGHS after scaling is 1.0e-5. Whole OA matrix over the same
// run: [1e-5, 1e12], against a window of roughly [1e-9, 1e15].
//
// So instead: scaling a row and its bounds by a positive constant leaves the
// feasible set exactly unchanged, so any row carrying an entry near the filter
// is scaled until its smallest entry is 1. Rows already clear of it are left
// alone — the slot rows in particular, whose units are chosen to line up with
// the judge's packing tolerance and would lose that if rescaled.
const SAFE_COEFFICIENT = 1e-6;

// The same filter at the other end, and the reason the scaling above is capped.
//
// HiGHS also *rejects* a model outright when an entry exceeds
// `large_matrix_value` (default 1e15) — not silently, but with "Unable to read
// LP model ... HiGHS error -1" out of the reader, which surfaces in the app as
// a plan that could not be computed. The two filters together define a window,
// and scaling a row to clear the bottom of it can push that row's largest entry
// out of the top.
//
// That is not hypothetical. A tangent cut placed deep in the grid can have a
// slope ratio of ~1e17 between its two coefficients: normalizing the small side
// to 1 then puts the other at 2.8e16 and the whole model becomes unreadable.
// So the scale is the *smaller* of "enough to clear the bottom" and "as much as
// the top allows", which leaves every row that already fits untouched and keeps
// the pathological ones inside the window rather than trading one filter for the
// other. Same 1000x margin as `SAFE_COEFFICIENT` keeps below 1e-9.
const SAFE_LARGE_COEFFICIENT = 1e12;

function scaleBound(bound: number, scale: number): number {
  if (bound >= INF) return INF;
  if (bound <= -INF) return -INF;
  const scaled = bound * scale;
  if (scaled >= INF) return INF;
  if (scaled <= -INF) return -INF;
  return scaled;
}

// Accumulates rows in triplet form and freezes them into row-major CSR. One
// `Map` per row so a coefficient written twice (a craftable that is also one of
// its own ingredients' consumers, say) adds rather than overwrites.
class Rows {
  private readonly offsets: number[] = [];
  private readonly indices: number[] = [];
  private readonly values: number[] = [];
  private readonly lower: number[] = [];
  private readonly upper: number[] = [];
  private current: Map<number, number> | null = null;

  begin(): void {
    this.current = new Map();
  }

  add(column: number, coefficient: number): void {
    if (coefficient === 0) return;
    const row = this.current!;
    row.set(column, (row.get(column) ?? 0) + coefficient);
  }

  // Closes the row at `lo <= expr <= up`. A row that ended up empty is dropped:
  // HiGHS accepts it, but the LP-format writer has nothing to print for it.
  end(lo: number, up: number): void {
    const row = this.current!;
    this.current = null;
    const cols = [...row.keys()].filter(c => row.get(c) !== 0).sort((a, b) => a - b);
    if (cols.length === 0) return;

    let smallest = Infinity;
    let largest = 0;
    for (const c of cols) {
      const magnitude = Math.abs(row.get(c)!);
      smallest = Math.min(smallest, magnitude);
      largest = Math.max(largest, magnitude);
    }
    // Never scale down, and never past the top of the window: a row whose own
    // dynamic range is wider than the window cannot be made to fit, and the
    // least bad answer is to keep the large entries readable.
    const headroom = largest > 0 ? SAFE_LARGE_COEFFICIENT / largest : Infinity;
    const scale = smallest < SAFE_COEFFICIENT ? Math.max(1, Math.min(1 / smallest, headroom)) : 1;

    this.offsets.push(this.indices.length);
    for (const c of cols) {
      this.indices.push(c);
      this.values.push(row.get(c)! * scale);
    }
    this.lower.push(scaleBound(lo, scale));
    this.upper.push(scaleBound(up, scale));
  }

  freeze(): Pick<MilpModel, 'rowCount' | 'rowLower' | 'rowUpper' | 'offsets' | 'indices' | 'values'> {
    return {
      rowCount: this.offsets.length,
      rowLower: Float64Array.from(this.lower),
      rowUpper: Float64Array.from(this.upper),
      offsets: Int32Array.from(this.offsets),
      indices: Int32Array.from(this.indices),
      values: Float64Array.from(this.values),
    };
  }
}

// Per-slot count bound for a group: the most launches of it one slot can hold.
// `group.cap` is the whole-plan bound (fuel and total time); the slot bound is
// tighter and is what the column needs.
function perSlotCap(model: Model, group: number): number {
  const grp = model.groups[group];
  const byTime = grp.time > 0 ? Math.floor(1 / grp.time) : MAX_PER_SLOT;
  return Math.max(0, Math.min(grp.cap, byTime, MAX_PER_SLOT));
}

interface Core {
  layout: Layout;
  rows: Rows;
  columnLower: Float64Array;
  columnUpper: Float64Array;
  columnIsInteger: Uint8Array;
}

// Columns and the rows every variant shares: conservation, score definitions,
// the fuel budget, the three slot budgets, and the slot-ordering symmetry break.
function buildCore(
  model: Model,
  qs: readonly number[],
  theta: readonly number[],
  integral: boolean,
  withZ: boolean
): Core {
  const layout = layoutOf(model, withZ);
  const columnLower = new Float64Array(layout.columnCount);
  const columnUpper = new Float64Array(layout.columnCount).fill(INF);
  const columnIsInteger = new Uint8Array(layout.columnCount);

  for (let g = 0; g < layout.groups; g++) {
    const cap = perSlotCap(model, g);
    for (let k = 0; k < layout.slots; k++) {
      const col = nCol(layout, g, k);
      columnUpper[col] = cap;
      columnIsInteger[col] = integral ? 1 : 0;
    }
    // Integrality of the total follows from the parts, so this column stays
    // continuous rather than giving branch-and-bound a fourth thing to branch on
    // per group.
    columnUpper[layout.aBase + g] = model.groups[g].cap;
  }
  // g(s) <= 0 for every s, so z is bounded above by 0 before any cut is added.
  if (withZ) {
    for (let t = 0; t < layout.targets; t++) {
      columnLower[layout.zBase + t] = -INF;
      columnUpper[layout.zBase + t] = 0;
    }
  }

  const rows = new Rows();

  // Aggregation: N_g - sum_k n_{g,k} = 0.
  for (let g = 0; g < layout.groups; g++) {
    rows.begin();
    rows.add(layout.aBase + g, 1);
    for (let k = 0; k < layout.slots; k++) rows.add(nCol(layout, g, k), -1);
    rows.end(0, 0);
  }

  // Conservation, one row per consumed item:
  //   sum_p consRows[i][p] c_p  -  sum_g yield_g[i] N_g  <=  baseB[i]
  for (let i = 0; i < model.items.length; i++) {
    rows.begin();
    for (let p = 0; p < layout.crafts; p++) rows.add(layout.cBase + p, model.consRows[i][p]);
    for (let g = 0; g < layout.groups; g++) rows.add(layout.aBase + g, -model.groups[g].yieldByItem[i]);
    rows.end(-INF, model.baseB[i]);
  }

  // Score definition, one row per target:
  //   theta_t sigma_t  -  Q_t c_{target t}  -  sum_g leg_g[t] N_g  =  0
  for (let t = 0; t < layout.targets; t++) {
    rows.begin();
    rows.add(layout.sBase + t, theta[t]);
    const craft = model.targetCraftIdx[t];
    if (craft >= 0) rows.add(layout.cBase + craft, -qs[t]);
    for (let g = 0; g < layout.groups; g++) rows.add(layout.aBase + g, -model.groups[g].legendaryByTarget[t]);
    rows.end(0, 0);
  }

  // Fuel, over the whole plan. Costs are normalized so the tank is 1 — this is
  // the row `SAFE_COEFFICIENT` most often ends up rescaling, since normalizing
  // by a large tank is exactly what drives coefficients toward the filter.
  rows.begin();
  for (let g = 0; g < layout.groups; g++) rows.add(layout.aBase + g, model.groups[g].fuel);
  rows.end(-INF, 1);

  // The packing constraint, stated exactly: each slot holds at most its own
  // capacity.
  //
  // In raw seconds, not normalized, and that is not cosmetic. HiGHS accepts an
  // integer solution that violates a row by up to `mip_feasibility_tolerance`,
  // which is *absolute* on the row activity — so a normalized row would let a
  // plan overfill a slot by that fraction of the whole horizon, seconds of it on
  // a month-long budget, and the judge's packer works to 1e-9 seconds. Stating
  // the row in the same units as the goalpost puts the two tolerances on the
  // same scale (see `SOLVER_OPTIONS`), which is what keeps `repair` a no-op
  // instead of a mission-shedding tax on every plan that fills a slot exactly.
  for (let k = 0; k < layout.slots; k++) {
    rows.begin();
    for (let g = 0; g < layout.groups; g++) rows.add(nCol(layout, g, k), model.groups[g].timeSeconds);
    rows.end(-INF, model.timeCapacitySeconds);
  }

  // Slots are interchangeable, which would otherwise make the search explore
  // slots! relabellings of the same plan. Forcing loads non-increasing keeps one
  // representative of each.
  for (let k = 0; k + 1 < layout.slots; k++) {
    rows.begin();
    for (let g = 0; g < layout.groups; g++) {
      const seconds = model.groups[g].timeSeconds;
      rows.add(nCol(layout, g, k), seconds);
      rows.add(nCol(layout, g, k + 1), -seconds);
    }
    rows.end(0, INF);
  }

  return { layout, rows, columnLower, columnUpper, columnIsInteger };
}

function finish(core: Core, objective: Float64Array): MilpModel {
  return {
    columnCount: core.layout.columnCount,
    columnLower: core.columnLower,
    columnUpper: core.columnUpper,
    columnIsInteger: core.columnIsInteger,
    objective,
    ...core.rows.freeze(),
  };
}

// Weight on the scale LP's single objective column.
//
// Not 1, and this is the whole reason the scale LP works at all.
//
// Everywhere else in this candidate the objective is O(1) — the OA MILP
// maximizes a sum of log-probabilities, around -16 in the regime the arena
// scores in. The scale LP is the exception: its optimum is a *raw* score, and
// raw scores here run to 1e-7 and below. HiGHS's `dual_feasibility_tolerance` is
// absolute on reduced costs, so at that magnitude every reduced cost at the
// all-zero vertex is inside tolerance, and HiGHS reports "optimal" at zero while
// a feasible point three decades better sits in the same polytope. Measured on
// seed 2028: pinning the counts to a known-good plan gives sigma = 1.28e-7,
// leaving them free gives a confidently optimal 0 — and a zero theta reads as
// "this target is unreachable", so the candidate returned an empty plan on an
// instance where the search this replaced scored 1.6e-14.
//
// Scaling the objective does not move the argmax, and theta is read off the
// *column*, not the objective value, so this is free: it multiplies every
// reduced cost by 1e9 and puts the decision back above the tolerance floor.
// The paired `dual_feasibility_tolerance` in `SOLVER_OPTIONS` buys the rest.
const SCALE_LP_OBJECTIVE = 1e9;

// Continuous relaxation maximizing target `t`'s score on its own. theta is left
// at 1 so sigma_t *is* s_t and the answer reads straight off the column.
export function buildScaleLp(model: Model, qs: readonly number[], t: number): MilpModel {
  const ones = new Array<number>(model.targets.length).fill(1);
  const core = buildCore(model, qs, ones, false, false);
  const objective = new Float64Array(core.layout.columnCount);
  objective[core.layout.sBase + t] = SCALE_LP_OBJECTIVE;
  return finish(core, objective);
}

// A tangent of g at s = theta_t * a, written in sigma:
//   z_t <= g(theta a) + theta g'(theta a) (sigma_t - a)
export interface Tangent {
  target: number;
  at: number; // the point, in sigma units
}

export function buildOaMilp(
  model: Model,
  qs: readonly number[],
  theta: readonly number[],
  cuts: readonly Tangent[]
): MilpModel {
  const core = buildCore(model, qs, theta, true, true);
  const { layout, rows } = core;

  for (const cut of cuts) {
    const s = theta[cut.target] * cut.at;
    if (!(s > 0) || !Number.isFinite(s)) continue;
    const slope = theta[cut.target] * slopeAt(s);
    const rhs = logHit(s) - slope * cut.at;
    if (!Number.isFinite(slope) || !Number.isFinite(rhs)) continue;
    rows.begin();
    rows.add(layout.zBase + cut.target, 1);
    rows.add(layout.sBase + cut.target, -slope);
    rows.end(-INF, rhs);
  }

  const objective = new Float64Array(layout.columnCount);
  for (let t = 0; t < layout.targets; t++) objective[layout.zBase + t] = 1;
  return finish(core, objective);
}

// Missions per group, summed back over the slots. HiGHS returns integers as
// floats a few ulps off, so this rounds; `oa.ts` re-checks both budgets against
// the rounded counts rather than trusting the model.
export function decodeCounts(model: Model, layout: Layout, columnValues: Float64Array): number[] {
  const counts = new Array<number>(model.groups.length).fill(0);
  for (let g = 0; g < layout.groups; g++) {
    let total = 0;
    for (let k = 0; k < layout.slots; k++) {
      const v = columnValues[nCol(layout, g, k)];
      if (Number.isFinite(v) && v > 0) total += Math.round(v);
    }
    counts[g] = Math.min(total, model.groups[g].cap);
  }
  return counts;
}

export function decodeSigmas(layout: Layout, columnValues: Float64Array): number[] {
  const out = new Array<number>(layout.targets).fill(0);
  for (let t = 0; t < layout.targets; t++) {
    const v = columnValues[layout.sBase + t];
    out[t] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}
