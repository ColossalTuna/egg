// The MILP seam: what `oa.ts` hands a solver, and what it expects back.
//
// There is exactly one implementation (`highs.ts`), and this is still a named
// seam rather than a direct call for one reason: `oa.ts` must stay synchronous —
// the arena's `Planner` is — while loading a WebAssembly module is not. So the
// loading happens once, at the edge, and what travels inward is a plain
// function. Everything else about this file is the wire format for a matrix.
//
// The model is always a maximization, always row-major, and always bounded by
// *deterministic* limits (node counts, never wall clock) — see `MilpLimits`.

// HiGHS treats any bound at or beyond this magnitude as infinite.
export const INF = 1e30;

export interface MilpModel {
  columnCount: number;
  columnLower: Float64Array;
  columnUpper: Float64Array;
  // 1 = integer, 0 = continuous. Parallel to the columns.
  columnIsInteger: Uint8Array;
  // Objective is always maximized; there is no sense flag to get wrong.
  objective: Float64Array;
  rowCount: number;
  rowLower: Float64Array;
  rowUpper: Float64Array;
  // Row-major sparse matrix. `offsets` holds one start per row (length
  // `rowCount`); the last row runs to the end of `indices`. That is what
  // `Highs::passModel` reads for a row-wise matrix, and it is what the LP-format
  // writer walks.
  offsets: Int32Array;
  indices: Int32Array;
  values: Float64Array;
}

export type MilpStatus =
  // proven optimal within the gap
  | 'optimal'
  // a feasible incumbent, but the search stopped on a limit
  | 'feasible'
  // proven infeasible
  | 'infeasible'
  // no usable primal solution came back
  | 'unknown';

export interface MilpSolution {
  status: MilpStatus;
  // Objective of the returned incumbent. Only meaningful when `status` is
  // 'optimal' or 'feasible'.
  objective: number;
  columnValues: Float64Array;
}

// Everything that bounds the search. Deliberately node- and gap-based rather
// than time-based: the arena requires the same problem to produce the same
// allocation, and a wall-clock limit makes the answer a function of how loaded
// the machine was. That rule holds in the app too — the sidebar exposes the node
// budget, not a number of seconds, so the same settings give the same plan.
export interface MilpLimits {
  // 0 means "no branching allowed beyond the root"; Infinity means unbounded.
  maxNodes: number;
  // Relative MIP gap at which HiGHS may declare optimality.
  relGap: number;
}

export type MilpSolve = (model: MilpModel, limits: MilpLimits) => MilpSolution;

// Options pinned on every solve, so a plan is a function of the model and the
// limits and of nothing else.
//
// `threads`/`parallel` are pinned because a parallel MIP search is not
// reproducible, and reproducibility is a hard arena rule. The feasibility
// tolerances are pinned an order of magnitude below HiGHS's defaults because a
// solution this candidate returns is graded by a packer working to 1e-9
// absolute seconds: at the default 1e-6 a plan could be "feasible" to HiGHS and
// infeasible to the judge, which is a hard arena failure rather than a rounding
// difference of opinion.
export const SOLVER_OPTIONS: Readonly<Record<string, boolean | number | string>> = {
  output_flag: false,
  log_to_console: false,
  threads: 1,
  parallel: 'off',
  random_seed: 0,
  presolve: 'on',
  primal_feasibility_tolerance: 1e-9,
  mip_feasibility_tolerance: 1e-9,
  // The dual tolerance is absolute on reduced costs, and this candidate's raw
  // scores are tiny enough that at the default 1e-7 an LP can report "optimal"
  // at the all-zero vertex while a strictly better point sits in the same
  // polytope. One order of magnitude, not more: at HiGHS's documented minimum
  // of 1e-10 the simplex fails outright on the wider instances ("HiGHS error
  // -1" out of `Highs_run`), so the structural fix is `SCALE_LP_OBJECTIVE` in
  // `milp.ts` and this is only the margin around it.
  dual_feasibility_tolerance: 1e-8,
};
