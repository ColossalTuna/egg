// Read Humility visits and their budgets from ascension-planner snapshots.
// Earnings use the visit and pre-arrival snapshots; see earningsRateOf.

import { ei, fuelTankSizes } from 'lib';
import { importedPlanName } from 'lib/planners/utils/export';

import { MAX_FTL_LEVEL, MAX_ZEROG_LEVEL } from '@/lib/missions';

import {
  AP_FTL_RESEARCH_ID,
  AP_ZEROG_RESEARCH_ID,
  NON_HUMILITY_EGG_IDS,
  type PlanSave,
  type PlanSaveAction,
  STAGED_SOURCE_TAG_PREFIX,
  SUPPORTED_PLAN_SAVE_VERSION,
} from './schema';

export interface HumilityVisit {
  // The id of the action that entered Humility: the join key AP matches on when the answer comes
  // back. Always a nonempty string, unique within the plan. An action whose id is not one (a number,
  // an empty string, or a repeat of an earlier visit's id, none of which AP itself writes) gets a
  // derived id instead; AP will not find that id in its plan and reports the visit as not stageable,
  // rather than rejecting the whole file.
  visitId: string;
  visitIndex: number;
  label: string;

  // Seconds since the epoch at which the player arrives on Humility, for looking up whether a 2x
  // mission capacity event is running then. Null when the save carries no readable ascension
  // start, in which case the visit is still planable, just undated.
  arrivalTimestamp: number | null;
  // Time the plan spends on Humility after arriving. Zero is normal and means the plan has
  // nothing scheduled there yet, which is exactly when a player comes here. The visit page takes
  // a manual budget in that case. Actions AP inserted when it staged an earlier answer (tagged
  // `humility-plan:`) are not counted, so re-loading a staged plan poses the same question again.
  plannedDurationSeconds: number;

  // Per-egg fuel in the tank at the point AP inserts the launch: the end of the visit's last
  // untagged Humility action, so a `store_fuel` / `remove_fuel` during the visit is seen. Humility
  // excluded.
  fuelByEgg: Map<ei.Egg, number>;
  // An index into `fuelTankSizes`: an integer, checked to be in range.
  tankLevel: number;
  // What the plan holds the moment it lands on Humility, which is nothing: shifting zeroes the
  // bank. Everything the visit has to spend is therefore earned during it.
  bankValue: number;
  // The rate the farm runs at on Humility, not the rate at the instant of arrival. See
  // `earningsRateOf`.
  earningsPerSecond: number;

  // The plan's epic research, checked against the game caps (FTL 0..60, Zero-G 0..10). Undefined
  // when the plan has no `epicResearchLevels` (AP omits it on a save with none bought): the save's
  // or the typed figure then applies, never a fabricated zero. A key missing from a map the plan
  // does carry is 0, the level AP stages at for that plan.
  epicResearchFTLLevel?: number;
  epicResearchZerogLevel?: number;
}

export class PlanSaveError extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

// Accept bare saves or single-plan envelopes; reject libraries.
// Validate the inner save version, independent of the envelope version.
function unwrapPlanEnvelope(json: Record<string, unknown>): Record<string, unknown> {
  if (json.type === 'plan') {
    if (!isRecord(json.data)) throw new PlanSaveError('Plan export has no `data`.');
    return json.data;
  }
  if (json.type === 'library') {
    throw new PlanSaveError(
      'That is a whole ascension-planner library, which can hold several plans. ' +
        'Export the one plan you want to solve and load that file instead.'
    );
  }
  return json;
}

export function planEnvelopeName(json: unknown): string | undefined {
  if (!isRecord(json) || json.type !== 'plan' || !isRecord(json.data)) return undefined;
  if (typeof json.name !== 'string') return undefined;
  const name = json.name.trim();
  return name === '' ? undefined : name;
}

// The label AP requires to be a nonempty string, so a filename with nothing left once its
// `.json` / `.json.gz` / `.gz` is gone falls back to this.
export const FALLBACK_PLAN_LABEL = 'ascension-plan';

export function planLabelFor(json: unknown, filename: string): string {
  return planEnvelopeName(json) ?? (importedPlanName(filename.trim()).trim() || FALLBACK_PLAN_LABEL);
}

