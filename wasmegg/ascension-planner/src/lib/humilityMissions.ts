// Reads the artifact explorer's humility missions files. Ships and durations cross as enum names;
// target ids use the shared protobuf enum. Fuel is derived from this app's tables.

import { ei } from 'lib';

import type { Action, VirtueEgg } from '@/types';
import { VIRTUE_EGGS } from '@/types';
import { Spaceship, DurationType, FUEL_REQUIREMENTS, getEffectiveDuration, missionName } from '@/lib/missions';
import { type Launch } from 'lib/planners/rockets/launches';

// The id predates the humility missions rename and is kept so existing exported files keep parsing.
export const HUMILITY_MISSIONS_SCHEMA = 'eggverse.humility-plan';
export const HUMILITY_MISSIONS_SCHEMA_VERSION = 1;

/**
 * The most ships one visit may launch. Far above anything a real window holds (a million of the
 * shortest mission is years of slot time), and low enough that a crafted count cannot stall the
 * schedule or the fuel arithmetic.
 */
export const MAX_SHIPS_PER_VISIT = 1_000_000;

// Appended to every "this file names something this planner does not know" message: the usual
// cause is two deployments of different ages, not a damaged file.
const VERSION_SKEW_HINT =
  ' The file may come from a newer artifact explorer than this planner: reload the planner to update it, ' +
  'or re-export the file from a matching version.';

export interface HumilityMissionsLaunch {
  ship: string;
  duration: string;
  targetAfxId: number;
  count: number;
}

/** The visit inputs the explorer read off the plan when it solved. See `planVisitBases`. */
export interface HumilityMissionsVisitBasis {
  bankValue: number;
  earningsPerSecond: number;
  tankLevel: number;
  plannedDurationSeconds: number;
  /** The four tanked eggs; no humility key. */
  fuelByEgg: Partial<Record<VirtueEgg, number>>;
}

export interface HumilityMissionsVisit {
  visitId: string;
  visitIndex: number;
  label: string;
  jointProbability: number;
  launches: HumilityMissionsLaunch[];
  makespanSeconds: number;
  fuelRequired: Partial<Record<VirtueEgg, number>>;
  gemCost: number;
  /** The TOTAL gem budget of the visit: what all of its launches together may spend. */
  gemBudget: number;
  /** The FTL level the solve priced durations at. Absent in files from older explorers. */
  epicResearchFTLLevel?: number;
  /** What the explorer read off the plan for this visit. Absent in files from older explorers. */
  basis?: HumilityMissionsVisitBasis;
}

export interface HumilityMissionsFile {
  schema: string;
  schemaVersion: number;
  source: string;
  generatedAt: number;
  planLabel: string;
  visits: HumilityMissionsVisit[];
}

export class HumilityMissionsError extends Error {}

/** Look up protobuf ship names. */
function shipByName(name: string): Spaceship | undefined {
  if (!Object.prototype.hasOwnProperty.call(Spaceship, name)) return undefined;
  const ship = (Spaceship as unknown as Record<string, number | undefined>)[name];
  return typeof ship === 'number' ? (ship as Spaceship) : undefined;
}

function shipFromName(name: unknown): Spaceship {
  if (typeof name !== 'string') throw new HumilityMissionsError(`Launch has no ship name.`);
  const ship = shipByName(name);
  if (ship === undefined) throw new HumilityMissionsError(`Unknown ship "${name}".${VERSION_SKEW_HINT}`);
  return ship;
}

/** Map durations by name: our EPIC = 3 collides with protobuf TUTORIAL. */
const DURATION_BY_NAME: Record<string, DurationType> = {
  SHORT: DurationType.SHORT,
  LONG: DurationType.LONG,
  EPIC: DurationType.EPIC,
};

function durationByName(name: string): DurationType | undefined {
  return Object.prototype.hasOwnProperty.call(DURATION_BY_NAME, name) ? DURATION_BY_NAME[name] : undefined;
}

function durationFromName(name: unknown): DurationType {
  if (typeof name !== 'string') throw new HumilityMissionsError(`Launch has no duration name.`);
  const duration = durationByName(name);
  if (typeof duration !== 'number') {
    throw new HumilityMissionsError(`Unsupported mission duration "${name}".${VERSION_SKEW_HINT}`);
  }
  return duration;
}

