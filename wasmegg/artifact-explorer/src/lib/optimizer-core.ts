// The mission-plan pipeline: option filtering, objective evaluation, and the assembly of a renderable
// solution around whatever plan the planner (`./solver/`) returned. See OPTIMIZER.md for the objective.

import type { CraftBudget, LaunchOption, LaunchSolution, OptimizerSolution, RecipeDAG, SlotSummary } from './types';
import { ei } from 'lib';
import { craftsToProbability } from './objective';
import { NUM_SLOTS, packWitness } from './packing';
import { loadHighs } from './solver/highs';
import { DEFAULT_TUNING, solveWith } from './solver/solve';
import { fuelCostOnAxis, normalizeProblem, type CraftSplitReport, type PlanProblem } from './solver/types';

// Below this, a mission's duration counts as zero — the only quantity it's compared against.
const ZERO_TOL = 1e-9;

// `actualTime` is `max(rawTime, launchPeriodSeconds)`, and `Math.max` with a NaN period is NaN, which the
// menu filter below would drop silently, emptying the plan. A NaN period imposes no floor, so the option
// keeps its unfloored duration. An option whose raw duration is itself not finite is left as it is and the
// filter drops it: there is no duration to fall back to.
function withFiniteFloor(o: LaunchOption): LaunchOption {
  return Number.isNaN(o.actualTime) && Number.isFinite(o.rawTime) ? { ...o, actualTime: o.rawTime } : o;
}

// The budgets below obey `solver/types.ts`'s one rule: absent means no limit, a present one is a
// finite non-negative number, and `normalizeProblem` holds every caller to it.
export interface OptimizeArgs {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  desiredArtifactNodeIds: string[];
  fuelCapacity: number;
  // Per-egg budgets from the player's tank. When present these replace `fuelCapacity`:
  // the plan is limited by the fuel actually stocked, egg by egg, rather than by how
  // much the tank could hold.
  fuelByEggCapacity?: Map<ei.Egg, number>;
  timeCapacityPerSlot: number;
  // Not a budget the plan spends against but a threshold on the menu: it drops ships the player
  // will not pay for, and leaves the feasible set bounded at any value, so `Infinity` is a legal
  // way to say "the whole menu" where an infinite capacity would be malformed.
  maximumCost: number | undefined;
  ownedStock: Map<string, number>;
  // Golden egg cap on the plan's crafts, or absent for no cap. It has to reach both the MILP and the
  // judge's craft LP, or the cap does not bind on the craft counts the card actually prints.
  craftBudget?: CraftBudget;
}

interface Assembly {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  targets: string[];
  ownedStock: Map<string, number>;
}

// Work cap for each probe of the makespan search, in candidate splits tried (see `packWitness`'s
// `stepBudget`), and the most probes it makes. A probe that runs out ends the search at the best real
// arrangement found so far, never at one that does not pack, and the budget is a count rather than a clock,
// so the same request reports the same makespan on any machine.
const MAKESPAN_PROBE_STEPS = 50_000;
const MAKESPAN_PROBES = 40;
// The search stops once the gap between its proven lower bound and the best real arrangement is below this
// fraction of the slot capacity, or below half a second, since the figure is reported in whole seconds.
const MAKESPAN_REL_GAP = 1e-9;
const MAKESPAN_ABS_GAP = 0.5;

const maxOf = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), 0);

function loadsOf(witness: number[][], durations: number[]): number[] {
  const load = new Array<number>(NUM_SLOTS).fill(0);
  for (let j = 0; j < witness.length; j++) for (const slot of witness[j]) load[slot] += durations[j];
  return load;
}

// Longest first into the emptiest slot, as a witness. Cheap, and usually within one short mission of optimal,
// so it is the search's opening upper bound; on instances too large to search it is the answer.
function lptWitness(durations: number[], counts: number[]): number[][] {
  const witness = durations.map(() => [] as number[]);
  const load = new Array<number>(NUM_SLOTS).fill(0);
  const order = durations.map((_, j) => j).sort((a, b) => durations[b] - durations[a]);
  for (const j of order) {
    for (let k = 0; k < counts[j]; k++) {
      let slot = 0;
      for (let b = 1; b < NUM_SLOTS; b++) if (load[b] < load[slot]) slot = b;
      load[slot] += Math.max(0, durations[j]);
      witness[j].push(slot);
    }
  }
  return witness;
}