// Validated rather than cast: the file is picked by the user and a missing `endState` further in
// would show up as a budget of NaN rather than as a message they can act on.
export function parsePlanSave(json: unknown): PlanSave {
  if (!isRecord(json)) throw new PlanSaveError('Not a plan file: expected a JSON object.');
  const save = unwrapPlanEnvelope(json);
  const { version, actions, initialState } = save;
  if (typeof version !== 'number') {
    throw new PlanSaveError('Not an ascension-planner plan file: no `version`.');
  }
  if (version !== SUPPORTED_PLAN_SAVE_VERSION) {
    throw new PlanSaveError(
      `This plan file is version ${version}; the planner here reads version ${SUPPORTED_PLAN_SAVE_VERSION}. ` +
        'Re-export it from a matching ascension-planner build.'
    );
  }
  if (!Array.isArray(actions)) throw new PlanSaveError('Plan file has no `actions` list.');
  if (!isRecord(initialState)) throw new PlanSaveError('Plan file has no `initialState`.');
  return save as unknown as PlanSave;
}

// AP writes the ascension start as a wall clock plus an IANA zone. Restated here rather than
// imported: the whole seam is two JSON documents, and this is the one calculation on the far side
// of it that has to agree. `plan-seam.spec.ts` runs this against AP's `getLocalTimestampInTimezone`
// on a shared grid of timestamps and zones to check that agreement, rather than just asserting it
// in a comment.
export function localTimestampInTimezone(dateStr: string, timeStr: string, timezone: string): number | null {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  if (![y, m, d, h, min].every(Number.isFinite)) return null;
  const guessUTC = Date.UTC(y, m - 1, d, h, min, 0);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(guessUTC));
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
    const wallClockUTC = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second')
    );
    const offsetMs = wallClockUTC - guessUTC;
    return Math.floor((guessUTC - offsetMs) / 1000);
  } catch {
    // An unrecognized timezone. The visit stays planable, just undated.
    return null;
  }
}

function ascensionStartSeconds(save: PlanSave): number | null {
  const v = save.virtueState;
  if (!v?.ascensionDate || !v.ascensionTime || !v.ascensionTimezone) return null;
  return localTimestampInTimezone(v.ascensionDate, v.ascensionTime, v.ascensionTimezone);
}

// AP always writes these as concrete non-negative numbers; a missing or unreadable one is a
// corrupt save, not a state the plan can legitimately be in. Coercing it to zero was the bug this
// guards against: a ship priced against a silently-zeroed bank or duration looks the same as a
// visit with nothing to spend, with no message telling the player their file is damaged.
function requireNumber(value: unknown, field: string, actionId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PlanSaveError(`Action "${actionId}" has an invalid ${field}.`);
  }
  return value;
}

// An epic research level the plan states, or undefined when the plan has no map at all. With no map
// AP keeps the levels it already had, so the plan says nothing (STA-10). With a map AP replaces its
// levels with it wholesale and reads a key the map lacks as 0 (humilityMissionsStage `?? 0`), so a
// missing key is level 0 here too; reading it as unknown let the explorer solve at the save's level
// while AP staged at 0 (SAT-SEAM-14).
function epicResearchLevel(save: PlanSave, id: string, max: number): number | undefined {
  const levels: unknown = save.initialState.epicResearchLevels;
  if (levels === undefined || levels === null) return undefined;
  if (!isRecord(levels)) throw new PlanSaveError('Plan file has an unreadable `epicResearchLevels`.');
  const level = levels[id];
  if (level === undefined) return 0;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > max) {
    throw new PlanSaveError(`Plan file has an invalid epic research level for ${id}: expected 0 to ${max}.`);
  }
  return level;
}

function tankLevelOf(action: PlanSaveAction): number {
  const level = requireNumber(action.endState.tankLevel, 'tankLevel', action.id);
  if (!Number.isInteger(level) || level >= fuelTankSizes.length) {
    throw new PlanSaveError(
      `Action "${action.id}" has an invalid tankLevel: expected an integer from 0 to ${fuelTankSizes.length - 1}.`
    );
  }
  return level;
}

function isStaged(action: PlanSaveAction): boolean {
  return typeof action.sourceTag === 'string' && action.sourceTag.startsWith(STAGED_SOURCE_TAG_PREFIX);
}