/** Use mission-grid labels; show unknown names until staging validates them. */
export function launchLabel(launch: HumilityMissionsLaunch): string {
  const ship = shipByName(launch.ship);
  const duration = durationByName(launch.duration);
  if (ship === undefined || duration === undefined) return `${launch.duration} ${launch.ship}`;
  return missionName(ship, duration);
}

export interface ResolvedLaunch extends Launch {
  targetAfxId: number;
}

export function resolveLaunches(visit: HumilityMissionsVisit): ResolvedLaunch[] {
  if (!Array.isArray(visit.launches)) throw new HumilityMissionsError(`Visit "${visit.label}" has no launches.`);
  let ships = 0;
  return visit.launches.map(launch => {
    if (!isRecord(launch)) throw new HumilityMissionsError(`Visit "${visit.label}" has an invalid launch.`);
    const count = launch.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      throw new HumilityMissionsError(`Visit "${visit.label}" has a launch with a count of ${launch.count}.`);
    }
    ships += count;
    if (ships > MAX_SHIPS_PER_VISIT) {
      throw new HumilityMissionsError(
        `Visit "${visit.label}" launches more than ${MAX_SHIPS_PER_VISIT.toLocaleString('en-US')} ships, ` +
          'more than any real window holds. The file is damaged or was not written by the artifact explorer.'
      );
    }
    const targetAfxId = launch.targetAfxId;
    if (
      typeof targetAfxId !== 'number' ||
      !Number.isInteger(targetAfxId) ||
      ei.ArtifactSpec.Name[targetAfxId] === undefined
    ) {
      throw new HumilityMissionsError(
        `Visit "${visit.label}" has a launch with an invalid target id (${String(targetAfxId)}).` +
          (typeof targetAfxId === 'number' && Number.isInteger(targetAfxId) ? VERSION_SKEW_HINT : '')
      );
    }
    const ship = shipFromName(launch.ship);
    const duration = durationFromName(launch.duration);
    if (!Array.isArray(FUEL_REQUIREMENTS[ship]?.[duration])) {
      throw new HumilityMissionsError(`Unsupported mission ${launch.ship} / ${launch.duration}.${VERSION_SKEW_HINT}`);
    }
    return { ship, duration, targetAfxId, count };
  });
}

export interface FuelDrift {
  egg: VirtueEgg;
  ours: number;
  theirs: number;
}

/** Compare the four exported fuel amounts with a 0.1% relative tolerance. */
const FUEL_DRIFT_TOLERANCE = 1e-3;

export function fuelDrift(visit: HumilityMissionsVisit, ours: Record<VirtueEgg, number>): FuelDrift[] {
  const drift: FuelDrift[] = [];
  for (const egg of VIRTUE_EGGS) {
    if (egg === 'humility') continue; // never in the file, by design
    const theirs = visit.fuelRequired?.[egg];
    if (theirs === undefined || !Number.isFinite(theirs)) continue;
    const scale = Math.max(Math.abs(ours[egg]), Math.abs(theirs), 1);
    if (Math.abs(ours[egg] - theirs) / scale > FUEL_DRIFT_TOLERANCE) {
      drift.push({ egg, ours: ours[egg], theirs });
    }
  }
  return drift;
}

/**
 * Find consecutive Humility action runs, keyed by their first action, as in the explorer.
 * Derive visit IDs and insertion points together so both refer to the same runs.
 */
export interface HumilityVisitRun {
  visitId: string;
  /** Index of the run's last action; the launch goes after it. */
  endIndex: number;
}

export function humilityVisitRuns(actions: readonly Action[]): HumilityVisitRun[] {
  const runs: HumilityVisitRun[] = [];
  actions.forEach((action, index) => {
    if (action.endState?.currentEgg !== 'humility') return;
    const current = runs[runs.length - 1];
    if (current && current.endIndex === index - 1) current.endIndex = index;
    else runs.push({ visitId: action.id, endIndex: index });
  });
  return runs;
}

export function humilityVisitIds(actions: readonly Action[]): string[] {
  return humilityVisitRuns(actions).map(run => run.visitId);
}

