<template>
  <div class="lg:grid lg:grid-cols-[minmax(280px,340px)_1fr] lg:gap-6 space-y-6 lg:space-y-0">
    <div class="lg:sticky lg:top-4 self-start">
      <optimizer-sidebar
        :player-id="playerId"
        :export-blocked="computing || loadingPlayer || !inputsValid || !!computeError"
        :wait-time-days="waitTimeDays"
        :time-budget-invalid="!timeBudgetValid"
        @submit-player-id="submitPlayerId"
        @update:wait-time-days="updateWaitTime"
      />
    </div>

    <div class="min-w-0 space-y-4">
      <div class="border border-gray-200 rounded-lg p-4">
        <h3 class="text-base font-semibold text-gray-700 mb-3">Best Ship Set</h3>
        <div class="relative">
          <div :class="dimSolution ? 'opacity-40 pointer-events-none transition-opacity' : ''">
            <optimizer-solution-card
              v-for="(view, i) in solutionViews"
              :key="'solution-' + i"
              :solution="view.solution"
              :max-wait-time-seconds="snapshot?.time ?? 0"
              :has-inventory="!!snapshot?.inventory"
              :golden-egg-balance="snapshot?.goldenEggs ?? null"
              :targets="view.targets"
              :plan-cost="view.planCost"
              :over-provisioned="(snapshot?.visitIndex ?? 0) > 0"
            />
            <p v-if="noAnswerMessage && !computing" role="status" class="text-sm text-amber-700">
              {{ noAnswerMessage }}
            </p>
            <p v-if="playerLoadError" role="alert" class="text-sm text-red-600">{{ playerLoadError }}</p>
            <p v-if="planSaveFailed" role="alert" class="text-sm text-red-600">
              The plan could not be saved in this browser's storage (it may be full). This tab keeps its answers, but
              answers recorded since are lost if the page is reloaded.
            </p>
            <p v-if="planChangedInAnotherTab" role="alert" class="text-sm text-amber-700">
              This plan was replaced or unloaded in another tab. This tab keeps its own copy; reload the page to follow
              the other tab instead.
            </p>
            <p v-if="loadingPlayer" role="status" class="text-sm text-gray-500">Loading the player's save…</p>
            <p
              v-else-if="computing && solutionViews.length === 0"
              role="status"
              class="flex items-center gap-2 text-sm text-gray-500"
            >
              <svg class="animate-spin h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Computing the best ship set…
            </p>
            <p v-else-if="computeError" class="text-sm text-red-600">Could not compute a plan: {{ computeError }}</p>
            <p v-else-if="solutionViews.length === 0" class="text-sm text-gray-400">
              {{ inputsValid ? 'No ship set found for the current settings.' : invalidBudgetMessage }}
            </p>
          </div>
          <div v-if="dimSolution" role="status" class="absolute inset-0 flex items-start justify-center pt-8">
            <svg class="animate-spin h-8 w-8 text-gray-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span class="sr-only">Computing the best ship set…</span>
          </div>
        </div>
      </div>

      <template v-for="target in inventoryTrees" :key="'inventory-' + target.nodeId">
        <div
          v-if="inventoryTrees.length > 1 && target.tree && playerInventory"
          class="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1"
        >
          <img :src="target.iconUrl" class="h-4 w-4 flex-shrink-0" alt="" />
          <span>{{ target.name }}</span>
        </div>
        <optimizer-inventory-panel :tree="target.tree" :has-inventory="!!playerInventory" />
      </template>

      <slot />
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, onUnmounted, PropType, ref, shallowRef, toRefs, watch } from 'vue';

import {
  formatDuration,
  getArtifactTierPropsFromId,
  getSavedPlayerID,
  iconURL,
  requestFirstContact,
  savePlayerID,
} from 'lib';