// The packing with the smallest busiest slot this search can find, at or under `capacity`. The makespan is
// the plan's wall-clock length, so it must be minimized and not merely feasible: a feasibility witness can
// stack six missions in one slot and leave another empty. Starts from the better of the feasibility witness
// and LPT, then bisects on the capacity handed to `packWitness`; each success tightens the upper bound to the
// *real* busiest load of its witness (a sum of mission durations, not the probe value), so what is reported
// is always the load of an arrangement that exists.
function minimalWitness(durations: number[], counts: number[], capacity: number): number[][] | null | undefined {
  const first = packWitness(durations, counts, capacity);
  if (!first) return first;

  let best = first;
  let hi = maxOf(loadsOf(best, durations));
  const lpt = lptWitness(durations, counts);
  const lptMax = maxOf(loadsOf(lpt, durations));
  if (lptMax < hi) {
    best = lpt;
    hi = lptMax;
  }

  // No arrangement beats the longest single mission or an even split of the total load.
  let total = 0;
  let longest = 0;
  for (let j = 0; j < durations.length; j++) {
    if (!(counts[j] > 0) || !(durations[j] > 0)) continue;
    total += counts[j] * durations[j];
    longest = Math.max(longest, durations[j]);
  }
  let lo = Math.max(longest, total / NUM_SLOTS);
  const gap = Math.max(MAKESPAN_REL_GAP * Math.max(capacity, hi, Number.MIN_VALUE), MAKESPAN_ABS_GAP);

  for (let probe = 0; probe < MAKESPAN_PROBES && hi - lo > gap; probe++) {
    // Try the lower bound itself first: it is often attained (equal missions, an even split).
    const mid = probe === 0 ? lo : lo + (hi - lo) / 2;
    const w = packWitness(durations, counts, mid, undefined, MAKESPAN_PROBE_STEPS);
    if (w === undefined) break; // budget exhausted: keep the best real arrangement found
    if (w === null) {
      lo = mid;
      continue;
    }
    const m = maxOf(loadsOf(w, durations));
    if (m < hi) best = w;
    // A witness at `mid` loads no slot past `mid` beyond the packer's tolerance.
    hi = Math.min(hi, Math.max(m, mid));
  }
  return best;
}

// Per-slot occupancy of a chosen allocation. Repacked here because the seam the MILP returns through carries
// only totals; if the exact packer cannot place the plan, the makespan shown is a best-fit estimate, not a claim.
// When it can, the arrangement is the one with the smallest busiest slot (`minimalWitness`), so the makespan
// reported is the minimized one.
function slotSummariesOf(options: LaunchOption[], alloc: Map<number, number>, capacity: number): SlotSummary[] {
  const idx = [...alloc.keys()].filter(i => (alloc.get(i) ?? 0) > 0);
  if (idx.length === 0) return [];

  const durations = idx.map(i => options[i].actualTime);
  const counts = idx.map(i => alloc.get(i) ?? 0);
  const witness = minimalWitness(durations, counts, capacity);
  const load = new Array<number>(NUM_SLOTS).fill(0);
  const rawLoad = new Array<number>(NUM_SLOTS).fill(0);
  const count = new Array<number>(NUM_SLOTS).fill(0);

  const place = (j: number, slot: number) => {
    load[slot] += durations[j];
    rawLoad[slot] += options[idx[j]].rawTime;
    count[slot] += 1;
  };

  if (witness) {
    for (let j = 0; j < idx.length; j++) for (const slot of witness[j]) place(j, slot);
  } else {
    // No witness (provably unpackable, or the node budget ran out). Longest first into the emptiest slot, so
    // the summary still describes a real arrangement of these missions even where it overfills.
    const order = idx.map((_, j) => j).sort((a, b) => durations[b] - durations[a]);
    for (const j of order) {
      for (let k = 0; k < counts[j]; k++) {
        let slot = 0;
        for (let b = 1; b < NUM_SLOTS; b++) if (load[b] < load[slot]) slot = b;
        place(j, slot);
      }
    }
  }

  return load.map((seconds, b) => ({
    loadSeconds: seconds,
    rawLoadSeconds: rawLoad[b],
    missionCount: count[b],
  }));
}