/** "H2 of 3": the visit's place in the plan as it is now, not where it was when the file was written. */
export function visitPositionLabel(visit: HumilityMissionsVisit, planVisitIds: readonly string[]): string {
  const position = planVisitIds.indexOf(visit.visitId);
  if (position < 0) return `H${visit.visitIndex + 1}`;
  return `H${position + 1} of ${planVisitIds.length}`;
}

// ---------------------------------------------------------------------------
// The visit inputs a solve read, and whether the plan still has them
// ---------------------------------------------------------------------------

/** The `sourceTag` prefix of the actions staging adds; see `humilitySourceTag`. */
export const STAGED_SOURCE_TAG_PREFIX = 'humility-plan:';

function isStagedAction(action: Action): boolean {
  return typeof action.sourceTag === 'string' && action.sourceTag.startsWith(STAGED_SOURCE_TAG_PREFIX);
}

const TANKED_EGGS = VIRTUE_EGGS.filter(egg => egg !== 'humility');

function earningsRateOf(action: Action | undefined): number {
  if (!action?.endState) return 0;
  return Math.max(action.endState.onlineEarnings ?? 0, action.endState.offlineEarnings ?? 0);
}

function tankedFuelOf(action: Action): Partial<Record<VirtueEgg, number>> {
  const fuel: Partial<Record<VirtueEgg, number>> = {};
  for (const egg of TANKED_EGGS) fuel[egg] = action.endState.fuelTankAmounts?.[egg] ?? 0;
  return fuel;
}

/**
 * Each Humility visit's basis, read off the actions' end states by the same rules the explorer's
 * `sliceHumilityVisits` (artifact-explorer src/lib/plan/read.ts) reads them off a saved plan: the
 * arrival's bank, tank level and tank; the higher of the arrival's and the previous action's earnings
 * rate, raised by any later untagged action in the run; the run's untagged time after arrival; and
 * the tank at the run's last untagged action. Staged (tagged) actions inside the run are skipped, as
 * there. A plan's saved end states are its simulated ones, so this agrees with the explorer to the bit.
 */
export function planVisitBases(actions: readonly Action[]): Map<string, HumilityMissionsVisitBasis> {
  const bases = new Map<string, HumilityMissionsVisitBasis>();
  let current: HumilityMissionsVisitBasis | null = null;
  let previous: Action | undefined;
  for (const action of actions) {
    const onHumility = action?.endState?.currentEgg === 'humility';
    if (onHumility && current === null) {
      current = {
        bankValue: action.endState.bankValue,
        earningsPerSecond: Math.max(earningsRateOf(action), earningsRateOf(previous)),
        tankLevel: action.endState.tankLevel,
        plannedDurationSeconds: 0,
        fuelByEgg: tankedFuelOf(action),
      };
      if (!bases.has(action.id)) bases.set(action.id, current);
    } else if (onHumility && current !== null) {
      if (!isStagedAction(action)) {
        current.plannedDurationSeconds += action.totalTimeSeconds ?? 0;
        current.earningsPerSecond = Math.max(current.earningsPerSecond, earningsRateOf(action));
        current.fuelByEgg = tankedFuelOf(action);
      }
    } else if (!onHumility) {
      current = null;
    }
    previous = action;
  }
  return bases;
}

// The basis crosses as JSON, which keeps doubles exactly; the tolerance is only there so a figure
// that went through different but equivalent float arithmetic is not called a change.
const BASIS_TOLERANCE = 1e-6;

function differs(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a !== b;
  return Math.abs(a - b) > BASIS_TOLERANCE * Math.max(Math.abs(a), Math.abs(b), 1);
}

/** What changed between the basis a visit was solved against and the plan's, or null if nothing did. */
export function basisDifference(solved: HumilityMissionsVisitBasis, plan: HumilityMissionsVisitBasis): string | null {
  const changes: string[] = [];
  if (solved.tankLevel !== plan.tankLevel) changes.push('the fuel tank level');
  if (differs(solved.bankValue, plan.bankValue)) changes.push('the bank on arrival');
  if (differs(solved.earningsPerSecond, plan.earningsPerSecond)) changes.push('the earnings rate');
  if (differs(solved.plannedDurationSeconds, plan.plannedDurationSeconds))
    changes.push('the time already planned on Humility');
  const fuel = TANKED_EGGS.filter(egg => differs(solved.fuelByEgg?.[egg] ?? 0, plan.fuelByEgg?.[egg] ?? 0));
  if (fuel.length > 0) changes.push(`the ${fuel.join(', ')} in the tank`);
  if (changes.length === 0) return null;
  return changes.length === 1 ? changes[0] : `${changes.slice(0, -1).join(', ')} and ${changes[changes.length - 1]}`;
}

