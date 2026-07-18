// Independent evaluator: given a problem instance and an integer allocation
// of launches, compute the legendary probability from first principles.
//
// The model implemented here is derived ONLY from the optimizer's public
// contract (the documented objective in optimizer-core's header comment and
// the types in types.ts), never from its implementation:
//
//   inventory_u = baseYield_u + sum_i k_i * yield_i[u]
//   crafts      = argmax of an exact LP over the recipe DAG:
//                   maximize sum_T Q_T * c_T
//                   s.t. for every ingredient u:
//                     consumption(u) - produced(u) <= inventory_u
//   Q_T         = -ln(1 - legendaryCraftProbability_T)
//   drops_T     = sum_i k_i * legendaryYield_i[T]
//   score       = LP optimum + sum_T drops_T
//   probability = 1 - exp(-score)
//
// The calibration probes in the spec cross-check this model against the
// optimizer's outputs on instances whose optimum is unambiguous; a mismatch
// there means the oracle's reading of the contract diverged and the whole
// comparison is void.

import type { LaunchOption, RecipeDAG } from '../lib/types';
import { Frac } from './rational';
import { simplexMaximize } from './simplex';

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

export function evaluateAllocation(inst: OracleInstance, allocation: number[]): OracleEvaluation {
  const inv = inventoryFor(inst, allocation);

  // Craft variables: every non-leaf node.
  const craftables: string[] = [];
  for (const [id, node] of inst.dag) {
    if (!node.isLeaf) {
      craftables.push(id);
    }
  }
  const varIndex = new Map(craftables.map((id, i) => [id, i]));

  // One constraint per item consumed as an ingredient anywhere in the DAG.
  const ingredients = new Set<string>();
  for (const node of inst.dag.values()) {
    for (const child of node.children) {
      ingredients.add(child.nodeId);
    }
  }

  const A: Frac[][] = [];
  const b: Frac[] = [];
  for (const item of ingredients) {
    const row: Frac[] = new Array(craftables.length).fill(Frac.ZERO);
    for (const node of inst.dag.values()) {
      if (node.isLeaf) {
        continue;
      }
      const j = varIndex.get(node.id)!;
      for (const child of node.children) {
        if (child.nodeId === item) {
          row[j] = row[j].add(Frac.fromNumber(child.quantity));
        }
      }
    }
    const producer = varIndex.get(item);
    if (producer !== undefined) {
      row[producer] = row[producer].sub(Frac.ONE);
    }
    A.push(row);
    b.push(inv.get(item) ?? Frac.ZERO);
  }

  const c: Frac[] = new Array(craftables.length).fill(Frac.ZERO);
  for (const target of inst.targets) {
    const j = varIndex.get(target);
    if (j === undefined) {
      throw new Error(`target ${target} is not craftable`);
    }
    c[j] = c[j].add(Frac.fromNumber(targetQ(inst, target)));
  }

  const lpScore = simplexMaximize(A, b, c).toNumber();

  let drops = 0;
  inst.options.forEach((opt, i) => {
    for (const target of inst.targets) {
      drops += allocation[i] * (opt.legendaryYieldVector.get(target) ?? 0);
    }
  });

  const score = lpScore + drops;
  return {
    score,
    lpScore,
    drops,
    probability: 1 - Math.exp(-score),
    expectedCrafts: inst.targets.length === 1 ? lpScore / targetQ(inst, inst.targets[0]) : null,
  };
}
