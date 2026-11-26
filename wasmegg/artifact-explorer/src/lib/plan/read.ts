// Read Humility visits and their budgets from ascension-planner snapshots.
// Earnings use the visit and pre-arrival snapshots; see earningsRateOf.

import { ei } from 'lib';

import { NUM_SLOTS } from '@/lib/packing';
import {
  AP_FTL_RESEARCH_ID,
  AP_ZEROG_RESEARCH_ID,
  NON_HUMILITY_EGG_IDS,
  type PlanSave,
  type PlanSaveAction,
  SUPPORTED_PLAN_SAVE_VERSION,
} from './schema';

export interface HumilityVisit {
  // The id of the action that entered Humility. The join key AP matches on when the answer comes
  // back, and the only staleness check there is.
  visitId: string;
  visitIndex: number;
  label: string;

  // Seconds since the epoch at which the player arrives on Humility, for looking up whether a 2x
  // mission capacity event is running then. Null when the save carries no readable ascension
  // start, in which case the visit is still planable, just undated.
  arrivalTimestamp: number | null;
  // Time the plan spends on Humility after arriving. Zero is normal and means the plan has
  // nothing scheduled there yet, which is exactly when a player comes here. The visit page takes
  // a manual budget in that case.
  plannedDurationSeconds: number;

  // Per-egg fuel banked in the tank on arrival, Humility excluded.
  fuelByEgg: Map<ei.Egg, number>;
  // Humility already in the tank on arrival. Never budgeted (the farm makes Humility during the
  // visit), but it takes room in the same tank, so a full-tank budget has to leave it out.
  // Optional: a visit persisted before this field existed reads as none.
  humilityFuel?: number;
  tankLevel: number;
  // What the plan holds the moment it lands on Humility, which is nothing: shifting zeroes the
  // bank. Everything the visit has to spend is therefore earned during it.
  bankValue: number;
  // The rate the farm runs at on Humility, not the rate at the instant of arrival. See
  // `earningsRateOf`.
  earningsPerSecond: number;

  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;

  // Launches the plan itself already makes inside the visit (placed by hand in AP, not staged from
  // a humility missions file). They hold mission slots and spend gems in the same window, so the
  // answer gets only what they leave. Optional for visits persisted before these fields existed.
  committedSlotSeconds?: number;
  committedGemCost?: number;
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

export function planLabelFor(json: unknown, filename: string): string {
  return planEnvelopeName(json) ?? filename.replace(/\.json$/i, '');
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

// Humility in the tank on arrival. Older saves may lack the key, which reads as none.
function humilityFuelOf(action: PlanSaveAction): number {
  const amounts = action.endState.fuelTankAmounts;
  const amount = isRecord(amounts) ? amounts.humility : undefined;
  return amount === undefined ? 0 : requireNumber(amount, 'fuelTankAmounts.humility', action.id);
}

// AP's tag on actions it staged from a humility missions file. Those launches are a previous
// answer for this visit, which a re-solve replaces, so they do not count as committed.
function isStagedAnswer(action: PlanSaveAction): boolean {
  return typeof action.sourceTag === 'string' && action.sourceTag.startsWith('humility-plan:');
}

// Slot time and gems a launch the plan already makes takes from the visit. Slot time is the
// launch's schedule on each slot it uses (at most all of them); with no readable payload every
// slot is taken for the whole action. Gems are the action's cost, or the bank it drops by.
function committedLaunchOf(
  action: PlanSaveAction,
  previous: PlanSaveAction | undefined
): { slotSeconds: number; gems: number } {
  const payload = action.payload;
  const missions = isRecord(payload) ? payload.totalMissions : undefined;
  const schedule = isRecord(payload) ? payload.totalTimeSeconds : undefined;
  const slotSeconds =
    typeof missions === 'number' && missions >= 0 && typeof schedule === 'number' && schedule >= 0
      ? Math.min(missions, NUM_SLOTS) * schedule
      : NUM_SLOTS * secondsOf(action);
  const gems =
    typeof action.cost === 'number' && Number.isFinite(action.cost) && action.cost >= 0
      ? action.cost
      : Math.max(0, (previous?.endState?.bankValue ?? 0) - (action.endState?.bankValue ?? 0));
  return { slotSeconds: Number.isFinite(slotSeconds) ? slotSeconds : 0, gems };
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
  const ftl = save.initialState.epicResearchLevels?.[AP_FTL_RESEARCH_ID] ?? 0;
  // AP has no epic-research action, so epic research is fixed for the whole plan and reading it
  // off the initial state is right at every visit. `store_fuel` / `remove_fuel` do exist, which
  // is why the tank is read per visit instead.
  const zerog = save.initialState.epicResearchLevels?.[AP_ZEROG_RESEARCH_ID] ?? 0;
  const start = ascensionStartSeconds(save);

  const visits: HumilityVisit[] = [];
  let elapsed = 0;
  let current: HumilityVisit | null = null;
  let previous: PlanSaveAction | undefined;

  for (const action of save.actions) {
    const onHumility = action?.endState?.currentEgg === 'humility';

    if (onHumility && current === null) {
      const index = visits.length;
      current = {
        visitId: action.id,
        visitIndex: index,
        label: `Humility #${index + 1}`,
        arrivalTimestamp: start === null ? null : start + elapsed + secondsOf(action),
        plannedDurationSeconds: 0,
        fuelByEgg: fuelByEggOf(action),
        humilityFuel: humilityFuelOf(action),
        tankLevel: requireNumber(action.endState.tankLevel, 'tankLevel', action.id),
        bankValue: requireNumber(action.endState.bankValue, 'bankValue', action.id),
        earningsPerSecond: Math.max(earningsRateOf(action), earningsRateOf(previous)),
        epicResearchFTLLevel: ftl,
        epicResearchZerogLevel: zerog,
        committedSlotSeconds: 0,
        committedGemCost: 0,
      };
      visits.push(current);
    } else if (onHumility && current !== null) {
      // Time the plan already spends on Humility after arriving. The departing shift is not part
      // of the run and so is not counted.
      current.plannedDurationSeconds += secondsOf(action);
      current.earningsPerSecond = Math.max(current.earningsPerSecond, earningsRateOf(action));
      if (action.type === 'launch_missions' && !isStagedAnswer(action)) {
        const committed = committedLaunchOf(action, previous);
        current.committedSlotSeconds = (current.committedSlotSeconds ?? 0) + committed.slotSeconds;
        current.committedGemCost = (current.committedGemCost ?? 0) + committed.gems;
      }
    } else if (!onHumility) {
      current = null;
    }

    elapsed += secondsOf(action);
    previous = action;
  }

  return visits;
}

// Per-ship price limit: arrival bank plus earnings over the chosen duration, less the gems the
// plan's own launches in the visit already spend. This does not cap total spending.
export function gemBudgetFor(visit: HumilityVisit, durationSeconds: number): number {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  return Math.max(0, visit.bankValue + visit.earningsPerSecond * seconds - (visit.committedGemCost ?? 0));
}