// The whole plan, start to finish. Async because the solver is a WebAssembly module instantiated once;
// every call after the first resolves off a cached promise.
export async function optimizeFull(args: OptimizeArgs): Promise<OptimizerSolution> {
  const { recipeDag, fuelByEggCapacity, maximumCost, ownedStock, craftBudget } = args;

  // A NaN threshold compares false against every price, so it would drop the whole menu and hand back an
  // empty plan as if nothing were affordable. Infinity is the legal "whole menu"; NaN is a caller bug.
  if (maximumCost !== undefined && Number.isNaN(maximumCost)) {
    throw new RangeError('maximumCost must be a number or undefined, got NaN');
  }
  const options = args.options.map(withFiniteFloor);

  // The whole boundary: budgets validated and clamped, targets deduplicated, fuel axes materialized.
  // Everything below reads the normalized problem rather than `args`, so no rule is applied twice or
  // differently — `buildModel` enters through the same function.
  const normalized = normalizeProblem({
    options,
    dag: recipeDag,
    targets: args.desiredArtifactNodeIds,
    fuelCapacity: args.fuelCapacity,
    // A per-egg budget replaces the tank entirely: the egg amounts already sum to no more
    // than the tank holds, so an aggregate row on top of them would be redundant.
    fuelAxes: fuelByEggCapacity && [...fuelByEggCapacity].map(([egg, capacity]) => ({ egg, capacity })),
    timeCapacityPerSlot: args.timeCapacityPerSlot,
    slots: NUM_SLOTS,
    ownedStock,
    craftBudget,
  });
  const S = normalized.timeCapacityPerSlot;
  const axes = normalized.fuelAxes;
  const targets = [...normalized.targets];

  // Dropped before indices are assigned, so an allocation index means the same thing here and inside the solver.
  // Fuel is bounded from above only, since a zero-fuel mission is legitimate, and the per-axis bound is what
  // still holds a NaN fuel budget to the zero-fuel missions. It is also what keeps an egg the player has *none* of
  // from reading as free downstream, where a zero capacity means "ignore this axis".
  const feasibleOptions = options.filter(
    o =>
      ZERO_TOL < o.actualTime &&
      o.actualTime <= S &&
      axes.every(ax => fuelCostOnAxis(o, ax) <= ax.capacity) &&
      (maximumCost === undefined || o.cost <= maximumCost)
  );

  const assembly: Assembly = { options: feasibleOptions, recipeDag, targets, ownedStock };

  const problem: PlanProblem = { ...normalized, options: feasibleOptions };

  const solve = await loadHighs();
  // `report` is what makes the judge hand back the craft split as well as the plan, so the counts the
  // card prints are the ones the plan was selected on rather than a second solver's answer to the same
  // question. See `solver/SPEC.md` section 5.
  const { allocation, craftSplit } = solveWith(problem, solve, DEFAULT_TUNING, { report: true });

  const alloc = new Map<number, number>();
  for (let i = 0; i < allocation.length; i++) {
    if (allocation[i] > 0) alloc.set(i, allocation[i]);
  }

  return assembleFullSolution(assembly, alloc, slotSummariesOf(feasibleOptions, alloc, S), craftSplit);
}