import {
  config,
  currentOptimizerArtifactIds,
  effectiveConfig,
  effectiveFuelByEggCapacity,
  effectiveFuelTankCapacity,
  effectiveMaxGemCost,
  effectiveCraftingBudget,
  costBudgetsValid,
  craftingCostInvalid,
  gemCostInvalid,
  gemCostMode,
  effectivePreviousCraftsOverride,
  effectiveCraftingLevel,
  effectiveWaitTimeSeconds,
  EFFORT_LAUNCH_PERIOD_SECONDS,
  missionFilters,
  overrides,
  playerGoldenEggs,
  playerInventory,
  playerShipsConfig,
  setPlayerData,
  setWaitTimeDays,
  type EffortLevel,
} from '@/store';
import {
  activePlanVisit,
  loadedPlan,
  clearSolvedVisit,
  planChangedInAnotherTab,
  planSaveFailed,
  recordSolvedVisit,
  retainSolvedVisitsMatching,
  setVisitWaitTime,
  waitTimeInputFor,
} from '@/store/plan';
import { formatBudgetValue } from '@/store/budget-input';
import { projectSolvedVisit } from '@/lib/plan/write';
import {
  buildRecipeDag,
  computeOwnedStock,
  computeCraftChainTree,
  computeInventoryTree,
  computeCraftUnitPrices,
  computeMissionLegendaryRows,
  computePlanCraftingCost,
  finalizeSolutions,
  lambdaFromDropProbability,
  legendaryCraftProbabilityOf,
  legendaryDataIsSparse,
  type OptimizerSolution,
  type TargetView,
} from '@/lib';
import { enumerateLaunchOptions } from '@/lib/problem-inputs';
import { createOptimizerClient, type OptimizerClient, type OptimizerRequestInput } from '@/lib/optimizer-client';
import OptimizerSidebar from './optimizer/OptimizerSidebar.vue';
import OptimizerInventoryPanel from './optimizer/OptimizerInventoryPanel.vue';
import OptimizerSolutionCard from './optimizer/OptimizerSolutionCard.vue';

// The id as the save server reads it: `requestFirstContact` drops a leading "mk2!", and the form
// trims what is typed. Two spellings of one id fetch the same save.
function normalizePlayerId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('mk2!') ? trimmed.slice(4) : trimmed;
}

