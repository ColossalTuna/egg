// Independent evaluator: given a problem instance and an integer allocation
// of launches, compute the legendary probability from first principles.
//
// The model implemented here is derived ONLY from the optimizer's public
// contract (the documented objective in optimizer-core's header comment and
// the types in types.ts), never from its implementation:
//
//   inventory_u = baseYield_u + sum_i k_i * yield_i[u]
//   crafts      = argmax of an LP over the recipe DAG:
//                   maximize sum_T Q_T * c_T
//                   s.t. for every ingredient u:
//                     consumption(u) - produced(u) <= inventory_u
//   Q_T         = -ln(1 - legendaryCraftProbability_T)
//   drops_T     = sum_i k_i * legendaryYield_i[T]
//   score       = LP optimum + sum_T drops_T
//   probability = 1 - exp(-score)
//
// Two evaluation paths share one LP template per instance: a float simplex
// for cheaply ranking the thousands of candidate allocations the brute-force
// search visits, and an exact BigInt-rational simplex for the numbers that
// are actually asserted or reported. The calibration probes in the spec
// cross-check this model against the optimizer's outputs on instances whose
// optimum is unambiguous; a mismatch there means the oracle's reading of the
// contract diverged and the whole comparison is void.

import type { LaunchOption, RecipeDAG } from '../lib/types';
import { Frac } from './rational';
import { simplexMaximize, simplexMaximizeFloat } from './simplex';

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
  // Only meaningful for single-target instances, where the LP objective has a
  // single term and the craft count is recoverable from the optimum value.
  expectedCrafts: number | null;
}

export function targetQ(inst: OracleInstance, target: string): number {
  const node = inst.dag.get(target);
  if (!node) {
    throw new Error(`target ${target} missing from DAG`);
  }
  return -Math.log(1 - node.legendaryCraftProbability);
}

// LP structure shared by every allocation of one instance: only the
// right-hand side (the inventory) changes with the allocation.
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

// Cheap ranking path: float LP, exact enough (~1e-9) to order candidates
// whose gaps are asserted at 1e-3 scale. Returns the score only.
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
