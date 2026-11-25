// Preprocessing for the planner: restricted recipe DAG, normalized budgets,
// filtered and duplicate-merged option groups.

import type { LaunchOption, RecipeDAG } from '../types';
import { fuelCostOnAxis, normalizeProblem, type FuelAxis, type PlanProblem } from './types';
import { qOf } from '../objective';

// Stand-in for a group total no budget bounds at all: a zero-duration mission that burns nothing
// budgeted. Any positive duration bounds a group through the time budget instead, and that bound is
// used as it is, however large; see SPEC.md section 2.
const UNBOUNDED_GROUP = 1e9;

export interface Group {
  // Normalized: a fraction of each fuel budget, and of one slot's horizon. One
  // entry per `Model.fuelAxes`, in that order.
  fuelFractions: number[];
  // Gems per launch as a fraction of the total gem budget; 0 when there is no gem cap.
  gemFraction: number;
  timeFraction: number;
  timeSeconds: number;
  yieldByItem: number[];
  legendaryByTarget: number[];
  cap: number;
  // Original option indices. Output lands on members[0], which is the cheapest member (by gem cost, then
  // by raw duration, then by index), so the plan is a function of the option set, not of its order.
  members: number[];
}

export interface Model {
  // Sorted by node id; `requestedOrder` maps back to the caller's order.
  sortedTargets: string[];
  requestedOrder: number[];
  craftables: string[];
  items: string[];
  consRows: number[][]; // items x craftables
  // Per craftable, its children; `childCraft` is -1 when the child is not crafted.
  craftChildren: { itemIdx: number; childCraft: number }[][];
  baseInventoryByItem: number[];
  Qs: number[];
  targetCraftIdx: number[]; // craft column per target; -1 when not craftable
  slots: number;
  // The budgets `Group.fuelFractions` is normalized against; only the count is
  // load-bearing downstream, but the axes themselves make a model self-describing.
  fuelAxes: readonly FuelAxis[];
  timeCapacitySeconds: number;
  // Total gem cap across every launch; Infinity when the problem sets none.
  gemBudget: number;
  // Upper bound per craft column; Infinity where nothing bounds it.
  craftCaps: number[];
  craftPrices: number[];
  craftBudgetCapacity: number;
  groups: Group[];
}

type Entry = [string, number];

interface Candidate {
  fuelFractions: number[];
  gemFraction: number;
  cost: number;
  rawTime: number;
  timeFraction: number;
  timeSeconds: number;
  yieldEntries: Entry[]; // sorted by item id
  legendaryEntries: Entry[]; // sorted by target id
  cap: number;
  index: number;
}

function cmpEntries(a: Entry[], b: Entry[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] < b[i][0] ? -1 : 1;
    if (a[i][1] !== b[i][1]) return a[i][1] - b[i][1];
  }
  return a.length - b.length;
}

