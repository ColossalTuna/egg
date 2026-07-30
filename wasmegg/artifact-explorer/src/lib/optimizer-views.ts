// Flat display helpers derived from an OptimizerSolution; the recipe-tree
// builders live in optimizer-tree.ts.

import { getArtifactTierPropsFromId, iconURL } from 'lib';
import type { ei, MissionType } from 'lib';
import type { CraftChainMetrics, RecipeTreeNode } from './optimizer-tree';
import type { DropRow, LaunchSolution, OptimizerSolution, RecipeDAG, TargetProbability } from './types';

export interface ArtifactDisplay {
  name: string;
  iconUrl: string;
}

// The one place the artifact icon path convention lives.
export function artifactDisplay(nodeId: string, iconSize = 64): ArtifactDisplay {
  const props = getArtifactTierPropsFromId(nodeId);
  return { name: props.name, iconUrl: iconURL('egginc/' + props.icon_filename, iconSize) };
}

export interface MissionLegendaryRow {
  ship: MissionType;
  targetAfxId: ei.ArtifactSpec.Name;
  numShipsLaunched: number;
  legendaryDrops: number;
}

// One target's worth of presentation data, resolved against that target's own
// nodeId rather than the plan's primary target.
export interface TargetView {
  nodeId: string;
  name: string;
  iconUrl: string;
  perTarget: TargetProbability;
  pCraft: number;
  lambda: number;
  craftChainTree: RecipeTreeNode<CraftChainMetrics> | null;
  missionLegendarySources: MissionLegendaryRow[];
  dropDataIsSparse: boolean;
}

// Invert P(drop) = 1 - e^(-lambda); 0 outside (0, 1).
export function lambdaFromDropProbability(p: number): number {
  return p > 0 && p < 1 ? -Math.log(1 - p) : 0;
}

// Per-mission expected direct legendary drops of `rootId`.
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

function computeExpectedDrops(solution: OptimizerSolution, dag: RecipeDAG): DropRow[] {
  const totals = new Map<string, number>();

  for (const choice of solution.choiceHistory) {
    for (const [item, rate] of choice.supplyVector) {
      totals.set(item, (totals.get(item) ?? 0) + rate * choice.numShipsLaunched);
    }
  }

  const rows: DropRow[] = [];
  for (const [itemId, expected] of totals) {
    if (expected < 0.05) continue;
    rows.push({
      itemId,
      ...artifactDisplay(itemId),
      expected,
      relevant: dag.has(itemId),
    });
  }
  rows.sort((a, b) => {
    if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
    return b.expected - a.expected;
  });
  return rows;
}

function computeFuelByEgg(solution: OptimizerSolution): Map<ei.Egg, number> {
  const totals = new Map<ei.Egg, number>();

  for (const choice of solution.choiceHistory) {
    for (const [egg, rate] of choice.actualFuelByEgg) {
      totals.set(egg, (totals.get(egg) ?? 0) + rate * choice.numShipsLaunched);
    }
  }

  return totals;
}

// Presentation-only fields, applied on whichever thread produced the solution
// so the worker and synchronous paths hand back identical objects.
export function finalizeSolutions(solutions: OptimizerSolution[], dag: RecipeDAG): OptimizerSolution[] {
  for (const solution of solutions) {
    solution.choiceHistory.sort((a: LaunchSolution, b: LaunchSolution) => a.ship.shipType - b.ship.shipType);
    solution.expectedDrops = computeExpectedDrops(solution, dag);
    solution.fuelByEgg = computeFuelByEgg(solution);
  }
  return solutions;
}
