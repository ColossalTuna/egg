// Recipe-tree builders for the inventory and craft-chain panels. A shared
// ingredient can be reached through more than one branch; only its shallowest
// occurrence is expanded with children, and every other occurrence renders
// inline but is marked `isDuplicate` and never re-expanded, so the tree stays
// finite even over a cyclic DAG.

import type { Inventory } from 'lib';
import { getArtifactTierPropsFromId, iconURL } from 'lib';
import type { OptimizerSolution, RecipeDAG } from './types';

export interface RecipeTreeNode<M> {
  nodeId: string;
  name: string;
  iconUrl: string;
  depth: number;
  qtyPerParentCraft: number;
  isLeaf: boolean;
  isDuplicate: boolean; // true = not the canonical (shallowest) occurrence
  metrics: M;
  children: RecipeTreeNode<M>[]; // empty for leaves AND duplicate occurrences
}

export interface CanonicalOccurrence {
  // shallowest depth at which each nodeId is reached from the root
  minDepth: Map<string, number>;
  // the parent nodeId (null for the root) via which that shallowest depth was reached
  canonicalParent: Map<string, string | null>;
}

// BFS from rootId: the first time a nodeId is dequeued is its shallowest
// occurrence, with depth ties broken by enqueue order.
export function computeCanonicalOccurrence(rootId: string, dag: RecipeDAG): CanonicalOccurrence {
  const minDepth = new Map<string, number>();
  const canonicalParent = new Map<string, string | null>();
  const visited = new Set<string>();
  const queue: { nodeId: string; depth: number; parentId: string | null }[] = [
    { nodeId: rootId, depth: 0, parentId: null },
  ];

  while (queue.length > 0) {
    const { nodeId, depth, parentId } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = dag.get(nodeId);
    if (!node) continue; // matches buildRecipeTree's skip of unresolved refs

    minDepth.set(nodeId, depth);
    canonicalParent.set(nodeId, parentId);

    for (const child of node.children) {
      queue.push({ nodeId: child.nodeId, depth: depth + 1, parentId: nodeId });
    }
  }

  return { minDepth, canonicalParent };
}

// DFS from rootId building the display tree. Only the canonical occurrence of
// each nodeId is expanded into children; the `expanded` set additionally
// guards against walking any nodeId's children twice, which is what protects
// against infinite recursion over a cyclic DAG.
export function buildRecipeTree<M>(
  rootId: string,
  dag: RecipeDAG,
  canonical: CanonicalOccurrence,
  metricsFor: (nodeId: string) => M
): RecipeTreeNode<M> | null {
  if (!dag.has(rootId)) return null;

  const expanded = new Set<string>();

  function build(nodeId: string, depth: number, qtyPerParentCraft: number, parentId: string | null): RecipeTreeNode<M> {
    const node = dag.get(nodeId)!;
    const props = getArtifactTierPropsFromId(nodeId);
    const isCanonical =
      depth === canonical.minDepth.get(nodeId) && parentId === (canonical.canonicalParent.get(nodeId) ?? null);
    const isDuplicate = !isCanonical;

    const shouldExpand = !isDuplicate && !expanded.has(nodeId);
    if (shouldExpand) expanded.add(nodeId);

    const children: RecipeTreeNode<M>[] = shouldExpand
      ? node.children
          .filter(child => dag.has(child.nodeId))
          .map(child => build(child.nodeId, depth + 1, child.quantity, nodeId))
      : [];

    return {
      nodeId,
      name: props.name,
      iconUrl: iconURL('egginc/' + props.icon_filename, 64),
      depth,
      qtyPerParentCraft,
      isLeaf: node.isLeaf,
      isDuplicate,
      metrics: metricsFor(nodeId),
      children,
    };
  }

  return build(rootId, 0, 1, null);
}

// Owned-inventory (all rarities) tree. A null playerInventory still builds
// the tree with zero-valued metrics, so the panel's shape is consistent.
export function computeInventoryTree(
  rootId: string,
  dag: RecipeDAG,
  playerInventory: Inventory | null
): RecipeTreeNode<{ have: number }> | null {
  const canonical = computeCanonicalOccurrence(rootId, dag);
  const metricsFor = (nodeId: string): { have: number } => {
    if (!playerInventory) return { have: 0 };
    const props = getArtifactTierPropsFromId(nodeId);
    const item = playerInventory.getItem({ name: props.afx_id, level: props.afx_level });
    return { have: item.haveRarity[0] + item.haveRarity[1] + item.haveRarity[2] + item.haveRarity[3] };
  };
  return buildRecipeTree(rootId, dag, canonical, metricsFor);
}