/**
 * The plan as the import panel compares a file against it. `bases` lists, per visit, every basis
 * the plan accepts for it (the plan as it is and, once the visit is staged, the plan without that
 * staging); `staged` holds the visits that have staged actions in the plan.
 */
export interface PlanVisitState {
  ids: readonly string[];
  bases?: ReadonlyMap<string, readonly HumilityMissionsVisitBasis[]>;
  staged?: ReadonlySet<string>;
}

/** The plan's visits, staged visits and as-is bases, from its actions alone. */
export function planVisitState(actions: readonly Action[]): PlanVisitState {
  const staged = new Set<string>();
  for (const action of actions) {
    if (isStagedAction(action)) staged.add(action.sourceTag!.slice(STAGED_SOURCE_TAG_PREFIX.length));
  }
  const bases = new Map<string, HumilityMissionsVisitBasis[]>();
  for (const [id, basis] of planVisitBases(actions)) bases.set(id, [basis]);
  return { ids: humilityVisitIds(actions), bases, staged };
}

/** Why a visit's basis no longer matches the plan, or null when it does or cannot be checked. */
export function staleBasisReason(
  visit: HumilityMissionsVisit,
  candidates: readonly HumilityMissionsVisitBasis[] | undefined
): string | null {
  if (!visit.basis || !candidates || candidates.length === 0) return null;
  let first: string | null = null;
  for (const candidate of candidates) {
    const difference = basisDifference(visit.basis, candidate);
    if (difference === null) return null;
    first ??= difference;
  }
  return `The plan has changed since ${visit.label} was solved (${first}). Re-solve it in the artifact explorer and export again.`;
}

export interface FileAssessment {
  /** False when the file is not from this plan, or nothing in it still applies. */
  matches: boolean;
  /** Why it does not match; empty when it does. */
  mismatch: string;
  /** Visits that cannot be staged, with the reason. Every other visit can be. */
  reasons: Map<string, string>;
}

function toPlanState(plan: readonly string[] | PlanVisitState): PlanVisitState {
  return Array.isArray(plan) ? { ids: plan as readonly string[] } : (plan as PlanVisitState);
}

/**
 * Decide which of the file's visits can be staged into the plan.
 *
 * Identity: the visit ids must be the plan's. A file visit the plan no longer has withholds every
 * later one (the answers were solved as a sequence); a plan that shares the file's visits up to one
 * and then has a Humility visit the file does not know in that one's place is another plan (or was
 * rebuilt), and nothing in the file applies.
 *
 * Inputs: a visit carrying a `basis` is stageable only while the plan still gives it that basis.
 * A visit from an older file has no basis to check, so once an earlier visit of the same file has
 * been staged, which moves the time, gems and fuel every later visit was solved against, the later
 * ones are withheld instead.
 */
