import { ei } from 'lib';
import {
  createSimAction,
  generateActionId,
  type Action,
  type ActionPayloadMap,
  type ActionType,
  type CalculationsSnapshot,
  type VirtueEgg,
} from '@/types';
import { simulate } from 'lib/planners/engine/simulate';
import { applyAction, getActionDuration } from '@/engine/apply';
import { createBaseEngineState } from 'lib/planners/engine/adapter';
import { computeSnapshot } from 'lib/planners/engine/compute';
import type { EngineState, SimulationContext } from '@/engine/types';
import { TANK_CAPACITIES } from '@/stores/fuelTank';
import { fuelForLaunches, launchCost } from 'lib/planners/rockets/launches';
import { formatDuration } from '@/lib/format';
import {
  ftlMismatchWarning,
  fuelShortfalls,
  humilityVisitInsertIndex,
  HumilityMissionsError,
  launchSchedule,
  planVisitBases,
  planVisitState,
  resolveLaunches,
  staleBasisReason,
  type HumilityMissionsVisit,
  type HumilityMissionsVisitBasis,
  type PlanVisitState,
  type ResolvedLaunch,
} from './humilityMissions';

// The `humility-plan:` prefix predates the humility missions rename and is kept so existing planner
// saves keep their staged markers.
export function humilitySourceTag(visitId: string): string {
  return `humility-plan:${visitId}`;
}

function validateTank(amounts: Record<VirtueEgg, number>, level: number): void {
  const capacity = TANK_CAPACITIES[level];
  const total = Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
  if (capacity === undefined || !Number.isFinite(total) || total > capacity + capacity * 1e-12) {
    throw new HumilityMissionsError(
      `This import would overflow the fuel tank (${total} eggs; capacity ${capacity ?? 0}).`
    );
  }
}

// Account for fuel spent between an earlier egg visit and the new launch, including
// consumption that the original simulation clamped to an empty tank.
function fuelToStore(
  actions: Action[],
  egg: VirtueEgg,
  required: number,
  insertIndex: number,
  launchIndex: number
): number {
  let needed = required;
  for (let i = launchIndex - 1; i >= insertIndex && needed > 0; i--) {
    const action = actions[i];
    if (action.type === 'store_fuel' && action.payload.egg === egg)
      needed = Math.max(0, needed - action.payload.amount);
    if (action.type === 'remove_fuel' && action.payload.egg === egg) needed += action.payload.amount;
    if (action.type === 'launch_missions') needed += action.payload.fuelConsumed[egg] ?? 0;
  }
  return Math.max(0, needed - (actions[insertIndex - 1].endState.fuelTankAmounts[egg] ?? 0));
}

/** Fuel storage is limited by the minimum free tank space until launch,
 * after accounting for earlier stores. */
function tankSpace(actions: readonly Action[]) {
  const free = actions.map(({ endState }) => {
    const stored = Object.values(endState.fuelTankAmounts).reduce((sum, amount) => sum + amount, 0);
    return (TANK_CAPACITIES[endState.tankLevel] ?? 0) - stored;
  });
  return function claim(from: number, until: number, wanted: number): number {
    let amount = wanted;
    for (let i = from; i < until; i++) amount = Math.min(amount, free[i]);
    if (!(amount > 0)) return 0;
    for (let i = from; i < until; i++) free[i] -= amount;
    return amount;
  };
}

function planFtlLevel(context: SimulationContext): number {
  return context.epicResearchLevels['afx_mission_time'] ?? 0;
}

/**
 * The launch action for a visit. `savingSeconds` is how long the plan saves for the launch's gems
 * where it goes. The window the explorer solved starts at arrival and its gem budget is the bank plus
 * what the farm earns across the window, so ships are bought as the gems come in rather than all
 * before the first goes up: the saving overlaps the missions instead of preceding them. The engine
 * charges a launch its saving time plus `totalTimeSeconds`, so once the saving time is known the
 * missions are given only what is left of the schedule after it, and the launch lasts the longer of
 * the two. An approximation in the explorer's favour: the last ship bought still has to fly.
 */
function launchPayload(launches: ResolvedLaunch[], context: SimulationContext, makespanSeconds?: number) {
  const schedule = launchSchedule(launches, planFtlLevel(context), makespanSeconds);
  return {
    payload: {
      missions: launches.map(launch => ({ ...launch })),
      // The full schedule until the saving time is known; see `stageHumilityVisit`.
      totalTimeSeconds: schedule.totalSeconds,
      totalMissions: schedule.totalMissions,
      fuelConsumed: fuelForLaunches(launches),
    },
    cost: launchCost(launches),
    scheduleSeconds: schedule.totalSeconds,
  };
}