// See `HumilityVisit.visitId`.
function visitIdFor(action: PlanSaveAction, index: number, taken: Set<string>): string {
  const raw: unknown = action.id;
  let id = typeof raw === 'string' && raw.trim() !== '' ? raw : '';
  if (id === '' || taken.has(id)) {
    const stem = id === '' ? (typeof raw === 'number' ? `action-${raw}` : 'humility-visit') : id;
    id = `${stem}#${index + 1}`;
    for (let n = 2; taken.has(id); n++) id = `${stem}#${index + 1}-${n}`;
  }
  taken.add(id);
  return id;
}

function secondsOf(action: PlanSaveAction): number {
  return requireNumber(action.totalTimeSeconds, 'totalTimeSeconds', action.id);
}

// Shifting resets population to one. Estimate refilled-farm earnings from the maximum
// across the visit and the pre-shift snapshot, including visits with no missions yet.
function earningsRateOf(action: PlanSaveAction | undefined): number {
  // `action` is genuinely absent, not malformed, when the plan opens straight onto Humility and
  // there is no prior action to read a rate from.
  if (!action?.endState) return 0;
  return Math.max(
    requireNumber(action.endState.onlineEarnings, 'onlineEarnings', action.id),
    requireNumber(action.endState.offlineEarnings, 'offlineEarnings', action.id)
  );
}

function fuelByEggOf(action: PlanSaveAction): Map<ei.Egg, number> {
  const amounts = action.endState.fuelTankAmounts;
  const fuels = new Map<ei.Egg, number>();
  for (const [egg, id] of NON_HUMILITY_EGG_IDS) {
    fuels.set(id, requireNumber(isRecord(amounts) ? amounts[egg] : undefined, `fuelTankAmounts.${egg}`, action.id));
  }
  return fuels;
}

export function sliceHumilityVisits(save: PlanSave): HumilityVisit[] {
  // AP has no epic-research action, so epic research is fixed for the whole plan and reading it
  // off the initial state is right at every visit. `store_fuel` / `remove_fuel` do exist, which
  // is why the tank is read per visit instead.
  const ftl = epicResearchLevel(save, AP_FTL_RESEARCH_ID, MAX_FTL_LEVEL);
  const zerog = epicResearchLevel(save, AP_ZEROG_RESEARCH_ID, MAX_ZEROG_LEVEL);
  const start = ascensionStartSeconds(save);

  const takenIds = new Set<string>();
  const visits: HumilityVisit[] = [];
  let elapsed = 0;
  let current: HumilityVisit | null = null;
  let previous: PlanSaveAction | undefined;

  for (const action of save.actions) {
    const onHumility = action?.endState?.currentEgg === 'humility';

    if (onHumility && current === null) {
      const index = visits.length;
      current = {
        visitId: visitIdFor(action, index, takenIds),
        visitIndex: index,
        label: `Humility #${index + 1}`,
        arrivalTimestamp: start === null ? null : start + elapsed + secondsOf(action),
        plannedDurationSeconds: 0,
        fuelByEgg: fuelByEggOf(action),
        tankLevel: tankLevelOf(action),
        bankValue: requireNumber(action.endState.bankValue, 'bankValue', action.id),
        earningsPerSecond: Math.max(earningsRateOf(action), earningsRateOf(previous)),
        epicResearchFTLLevel: ftl,
        epicResearchZerogLevel: zerog,
      };
      visits.push(current);
    } else if (onHumility && current !== null) {
      // Time the plan already spends on Humility after arriving. The departing shift is not part
      // of the run and so is not counted, and neither is a staged answer's launch and wait.
      if (!isStaged(action)) {
        current.plannedDurationSeconds += secondsOf(action);
        current.earningsPerSecond = Math.max(current.earningsPerSecond, earningsRateOf(action));
        // AP inserts the launch after the run's last action and checks fuel there, so that is the
        // tank the solve has to budget against.
        current.fuelByEgg = fuelByEggOf(action);
      }
    } else if (!onHumility) {
      current = null;
    }

    elapsed += secondsOf(action);
    previous = action;
  }

  return visits;
}

// The visit's TOTAL gem budget: the bank on arrival plus what the farm earns over the chosen
// duration, i.e. everything the visit's launches together can spend. Clamped to the largest finite
// double, so an absurd rate or duration never becomes Infinity (written to JSON as null, which AP
// rejects).
export function gemBudgetFor(visit: HumilityVisit, durationSeconds: number): number {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const budget = visit.bankValue + visit.earningsPerSecond * seconds;
  return Number.isNaN(budget) ? visit.bankValue : Math.min(budget, Number.MAX_VALUE);
}
