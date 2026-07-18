// Seeded instance generator for the oracle harness.
//
// Families mix broad randomized coverage with adversarial shapes aimed at
// spots where a heuristic outer search could plausibly go wrong (leftover
// budget that only cheap options can fill, near-tied efficiencies, chunky
// indivisible costs, degenerate budgets). All numeric data is dyadic
// (representable exactly as k/4 or k/64) so the oracle's rational evaluator
// sees the instance exactly as the optimizer does.
//
// Everything is derived from the public input contract in types.ts; the
// generator knows nothing about how the optimizer searches.

import type { DAGNode, LaunchOption } from '../lib/types';
import { makeNode, makeOpt } from '../lib/spec-helpers';
import { countFeasible } from './enumerate';
import type { OracleInstance } from './evaluate';

export const FAMILIES = [
  'random-single',
  'random-multi',
  'cheap-filler',
  'near-tie',
  'chunky-knapsack',
  'edge',
] as const;
export type Family = (typeof FAMILIES)[number];

const FEASIBLE_CAP = 60_000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function dyadic(rng: Rng, lo: number, hi: number, denom = 4): number {
  return randInt(rng, Math.round(lo * denom), Math.round(hi * denom)) / denom;
}

function pick<T>(rng: Rng, items: T[]): T {
  return items[randInt(rng, 0, items.length - 1)];
}

function sample<T>(rng: Rng, items: T[], count: number): T[] {
  const pool = items.slice();
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(randInt(rng, 0, pool.length - 1), 1)[0]);
  }
  return out;
}

interface DagPlan {
  nodes: DAGNode[];
  targets: string[];
  ingredientIds: string[]; // ids options may drop (leaves + intermediates)
  targetIngredients: string[]; // ingredients reachable from some target
}

function buildDag(rng: Rng, targetCount: number): DagPlan {
  const nLeaves = randInt(rng, 2, 5);
  const nMids = randInt(rng, 0, 2);
  const leaves = Array.from({ length: nLeaves }, (_, i) => `leaf${i}`);
  const mids = Array.from({ length: nMids }, (_, i) => `mid${i}`);
  const nodes: DAGNode[] = leaves.map(id => makeNode(id, true));

  mids.forEach((id, i) => {
    // intermediates consume leaves and strictly earlier intermediates,
    // which keeps the graph acyclic by construction
    const pool = [...leaves, ...mids.slice(0, i)];
    const children = sample(rng, pool, randInt(rng, 1, Math.min(3, pool.length))).map(
      c => [c, randInt(rng, 1, 3)] as [string, number]
    );
    nodes.push(makeNode(id, false, children));
  });

  const targets: string[] = [];
  const targetIngredients = new Set<string>();
  for (let t = 0; t < targetCount; t++) {
    const id = `target${t}`;
    const pool = [...leaves, ...mids];
    let childIds = sample(rng, pool, randInt(rng, 1, Math.min(3, pool.length)));
    if (t > 0 && !childIds.some(c => targetIngredients.has(c))) {
      // force multi-target instances to fight over at least one ingredient
      childIds = [...childIds, pick(rng, [...targetIngredients])];
    }
    const children = childIds.map(c => [c, randInt(rng, 1, 4)] as [string, number]);
    nodes.push(makeNode(id, false, children, 0.05 + rng() * 0.85));
    targets.push(id);
    for (const c of childIds) {
      targetIngredients.add(c);
      const node = nodes.find(n => n.id === c);
      for (const grand of node?.children ?? []) {
        targetIngredients.add(grand.nodeId);
      }
    }
  }

  // occasionally add a decoy root: craftable, never targeted, zero legendary
  // probability — crafting it is pure waste
  if (rng() < 0.25) {
    const pool = [...leaves, ...mids];
    const children = sample(rng, pool, randInt(rng, 1, Math.min(2, pool.length))).map(
      c => [c, randInt(rng, 1, 3)] as [string, number]
    );
    nodes.push(makeNode('decoy', false, children));
  }

  return { nodes, targets, ingredientIds: [...leaves, ...mids], targetIngredients: [...targetIngredients] };
}

function yieldEntries(rng: Rng, dag: DagPlan, maxItems = 3): [string, number][] {
  const count = randInt(rng, 1, maxItems);
  const entries = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    // bias drops toward items the targets actually need, so instances are
    // rarely degenerate, while still exercising useless drops
    const pool =
      rng() < 0.75 && dag.targetIngredients.length > 0 ? dag.targetIngredients : dag.ingredientIds;
    entries.set(pick(rng, pool), dyadic(rng, 0.25, 4));
  }
  return [...entries];
}