function assembleFullSolution(
  a: Assembly,
  bestAlloc: Map<number, number>,
  bestSlots: SlotSummary[],
  craftSplit: CraftSplitReport | undefined
): OptimizerSolution {
  const { recipeDag, ownedStock, targets } = a;
  const { supplyByItem, totalLegendary, fuelUsed, fuelByEgg, choiceHistory } = assembleSolution(
    ownedStock,
    bestAlloc,
    a.options
  );

  const busiest = bestSlots.reduce<SlotSummary | null>(
    (best, s) => (best === null || s.loadSeconds > best.loadSeconds ? s : best),
    null
  );
  // `slotSummariesOf` arranged the plan to minimize the busiest slot, so this is the minimized makespan
  // (when the packer could place the plan at all). The raw time is read off the same slot, and both are
  // rounded with the same monotone rule, so `runningTimeSeconds <= timeUnitsUsed` survives the rounding.
  const makespan = busiest?.loadSeconds ?? 0;
  const running = busiest?.rawLoadSeconds ?? 0;

  // Absent when the judge could not re-derive the plan it had already selected. Empty maps then read
  // as "no crafts", which is what every downstream figure already means by a missing node.
  const craftByTarget = craftSplit?.byTarget ?? new Map<string, number>();
  const perTarget = targets.map(t => {
    // A leaf has no recipe, so nothing is crafted into it and its figure is drop-only. Counting its
    // supply as crafts would price each common copy as a legendary roll, which neither the MILP nor the
    // judge does (they give a leaf no craft column), and the printed P would then disagree with both.
    const craftCount = recipeDag.get(t)?.isLeaf ? 0 : (craftByTarget.get(t) ?? 0);
    const p = craftsToProbability(craftCount, totalLegendary, [t], recipeDag);
    return { nodeId: t, expectedCrafts: craftCount, ...p };
  });
  const primary = perTarget[0] ?? {
    bestProbability: 0,
    craftProbability: 0,
    dropProbability: 0,
    expectedCrafts: 0,
  };

  // No targets yields 0, not the empty product's 1: nothing was asked for, so nothing is achieved.
  // Every factor is a distinct target: `normalizeProblem` deduplicates the list, so an id asked for
  // twice cannot square its own probability here.
  let jointProbability = perTarget.length > 0 ? 1 : 0;
  for (const t of perTarget) jointProbability *= t.bestProbability;

  return {
    bestProbability: primary.bestProbability,
    craftProbability: primary.craftProbability,
    dropProbability: primary.dropProbability,
    expectedCrafts: primary.expectedCrafts,
    fuelUsed: fuelUsed,
    fuelByEgg: fuelByEgg,
    timeUnitsUsed: Math.round(makespan),
    runningTimeSeconds: Math.round(running),
    slots: bestSlots.length > 0 ? bestSlots : undefined,
    choiceHistory: choiceHistory,
    expectedDrops: [], // populated by index.ts
    supplyByItem: supplyByItem,
    ownedStock: new Map(ownedStock),
    recipeDag: recipeDag,
    craftPrimal: craftSplit?.byNode ?? new Map<string, number>(),
    perTarget: perTarget,
    jointProbability,
  };
}

function assembleSolution(ownedStock: Map<string, number>, bestAlloc: Map<number, number>, options: LaunchOption[]) {
  const choiceHistory: LaunchSolution[] = [];
  let fuelUsed = 0;
  const supplyByItem = new Map<string, number>(ownedStock);
  const totalLegendary = new Map<string, number>();
  const fuelByEgg = new Map<ei.Egg, number>();
  for (const [idx, k] of bestAlloc) {
    if (k <= 0) continue;
    const opt = options[idx];
    fuelUsed += k * opt.actualFuel;
    for (const [n, r] of opt.yieldVector) {
      supplyByItem.set(n, (supplyByItem.get(n) ?? 0) + k * r);
    }
    for (const [n, r] of opt.legendaryYieldVector) {
      totalLegendary.set(n, (totalLegendary.get(n) ?? 0) + k * r);
    }
    for (const [egg, rate] of opt.fuelByEgg) {
      fuelByEgg.set(egg, (fuelByEgg.get(egg) ?? 0) + k * rate);
    }
    choiceHistory.push({
      ship: opt.ship,
      actualFuel: opt.actualFuel,
      actualFuelByEgg: opt.fuelByEgg,
      actualTime: opt.actualTime,
      target: opt.target ?? '',
      targetAfxId: opt.targetAfxId,
      numShipsLaunched: k,
      supplyVector: opt.supplyVector,
      legendarySupplyVector: opt.legendaryYieldVector,
    });
  }
  return { supplyByItem, totalLegendary, fuelUsed, fuelByEgg, choiceHistory };
}
