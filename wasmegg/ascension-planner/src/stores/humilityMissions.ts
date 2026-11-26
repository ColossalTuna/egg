// Keeps the loaded file for this tab and applies validated visit replacements.

import { ei } from 'lib';

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  fuelDrift,
  parseHumilityMissions,
  resolveLaunches,
  type FuelDrift,
  type HumilityMissionsFile,
  type HumilityMissionsVisit,
} from '@/lib/humilityMissions';
import { fuelForLaunches } from 'lib/planners/rockets/launches';
import { humilitySourceTag, stageHumilityVisit, type StageOptions } from '@/lib/humilityMissionsStage';
import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { useActionsStore } from './actions';
import { useInitialStateStore } from './initialState';
import { computeSnapshot } from 'lib/planners/engine/compute';

export interface VisitFuelDrift extends FuelDrift {
  visitId: string;
}

/** Whether the plan holds this card's answer, another answer for the same visit, or none. */
export type StagedState = 'none' | 'this' | 'other';

// Launches as a multiset keyed by ship, duration and target, so order does not matter.
function launchKey(launches: readonly { ship: number; duration: number; targetAfxId?: number; count: number }[]) {
  const counts = new Map<string, number>();
  for (const { ship, duration, targetAfxId, count } of launches) {
    const key = `${ship}/${duration}/${targetAfxId}`;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

export const useHumilityMissionsStore = defineStore('humilityMissions', () => {
  const file = ref<HumilityMissionsFile | null>(null);
  // Kept per visit: each staging replaces only its own visit's entries.
  const driftByVisit = ref<Record<string, FuelDrift[]>>({});
  const warningsByVisit = ref<Record<string, string[]>>({});

  const drift = computed<VisitFuelDrift[]>(() =>
    Object.entries(driftByVisit.value).flatMap(([visitId, entries]) => entries.map(entry => ({ ...entry, visitId })))
  );

  function load(json: unknown) {
    file.value = parseHumilityMissions(json);
    driftByVisit.value = {};
    warningsByVisit.value = {};
  }

  function clear() {
    file.value = null;
    driftByVisit.value = {};
    warningsByVisit.value = {};
  }

  // The staged launch for each visit, keyed by its launches.
  const stagedLaunches = computed(() => {
    const launches = new Map<string, string>();
    for (const action of useActionsStore().actions) {
      if (action.sourceTag && action.type === 'launch_missions') {
        launches.set(action.sourceTag, launchKey(action.payload.missions));
      }
    }
    return launches;
  });

  function stagedState(visit: HumilityMissionsVisit): StagedState {
    const staged = stagedLaunches.value.get(humilitySourceTag(visit.visitId));
    if (staged === undefined) return 'none';
    try {
      return staged === launchKey(resolveLaunches(visit)) ? 'this' : 'other';
    } catch {
      return 'other';
    }
  }

  function isStaged(visit: HumilityMissionsVisit): boolean {
    return stagedState(visit) === 'this';
  }

  function driftFor(visitId: string): FuelDrift[] {
    return driftByVisit.value[visitId] ?? [];
  }

  function warningsFor(visitId: string): string[] {
    return warningsByVisit.value[visitId] ?? [];
  }

  async function stage(visit: HumilityMissionsVisit, options: StageOptions = {}) {
    const actionsStore = useActionsStore();
    const base = createBaseEngineState(actionsStore._initialSnapshot);
    const context = getSimulationContext();
    const replacement = stageHumilityVisit(actionsStore.actions, visit, base, context, options);
    const initialEgg = replacement.initialEgg;
    const initialSnapshot = initialEgg
      ? {
          ...(actionsStore._initialSnapshot ?? computeSnapshot(base, context, { skipEpochConversion: true })),
          currentEgg: initialEgg,
        }
      : undefined;
    if (initialEgg) {
      const initialState = useInitialStateStore();
      if (initialState.currentFarmState) {
        initialState.currentFarmState = {
          ...initialState.currentFarmState,
          eggType: ei.Egg[initialEgg.toUpperCase() as keyof typeof ei.Egg],
        };
      }
    }
    actionsStore.replaceSimulatedActions(replacement.actions, initialSnapshot);
    driftByVisit.value = {
      ...driftByVisit.value,
      [visit.visitId]: fuelDrift(visit, fuelForLaunches(resolveLaunches(visit))),
    };
    warningsByVisit.value = { ...warningsByVisit.value, [visit.visitId]: replacement.warnings };
  }

  return { file, drift, driftByVisit, load, clear, isStaged, stagedState, driftFor, warningsFor, stage };
});
