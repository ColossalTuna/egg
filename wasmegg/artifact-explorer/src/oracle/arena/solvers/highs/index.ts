// highs: the production candidate, and the one the app actually runs.
//
// Methodology (SPEC.md): state the whole plan as a mixed-integer program —
// missions per slot, crafts as continuous flow over the conservation polytope,
// one row per slot so packing is a constraint rather than a repair — and let a
// real branch-and-bound solver do the integer search. The objective's concave
// log is handled by outer approximation, refined against the judged value of
// each incumbent (`oa.ts`).
//
// This module and `src/lib/optimizer-core.ts` call the same `solveWith` with the
// same loaded solver, and that identity is the point: a change to the shipped
// planner is a change to this entry, and has to survive the invariant checks
// before it is believed. The dependency runs one way only — production imports
// the candidate, never the reverse — so nothing here reads `src/lib` or the
// harness. The problem model and the evaluator come from `solvers/common`.
//
// The wasm module is awaited at import time because `Planner` is synchronous.
// That makes importing the registry load 3.4MB, which is fine in a test process
// and is exactly why the app goes through `loadHighs()` itself instead.

import type { ArenaSolver, PlanProblem, PlanResult } from '../../contract';
import { memoizePlanner } from '../common/memo';
import { loadHighs } from './highs';
import { solveWith } from './oa';

const solve = await loadHighs();

export const highs: ArenaSolver = {
  id: 'highs',
  description: 'MILP over slots and crafts, outer-approximated objective, solved by HiGHS (WebAssembly)',
  plan: memoizePlanner((problem: PlanProblem): PlanResult => solveWith(problem, solve)),
};