function drawCost(
  rng: Rng,
  taken: Set<string>,
  fuelRange: [number, number],
  timeRange: [number, number]
): [number, number] {
  for (let guard = 0; guard < 200; guard++) {
    const fuel = randInt(rng, fuelRange[0], fuelRange[1]);
    const time = randInt(rng, timeRange[0], timeRange[1]);
    const key = `${fuel}:${time}`;
    if (!taken.has(key)) {
      taken.add(key);
      return [fuel, time];
    }
  }
  throw new Error('could not draw a distinct cost pair');
}

function uniqueCosts(rng: Rng, count: number, fuelRange: [number, number], timeRange: [number, number]): [number, number][] {
  const costs: [number, number][] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (costs.length < count) {
    const fuel = randInt(rng, fuelRange[0], fuelRange[1]);
    const time = randInt(rng, timeRange[0], timeRange[1]);
    const key = `${fuel}:${time}`;
    if (!seen.has(key)) {
      seen.add(key);
      costs.push([fuel, time]);
    }
    if (++guard > 200) {
      throw new Error('could not draw distinct costs');
    }
  }
  return costs;
}

function maybeBaseYield(rng: Rng, dag: DagPlan): Map<string, number> {
  const base = new Map<string, number>();
  if (rng() < 0.5) {
    for (const item of sample(rng, dag.ingredientIds, randInt(rng, 1, 3))) {
      base.set(item, dyadic(rng, 0.25, 6));
    }
  }
  return base;
}

function maybeLegendaryDrops(rng: Rng, dag: DagPlan, options: LaunchOption[]): void {
  for (const opt of options) {
    if (rng() < 0.3) {
      opt.legendaryYieldVector.set(pick(rng, dag.targets), dyadic(rng, 1 / 64, 8 / 64, 64));
    }
  }
}

function finalize(
  label: Family,
  seed: number,
  rng: Rng,
  dag: DagPlan,
  options: LaunchOption[],
  fuelCapacity: number,
  timeCapacity: number,
  baseYield: Map<string, number>
): OracleInstance | null {
  // unique (fuel, time) pairs are the precondition for mapping the solver's
  // choiceHistory back onto input options
  const costKeys = new Set(options.map(o => `${o.actualFuel}:${o.actualTime}`));
  if (costKeys.size !== options.length) {
    throw new Error(`${label} seed ${seed}: duplicate option cost pair`);
  }
  let fuel = fuelCapacity;
  let time = timeCapacity;
  for (let attempt = 0; attempt < 20; attempt++) {
    const inst: OracleInstance = {
      label,
      seed,
      options,
      dag: new Map(dag.nodes.map(n => [n.id, n])),
      targets: dag.targets,
      fuelCapacity: fuel,
      timeCapacity: time,
      baseYield,
    };
    if (countFeasible(inst, FEASIBLE_CAP) !== null) {
      return inst;
    }
    fuel = Math.max(1, Math.floor(fuel * 0.8));
    time = Math.max(1, Math.floor(time * 0.8));
  }
  return null;
}

