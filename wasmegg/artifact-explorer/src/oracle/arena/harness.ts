// Problem construction and scoring. The only place the arena touches a solver.
//
// Construction (recipe DAG, option enumeration) is production behaviour, not
// solving, so the harness owns it and hands every candidate the identical
// `PlanProblem`. Scoring is `../evaluate.ts`, which re-derives the objective
// from `src/lib/OPTIMIZER.md` and imports only *types* from `src/lib`. So the
// number every invariant compares is computed by the harness from the
// candidate's allocation, never taken from the candidate's own arithmetic.

import { buildRecipeDag } from '@/lib';
import { enumerateLaunchOptions } from '@/lib/phases';
import { EFFORT_LAUNCH_PERIOD_SECONDS, type EffortLevel } from '@/store/schema';
import type { LaunchOption } from '../../lib/types';
import { evaluateAllocationJoint, type OracleInstance, type OracleJointEvaluation } from '../evaluate';
import { NUM_SLOTS, type PlanProblem, type PlanResult, type Planner } from './contract';
import type { ArenaInstance } from './instances';
import { packFeasible, type PackVerdict } from './pack-feasibility';

// Slack on budget comparisons. Capacities are float sums of float costs, so a
// plan that lands exactly on the cap can read a few ulps over it.
export const BUDGET_TOL = 1e-9;

export interface SolveOverrides {
  config?: ArenaInstance['config'];
  targets?: string[];
  fuelCapacity?: number;
  timeCapacity?: number;
  effort?: EffortLevel;
  craftingLevel?: number;
  previousCrafts?: number;
  baseYield?: Map<string, number>;
  // Applied to the enumerated menu before it reaches the solver, for the
  // invariances that perturb the menu itself.
  transformOptions?: (options: LaunchOption[]) => LaunchOption[];
}

export function buildProblem(inst: ArenaInstance, over: SolveOverrides = {}): PlanProblem {
  const targets = over.targets ?? inst.targets;
  const config = over.config ?? inst.config;
  const effort = over.effort ?? inst.effort;

  const dag = buildRecipeDag(
    targets,
    over.craftingLevel ?? inst.craftingLevel,
    null,
    over.previousCrafts ?? inst.previousCrafts
  );
  let options = enumerateLaunchOptions(config, dag, EFFORT_LAUNCH_PERIOD_SECONDS[effort], undefined);
  if (over.transformOptions) options = over.transformOptions(options);

  return {
    options,
    dag,
    targets,
    fuelCapacity: over.fuelCapacity ?? inst.fuelCapacity,
    timeCapacity: over.timeCapacity ?? inst.timeCapacity,
    slots: NUM_SLOTS,
    baseYield: over.baseYield ?? new Map<string, number>(),
  };
}

export function oracleInstanceOf(problem: PlanProblem): OracleInstance {
  return {
    label: 'arena',
    seed: 0,
    options: problem.options as LaunchOption[],
    dag: problem.dag,
    targets: problem.targets as string[],
    fuelCapacity: problem.fuelCapacity,
    timeCapacity: problem.timeCapacity,
    baseYield: problem.baseYield as Map<string, number>,
  };
}

export interface ContractBreach {
  detail: string;
}

// A candidate that returns something outside the contract is a finding, not a
// crash. Normalise what can be normalised, report what cannot.
export function contractBreaches(problem: PlanProblem, result: PlanResult): ContractBreach[] {
  const out: ContractBreach[] = [];
  const alloc = result.allocation;
  if (!Array.isArray(alloc)) {
    out.push({ detail: 'allocation is not an array' });
    return out;
  }
  if (alloc.length !== problem.options.length) {
    out.push({
      detail: `allocation has ${alloc.length} entries for a menu of ${problem.options.length}`,
    });
    return out;
  }
  for (let i = 0; i < alloc.length; i++) {
    const n = alloc[i];
    if (!Number.isFinite(n)) {
      out.push({ detail: `allocation[${i}] is ${n}` });
      break;
    }
    if (n < 0) {
      out.push({ detail: `allocation[${i}] is negative (${n})` });
      break;
    }
    if (!Number.isInteger(n)) {
      out.push({ detail: `allocation[${i}] is fractional (${n}); missions are indivisible` });
      break;
    }
  }
  if (result.reported) {
    const r = result.reported;
    if (!Number.isFinite(r.jointProbability)) {
      out.push({ detail: `reported.jointProbability is ${r.jointProbability}` });
    }
    if (r.perTarget.length !== problem.targets.length) {
      out.push({
        detail: `reported.perTarget has ${r.perTarget.length} entries for ${problem.targets.length} target(s)`,
      });
    }
  }
  return out;
}

export interface Budgets {
  fuel: number;
  totalTime: number;
  pack: PackVerdict;
}

export function budgetsOf(problem: PlanProblem, alloc: readonly number[]): Budgets {
  let fuel = 0;
  let totalTime = 0;
  const durations: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < alloc.length; i++) {
    const n = alloc[i];
    if (!(n > 0)) continue;
    fuel += n * problem.options[i].actualFuel;
    totalTime += n * problem.options[i].actualTime;
    durations.push(problem.options[i].actualTime);
    counts.push(n);
  }
  return {
    fuel,
    totalTime,
    pack: packFeasible(durations, counts, problem.timeCapacity, problem.slots),
  };
}

export function feasible(problem: PlanProblem, alloc: readonly number[]): boolean {
  const b = budgetsOf(problem, alloc);
  return b.fuel <= problem.fuelCapacity * (1 + BUDGET_TOL) + 1e-6 && b.pack === 'packs';
}

export interface Solved {
  problem: PlanProblem;
  result: PlanResult;
  allocation: number[];
  breaches: ContractBreach[];
  // The harness's own valuation of `result.allocation`. Every invariant
  // compares this, never `result.reported`.
  judged: OracleJointEvaluation;
  joint: number;
  elapsedMs: number;
}

export function run(planner: Planner, inst: ArenaInstance, over: SolveOverrides = {}): Solved {
  const problem = buildProblem(inst, over);
  const started = performance.now();
  const result = planner(problem);
  const elapsedMs = performance.now() - started;

  const breaches = contractBreaches(problem, result);
  // Score whatever is scoreable. A malformed allocation is reported by C0 and
  // clamped here so one bad return does not abort the rest of the sweep.
  const allocation = new Array<number>(problem.options.length).fill(0);
  if (Array.isArray(result.allocation)) {
    for (let i = 0; i < allocation.length; i++) {
      const n = result.allocation[i];
      allocation[i] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
  }

  const judged = evaluateAllocationJoint(oracleInstanceOf(problem), allocation);
  return {
    problem,
    result,
    allocation,
    breaches,
    judged,
    joint: judged.jointProbability,
    elapsedMs,
  };
}

export function signature(s: Solved): string {
  return s.allocation.map((n, i) => (n > 0 ? `${i}:${n}` : '')).filter(Boolean).join('|');
}
