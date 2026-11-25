// File formats exchanged with ascension-planner (AP); no shared runtime.
// Ships and durations use enum names because AP and protobuf duration numbers differ
// (AP EPIC = 3, protobuf EPIC = 2). Targets use the shared numeric ei.ArtifactSpec.Name.

import { ei } from 'lib';

export const HUMILITY_MISSIONS_SCHEMA = 'eggverse.humility-plan';
export const HUMILITY_MISSIONS_SCHEMA_VERSION = 1;

// The only version of AP's plan save this reader understands.
export const SUPPORTED_PLAN_SAVE_VERSION = 1;

export type VirtueEgg = 'curiosity' | 'integrity' | 'humility' | 'resilience' | 'kindness';

// No humility key: `makeLaunchOption` in problem-inputs.ts strips it from every mission's cost.
// AP re-derives it from its own table on import.
export const NON_HUMILITY_EGG_IDS: ReadonlyArray<readonly [VirtueEgg, ei.Egg]> = [
  ['curiosity', ei.Egg.CURIOSITY],
  ['integrity', ei.Egg.INTEGRITY],
  ['resilience', ei.Egg.RESILIENCE],
  ['kindness', ei.Egg.KINDNESS],
];

// ---------------------------------------------------------------------------
// AP's plan save, narrowed to what this app reads
// ---------------------------------------------------------------------------

export interface PlanSaveEndState {
  tankLevel: number;
  fuelTankAmounts: Partial<Record<VirtueEgg, number>>;
  bankValue: number;
  onlineEarnings: number;
  offlineEarnings: number;
  currentEgg: VirtueEgg;
}

export interface PlanSaveAction {
  id: string;
  type: string;
  totalTimeSeconds: number;
  payload?: unknown;
  // Set by AP on actions it inserted when staging a humility missions file, as
  // `${STAGED_SOURCE_TAG_PREFIX}<visitId>`. Absent on everything the player added.
  sourceTag?: string;
  endState: PlanSaveEndState;
}

export interface PlanSave {
  version: number;
  initialState: {
    // AP omits the whole map on a save with no epic research bought.
    epicResearchLevels?: Record<string, number>;
  };
  virtueState?: {
    ascensionDate?: string;
    ascensionTime?: string;
    ascensionTimezone?: string;
  };
  actions: PlanSaveAction[];
}

// AP's epic research ids, as they appear in `initialState.epicResearchLevels`.
export const AP_FTL_RESEARCH_ID = 'afx_mission_time';
export const AP_ZEROG_RESEARCH_ID = 'afx_mission_capacity';

// AP's `humilitySourceTag` prefix (humilityMissionsStage.ts), marking the actions a staged visit added.
export const STAGED_SOURCE_TAG_PREFIX = 'humility-plan:';

// ---------------------------------------------------------------------------
// The humility missions file, this app's output
// ---------------------------------------------------------------------------

export interface HumilityMissionsTarget {
  nodeId: string;
  targetAfxId: ei.ArtifactSpec.Name;
  probability: number;
  expectedCrafts: number;
}

// One launch line. Aggregated on (ship, duration, targetAfxId): targeting is a first-class axis
// of the optimizer's model, so a `{ship, duration, count}` triple cannot express its answer.
export interface HumilityMissionsLaunch {
  ship: string; // ei.MissionInfo.Spaceship name
  duration: string; // ei.MissionInfo.DurationType name
  targetAfxId: ei.ArtifactSpec.Name;
  count: number;
}

// The visit inputs the explorer read off the plan when it solved, so the importer can tell whether
// the plan still poses the same question. Every figure is copied unchanged from the `HumilityVisit`
// the solve ran against; see its field docs in read.ts for what each one means.
export interface HumilityMissionsVisitBasis {
  bankValue: number;
  earningsPerSecond: number;
  tankLevel: number;
  plannedDurationSeconds: number;
  // The four tanked eggs, all present. No humility key, as for `fuelRequired`.
  fuelByEgg: Partial<Record<VirtueEgg, number>>;
}

// What `gemBudget` holds when the solve ran with no gem limit. JSON has no Infinity (it writes null,
// which AP rejects), so "unlimited" is the largest finite double: AP's number check accepts it and no
// real gem cost reaches it, so `gemCost > gemBudget` stays false.
export const GEM_BUDGET_UNLIMITED = Number.MAX_VALUE;

export interface HumilityMissionsVisit {
  // The id of the AP action that entered Humility, and the join key on import. For a plan that
  // starts on Humility, the `start_ascension` id.
  visitId: string;
  visitIndex: number;
  label: string;

  targets: HumilityMissionsTarget[];
  // For this visit only, not for the cycle: one legendary of a target satisfies the whole cycle,
  // so the product over visits would overstate the result.
  jointProbability: number;

  launches: HumilityMissionsLaunch[];

  // The busiest slot's load, with each mission floored at the effort's launch period, and the same
  // slot's load at the missions' own durations. Both at `epicResearchFTLLevel`.
  makespanSeconds: number;
  rawMakespanSeconds: number;
  // No humility key. The importer re-derives all five figures from AP's own table and treats
  // these four as a cross-check.
  fuelRequired: Partial<Record<VirtueEgg, number>>;
  // Total gem price of every launch in the visit.
  gemCost: number;
  // The TOTAL gem budget for the visit: what all of its launches together may spend, not a price cap
  // on each ship. `GEM_BUDGET_UNLIMITED` when the solve had no gem limit. Always finite.
  gemBudget: number;
  effort: string;

  // The FTL level the solve priced durations at. The importer compares it with the plan's own level
  // and warns on a mismatch. Absent in files from builds before it was written; also absent when the
  // writer was given no level and the plan carried none.
  epicResearchFTLLevel?: number;
  // The visit inputs the solve read. Absent in files from builds before it was written.
  basis?: HumilityMissionsVisitBasis;
}

export interface HumilityMissionsFile {
  schema: typeof HUMILITY_MISSIONS_SCHEMA;
  schemaVersion: number;
  source: 'artifact-explorer';
  generatedAt: number;
  planLabel: string;
  visits: HumilityMissionsVisit[];
}

// ---------------------------------------------------------------------------
// Enum names
// ---------------------------------------------------------------------------

export function spaceshipEnumName(ship: ei.MissionInfo.Spaceship): string {
  const name = ei.MissionInfo.Spaceship[ship];
  if (name === undefined) throw new Error(`unknown spaceship ${ship}`);
  return name;
}

export function durationEnumName(duration: ei.MissionInfo.DurationType): string {
  const name = ei.MissionInfo.DurationType[duration];
  if (name === undefined) throw new Error(`unknown duration type ${duration}`);
  return name;
}