export function generateInstance(family: Family, seed: number): OracleInstance | null {
  const rng = mulberry32(seed * 6 + FAMILIES.indexOf(family) + 1);

  switch (family) {
    case 'random-single':
    case 'random-multi': {
      const dag = buildDag(rng, family === 'random-multi' ? 2 : 1);
      const nOpts = randInt(rng, 2, 4);
      const costs = uniqueCosts(rng, nOpts, [1, 9], [1, 9]);
      const options = costs.map(([fuel, time]) => makeOpt(fuel, time, yieldEntries(rng, dag)));
      maybeLegendaryDrops(rng, dag, options);
      return finalize(
        family,
        seed,
        rng,
        dag,
        options,
        randInt(rng, 6, 30),
        randInt(rng, 6, 30),
        maybeBaseYield(rng, dag)
      );
    }

    case 'cheap-filler': {
      // one expensive workhorse plus cheap low-yield fillers; the budget is
      // deliberately not a multiple of the workhorse cost, so an optimal plan
      // must top up with fillers
      const dag = buildDag(rng, 1);
      const mainFuel = randInt(rng, 6, 9);
      const options = [
        makeOpt(mainFuel, randInt(rng, 4, 8), yieldEntries(rng, dag)),
        makeOpt(randInt(rng, 1, 2), randInt(rng, 1, 2), yieldEntries(rng, dag, 2).map(([id, q]) => [id, q / 4])),
      ];
      if (rng() < 0.5) {
        options.push(makeOpt(randInt(rng, 3, 5), randInt(rng, 2, 5), yieldEntries(rng, dag, 2)));
      }
      const remainder = randInt(rng, 1, mainFuel - 1);
      const fuelCapacity = mainFuel * randInt(rng, 2, 4) + remainder;
      maybeLegendaryDrops(rng, dag, options);
      return finalize(family, seed, rng, dag, options, fuelCapacity, randInt(rng, 15, 40), maybeBaseYield(rng, dag));
    }

    case 'near-tie': {
      // two options whose per-fuel value is (almost) identical — prime
      // territory for aggressive dual/dominance filtering to drop one that
      // the budget arithmetic still needs
      const dag = buildDag(rng, 1);
      const baseEntries = yieldEntries(rng, dag);
      const taken = new Set<string>();
      const [costA, costB, costC] = [
        drawCost(rng, taken, [2, 5], [1, 5]),
        drawCost(rng, taken, [3, 7], [1, 5]),
        drawCost(rng, taken, [1, 9], [1, 9]),
      ];
      const wobble = pick(rng, [1, 1, 1 + 1 / 64, 1 - 1 / 64]);
      const scaled = baseEntries.map(
        ([id, q]) => [id, (q * costB[0] * wobble) / costA[0]] as [string, number]
      );
      const options = [
        makeOpt(costA[0], costA[1], baseEntries),
        makeOpt(costB[0], costB[1], scaled),
        makeOpt(costC[0], costC[1], yieldEntries(rng, dag, 2)),
      ];
      return finalize(family, seed, rng, dag, options, randInt(rng, 10, 30), randInt(rng, 10, 30), maybeBaseYield(rng, dag));
    }

    case 'chunky-knapsack': {
      // large indivisible costs and a tight budget: the payoff as a function
      // of any single count is stepped, not smooth, stressing searches that
      // assume approximate concavity along an axis
      const dag = buildDag(rng, 1);
      const nOpts = randInt(rng, 3, 4);
      const costs = uniqueCosts(rng, nOpts, [3, 9], [3, 9]);
      const options = costs.map(([fuel, time]) => makeOpt(fuel, time, yieldEntries(rng, dag)));
      maybeLegendaryDrops(rng, dag, options);
      return finalize(family, seed, rng, dag, options, randInt(rng, 12, 24), randInt(rng, 12, 24), maybeBaseYield(rng, dag));
    }

    case 'edge': {
      const variant = seed % 5;
      const dag = buildDag(rng, 1);
      if (variant === 0) {
        // nothing can launch: answer comes purely from owned inventory
        const base = new Map<string, number>();
        for (const item of dag.targetIngredients) {
          if (rng() < 0.7) {
            base.set(item, dyadic(rng, 0.25, 5));
          }
        }
        return finalize(family, seed, rng, dag, [makeOpt(5, 5, yieldEntries(rng, dag))], 0, 20, base);
      }
      if (variant === 1) {
        // budgets positive but below every option's cost
        const options = [makeOpt(6, 3, yieldEntries(rng, dag)), makeOpt(4, 7, yieldEntries(rng, dag))];
        return finalize(family, seed, rng, dag, options, 3, 2, maybeBaseYield(rng, dag));
      }
      if (variant === 2) {
        // single option, budget an exact multiple of its cost
        const fuel = randInt(rng, 2, 5);
        const options = [makeOpt(fuel, randInt(rng, 1, 3), yieldEntries(rng, dag))];
        maybeLegendaryDrops(rng, dag, options);
        return finalize(family, seed, rng, dag, options, fuel * randInt(rng, 1, 8), 60, maybeBaseYield(rng, dag));
      }
      if (variant === 3) {
        // pure direct-drop option (no craftable yields at all)
        const options = [
          makeOpt(randInt(rng, 2, 4), randInt(rng, 2, 4), []),
          makeOpt(randInt(rng, 5, 8), randInt(rng, 5, 8), yieldEntries(rng, dag)),
        ];
        options[0].legendaryYieldVector.set(dag.targets[0], dyadic(rng, 2 / 64, 12 / 64, 64));
        return finalize(family, seed, rng, dag, options, randInt(rng, 8, 24), randInt(rng, 8, 24), maybeBaseYield(rng, dag));
      }
      // time budget binding, fuel effectively unconstrained
      const costs = uniqueCosts(rng, 3, [1, 3], [4, 9]);
      const options = costs.map(([fuel, time]) => makeOpt(fuel, time, yieldEntries(rng, dag)));
      return finalize(family, seed, rng, dag, options, 500, randInt(rng, 10, 25), maybeBaseYield(rng, dag));
    }
  }
}