/** How long a launch spends saving for its gems after `previous`, on whatever set is on there. */
function savingSecondsFor(launch: Action, previous: CalculationsSnapshot, context: SimulationContext): number {
  const probe = { ...launch, payload: { ...(launch.payload as object), totalTimeSeconds: 0 } } as Action;
  return getActionDuration(probe, previous, context);
}

/** Absorb the saving: the launch lasts max(saving, schedule). */
function absorbed(launch: Action, scheduleSeconds: number, previous: CalculationsSnapshot, context: SimulationContext) {
  const saving = savingSecondsFor(launch, previous, context);
  return saving + Math.max(0, scheduleSeconds - saving);
}

// The launch is priced at the earnings rate of whichever set is on when it goes. The elr set lays
// eggs faster but can earn thousands of times less offline, so a launch the explorer budgeted
// against the earnings set can spend weeks saving under elr; swapping just for the launch is only
// offered when both sets are known and the plan is on elr at that point.
function canSwapToEarningsSet(previous: CalculationsSnapshot): boolean {
  return previous.activeArtifactSet === 'elr' && previous.artifactSets.earnings !== null;
}

export interface LaunchDurations {
  seconds: number;
  /** Absent when no swap can be offered. */
  withEarningsSet?: number;
}

/** How long the visit's launch would take from where it will be inserted, on each set. */
export function previewLaunchDurations(
  actions: readonly Action[],
  visit: HumilityMissionsVisit,
  context: SimulationContext
): LaunchDurations | null {
  const tag = humilitySourceTag(visit.visitId);
  const untagged = actions.filter(action => action.sourceTag !== tag);
  const launchIndex = humilityVisitInsertIndex(untagged, visit.visitId);
  if (launchIndex === null || launchIndex === 0) return null;
  const previous = untagged[launchIndex - 1].endState;
  const launches = resolveLaunches(visit);
  if (launches.length === 0) return null;
  const { payload, cost, scheduleSeconds } = launchPayload(launches, context, visit.makespanSeconds);
  const launch = createSimAction('launch_missions', payload, cost);
  const durations: LaunchDurations = { seconds: absorbed(launch, scheduleSeconds, previous, context) };
  if (canSwapToEarningsSet(previous)) {
    const swapped = applyAction(
      createBaseEngineState(previous),
      createSimAction('equip_artifact_set', { setName: 'earnings' })
    );
    durations.withEarningsSet = absorbed(
      launch,
      scheduleSeconds,
      computeSnapshot(swapped, context, { skipEpochConversion: true }),
      context
    );
  }
  return durations;
}

export interface StageOptions {
  /** Equip the earnings set for the launch and put the elr set back after it. */
  equipEarningsSet?: boolean;
}

