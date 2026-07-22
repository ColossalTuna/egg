// Display-ready view builders derived from an OptimizerSolution. The
// inventory and craft-chain hierarchies live in optimizer-tree.ts; this file
// keeps the remaining flat, non-recipe-tree presentation helpers.

import type { ei, MissionType } from 'lib';
import type { OptimizerSolution } from './types';

export interface MissionLegendaryRow {
  ship: MissionType;
  targetAfxId: ei.ArtifactSpec.Name;
  numShipsLaunched: number;
  legendaryDrops: number;
}

// Invert P(drop) = 1 - e^(-lambda); 0 outside (0, 1).
export function lambdaFromDropProbability(p: number): number {
  return p > 0 && p < 1 ? -Math.log(1 - p) : 0;
}

// Per-mission expected direct legendary drops of the targeted root.
// legendary_supply_vector is per single ship, and numShipsLaunched counts
// single ships, so the two multiply directly. Missions contributing
// essentially nothing are dropped from the breakdown.
export function computeMissionLegendaryRows(solution: OptimizerSolution, rootId: string): MissionLegendaryRow[] {
  return solution.choiceHistory
    .map(choice => ({
      ship: choice.ship,
      targetAfxId: choice.targetAfxId,
      numShipsLaunched: choice.numShipsLaunched,
      legendaryDrops: choice.numShipsLaunched * (choice.legendarySupplyVector.get(rootId) ?? 0),
    }))
    .filter(row => row.legendaryDrops > 0.0001);
}

export function legendaryCraftProbabilityOf(solution: OptimizerSolution, rootId: string): number {
  return solution.recipeDag.get(rootId)?.legendaryCraftProbability ?? 0;
}