export default defineComponent({
  components: { OptimizerSidebar, OptimizerInventoryPanel, OptimizerSolutionCard },
  props: {
    artifactIds: { type: Array as PropType<string[]>, required: true },
  },
  setup(props) {
    const { artifactIds } = toRefs(props);

    // Preserve budgets across unmounts and keep plan visits independent.
    const waitTimeDays = computed(() =>
      activePlanVisit.value ? waitTimeInputFor(activePlanVisit.value) : missionFilters.value.waitTimeDays
    );
    const maxWaitTimeSeconds = effectiveWaitTimeSeconds;

    function updateWaitTime(value: string) {
      const visit = activePlanVisit.value;
      if (visit) setVisitWaitTime(visit.visitId, value);
      else setWaitTimeDays(value);
    }

    const timeBudgetValid = computed(() => Number.isFinite(maxWaitTimeSeconds.value) && maxWaitTimeSeconds.value > 0);

    const playerId = ref(new URLSearchParams(window.location.search).get('playerId') || getSavedPlayerID() || '');
    // True while a save is being fetched. No solve starts meanwhile: one would run on whatever inputs
    // the page holds before the save arrives and record that answer over a good one.
    const loadingPlayer = ref(false);
    const playerLoadError = ref('');
    // The player id (normalized) whose save was last loaded whole, or null when the last load failed
    // or returned no usable save.
    const loadedPlayerId = ref<string | null>(null);
    // Whether the page's inputs are a real save's: there is no player id, or the id's save loaded.
    // Otherwise they are placeholders (or another player's data), and recorded answers are neither
    // judged against them nor replaced by an answer solved on them.
    const playerSaveReady = computed(
      () => !playerId.value || loadedPlayerId.value === normalizePlayerId(playerId.value)
    );
    const KEPT_NOTE = 'Recorded answers are kept, and results are not recorded until the save loads.';
    let playerRequest = 0;
    // Never rejects: a failed fetch is reported on the page, and the page then solves on the inputs it
    // has, as it would with no player id at all, without recording what it finds.
    async function loadPlayer(id: string): Promise<void> {
      const request = ++playerRequest;
      loadingPlayer.value = true;
      playerLoadError.value = '';
      try {
        const data = await requestFirstContact(id);
        if (request !== playerRequest) return;
        if (data.backup) setPlayerData(data.backup);
        // What setPlayerData needs to replace the player's data; anything less is no save.
        if (data.backup?.game && data.backup.artifactsDb) loadedPlayerId.value = normalizePlayerId(id);
        else {
          loadedPlayerId.value = null;
          playerLoadError.value = `Could not load the save for ${id}: no save was returned. ${KEPT_NOTE}`;
        }
      } catch (err) {
        if (request !== playerRequest) return;
        loadedPlayerId.value = null;
        playerLoadError.value = `Could not load the save for ${id}: ${err instanceof Error ? err.message : String(err)}. ${KEPT_NOTE}`;
      } finally {
        if (request === playerRequest) loadingPlayer.value = false;
      }
    }
    if (playerId.value) void loadPlayer(playerId.value);

    // let the settings UI show each target's prior craft count
    watch(
      artifactIds,
      v => {
        currentOptimizerArtifactIds.value = [...v];
      },
      { immediate: true }
    );
    onUnmounted(() => {
      currentOptimizerArtifactIds.value = [];
    });

    const submitPlayerId = async (id: string) => {
      playerId.value = id;
      savePlayerID(id);
      await loadPlayer(id);
    };

    const computing = ref(false);
    const computeError = ref('');
    // Why the last solve's answer was not recorded for the visit (it launches nothing, or there was
    // nothing to aim at). Empty when it was, or when there is nothing to say.
    const noAnswerMessage = ref('');
    const computedResults = ref<OptimizerSolution[]>([]);
    const inputsValid = computed(() => timeBudgetValid.value && costBudgetsValid.value);
    // Names the field that's blocking a solve, and — for a plan visit whose time budget is empty
    // because the plan hasn't scheduled its missions yet — says why, rather than pointing at "the
    // budget" in general.
    const invalidBudgetMessage = computed(() => {
      if (!timeBudgetValid.value) {
        if (activePlanVisit.value && maxWaitTimeSeconds.value === 0) {
          return "This visit's time budget is empty because the plan hasn't scheduled any Humility missions for it yet. Enter a time budget in the sidebar to solve it anyway.";
        }
        return 'Enter a valid time budget in the sidebar — a positive duration such as 30, 12d12h, or 10h5m.';
      }
      if (gemCostInvalid.value) return 'Enter a valid maximum purchase cost in the sidebar (e.g. 10S).';
      if (craftingCostInvalid.value) return 'Enter a valid maximum crafting cost in the sidebar (e.g. 25M).';
      return 'Correct the invalid budget in the sidebar.';
    });
    const inventoryRevision = ref(0);
    watch(playerInventory, () => inventoryRevision.value++, { flush: 'sync' });
    // Capture result metadata before inputs can change during a solve.
    const snapshot = shallowRef<{
      time: number;
      inventory: typeof playerInventory.value;
      goldenEggs: number | null;
      visitIndex: number;
    } | null>(null);
    // The parts of the ships config the solve reads, other than epic research (`enumerateLaunchOptions`
    // and the mission durations and capacities it prices). The rest (the drop-stats target checkboxes,
    // the legacy only-Henners/Liners flags) is display, and changing it changes no answer.
    const solveShipsConfig = computed(() => {
      const c = effectiveConfig.value;
      return { shipLevels: c.shipLevels, shipVisibility: c.shipVisibility, showNodata: c.showNodata };
    });

    // Compare the meaning of inputs, not their object identity or normalized spelling.
    // Launch enumeration is a deterministic function of config, targets, and effort.
    const questionKey = computed(() =>
      JSON.stringify({
        priceMode: gemCostMode.value,
        visit: activePlanVisit.value?.visitId,
        targets: artifactIds.value,
        config: {
          ...solveShipsConfig.value,
          ftl: effectiveConfig.value.epicResearchFTLLevel,
          zerog: effectiveConfig.value.epicResearchZerogLevel,
        },
        crafting: effectiveCraftingLevel.value,
        previousCrafts: effectivePreviousCraftsOverride.value,
        inventory: inventoryRevision.value,
        time: maxWaitTimeSeconds.value,
        fuel: effectiveFuelByEggCapacity.value
          ? [...effectiveFuelByEggCapacity.value]
          : effectiveFuelTankCapacity.value,
        price: effectiveMaxGemCost.value,
        craftBudget: effectiveCraftingBudget.value,
        effort: missionFilters.value.effort,
        valid: inputsValid.value,
      })
    );

    // Everything a plan visit's answer depends on that is not the visit's own: the player, their
    // inventory and ship levels, crafting, effort and the craft cap, and whether that cap is valid.
    // A visit's own inputs (targets, time, fuel and gem settings) are guarded in `store/plan.ts`;
    // the visit's own epic research is left out here for the same reason. Recorded with each answer;
    // when it changes, every answer solved under another key is dropped, other visits' included.
    // Only what the solve reads is in it. The tank-level override is not: a plan visit budgets against
    // its own tank (SEAM-09), and answers are only recorded for plan visits. The player id is the one
    // the save server reads, so another spelling of the same id is the same player.
    const inventoryFingerprint = computed(() => {
      const inventory = playerInventory.value;
      if (!inventory) return null;
      return inventory.items
        .filter(item => item.crafted > 0 || item.haveRarity.some(n => n > 0))
        .map(item => `${item.afxId}.${item.afxLevel}:${item.haveRarity.join(',')}:${item.crafted}:${item.slotted}`)
        .join(';');
    });
    const globalInputsKey = computed(() => {
      const player = playerShipsConfig.value;
      return JSON.stringify({
        player: normalizePlayerId(playerId.value),
        inventory: inventoryFingerprint.value,
        ships: solveShipsConfig.value,
        // What a visit that carries no epic research of its own falls back on.
        ftl: overrides.value.epicResearchFTLLevel
          ? config.value.epicResearchFTLLevel
          : (player?.epicResearchFTLLevel ?? config.value.epicResearchFTLLevel),
        zerog: overrides.value.epicResearchZerogLevel
          ? config.value.epicResearchZerogLevel
          : (player?.epicResearchZerogLevel ?? config.value.epicResearchZerogLevel),
        crafting: effectiveCraftingLevel.value,
        previousCrafts: effectivePreviousCraftsOverride.value ?? null,
        craftBudget: craftingCostInvalid.value ? 'invalid' : (effectiveCraftingBudget.value ?? null),
        effort: missionFilters.value.effort,
      });
    });

    const recipeDag = computed<ReturnType<typeof buildRecipeDag>>(() =>
      buildRecipeDag(
        artifactIds.value,
        effectiveCraftingLevel.value,
        playerInventory.value,
        effectivePreviousCraftsOverride.value
      )
    );

    const playerOwnedStock = computed<ReturnType<typeof computeOwnedStock>>(() =>
      computeOwnedStock(playerInventory.value, artifactIds.value, recipeDag.value)
    );

    // Launch-option enumeration stays on the main thread: it is the only step needing the loot dataset, which this bundle already loads.
    // Kept off `computeInputs` so that editing a budget, which cannot change the menu, does not re-enumerate it.
    const launchMenu = computed(() =>
      enumerateLaunchOptions(
        effectiveConfig.value,
        recipeDag.value,
        EFFORT_LAUNCH_PERIOD_SECONDS[missionFilters.value.effort]
      )
    );

    // The prices are likewise a function of the tree and the inventory, not of the cap they are compared against.
    const craftUnitPrices = computed(() => computeCraftUnitPrices(recipeDag.value, playerInventory.value));

    const computeInputs = computed<OptimizerRequestInput | null>(() => {
      if (!inputsValid.value) return null;
      const maxGemCost = effectiveMaxGemCost.value;
      const craftBudget =
        effectiveCraftingBudget.value !== undefined
          ? { capacity: effectiveCraftingBudget.value, unitPrices: craftUnitPrices.value }
          : undefined;
      return {
        options: launchMenu.value,
        recipeDag: recipeDag.value,
        desiredArtifactNodeIds: [...artifactIds.value],
        fuelCapacity: effectiveFuelTankCapacity.value,
        fuelByEggCapacity: effectiveFuelByEggCapacity.value ?? undefined,
        timeCapacityPerSlot: maxWaitTimeSeconds.value,
        ownedStock: playerOwnedStock.value,
        // The effective gem mode's cap is the visit's TOTAL gem budget, and it is also the price no
        // single ship may exceed, so it both filters the menu and caps the plan's spend. Unlimited
        // leaves both out.
        maximumCost: maxGemCost,
        gemBudget: maxGemCost,
        craftBudget,
      };
    });

    // Lazy so a page that never opens the planner doesn't pay for the worker
    // bundle.
    let client: OptimizerClient | null = null;
    const optimizerClient = () => (client ??= createOptimizerClient());

    let generation = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    async function runCompute() {
      clearTimeout(debounceTimer);
      const requestGeneration = ++generation;
      const input = computeInputs.value;
      if (!input) {
        computing.value = false;
        return;
      }
      const visit = activePlanVisit.value;
      const plan = loadedPlan.value;
      const key = questionKey.value;
      const requestedSnapshot = {
        time: input.timeCapacityPerSlot,
        inventory: playerInventory.value,
        goldenEggs: playerGoldenEggs.value,
        visitIndex: visit?.visitIndex ?? 0,
      };
      const effort = missionFilters.value.effort;
      // Written to the file as the cap the solve used and the FTL it priced durations at.
      const gemBudget = input.gemBudget;
      const epicResearchFTLLevel = effectiveConfig.value.epicResearchFTLLevel;
      const inputsKey = globalInputsKey.value;
      computing.value = true;
      computeError.value = '';
      try {
        const solutions = await optimizerClient().run(input);
        if (
          requestGeneration !== generation ||
          plan !== loadedPlan.value ||
          key !== questionKey.value ||
          inputsKey !== globalInputsKey.value ||
          loadingPlayer.value ||
          !inputsValid.value
        )
          return;
        if (solutions === null) {
          computing.value = false;
          return;
        }
        snapshot.value = requestedSnapshot;
        computedResults.value = finalizeSolutions(solutions, input.recipeDag);
        // Record at the matching request's completion, never via a watcher of live UI state. An
        // answer that launches nothing, or aims at nothing, is not recorded: the planner would stage
        // an empty visit as if it had been solved.
        const solution = computedResults.value[0];
        const unanswered = solution ? noAnswerReason(input, solution, effort) : 'No ship set was found.';
        noAnswerMessage.value = unanswered ?? '';
        // On placeholder inputs (the save did not load) the answer is shown but not recorded, and the
        // one recorded for the visit, if any, is kept.
        if (visit && playerSaveReady.value) {
          if (solution && unanswered === null) {
            recordSolvedVisit(
              projectSolvedVisit({ visit, solution, effort, gemBudget, epicResearchFTLLevel }),
              inputsKey
            );
          } else clearSolvedVisit(visit.visitId);
        }
      } catch (err) {
        if (requestGeneration !== generation) return;
        computeError.value = err instanceof Error ? err.message : String(err);
        noAnswerMessage.value = '';
        computedResults.value = [];
        snapshot.value = null;
        if (visit && playerSaveReady.value) clearSolvedVisit(visit.visitId);
      } finally {
        if (requestGeneration === generation) computing.value = false;
      }
    }

    watch(
      [questionKey, () => loadedPlan.value, loadingPlayer],
      () => {
        ++generation; // Retire even a running request before the debounced replacement starts.
        clearTimeout(debounceTimer);
        computeError.value = '';
        noAnswerMessage.value = '';
        // Keep what is shown until the save arrives; the watcher fires again when it has.
        if (loadingPlayer.value) {
          computing.value = false;
          return;
        }
        computing.value = inputsValid.value;
        if (computing.value) debounceTimer = setTimeout(runCompute, 250);
        else {
          computedResults.value = [];
          snapshot.value = null;
        }
      },
      { immediate: true, flush: 'sync' }
    );

    // Drop the answers to questions the page can no longer pose. Not while a save is loading, nor
    // after it failed to load or came back empty: the inputs are then placeholders, and only a save
    // that loaded is what the recorded answers are judged against. Pre-flush rather than sync, so a
    // save landing field by field is judged once, whole.
    let checkedInputsKey: string | undefined;
    watch(
      [globalInputsKey, loadingPlayer, playerSaveReady],
      () => {
        if (loadingPlayer.value || !playerSaveReady.value || globalInputsKey.value === checkedInputsKey) return;
        checkedInputsKey = globalInputsKey.value;
        retainSolvedVisitsMatching(checkedInputsKey);
      },
      { immediate: true }
    );

    onUnmounted(() => {
      ++generation;
      clearTimeout(debounceTimer);
      client?.terminate();
    });

    // Why `solution` is not an answer to record, naming the limit that emptied it, or null when it is one.
    function noAnswerReason(
      input: OptimizerRequestInput,
      solution: OptimizerSolution,
      effort: EffortLevel
    ): string | null {
      if (input.desiredArtifactNodeIds.length === 0) return 'Pick at least one target artifact to plan for.';
      if (solution.choiceHistory.some(run => run.numShipsLaunched > 0)) return null;
      const time = input.timeCapacityPerSlot;
      const floor = EFFORT_LAUNCH_PERIOD_SECONDS[effort];
      if (floor > time) {
        return `Nothing launches: at ${effort} effort each launch holds a slot for at least ${formatDuration(floor, true)}, longer than the ${formatDuration(time, true)} time budget. Lower the effort or raise the time budget.`;
      }
      const fitting = input.options.filter(o => o.actualTime <= time);
      if (fitting.length === 0) {
        return `Nothing launches: no mission fits in the ${formatDuration(time, true)} time budget.`;
      }
      const cap = input.gemBudget;
      if (cap !== undefined && !fitting.some(o => o.cost <= cap)) {
        return `Nothing launches: no ship costs ${formatBudgetValue(cap)} gems or less, the gem budget for this solve. Raise the gem budget or remove the limit.`;
      }
      return 'Nothing launches: no mission within these budgets improves the odds for the chosen targets.';
    }

    function artifactDisplay(nodeId: string): { name: string; iconUrl: string } {
      const props = getArtifactTierPropsFromId(nodeId);
      return { name: props.name, iconUrl: iconURL('egginc/' + props.icon_filename, 64) };
    }

    const inventoryTrees = computed(() =>
      artifactIds.value.map(nodeId => ({
        nodeId,
        ...artifactDisplay(nodeId),
        tree: computeInventoryTree(nodeId, recipeDag.value, playerInventory.value),
      }))
    );

    const solutionViews = computed(() =>
      computedResults.value.map(solution => {
        // Iterate solution.perTarget, never the live artifactIds: the solution
        // is stale between a selection change and the next completed solve.
        const targets: TargetView[] = solution.perTarget.map(perTarget => {
          const nodeId = perTarget.nodeId;
          const display = artifactDisplay(nodeId);
          return {
            nodeId,
            name: display.name,
            iconUrl: display.iconUrl,
            perTarget,
            pCraft: legendaryCraftProbabilityOf(solution, nodeId),
            lambda: lambdaFromDropProbability(perTarget.dropProbability),
            craftChainTree: computeCraftChainTree(solution, nodeId, snapshot.value?.inventory ?? null),
            missionLegendarySources: computeMissionLegendaryRows(solution, nodeId),
            dropDataIsSparse: legendaryDataIsSparse(nodeId),
          };
        });
        return { solution, targets, planCost: computePlanCraftingCost(solution, snapshot.value?.inventory ?? null) };
      })
    );

    const dimSolution = computed(() => computing.value && solutionViews.value.length > 0);

    return {
      waitTimeDays,
      updateWaitTime,
      dimSolution,
      snapshot,
      inputsValid,
      timeBudgetValid,
      invalidBudgetMessage,
      computing,
      computeError,
      noAnswerMessage,
      loadingPlayer,
      playerLoadError,
      planChangedInAnotherTab,
      planSaveFailed,
      playerId,
      submitPlayerId,
      playerInventory,
      inventoryTrees,
      solutionViews,
    };
  },
});
</script>