export function assessFile(file: HumilityMissionsFile, plan: readonly string[] | PlanVisitState): FileAssessment {
  const state = toPlanState(plan);
  const reasons = new Map<string, string>();
  const position = new Map(state.ids.map((id, i) => [id, i] as const));
  const fileIds = new Set(file.visits.map(visit => visit.visitId));

  if (!file.visits.some(visit => position.has(visit.visitId))) {
    for (const visit of file.visits) reasons.set(visit.visitId, 'This visit is not in the current plan.');
    return { matches: false, mismatch: 'None of its visits are in the current plan.', reasons };
  }
  // The plan follows the file up to a visit, then has a Humility visit the file does not know where
  // the file's next one was: it diverged from the plan the file was solved against.
  let followed = false;
  for (const visit of file.visits) {
    if (position.has(visit.visitId)) {
      followed = true;
      continue;
    }
    const occupant = state.ids[visit.visitIndex];
    if (followed && occupant !== undefined && !fileIds.has(occupant)) {
      for (const v of file.visits) reasons.set(v.visitId, 'The file does not come from this plan.');
      return {
        matches: false,
        mismatch: `Its ${visit.label} is not in the current plan, and a different Humility visit is in its place, so the file is not from this plan.`,
        reasons,
      };
    }
  }

  let lost = false;
  let earlierStaged = false;
  for (const visit of file.visits) {
    if (!position.has(visit.visitId)) {
      reasons.set(visit.visitId, 'This visit is no longer in the plan.');
      lost = true;
      continue;
    }
    if (lost) {
      reasons.set(visit.visitId, 'An earlier solved visit is no longer in the plan.');
      continue;
    }
    const stale = staleBasisReason(visit, state.bases?.get(visit.visitId));
    if (stale) reasons.set(visit.visitId, stale);
    else if (!visit.basis && earlierStaged)
      reasons.set(
        visit.visitId,
        'An earlier visit from this file has been staged since this one was solved, which changed the plan it was ' +
          'solved against. Re-solve it in the artifact explorer and export again.'
      );
    if (state.staged?.has(visit.visitId)) earlierStaged = true;
  }

  const anyApplies = file.visits.some(visit => position.has(visit.visitId) && !reasons.has(visit.visitId));
  const allStale = file.visits.every(
    visit => !position.has(visit.visitId) || staleBasisReason(visit, state.bases?.get(visit.visitId)) !== null
  );
  if (!anyApplies && allStale) {
    return {
      matches: false,
      mismatch: 'The plan has changed since this file was exported. Re-solve its visits in the artifact explorer.',
      reasons,
    };
  }
  return { matches: true, mismatch: '', reasons };
}

/** The visits that can be staged now. See `assessFile` for the rules. */
export function stageableVisitIds(file: HumilityMissionsFile, plan: readonly string[] | PlanVisitState): Set<string> {
  const assessment = assessFile(file, plan);
  const stageable = new Set<string>();
  if (!assessment.matches) return stageable;
  for (const visit of file.visits) if (!assessment.reasons.has(visit.visitId)) stageable.add(visit.visitId);
  return stageable;
}

/** False when the file is not from this plan, or the plan has changed under every visit in it. */
export function fileMatchesPlan(file: HumilityMissionsFile, plan: readonly string[] | PlanVisitState): boolean {
  return assessFile(file, plan).matches;
}

/** Insert after the visit's actions so their fuel and research apply; null if missing. */
export function humilityVisitInsertIndex(actions: readonly Action[], visitId: string): number | null {
  const run = humilityVisitRuns(actions).find(r => r.visitId === visitId);
  return run ? run.endIndex + 1 : null;
}

/** A warning when the explorer solved at another FTL level than the plan's, else null. */
export function ftlMismatchWarning(visit: HumilityMissionsVisit, planFtlLevel: number): string | null {
  const solved = visit.epicResearchFTLLevel;
  if (solved === undefined || solved === planFtlLevel) return null;
  return (
    `${visit.label} was solved at FTL level ${solved}; this plan has FTL level ${planFtlLevel}. ` +
    `Mission durations follow this plan's level.`
  );
}

export interface FuelShortfall {
  egg: VirtueEgg;
  amount: number;
}

/** Fuel shortfalls at the insertion point. */
export function fuelShortfalls(
  required: Record<VirtueEgg, number>,
  inTank: Partial<Record<VirtueEgg, number>>
): FuelShortfall[] {
  const shortfalls: FuelShortfall[] = [];
  for (const egg of VIRTUE_EGGS) {
    const missing = required[egg] - (inTank[egg] ?? 0);
    if (missing > 0) shortfalls.push({ egg, amount: missing });
  }
  return shortfalls;
}

// ---------------------------------------------------------------------------
// Scheduling the launches across the three slots
// ---------------------------------------------------------------------------

const NUM_SLOTS = 3;

export interface ScheduledLaunch {
  ship: Spaceship;
  duration: DurationType;
  durationSeconds: number;
  count: number;
}

export interface LaunchSchedule {
  slots: { launches: ScheduledLaunch[]; totalSeconds: number }[];
  /** The busiest slot: the time from the first launch until the last mission returns. */
  totalSeconds: number;
  totalMissions: number;
}