export interface CraftChainMetrics {
  owned: number;
  dropped: number;
  crafted: number;
  consumed: number;
}

// Units of each descendant node consumed to craft one unit of `nodeId`, summed
// over every recipe path. Memoized across the (acyclic) DAG, so there is no
// self term. Used to attribute shared components to each target below.
function recursiveConsumption(
  dag: RecipeDAG,
  nodeId: string,
  memo: Map<string, Map<string, number>>
): Map<string, number> {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const out = new Map<string, number>();
  memo.set(nodeId, out);
  const node = dag.get(nodeId);
  if (node && !node.isLeaf) {
    for (const child of node.children) {
      out.set(child.nodeId, (out.get(child.nodeId) ?? 0) + child.quantity);
      for (const [x, m] of recursiveConsumption(dag, child.nodeId, memo)) {
        out.set(x, (out.get(x) ?? 0) + child.quantity * m);
      }
    }
  }
  return out;
}

// Craft-chain breakdown tree for the probability display; consumed[B] is the
// LP-implied number of B eaten by the chosen recipes.
//
// For a multi-target solution the LP crafts a shared recursive component ONCE
// and splits it across the targets that consume it; craftPrimal/finalYieldVector
// are therefore solution-wide pooled totals. Rendering those pooled numbers
// under every target's tree would show each artifact "using" the whole pool
// (identical crafted rates for shared components). We instead attribute each
// node's pooled crafted/dropped/consumed to this target in proportion to its
// share of the total recursive demand for that node -- so the per-target
// breakdowns sum back to the pooled totals. The root target itself is never
// scaled: every craft of it rolls for its own legendary, so its full craft
// count (alpha) must drive its probability. `owned` is the player's real,
// target-independent stock and is likewise left whole. With a single target
// every share is 1, so the n=1 breakdown is unchanged.
export function computeCraftChainTree(
  solution: OptimizerSolution,
  rootId: string,
  playerInventory: Inventory | null
): RecipeTreeNode<CraftChainMetrics> | null {
  const dag = solution.recipeDag;
  if (!dag.has(rootId)) return null;

  const consumed = new Map<string, number>();
  for (const [nodeId, node] of dag) {
    if (node.isLeaf) continue;
    const crafted = solution.craftPrimal.get(nodeId) ?? 0;
    if (crafted <= 0) continue;
    for (const child of node.children) {
      consumed.set(child.nodeId, (consumed.get(child.nodeId) ?? 0) + crafted * child.quantity);
    }
  }

  // Total recursive demand for each node across every target, and this target's
  // slice of it (see the doc comment). demand_T(X) = crafts_T * (X consumed per
  // craft of T).
  const consumptionMemo = new Map<string, Map<string, number>>();
  const totalDemand = new Map<string, number>();
  for (const target of solution.perTarget) {
    for (const [x, m] of recursiveConsumption(dag, target.nodeId, consumptionMemo)) {
      totalDemand.set(x, (totalDemand.get(x) ?? 0) + target.expectedCrafts * m);
    }
  }
  const rootCrafts = solution.perTarget.find(t => t.nodeId === rootId)?.expectedCrafts ?? 0;
  const rootConsumption = recursiveConsumption(dag, rootId, consumptionMemo);
  const shareOf = (nodeId: string): number => {
    if (nodeId === rootId) return 1;
    const denom = totalDemand.get(nodeId) ?? 0;
    if (denom <= 0) return 1;
    return (rootCrafts * (rootConsumption.get(nodeId) ?? 0)) / denom;
  };

  const canonical = computeCanonicalOccurrence(rootId, dag);
  const metricsFor = (nodeId: string): CraftChainMetrics => {
    const props = getArtifactTierPropsFromId(nodeId);
    let ownedCount = 0;
    if (playerInventory) {
      const it = playerInventory.getItem({ name: props.afx_id, level: props.afx_level });
      ownedCount = it.haveRarity[0] + it.haveRarity[1] + it.haveRarity[2] + it.haveRarity[3];
    }
    const share = shareOf(nodeId);
    const dropped = Math.max(0, (solution.finalYieldVector.get(nodeId) ?? 0) - (solution.baseYield.get(nodeId) ?? 0));
    return {
      owned: ownedCount,
      dropped: dropped * share,
      crafted: (solution.craftPrimal.get(nodeId) ?? 0) * share,
      consumed: (consumed.get(nodeId) ?? 0) * share,
    };
  };

  return buildRecipeTree(rootId, dag, canonical, metricsFor);
}