// Elementwise, and a total order: two options that cost the same fuel in total but
// draw it from different eggs must not merge into one group.
function cmpFractions(a: number[], b: number[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// Total on numbers that may be Infinity, where plain subtraction gives NaN for two equal infinities.
function cmpNumber(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function cmpKey(a: Candidate, b: Candidate): number {
  const fuel = cmpFractions(a.fuelFractions, b.fuelFractions);
  if (fuel !== 0) return fuel;
  // Under a gem cap two prices are two different resources drawn; without one `gemFraction` is 0 for
  // every option and cost decides only which member a merged group launches (`members[0]`).
  if (a.gemFraction !== b.gemFraction) return a.gemFraction - b.gemFraction;
  if (a.timeFraction !== b.timeFraction) return a.timeFraction - b.timeFraction;
  return cmpEntries(a.yieldEntries, b.yieldEntries) || cmpEntries(a.legendaryEntries, b.legendaryEntries);
}

function craftUpperBounds(
  dag: RecipeDAG,
  targets: readonly string[],
  craftables: readonly string[],
  craftIndex: ReadonlyMap<string, number>,
  items: readonly string[],
  itemIndex: ReadonlyMap<string, number>,
  baseInventoryByItem: readonly number[],
  groups: readonly Group[]
): number[] {
  const dropped = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    let total = baseInventoryByItem[i];
    for (const grp of groups) {
      const y = grp.yieldByItem[i];
      if (y > 0) total += y * grp.cap;
    }
    dropped[i] = Number.isFinite(total) ? total : Infinity;
  }

  // Post-order. Reverse first-visit order is NOT enough: with two targets sharing an ingredient, the second
  // is discovered after the shared node and would read a bound that had not been computed yet.
  const caps = new Array<number>(craftables.length).fill(Infinity);
  const seen = new Set<string>();
  const order: number[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = dag.get(id);
    if (node) for (const child of node.children) visit(child.nodeId);
    const idx = craftIndex.get(id);
    if (idx !== undefined) order.push(idx);
  };
  for (const t of targets) visit(t);

  for (const idx of order) {
    const node = dag.get(craftables[idx]);
    if (!node || node.children.length === 0) continue;
    let bound = Infinity;
    for (const child of node.children) {
      if (!(child.qty > 0)) continue;
      const itemIdx = itemIndex.get(child.nodeId);
      if (itemIdx === undefined) {
        bound = Infinity;
        break;
      }
      let supply = dropped[itemIdx];
      const producer = craftIndex.get(child.nodeId);
      if (producer !== undefined) supply += caps[producer];
      const limit = supply / child.qty;
      if (limit < bound) bound = limit;
    }
    caps[idx] = Number.isFinite(bound) && bound >= 0 ? bound : Infinity;
  }
  return caps;
}

// Largest whole number of launches that fits: the count `n` with `n * unitCost <= capacity`. Computed
// from the two quantities rather than from their ratio's reciprocal, which `Math.floor` then drops a
// launch off — a 1-second mission in a 93-second slot gives `1/(1/93) = 93.00000000000001` one way and
// `92.99999999999999` the other. The multiplication is the same arithmetic the row itself is checked in.
export function maxLaunches(capacity: number, unitCost: number): number {
  const n = Math.floor(capacity / unitCost);
  return (n + 1) * unitCost <= capacity ? n + 1 : n;
}

// Whether the rows alone bound this group's columns. They do not when a zero duration leaves `cap` on the
// stand-in, and a group taking another's launches on is the one thing that can walk a column into such a
// cap. A positive duration settles it: the slot row then bounds every per-slot column by
// `maxLaunches(timeCapacitySeconds, timeSeconds)`, which is derived from the time budget and used as is.
export function boundsFollowFromRows(grp: Group, _timeCapacitySeconds?: number): boolean {
  return grp.timeSeconds > 0;
}

// `taker` dominates `given` when every launch of `given` could have been flown as a `taker` in the same
// slot: no more fuel, no more seconds, and at least as much of every item the conservation rows read and
// of every target's legendary drops. Compared exactly rather than to a tolerance, which is what keeps the
// relation transitive. See SPEC.md section 1.
function dominates(taker: Group, given: Group): boolean {
  if (taker.timeSeconds > given.timeSeconds) return false;
  let strict = taker.timeSeconds < given.timeSeconds;
  // Gems are one more budget drawn per launch: a dearer taker cannot absorb a cheaper group's launches.
  if (taker.gemFraction > given.gemFraction) return false;
  if (taker.gemFraction < given.gemFraction) strict = true;
  // Every axis, not the total: drawing less of one egg does not excuse drawing more of another, or a
  // pruned group's launches would land on a dominator the player cannot fuel.
  for (let a = 0; a < taker.fuelFractions.length; a++) {
    if (taker.fuelFractions[a] > given.fuelFractions[a]) return false;
    if (taker.fuelFractions[a] < given.fuelFractions[a]) strict = true;
  }
  for (let i = 0; i < taker.yieldByItem.length; i++) {
    if (taker.yieldByItem[i] < given.yieldByItem[i]) return false;
    if (taker.yieldByItem[i] > given.yieldByItem[i]) strict = true;
  }
  for (let t = 0; t < taker.legendaryByTarget.length; t++) {
    if (taker.legendaryByTarget[t] < given.legendaryByTarget[t]) return false;
    if (taker.legendaryByTarget[t] > given.legendaryByTarget[t]) strict = true;
  }
  return strict;
}

// Requiring strictness makes `dominates` a strict partial order, so every dropped group has a dominator
// that itself survives, and testing each group against the whole menu, dropped ones included, leaves the
// survivors a function of the group set rather than of the order it was walked in.
function pruneDominated(groups: readonly Group[], timeCapacitySeconds: number): Group[] {
  return groups.filter(
    given =>
      !groups.some(
        taker => taker !== given && boundsFollowFromRows(taker, timeCapacitySeconds) && dominates(taker, given)
      )
  );
}

export function buildModel(raw: PlanProblem): Model {
  // The same boundary `optimizeFull` enters through, and idempotent, so entering it twice costs a copy
  // and nothing else. Everything below may assume budgets are finite and target ids unique.
  const problem = normalizeProblem(raw);
  const dag: RecipeDAG = problem.dag;

  // Sorted so the model is a function of the target *set*: the closure below visits targets in order, so
  // permuting the caller's list permutes every row and column and a node-limited search then diverges.
  // `requestedOrder` is a bijection back onto the caller's list, which the deduplication above is what
  // makes possible.
  const requested = [...problem.targets];
  const requestedOrder = requested.map((_, i) => i).sort((a, b) => (requested[a] < requested[b] ? -1 : 1));
  const targets = requestedOrder.map(i => requested[i]);

  const orderIds: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    orderIds.push(id);
    const node = dag.get(id);
    if (!node) return;
    for (const child of node.children) visit(child.nodeId);
  };
  for (const t of targets) visit(t);

  // A craftable needs at least one ingredient, and under a craft budget it needs a price. A node that has
  // neither is not crafted at all rather than crafted for free: an ingredient-less recipe would leave its
  // craft column bounded by nothing (an unbounded scale LP and judge), and a missing, negative or non-finite
  // price is malformed input, not a craft that costs nothing. Such a node is scored on its drops alone, and
  // where another recipe lists it, it is an item supplied only by missions and stock. SPEC.md section 2.
  const budget = problem.craftBudget;
  const priceOf = (id: string): number | null => {
    if (!budget) return 0;
    const price = budget.unitPrices.get(id);
    return price !== undefined && Number.isFinite(price) && price >= 0 ? price : null;
  };
  const craftables: string[] = [];
  for (const id of orderIds) {
    const node = dag.get(id);
    if (!node || node.isLeaf) continue;
    if (!node.children.some(child => child.qty > 0)) continue;
    if (priceOf(id) === null) continue;
    craftables.push(id);
  }
  const craftIndex = new Map(craftables.map((id, i) => [id, i]));

  const items: string[] = [];
  const itemIndex = new Map<string, number>();
  for (const id of craftables) {
    for (const child of dag.get(id)!.children) {
      if (!itemIndex.has(child.nodeId)) {
        itemIndex.set(child.nodeId, items.length);
        items.push(child.nodeId);
      }
    }
  }

  const consRows = items.map(() => new Array<number>(craftables.length).fill(0));
  for (const id of craftables) {
    const j = craftIndex.get(id)!;
    for (const child of dag.get(id)!.children) {
      consRows[itemIndex.get(child.nodeId)!][j] += child.qty;
    }
  }
  for (const [item, i] of itemIndex) {
    const producer = craftIndex.get(item);
    if (producer !== undefined) consRows[i][producer] -= 1;
  }

  const craftChildren = craftables.map(id =>
    dag
      .get(id)!
      .children.filter(child => child.qty > 0)
      .map(child => ({
        itemIdx: itemIndex.get(child.nodeId)!,
        childCraft: craftIndex.get(child.nodeId) ?? -1,
      }))
  );

  const baseInventoryByItem = items.map(item => {
    const quantity = problem.ownedStock.get(item) ?? 0;
    return Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
  });
  const Qs = targets.map(t => qOf(dag.get(t)?.legendaryCraftProbability ?? 0));
  const targetCraftIdx = targets.map(t => craftIndex.get(t) ?? -1);

  // Every craftable kept above has a finite non-negative price under a budget (0 without one), and
  // `normalizeProblem` has already held the capacity to finite and non-negative. A budget whose prices are
  // all zero writes an empty row, which `Rows.end` drops: free crafts under any cap are still free.
  const craftPrices = craftables.map(id => priceOf(id)!);
  const craftBudgetCapacity = budget ? budget.capacity : Infinity;

  // Normalized budgets: every fuel axis 1, per-slot time 1. An axis the player has nothing on
  // affords nothing: a positive cost against it is unaffordable at any count, so the option falls
  // out on `cap < 1` below, exactly as `timeFraction` already handles a zero time budget.
  const axes = problem.fuelAxes;
  const timeCap = problem.timeCapacityPerSlot;
  const slots = problem.slots;
  const gemBudget = problem.gemBudget ?? Infinity;
  const gemCapped = Number.isFinite(gemBudget);
  // Per-egg axes list the eggs the player has a budget for, and nothing else. An egg missing from the list
  // is an egg with no budget, not a free one: an option burning any of it is unaffordable.
  const perEgg = axes.every(ax => ax.egg !== null);
  const budgeted = new Set(axes.map(ax => ax.egg));

  const candidates: Candidate[] = [];
  problem.options.forEach((opt: LaunchOption, index: number) => {
    // A malformed cost falls through the comparisons below rather than failing loudly:
    // `NaN > 1` is false, and a negative cost *buys* fuel budget or discounts a slot.
    if (
      !Number.isFinite(opt.actualFuel) ||
      !Number.isFinite(opt.actualTime) ||
      opt.actualFuel < 0 ||
      opt.actualTime < 0
    ) {
      return;
    }
    const costs = axes.map(ax => fuelCostOnAxis(opt, ax));
    if (costs.some(c => !Number.isFinite(c) || c < 0)) return;
    if (perEgg) {
      for (const [egg, amount] of opt.fuelByEgg) {
        if (!(amount <= 0) && !budgeted.has(egg)) return;
      }
    }
    if (gemCapped && !(Number.isFinite(opt.cost) && opt.cost >= 0)) return;
    const gemCost = gemCapped ? opt.cost : 0;
    const gemFraction = gemCost > 0 ? (gemBudget > 0 ? gemCost / gemBudget : Infinity) : 0;
    const fuelFractions = axes.map((ax, a) => (ax.capacity > 0 ? costs[a] / ax.capacity : costs[a] > 0 ? Infinity : 0));
    const timeFraction = timeCap > 0 ? opt.actualTime / timeCap : Infinity;
    if (timeFraction > 1) return;

    const yieldEntries: Entry[] = [];
    for (const [item, qty] of opt.yieldVector) {
      if (qty > 0 && itemIndex.has(item)) {
        if (!Number.isFinite(qty)) return;
        yieldEntries.push([item, qty]);
      }
    }
    const legendaryEntries: Entry[] = [];
    for (const t of targets) {
      const qty = opt.legendaryYieldVector.get(t) ?? 0;
      if (qty > 0) {
        if (!Number.isFinite(qty)) return;
        legendaryEntries.push([t, qty]);
      }
    }
    if (yieldEntries.length === 0 && legendaryEntries.length === 0) return;
    yieldEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    legendaryEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    // The tightest axis binds; an option needing more of one egg than the player has
    // gets a fraction above 1 and falls out on `cap < 1`.
    // A positive duration bounds the group through the time budget, and that bound is taken as it is: no
    // stand-in caps it, so a long horizon of short missions is not cut off at an arbitrary count (SOL-24).
    const cap = Math.min(
      ...costs.map((cost, a) => (cost > 0 ? maxLaunches(axes[a].capacity, cost) : Infinity)),
      gemCost > 0 ? maxLaunches(gemBudget, gemCost) : Infinity,
      opt.actualTime > 0 ? maxLaunches(slots * timeCap, opt.actualTime) : UNBOUNDED_GROUP
    );
    if (!(cap >= 1)) return;

    candidates.push({
      fuelFractions,
      gemFraction,
      cost: Number.isFinite(opt.cost) ? opt.cost : Infinity,
      rawTime: Number.isFinite(opt.rawTime) ? opt.rawTime : Infinity,
      timeFraction,
      timeSeconds: opt.actualTime,
      yieldEntries,
      legendaryEntries,
      cap,
      index,
    });
  });

  candidates.sort((a, b) => cmpKey(a, b) || a.index - b.index);
  const groups: Group[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (i > 0 && cmpKey(candidates[i - 1], cand) === 0) {
      groups[groups.length - 1].members.push(cand.index);
      continue;
    }
    const yieldByItem = new Array<number>(items.length).fill(0);
    for (const [item, qty] of cand.yieldEntries) yieldByItem[itemIndex.get(item)!] = qty;
    const legendaryByTarget = targets.map(t => {
      const hit = cand.legendaryEntries.find(e => e[0] === t);
      return hit ? hit[1] : 0;
    });
    groups.push({
      fuelFractions: cand.fuelFractions,
      gemFraction: cand.gemFraction,
      timeFraction: cand.timeFraction,
      timeSeconds: cand.timeSeconds,
      yieldByItem,
      legendaryByTarget,
      cap: cand.cap,
      members: [cand.index],
    });
  }
  // Cheapest member first: it is the one `emit` launches. Gem cost, then budgeted seconds (members share
  // a `timeFraction`, which two durations an ulp apart can), then raw duration (the same budget, finished
  // sooner), then index for a total order. The group's seconds are then its representative's, so the
  // time the plan is optimized under is the time of the launch it exports (SOL-25).
  const byIndex = new Map(candidates.map(c => [c.index, c]));
  for (const grp of groups) {
    grp.members.sort((a, b) => {
      const ca = byIndex.get(a)!;
      const cb = byIndex.get(b)!;
      return (
        cmpNumber(ca.cost, cb.cost) ||
        cmpNumber(ca.timeSeconds, cb.timeSeconds) ||
        cmpNumber(ca.rawTime, cb.rawTime) ||
        a - b
      );
    });
    grp.timeSeconds = byIndex.get(grp.members[0])!.timeSeconds;
  }

  // Dropped before `craftUpperBounds`, which counts every group at its cap: fewer groups only tightens a
  // bound that stays an over-statement of what the remaining ones can supply.
  const kept = pruneDominated(groups, timeCap);

  return {
    sortedTargets: targets,
    requestedOrder,
    craftables,
    items,
    consRows,
    craftChildren,
    baseInventoryByItem,
    Qs,
    targetCraftIdx,
    slots,
    fuelAxes: axes,
    timeCapacitySeconds: timeCap,
    gemBudget,
    craftCaps: craftUpperBounds(dag, targets, craftables, craftIndex, items, itemIndex, baseInventoryByItem, kept),
    craftPrices,
    craftBudgetCapacity,
    groups: kept,
  };
}