// Packer tolerances, relative to the capacity like the explorer's, so float summation order never
// turns an exact fit into an overflow.
const REL_EPS = 1e-9;
const REL_GRAIN = 2 ** -40;
// Work caps, in candidate splits tried. The probe at the explorer's own makespan gets a large one,
// since an arrangement there is known to exist; the bisection below it gets the explorer's.
const TARGET_PROBE_STEPS = 2_000_000;
const SEARCH_PROBE_STEPS = 50_000;
const SEARCH_PROBES = 40;
const SEARCH_ABS_GAP = 0.5;

/**
 * Exact three-slot packing of `counts[j]` missions of `durations[j]` under `capacity`, as per-slot
 * counts (`witness[j][slot]`). Null when the missions provably do not fit, undefined when the step
 * budget ran out. The same search as the explorer's `packWitness`, with each split's range cut to
 * the splits that fit and a check that the remaining load fits the remaining room.
 */
function packCounts(
  durations: number[],
  counts: number[],
  capacity: number,
  stepBudget: number
): number[][] | null | undefined {
  const eps = REL_EPS * capacity;
  const grain = REL_GRAIN * capacity;
  const cell = (load: number) => Math.round(load / grain);
  const witness = durations.map(() => [0, 0, 0]);
  const active = durations.map((_, j) => j).filter(j => counts[j] > 0 && durations[j] > 0);
  for (const j of durations.keys()) if (counts[j] > 0 && !(durations[j] > 0)) witness[j][0] = counts[j];
  active.sort((a, b) => durations[b] - durations[a]);
  for (const j of active) if (durations[j] > capacity + eps) return null;
  const suffix = new Array<number>(active.length + 1).fill(0);
  for (let t = active.length - 1; t >= 0; t--) suffix[t] = suffix[t + 1] + counts[active[t]] * durations[active[t]];
  if (suffix[0] > NUM_SLOTS * capacity + eps) return null;

  const infeasible = new Set<string>();
  let steps = 0;
  let exhausted = false;
  const search = (t: number, loads: number[], slots: number[]): boolean => {
    if (t === active.length) return true;
    if (NUM_SLOTS * capacity - loads[0] - loads[1] - loads[2] + eps < suffix[t]) return false;
    const key = `${t}#${cell(loads[0])},${cell(loads[1])},${cell(loads[2])}`;
    if (infeasible.has(key)) return false;
    const j = active[t];
    const c = counts[j];
    const d = durations[j];
    const room = (load: number) => Math.max(0, Math.floor((capacity - load + eps) / d));
    const [room0, room1, room2] = [room(loads[0]), room(loads[1]), room(loads[2])];
    // Fill the emptiest slot first: the most-even splits are tried first.
    for (let x0 = Math.min(c, room0); x0 >= Math.max(0, c - room1 - room2); x0--) {
      const rest = c - x0;
      for (let x1 = Math.min(rest, room1); x1 >= Math.max(0, rest - room2); x1--) {
        if (++steps > stepBudget) {
          exhausted = true;
          return false;
        }
        const x = [x0, x1, rest - x1];
        const next = loads.map((load, k) => load + x[k] * d);
        const order = [0, 1, 2].sort((a, b) => next[a] - next[b]);
        if (
          search(
            t + 1,
            order.map(k => next[k]),
            order.map(k => slots[k])
          )
        ) {
          for (let k = 0; k < NUM_SLOTS; k++) witness[j][slots[k]] = x[k];
          return true;
        }
        if (exhausted) return false;
      }
    }
    infeasible.add(key);
    return false;
  };
  const packs = search(0, [0, 0, 0], [0, 1, 2]);
  if (exhausted) return undefined;
  return packs ? witness : null;
}

/** Longest first into the emptiest slot. */
function lptCounts(durations: number[], counts: number[]): number[][] {
  const witness = durations.map(() => [0, 0, 0]);
  const load = [0, 0, 0];
  const order = durations.map((_, j) => j).sort((a, b) => durations[b] - durations[a]);
  for (const j of order) {
    const d = Math.max(0, durations[j]);
    for (let k = 0; k < counts[j]; k++) {
      const slot = load[0] <= load[1] ? (load[0] <= load[2] ? 0 : 2) : load[1] <= load[2] ? 1 : 2;
      load[slot] += d;
      witness[j][slot]++;
    }
  }
  return witness;
}

function slotLoads(witness: number[][], durations: number[]): number[] {
  const load = [0, 0, 0];
  witness.forEach((perSlot, j) => perSlot.forEach((n, slot) => (load[slot] += n * Math.max(0, durations[j]))));
  return load;
}

