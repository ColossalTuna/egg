// The one seam the invariant harness solves through.
//
// Everything a candidate solver is allowed to see is in `PlanProblem`, and
// everything the harness needs back is in `PlanResult`. The harness never reads
// a candidate's internals, never imports its module, and never trusts a number
// it reports: `allocation` is scored by the harness's own judge
// (`../evaluate.ts`, an independent re-derivation of the objective from
// `src/lib/OPTIMIZER.md`). A candidate is therefore free to be a MILP, an
// annealer, a DP, a learned policy or a lookup table without the harness
// changing by a line.
//
// See ARENA.md for the rules a candidate has to follow.

import type { LaunchOption, RecipeDAG } from '../../lib/types';

// Every plan is packed into this many concurrent mission slots, each holding
// `timeCapacity` seconds of flight. It is a property of the game, not of any
// solver, so it lives here rather than in an implementation.
export const NUM_SLOTS = 3;

export interface PlanProblem {
  // Menu of launches available, already enumerated from the player's ships,
  // research and effort level. `allocation` is indexed against this array, in
  // this order. Options may repeat, may be shuffled, and may include entries no
  // sane plan would use — the harness perturbs this deliberately.
  readonly options: readonly LaunchOption[];
  // Recipe graph for the targets, carrying per-node craft chances and the
  // ingredient conservation structure.
  readonly dag: RecipeDAG;
  // Desired artifact node ids. The objective is P(at least one legendary of
  // EVERY one of these) — the product over targets, not the max or the sum.
  readonly targets: readonly string[];
  // Total fuel across the whole plan.
  readonly fuelCapacity: number;
  // Seconds available *per slot*. A plan is feasible when its missions
  // partition into `NUM_SLOTS` slots each loaded to at most this.
  readonly timeCapacity: number;
  readonly slots: number;
  // Copies of each node the player already owns, folded in before crafting.
  readonly baseYield: ReadonlyMap<string, number>;
}

// Optional self-report. Supplying it opts a candidate into C2-honesty and
// C3-joint-product, which check that what a solver claims matches what its own
// allocation is actually worth. Omitting it is legal and costs nothing but
// those two checks.
export interface PlanReport {
  jointProbability: number;
  perTarget: number[]; // parallel to problem.targets
}

export interface PlanResult {
  // Missions launched per option, parallel to `problem.options`. Non-negative
  // integers. Must be feasible: fuel within capacity, and packable into
  // `slots` slots of `timeCapacity`.
  allocation: number[];
  reported?: PlanReport;
}

export type Planner = (problem: PlanProblem) => PlanResult;

export interface ArenaSolver {
  // Stable id used on the command line and in result files.
  id: string;
  // One line for the scorecard.
  description: string;
  plan: Planner;
}
