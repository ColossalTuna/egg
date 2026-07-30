export * from './artifacts';
export * from './missions';
export * from './loot';
export * from './optimizer-views';
export * from './optimizer-tree';
export * from './tank-ids';

import type { DAGNode, OptimizerConfig, OptimizerSolution, RecipeDAG } from './types';
import { enumerateLaunchOptions, generateRecipeDag } from './phases';
import { optimizeFull } from './optimizer-core';
import { buildConservationPolytope } from './value-function';
import { finalizeSolutions } from './optimizer-views';
import { ei, getArtifactTierPropsFromId, getCraftingInfoFromLevel, Inventory, InventoryItem, ShipsConfig } from 'lib';

// An undefined previousCraftsOverride means "read each target's own crafted
// count from the save"; a defined one applies to every target.
export function buildRecipeDag(
  desiredArtifactNodeIds: string[],
  playerLevel: number,
  playerInventory?: Inventory | null,
  previousCraftsOverride?: number
): Map<string, DAGNode> {
  const recipeDag = new Map<string, DAGNode>();

  for (const artifact of desiredArtifactNodeIds) {
    generateRecipeDag(artifact, recipeDag);
    const artifactProps = getArtifactTierPropsFromId(artifact);
    const artifactItem = new InventoryItem(artifactProps.afx_id, artifactProps.afx_level);
    const artifactDagNode = recipeDag.get(artifact)!;
    const previousCrafts =
      previousCraftsOverride !== undefined
        ? previousCraftsOverride
        : playerInventory
          ? playerInventory.getItem({ name: artifactProps.afx_id, level: artifactProps.afx_level }).crafted
          : 0;

    // craftChance returns a percentage value, not a raw probability
    artifactDagNode.legendaryCraftProbability =
      artifactItem.craftChance(
        getCraftingInfoFromLevel(playerLevel).rarityMult,
        ei.ArtifactSpec.Rarity.LEGENDARY,
        previousCrafts
      ) / 100.0;
  }

  return recipeDag;
}

// Counted across all rarities: this is "copies you can feed a recipe", never
// "you already own a legendary". See OPTIMIZER.md.
export function computeBaseYield(
  playerInventory: Inventory | null | undefined,
  desiredArtifactNodeIds: string[],
  recipeDag: Map<string, DAGNode>
) {
  const baseYield = new Map<string, number>();

  if (playerInventory) {
    // The nodes carrying a conservation row are exactly the consumed ones, so
    // this reads the LP's own parent relation instead of re-deriving it.
    const consumed = new Set(buildConservationPolytope(recipeDag).constraintNodes);
    const unconsumedTargets = new Set(desiredArtifactNodeIds.filter(id => !consumed.has(id)));

    for (const nodeId of recipeDag.keys()) {
      if (unconsumedTargets.has(nodeId)) continue;
      const props = getArtifactTierPropsFromId(nodeId);
      const item = playerInventory.getItem({ name: props.afx_id, level: props.afx_level });
      const total = item.have;
      if (total > 0) baseYield.set(nodeId, total);
    }
  }

  return baseYield;
}

// Returns an array though today it's always one solution.
export function optimize(
  config: OptimizerConfig,
  playerConfig: ShipsConfig,
  dag: RecipeDAG,
  baseYield: Map<string, number>,
  launchPeriodSeconds = 0,
  maxGemCost?: number
) {
  const { desiredArtifactNodeIds, fuelTankCapacity, timeBudgetSeconds } = config;
  const options = enumerateLaunchOptions(playerConfig, dag, launchPeriodSeconds, maxGemCost);

  const solutions: OptimizerSolution[] = [
    optimizeFull({
      options,
      recipeDag: dag,
      desiredArtifactNodeIds: desiredArtifactNodeIds,
      fuelCapacity: fuelTankCapacity,
      timeCapacity: timeBudgetSeconds,
      baseYield: baseYield,
    }),
  ];

  return finalizeSolutions(solutions, dag);
}

export type {
  OptimizerConfig,
  OptimizerSolution,
  LaunchOption,
  LaunchSolution,
  DropRow,
  DAGNode,
  DAGChildRef,
  RecipeDAG,
} from './types';