/**
 * The arrangement with the smallest busiest slot this search finds: LPT, then (when given) the
 * explorer's own makespan, then a bisection between the best so far and the lower bound. The probe
 * at `targetSeconds` is what makes this at least as good as the explorer: its packing exists at
 * that capacity, so an exact search finds one there too.
 */
function minimalCounts(durations: number[], counts: number[], targetSeconds?: number): number[][] {
  let best = lptCounts(durations, counts);
  let hi = Math.max(...slotLoads(best, durations));
  let total = 0;
  let longest = 0;
  durations.forEach((d, j) => {
    if (!(counts[j] > 0) || !(d > 0)) return;
    total += counts[j] * d;
    longest = Math.max(longest, d);
  });
  let lo = Math.max(longest, total / NUM_SLOTS);
  const gap = Math.max(REL_EPS * hi, SEARCH_ABS_GAP);
  const tryAt = (capacity: number, steps: number): number[][] | null | undefined => {
    const witness = packCounts(durations, counts, capacity, steps);
    if (witness) {
      const max = Math.max(...slotLoads(witness, durations));
      if (max < hi) {
        best = witness;
        hi = max;
      }
    }
    return witness;
  };

  // The explorer's figure is rounded to whole seconds, so allow it the half second it may have lost.
  // Once the explorer's own makespan is matched, the staged visit fits its window: stop there.
  if (targetSeconds !== undefined && Number.isFinite(targetSeconds)) {
    if (targetSeconds + SEARCH_ABS_GAP < hi) tryAt(targetSeconds + SEARCH_ABS_GAP, TARGET_PROBE_STEPS);
    if (hi <= targetSeconds + SEARCH_ABS_GAP) return best;
  }
  for (let probe = 0; probe < SEARCH_PROBES && hi - lo > gap; probe++) {
    const mid = probe === 0 ? lo : lo + (hi - lo) / 2;
    const witness = tryAt(mid, SEARCH_PROBE_STEPS);
    if (witness === undefined) break;
    if (witness === null) lo = mid;
    else hi = Math.min(hi, Math.max(Math.max(...slotLoads(witness, durations)), mid));
  }
  return best;
}

/**
 * Pack the launches into the three slots at the plan's FTL level, minimizing the busiest slot.
 *
 * Local to the import, rather than the mission grid's LPT `scheduleMissions`, because a staged visit
 * has to fit the window the explorer solved it for: given `targetSeconds` (the file's makespan), the
 * schedule is never longer than the explorer's own packing when the durations agree. A schedule that
 * lands a fraction of a second past `targetSeconds` is float noise against the explorer's rounding and
 * is reported as `targetSeconds`. Missions are grouped by duration, so the work does not grow with the
 * number of ships.
 */
export function launchSchedule(
  launches: readonly ResolvedLaunch[],
  ftlLevel: number,
  targetSeconds?: number
): LaunchSchedule {
  const groups: ScheduledLaunch[][] = [];
  const durations: number[] = [];
  const counts: number[] = [];
  let totalMissions = 0;
  for (const { ship, duration, count } of launches) {
    const durationSeconds = getEffectiveDuration(ship, duration, ftlLevel);
    totalMissions += count;
    let j = durations.indexOf(durationSeconds);
    if (j < 0) {
      j = durations.push(durationSeconds) - 1;
      counts.push(0);
      groups.push([]);
    }
    counts[j] += count;
    groups[j].push({ ship, duration, durationSeconds, count });
  }

  const witness = minimalCounts(durations, counts, targetSeconds);
  const slots = Array.from({ length: NUM_SLOTS }, () => ({ launches: [] as ScheduledLaunch[], totalSeconds: 0 }));
  witness.forEach((perSlot, j) => {
    // Hand the group's ships out to its slots in launch order.
    const queue = groups[j].map(launch => ({ ...launch }));
    perSlot.forEach((n, slot) => {
      let left = n;
      while (left > 0) {
        const head = queue[0];
        const take = Math.min(left, head.count);
        slots[slot].launches.push({ ...head, count: take });
        slots[slot].totalSeconds += take * Math.max(0, head.durationSeconds);
        head.count -= take;
        left -= take;
        if (head.count === 0) queue.shift();
      }
    });
  });
  let totalSeconds = Math.max(0, ...slots.map(slot => slot.totalSeconds));
  if (targetSeconds !== undefined && totalSeconds > targetSeconds && totalSeconds - targetSeconds < 1) {
    totalSeconds = targetSeconds;
  }
  return { slots, totalSeconds, totalMissions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, field: string, maximum = Infinity): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new HumilityMissionsError(`Invalid ${field}: expected a finite number between 0 and ${maximum}.`);
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HumilityMissionsError(`Invalid ${field}: expected a nonempty string.`);
  }
}

