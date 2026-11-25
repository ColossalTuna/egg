// Project solved visits into the humility missions file. OptimizerSolution contains Maps that
// JSON.stringify would lose, so the file is a plain-data projection of it. Not every field is read by
// the planner: `targets`, `rawMakespanSeconds` and `effort` describe the answer for a reader of the
// file, and `epicResearchFTLLevel` and `basis` let the planner check the plan still matches the solve.

import { ei, getArtifactTierPropsFromId } from 'lib';

import type { OptimizerSolution } from '@/lib/types';

import type { HumilityVisit } from './read';
import {
  durationEnumName,
  GEM_BUDGET_UNLIMITED,
  HUMILITY_MISSIONS_SCHEMA,
  HUMILITY_MISSIONS_SCHEMA_VERSION,
  type HumilityMissionsFile,
  type HumilityMissionsLaunch,
  type HumilityMissionsTarget,
  type HumilityMissionsVisit,
  type HumilityMissionsVisitBasis,
  NON_HUMILITY_EGG_IDS,
  spaceshipEnumName,
  type VirtueEgg,
} from './schema';

const EGG_NAME_BY_ID = new Map<ei.Egg, VirtueEgg>(NON_HUMILITY_EGG_IDS.map(([name, id]) => [id, name]));

// Launches of the same ship, duration and target are one row: AP flies them identically, and the
// solver may reach the same option from more than one slot. Sorted on the same tuple so the file
// is a function of the plan rather than of the order the solver happened to emit its choices in.
function aggregateLaunches(solution: OptimizerSolution): { launches: HumilityMissionsLaunch[]; gemCost: number } {
  const byKey = new Map<string, { sort: [number, number, number]; launch: HumilityMissionsLaunch }>();
  let gemCost = 0;

  for (const run of solution.choiceHistory) {
    if (!(run.numShipsLaunched > 0)) continue;
    const key = `${run.ship.shipType}|${run.ship.durationType}|${run.targetAfxId}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.launch.count += run.numShipsLaunched;
    } else {
      byKey.set(key, {
        sort: [run.ship.shipType, run.ship.durationType, run.targetAfxId],
        launch: {
          ship: spaceshipEnumName(run.ship.shipType),
          duration: durationEnumName(run.ship.durationType),
          targetAfxId: run.targetAfxId,
          count: run.numShipsLaunched,
        },
      });
    }
    gemCost += run.ship.virtueGemCost * run.numShipsLaunched;
  }

  const launches = [...byKey.values()]
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2])
    .map(e => e.launch);
  return { launches, gemCost };
}

function fuelRequiredOf(solution: OptimizerSolution): Partial<Record<VirtueEgg, number>> {
  const fuel: Partial<Record<VirtueEgg, number>> = {};
  for (const [egg, amount] of solution.fuelByEgg) {
    const name = EGG_NAME_BY_ID.get(egg);
    // Humility never appears here, per `makeLaunchOption` in problem-inputs.ts. AP re-derives all five
    // figures from its own table and treats these as a cross-check, so an unexpected key here would be
    // a claim rather than a correction.
    if (name === undefined) continue;
    fuel[name] = (fuel[name] ?? 0) + amount;
  }
  for (const [name] of NON_HUMILITY_EGG_IDS) {
    fuel[name] ??= 0;
  }
  return fuel;
}

function targetsOf(solution: OptimizerSolution): HumilityMissionsTarget[] {
  return solution.perTarget.map(target => ({
    nodeId: target.nodeId,
    targetAfxId: getArtifactTierPropsFromId(target.nodeId).afx_id,
    probability: target.bestProbability,
    expectedCrafts: target.expectedCrafts,
  }));
}

// See `HumilityMissionsVisit.gemBudget`: a total, always finite. No limit (undefined or +Infinity)
// is written as GEM_BUDGET_UNLIMITED; an unreadable or negative figure as 0, so the importer's
// `gemCost > gemBudget` check flags it rather than passing it.
function gemBudgetOf(gemBudget: number | undefined): number {
  if (gemBudget === undefined || gemBudget === Infinity) return GEM_BUDGET_UNLIMITED;
  if (!(gemBudget >= 0)) return 0;
  return Math.min(gemBudget, GEM_BUDGET_UNLIMITED);
}

function basisOf(visit: HumilityVisit): HumilityMissionsVisitBasis {
  const fuelByEgg: Partial<Record<VirtueEgg, number>> = {};
  for (const [name, id] of NON_HUMILITY_EGG_IDS) fuelByEgg[name] = visit.fuelByEgg?.get(id) ?? 0;
  return {
    bankValue: visit.bankValue,
    earningsPerSecond: visit.earningsPerSecond,
    tankLevel: visit.tankLevel,
    plannedDurationSeconds: visit.plannedDurationSeconds,
    fuelByEgg,
  };
}

export function projectSolvedVisit(args: {
  visit: HumilityVisit;
  solution: OptimizerSolution;
  effort: string;
  // The visit's TOTAL gem budget the solve ran under; undefined when it ran with no gem limit.
  gemBudget: number | undefined;
  // The FTL level the solve priced durations at. Defaults to the visit's own level.
  epicResearchFTLLevel?: number;
}): HumilityMissionsVisit {
  const { visit, solution, effort } = args;
  const { launches, gemCost } = aggregateLaunches(solution);
  return {
    visitId: visit.visitId,
    visitIndex: visit.visitIndex,
    label: visit.label,
    targets: targetsOf(solution),
    jointProbability: solution.jointProbability,
    launches,
    makespanSeconds: solution.timeUnitsUsed,
    rawMakespanSeconds: solution.runningTimeSeconds,
    fuelRequired: fuelRequiredOf(solution),
    gemCost,
    gemBudget: gemBudgetOf(args.gemBudget),
    effort,
    epicResearchFTLLevel: args.epicResearchFTLLevel ?? visit.epicResearchFTLLevel,
    basis: basisOf(visit),
  };
}

const HUMILITY_MISSIONS_FILENAME_MAX_LABEL_LENGTH = 80;

export function humilityMissionsFilename(planLabel: string): string {
  const clean = (s: string) =>
    s
      .replace(/([_-])[_-]+/g, '$1')
      .replace(/^[._-]+/, '')
      .replace(/[._-]+$/, '');
  let label = clean(
    planLabel
      .trim()
      .replace(/\s+/g, '_')
      .replace(/(?<![\p{L}\p{M}\p{N}])\p{M}+/gu, '')
      .replace(/[^\p{L}\p{M}\p{N}._-]/gu, '')
  );
  label = clean(Array.from(label).slice(0, HUMILITY_MISSIONS_FILENAME_MAX_LABEL_LENGTH).join(''));
  return label === '' ? 'humility-missions.json' : `humility-missions-${label}.json`;
}

export function buildHumilityMissionsFile(planLabel: string, visits: HumilityMissionsVisit[]): HumilityMissionsFile {
  return {
    schema: HUMILITY_MISSIONS_SCHEMA,
    schemaVersion: HUMILITY_MISSIONS_SCHEMA_VERSION,
    source: 'artifact-explorer',
    generatedAt: Date.now(),
    planLabel,
    visits: [...visits].sort((a, b) => a.visitIndex - b.visitIndex),
  };
}
