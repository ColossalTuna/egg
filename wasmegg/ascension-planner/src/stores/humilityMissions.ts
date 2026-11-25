// Keeps the loaded file for this tab and applies validated visit replacements.

import { ei } from 'lib';

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  assessFile,
  fuelDrift,
  parseHumilityMissions,
  resolveLaunches,
  type FileAssessment,
  type FuelDrift,
  type HumilityMissionsFile,
  type HumilityMissionsVisit,
  type PlanVisitState,
} from '@/lib/humilityMissions';
import { fuelForLaunches } from 'lib/planners/rockets/launches';
import { humilitySourceTag, importPlanState, stageHumilityVisit, type StageOptions } from '@/lib/humilityMissionsStage';
import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { useActionsStore } from './actions';
import { useInitialStateStore } from './initialState';
import { computeSnapshot } from 'lib/planners/engine/compute';

export const useHumilityMissionsStore = defineStore('humilityMissions', () => {
  const file = ref<HumilityMissionsFile | null>(null);
  const drift = ref<FuelDrift[]>([]);
  /** What the last staging warned about, e.g. an FTL level that differs from the solve's. */
  const warnings = ref<string[]>([]);

  function load(json: unknown) {
    file.value = parseHumilityMissions(json);
    drift.value = [];
    warnings.value = [];
  }

  function clear() {
    file.value = null;
    drift.value = [];
    warnings.value = [];
  }

  /** The plan's Humility visits and the inputs it gives each, as the file is checked against them. */
  const planState = computed<PlanVisitState>(() => {
    const actionsStore = useActionsStore();
    return importPlanState(
      actionsStore.actions,
      getSimulationContext(),
      createBaseEngineState(actionsStore._initialSnapshot)
    );
  });

  /** Which of the file's visits can be staged, and why not for the rest. */
  const assessment = computed<FileAssessment | null>(() =>
    file.value ? assessFile(file.value, planState.value) : null
  );

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
    warnings.value = replacement.warnings;
  }

  return { file, drift, warnings, planState, assessment, load, clear, isStaged, stage };
});