/** Build and validate a replacement without mutating the live plan. */
export function stageHumilityVisit(
  original: Action[],
  visit: HumilityMissionsVisit,
  base: EngineState,
  context: SimulationContext,
  options: StageOptions = {}
): StageResult {
  const tag = humilitySourceTag(visit.visitId);
  let actions = simulate(
    original.filter(action => action.sourceTag !== tag),
    context,
    base
  );
  let launchIndex = humilityVisitInsertIndex(actions, visit.visitId);
  if (launchIndex === null)
    throw new HumilityMissionsError(`This plan no longer has the visit ${visit.label} was solved for.`);
  // The plan must still pose the question the file answers. Either the plan without this visit's
  // staging (a first stage or a restage of the same file) or the plan as it stands (a file exported
  // from the staged plan) will do.
  const stale = staleBasisReason(visit, basesFor(visit.visitId, [actions, original]));
  if (stale) throw new HumilityMissionsError(stale);

  const warnings: string[] = [];
  const ftlWarning = ftlMismatchWarning(visit, planFtlLevel(context));
  if (ftlWarning) warnings.push(ftlWarning);

  const launches = resolveLaunches(visit);
  // Nothing to launch: staging is only the removal of an earlier staging of this visit.
  if (launches.length === 0) return { actions, warnings };

  let arrivalIndex = actions.findIndex(action => action.id === visit.visitId);
  let previous = actions[launchIndex - 1].endState;
  const required = fuelForLaunches(launches);
  // Check capacity before expanding launches. Humility is produced on the farm
  // and needs no tank space, matching stores/rockets.ts isOverBudget.
  validateTank({ ...required, humility: 0 }, previous.tankLevel);

  let initialEgg: VirtueEgg | undefined;
  if (arrivalIndex === 0 && actions[0].type === 'start_ascension') {
    initialEgg = fuelShortfalls(required, previous.fuelTankAmounts).find(fuel => fuel.egg !== 'humility')?.egg;
    if (initialEgg) {
      const start = actions[0];
      const initialFarmState = start.payload.initialFarmState;
      const fuelStart: Action<'start_ascension'> = {
        ...start,
        id: generateActionId(),
        payload: {
          ...start.payload,
          initialEgg,
          ...(initialFarmState && {
            initialFarmState: { ...initialFarmState, eggType: ei.Egg[initialEgg.toUpperCase() as keyof typeof ei.Egg] },
          }),
        },
      };
      // Keep the visit id on its new incoming shift so exports and restaging still find it.
      const arrival = {
        ...createSimAction('shift', { fromEgg: initialEgg, toEgg: 'humility', newShiftCount: 0 }),
        id: visit.visitId,
        timestamp: Date.now(),
      };
      base = { ...base, currentEgg: initialEgg };
      actions = simulate([fuelStart, arrival, ...actions.slice(1)], context, base);
      arrivalIndex = 1;
      launchIndex = humilityVisitInsertIndex(actions, visit.visitId)!;
      previous = actions[launchIndex - 1].endState;
    }
  }

  const insertions = new Map<number, Action[]>();
  const timestamp = Date.now();
  function action<T extends ActionType>(type: T, payload: ActionPayloadMap[T], cost = 0): Action<T> {
    return { ...createSimAction(type, payload, cost), id: generateActionId(), timestamp, sourceTag: tag };
  }
  function insert(index: number, additions: Action[]): void {
    insertions.set(index, [...(insertions.get(index) ?? []), ...additions]);
  }
  /** Weaves the pending insertions, indexed against `source`, into it, and takes them. */
  function weave(source: Action[]): Action[] {
    const candidate: Action[] = [];
    for (let i = 0; i <= source.length; i++) {
      candidate.push(...(insertions.get(i) ?? []));
      if (i < source.length) candidate.push(source[i]);
    }
    insertions.clear();
    return candidate;
  }

  // Only the four eggs that have to be tanked. A store is how fuel for an egg the farm is not
  // producing at launch time gets into the tank, so each one is placed in that egg's own visit;
  // Humility needs none, because the farm is producing Humility right up to the launch.
  const claim = tankSpace(actions);
  for (const { egg } of fuelShortfalls(required, previous.fuelTankAmounts)) {
    if (egg === 'humility') continue;
    let eggIndex = arrivalIndex - 1;
    while (eggIndex >= 0 && actions[eggIndex].endState.currentEgg !== egg) eggIndex--;
    if (eggIndex < 0) continue;
    // That search reaches back across earlier Humility launches, which hold their own fuel in the
    // tank until they go, so this visit takes only what fits the whole way from there. Storing the
    // full amount is what would overflow the earlier launch; the rest is picked up below.
    const insertIndex = eggIndex + 1;
    const wanted = fuelToStore(actions, egg, required[egg], insertIndex, launchIndex);
    const amount = claim(insertIndex - 1, arrivalIndex, wanted);
    if (amount > 0) insert(insertIndex, [action('store_fuel', { egg, amount, timeSeconds: 0 })]);
  }
  const filled = insertions.size > 0 ? simulate(weave(actions), context, base) : actions;
  arrivalIndex = filled.findIndex(step => step.id === visit.visitId);
  launchIndex = humilityVisitInsertIndex(filled, visit.visitId)!;
  previous = filled[launchIndex - 1].endState;

  // Store remaining fuel in new egg visits: shift, refill habs, then store.
  // Simulation recalculates these seed payloads against the post-shift state.
  const newPhases: Action[] = [];
  for (const { egg } of fuelShortfalls(required, previous.fuelTankAmounts)) {
    if (egg === 'humility') continue;
    newPhases.push(
      action('shift', { fromEgg: previous.currentEgg, toEgg: egg, newShiftCount: 0 }),
      action('wait_for_full_habs', {
        habCapacity: previous.habCapacity,
        ihr: previous.offlineIHR,
        currentPopulation: 1,
        totalTimeSeconds: 0,
      }),
      action('store_fuel', {
        egg,
        amount: fuelToStore(filled, egg, required[egg], arrivalIndex, launchIndex),
        timeSeconds: 0,
      })
    );
  }
  insert(arrivalIndex, newPhases);

  const { payload, cost, scheduleSeconds } = launchPayload(launches, context, visit.makespanSeconds);
  if (scheduleSeconds > visit.makespanSeconds) {
    warnings.push(
      `At this plan's mission durations the launches take ${formatDuration(scheduleSeconds)}, longer than the ` +
        `${formatDuration(visit.makespanSeconds)} the artifact explorer solved ${visit.label} for.` +
        (visit.epicResearchFTLLevel === undefined ? ' The file may have been solved at another FTL level.' : '')
    );
  }
  let launch = action('launch_missions', payload, cost);
  const swap = options.equipEarningsSet && canSwapToEarningsSet(previous);
  insert(
    launchIndex,
    swap
      ? [
          action('equip_artifact_set', { setName: 'earnings' }),
          launch,
          action('equip_artifact_set', { setName: 'elr' }),
        ]
      : [launch]
  );

  const candidate = weave(filled);
  let result = simulate(candidate, context, base);
  let launchedIndex = result.findIndex(step => step.id === launch.id);
  // Now that the state the launch goes from is known, overlap its gem saving with its missions.
  const saving = result[launchedIndex].totalTimeSeconds - payload.totalTimeSeconds;
  const missionSeconds = Math.max(0, scheduleSeconds - saving);
  if (missionSeconds !== payload.totalTimeSeconds) {
    launch = { ...launch, payload: { ...payload, totalTimeSeconds: missionSeconds } };
    candidate[candidate.findIndex(step => step.id === launch.id)] = launch;
    result = simulate(candidate, context, base);
    launchedIndex = result.findIndex(step => step.id === launch.id);
  }
  for (const step of result) validateTank(step.endState.fuelTankAmounts, step.endState.tankLevel);

  // The window runs from arrival, as the explorer's does: wait out what is left of it after the
  // launch, unless that is a rounding remainder of under a second.
  const arrivedIndex = result.findIndex(step => step.id === visit.visitId);
  const tailIndex = launchedIndex + (swap ? 2 : 1);
  let elapsed = 0;
  for (let i = arrivedIndex + 1; i < tailIndex; i++) elapsed += result[i].totalTimeSeconds;
  const remaining = visit.makespanSeconds - elapsed;
  if (!(remaining >= 1)) return { actions: result, initialEgg, warnings };
  // The rest of the window is waited out on the set the plan had on, after any swap is undone.
  const tail = simulate(
    [action('wait_for_time', { totalTimeSeconds: remaining }), ...result.slice(tailIndex)],
    context,
    result[tailIndex - 1].endState,
    tailIndex
  );
  return { actions: [...result.slice(0, tailIndex), ...tail], initialEgg, warnings };
}

