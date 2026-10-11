// Project solved visits into the humility missions file. OptimizerSolution contains Maps
// that JSON.stringify would lose; export only the fields the planner needs.

import { ei, getArtifactTierPropsFromId } from 'lib';

import type { OptimizerSolution } from '@/lib/types';

import type { HumilityVisit } from './read';
import {
  durationEnumName,
  HUMILITY_PLAN_SCHEMA,
  HUMILITY_PLAN_SCHEMA_VERSION,
  type HumilityPlanFile,
  type HumilityPlanLaunch,
  type HumilityPlanTarget,
  type HumilityPlanVisit,
  NON_HUMILITY_EGG_IDS,
  spaceshipEnumName,
  type VirtueEgg,
} from './schema';

const EGG_NAME_BY_ID = new Map<ei.Egg, VirtueEgg>(NON_HUMILITY_EGG_IDS.map(([name, id]) => [id, name]));

// Launches of the same ship, duration and target are one row: AP flies them identically, and the
// solver may reach the same option from more than one slot. Sorted on the same tuple so the file
// is a function of the plan rather than of the order the solver happened to emit its choices in.
function aggregateLaunches(solution: OptimizerSolution): { launches: HumilityPlanLaunch[]; gemCost: number } {
  const byKey = new Map<string, { sort: [number, number, number]; launch: HumilityPlanLaunch }>();
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

function targetsOf(solution: OptimizerSolution): HumilityPlanTarget[] {
  return solution.perTarget.map(target => ({
    nodeId: target.nodeId,
    targetAfxId: getArtifactTierPropsFromId(target.nodeId).afx_id,
    probability: target.bestProbability,
    expectedCrafts: target.expectedCrafts,
  }));
}

export function projectSolvedVisit(args: {
  visit: HumilityVisit;
  solution: OptimizerSolution;
  effort: string;
  gemBudget: number;
}): HumilityPlanVisit {
  const { visit, solution, effort, gemBudget } = args;
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
    gemBudget,
    effort,
  };
}

const HUMILITY_MISSIONS_FILENAME_MAX_LABEL_LENGTH = 80;

// `humility-missions-<plan>.json`, so repeated exports from different plans are told apart by name
// rather than by the browser's ` (1)` suffix. The label is made filename-safe:
// - trimmed, and each whitespace run becomes `_` (as the planner's own library export names files);
// - anything other than letters, marks and digits in any script (`\p{L}`, `\p{M}`, `\p{N}`) or
//   `.`, `_`, `-` is dropped, which covers path separators, the characters Windows reserves
//   (`: * ? " < > |`), control characters and emoji, while names in any language survive as the
//   planner wrote them;
// - runs of `_` / `-` collapse to the first one, and leading or trailing `.`, `_`, `-` are trimmed;
// - the result is capped at 80 code points, so a cut never splits a surrogate pair, and trimmed
//   again at the cut.
// A label with nothing left after that gives plain `humility-missions.json`.
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
      .replace(/[^\p{L}\p{M}\p{N}._-]/gu, '')
  );
  label = clean(Array.from(label).slice(0, HUMILITY_MISSIONS_FILENAME_MAX_LABEL_LENGTH).join(''));
  return label === '' ? 'humility-missions.json' : `humility-missions-${label}.json`;
}

export function buildHumilityPlanFile(planLabel: string, visits: HumilityPlanVisit[]): HumilityPlanFile {
  return {
    schema: HUMILITY_PLAN_SCHEMA,
    schemaVersion: HUMILITY_PLAN_SCHEMA_VERSION,
    source: 'artifact-explorer',
    generatedAt: Date.now(),
    planLabel,
    visits: [...visits].sort((a, b) => a.visitIndex - b.visitIndex),
  };
}