function requireFuel(value: unknown, field: string): void {
  if (!isRecord(value)) throw new HumilityMissionsError(`Visit has no ${field}.`);
  for (const [egg, amount] of Object.entries(value)) {
    if (!VIRTUE_EGGS.includes(egg as VirtueEgg)) throw new HumilityMissionsError(`Unknown fuel egg "${egg}".`);
    requireNumber(amount, `${egg} fuel`);
  }
}

// The two fields newer explorers add. Both optional: a file without them still loads.
function validateOptionalFields(visit: Record<string, unknown>): void {
  if (visit.epicResearchFTLLevel !== undefined) {
    requireNumber(visit.epicResearchFTLLevel, 'FTL level', 60);
    if (!Number.isInteger(visit.epicResearchFTLLevel)) throw new HumilityMissionsError('FTL level must be an integer.');
  }
  if (visit.basis !== undefined) {
    const basis = visit.basis;
    if (!isRecord(basis)) throw new HumilityMissionsError('Invalid visit basis.');
    for (const field of ['bankValue', 'earningsPerSecond', 'plannedDurationSeconds']) {
      requireNumber(basis[field], `basis ${field}`);
    }
    requireNumber(basis.tankLevel, 'basis tankLevel');
    if (!Number.isInteger(basis.tankLevel)) throw new HumilityMissionsError('Basis tank level must be an integer.');
    requireFuel(basis.fuelByEgg, 'basis fuel');
  }
}

export function parseHumilityMissions(json: unknown): HumilityMissionsFile {
  if (!isRecord(json)) {
    throw new HumilityMissionsError('Not a humility missions file: expected a JSON object.');
  }
  const file = json;
  if (file.schema !== HUMILITY_MISSIONS_SCHEMA) {
    throw new HumilityMissionsError(
      "That is not a humility missions file. Export one from the artifact explorer's mission optimizer."
    );
  }
  if (file.schemaVersion !== HUMILITY_MISSIONS_SCHEMA_VERSION) {
    throw new HumilityMissionsError(
      `This file is schema version ${file.schemaVersion}; this planner reads version ` +
        `${HUMILITY_MISSIONS_SCHEMA_VERSION}. Update one side or re-export from a matching build.`
    );
  }
  if (!Array.isArray(file.visits) || file.visits.length === 0) {
    throw new HumilityMissionsError('That humility missions file has no solved visits in it.');
  }
  if (file.source !== 'artifact-explorer') throw new HumilityMissionsError('Unknown humility missions file source.');
  requireString(file.planLabel, 'plan label');
  requireNumber(file.generatedAt, 'generation timestamp');
  const ids = new Set<string>();
  const indices = new Set<number>();
  for (const visit of file.visits) {
    if (!isRecord(visit)) throw new HumilityMissionsError('Invalid Humility visit.');
    requireString(visit.visitId, 'visit id');
    requireString(visit.label, 'visit label');
    requireNumber(visit.visitIndex, 'visit index', Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(visit.visitIndex)) throw new HumilityMissionsError('Visit index must be an integer.');
    if (ids.has(visit.visitId) || indices.has(visit.visitIndex)) {
      throw new HumilityMissionsError('Duplicate Humility visit id or index.');
    }
    ids.add(visit.visitId);
    indices.add(visit.visitIndex);
    requireNumber(visit.jointProbability, 'joint probability', 1);
    for (const field of ['makespanSeconds', 'gemCost', 'gemBudget']) requireNumber(visit[field], field);
    requireFuel(visit.fuelRequired, 'fuel requirements');
    validateOptionalFields(visit);
    resolveLaunches(visit as unknown as HumilityMissionsVisit);
  }
  return file as unknown as HumilityMissionsFile;
}