export interface StageResult {
  actions: Action[];
  initialEgg?: VirtueEgg;
  /** Things the player should know about the staged visit; staging went ahead regardless. */
  warnings: string[];
}

function basesFor(visitId: string, plans: readonly (readonly Action[])[]): HumilityMissionsVisitBasis[] {
  const bases: HumilityMissionsVisitBasis[] = [];
  for (const plan of plans) {
    const basis = planVisitBases(plan).get(visitId);
    if (basis) bases.push(basis);
  }
  return bases;
}

/**
 * The plan as the import panel compares a file against it: `planVisitState`, plus, for every staged
 * visit, the basis the plan gives it without its own staging (the plan the file was solved against).
 */
export function importPlanState(actions: Action[], context: SimulationContext, base: EngineState): PlanVisitState {
  const state = planVisitState(actions);
  const bases = new Map(state.bases);
  for (const visitId of state.staged ?? []) {
    const tag = humilitySourceTag(visitId);
    try {
      const stripped = planVisitBases(
        simulate(
          actions.filter(a => a.sourceTag !== tag),
          context,
          base
        )
      ).get(visitId);
      if (stripped) bases.set(visitId, [...(bases.get(visitId) ?? []), stripped]);
    } catch {
      // A plan that does not simulate without the staging keeps its as-is basis only.
    }
  }
  return { ...state, bases };
}
