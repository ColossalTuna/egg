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

export const useHumilityMissionsStore = defineStore('humilityMissions', () => {
  const file = ref<HumilityMissionsFile | null>(null);
  const drift = ref<FuelDrift[]>([]);
  const warningsByVisit = ref<Record<string, string[]>>({});

  function load(json: unknown) {
    file.value = parseHumilityMissions(json);
    drift.value = [];
    warningsByVisit.value = {};
  }

  function clear() {
    file.value = null;
    drift.value = [];
    warningsByVisit.value = {};
  }

  const stagedTags = computed(() => {
    const tags = new Set<string>();
    for (const action of useActionsStore().actions) {
      if (action.sourceTag) tags.add(action.sourceTag);
    }
    return tags;
  });

  function isStaged(visit: HumilityMissionsVisit): boolean {
    return stagedTags.value.has(humilitySourceTag(visit.visitId));
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
    drift.value = fuelDrift(visit, fuelForLaunches(resolveLaunches(visit)));
    warningsByVisit.value = { ...warningsByVisit.value, [visit.visitId]: replacement.warnings };
  }

  return { file, drift, load, clear, isStaged, warningsFor, stage };
});
