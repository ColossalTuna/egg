<template>
  <div class="lg:grid lg:grid-cols-[minmax(280px,340px)_1fr] lg:gap-6 space-y-6 lg:space-y-0">
    <!-- Left: inputs sidebar -->
    <div class="lg:sticky lg:top-4 self-start">
      <optimizer-sidebar
        :player-id="playerId"
        :pending-compute="pendingCompute"
        :computing="computing"
        :wait-time-days="waitTimeDays"
        :time-budget-invalid="!timeBudgetValid"
        @submit-player-id="submitPlayerId"
        @run-compute="runCompute"
        @update:wait-time-days="waitTimeDays = $event"
      />
    </div>

    <!-- Right: results canvas -->
    <div class="min-w-0 space-y-4">
      <div class="border border-gray-200 rounded-lg p-4">
        <h3 class="text-base font-semibold text-gray-700 mb-3">Best Ship Set</h3>
        <optimizer-solution-card
          v-for="(view, i) in solutionViews"
          :key="'solution-' + i"
          :solution="view.solution"
          :max-wait-time-seconds="lastComputedMaxWaitTimeSeconds"
          :has-inventory="!!playerInventory"
          :targets="view.targets"
        />
        <p v-if="computing" role="status" class="flex items-center gap-2 text-sm text-gray-500">
          <svg class="animate-spin h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Computing the best ship set…
        </p>
        <p v-else-if="computeError" class="text-sm text-red-600">Could not compute a plan: {{ computeError }}</p>
        <p v-else-if="solutionViews.length === 0" class="text-sm text-gray-400">
          {{
            timeBudgetValid
              ? 'No ship set found for the current settings.'
              : 'Enter a time budget (e.g. 30, 12d12h, 10h5m) to compute a plan.'
          }}
        </p>
      </div>

      <!-- One path for any number of targets: the per-target label is only
           meaningful with more than one, and it has to sit under exactly the
           same condition as the panel itself. OptimizerInventoryPanel renders
           nothing without a tree and an inventory, so a heading outside it
           leaves a bare list of artifact names with nothing under them
           whenever no player id has been entered -- the default state. The
           v-for is on a <template> so the single-target case still renders the
           panel as a direct child of the layout's spacing container, exactly
           as it did before there was anything to label. -->
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
import { computed, defineComponent, onUnmounted, PropType, ref, toRefs, watch, watchEffect } from 'vue';

import {
  getArtifactTierPropsFromId,
  getSavedPlayerID,
  iconURL,
  parseDurationDays,
  requestFirstContact,
  savePlayerID,
} from 'lib';

import {
  autoCompute,
  currentOptimizerArtifactId,
  effectiveConfig,
  effectiveFuelTankCapacity,
  effectivePreviousCrafts,
  effectiveCraftingLevel,
  EFFORT_LAUNCH_PERIOD_SECONDS,
  missionFilters,
  playerInventory,
  setPlayerData,
} from '@/store';
import {
  buildRecipeDag,
  computeBaseYield,
  computeCraftChainTree,
  computeInventoryTree,
  computeMissionLegendaryRows,
  finalizeSolutions,
  lambdaFromDropProbability,
  legendaryCraftProbabilityOf,
  legendaryDataIsSparse,
  type OptimizerSolution,
  type TargetView,
} from '@/lib';
import { enumerateLaunchOptions } from '@/lib/phases';
import { createOptimizerClient, type OptimizerClient, type OptimizerRequestInput } from '@/lib/optimizer-client';
import OptimizerSidebar from './optimizer/OptimizerSidebar.vue';
import OptimizerInventoryPanel from './optimizer/OptimizerInventoryPanel.vue';
import OptimizerSolutionCard from './optimizer/OptimizerSolutionCard.vue';

export default defineComponent({
  components: { OptimizerSidebar, OptimizerInventoryPanel, OptimizerSolutionCard },
  props: {
    artifactIds: { type: Array as PropType<string[]>, required: true },
  },
  setup(props) {
    const { artifactIds } = toRefs(props);
    // The craft-chain and inventory trees are built per target (see
    // solutionViews / inventoryTrees below); this is only the override modal's
    // notion of "the artifact currently being planned", which stays
    // single-valued because the modal edits one artifact's craft count.
    const primaryArtifactId = computed(() => artifactIds.value[0]);

    const waitTimeDays = ref('30');
    const maxWaitTimeSeconds = computed(() => parseDurationDays(waitTimeDays.value));

    const timeBudgetValid = computed(() => Number.isFinite(maxWaitTimeSeconds.value) && maxWaitTimeSeconds.value > 0);

    const playerId = ref(new URLSearchParams(window.location.search).get('playerId') || getSavedPlayerID() || '');
    if (playerId.value) {
      requestFirstContact(playerId.value).then(data => {
        if (data.backup) setPlayerData(data.backup);
      });
    }

    // let the override modal show the prior craft count for this artifact
    watch(
      primaryArtifactId,
      v => {
        currentOptimizerArtifactId.value = v;
      },
      { immediate: true }
    );
    onUnmounted(() => {
      currentOptimizerArtifactId.value = null;
    });

    const submitPlayerId = async (id: string) => {
      playerId.value = id;
      savePlayerID(id);
      const data = await requestFirstContact(id);
      if (data.backup) setPlayerData(data.backup);
    };

    const pendingCompute = ref(false);
    const computing = ref(false);
    const computeError = ref('');
    const computedResults = ref<OptimizerSolution[]>([]);
    // budget the displayed plan was computed against; the live input can
    // change before a manual recompute
    const lastComputedMaxWaitTimeSeconds = ref(0);

    const recipeDag = computed<ReturnType<typeof buildRecipeDag>>(() =>
      buildRecipeDag(
        artifactIds.value,
        effectiveCraftingLevel.value,
        playerInventory.value,
        effectivePreviousCrafts.value
      )
    );

    const playerBaseYield = computed<ReturnType<typeof computeBaseYield>>(() =>
      computeBaseYield(playerInventory.value, artifactIds.value, recipeDag.value)
    );

    // Everything the search needs, assembled reactively so the auto-compute
    // effect below can track its inputs without running the solve itself.
    // Launch-option enumeration happens here rather than in the worker: it is
    // cheap, and it is the only step that needs the loot dataset, which the
    // main bundle already loads for the mission views (see
    // optimizer-worker-protocol.ts).
    const computeInputs = computed<OptimizerRequestInput | null>(() => {
      if (!timeBudgetValid.value) return null;
      const launchPeriodSeconds = EFFORT_LAUNCH_PERIOD_SECONDS[missionFilters.value.effort];
      const maxGemCost = missionFilters.value.maxGemCostEnabled ? missionFilters.value.maxGemCost : undefined;
      return {
        options: enumerateLaunchOptions(effectiveConfig.value, recipeDag.value, launchPeriodSeconds, maxGemCost),
        recipeDag: recipeDag.value,
        desiredArtifactNodeIds: [...artifactIds.value],
        fuelCapacity: effectiveFuelTankCapacity.value,
        timeCapacity: maxWaitTimeSeconds.value,
        baseYield: playerBaseYield.value,
      };
    });

    // The solve runs in a worker (see optimizer.worker.ts), so a multi-second
    // multi-target search never blocks paint and auto-compute can stay on for
    // any number of targets. Created lazily so a page that never opens the
    // planner doesn't pay for the worker bundle.
    let client: OptimizerClient | null = null;
    const optimizerClient = () => (client ??= createOptimizerClient());

    async function runCompute() {
      const input = computeInputs.value;
      if (!input) {
        computedResults.value = [];
        pendingCompute.value = false;
        computing.value = false;
        computeError.value = '';
        return;
      }
      const budget = maxWaitTimeSeconds.value;
      pendingCompute.value = false;
      computing.value = true;
      computeError.value = '';
      try {
        const solutions = await optimizerClient().run(input);
        // null means a newer request superseded this one; that request owns
        // the results and the spinner, so leave both alone.
        if (solutions === null) return;
        // The inputs can also have gone invalid while the solve was in flight
        // (clearing the time budget, say). Nothing supersedes the request in
        // that case -- the watchEffect just empties the results -- so this
        // handler has to drop them rather than restore a stale plan.
        if (!computeInputs.value) {
          computedResults.value = [];
          computing.value = false;
          return;
        }
        lastComputedMaxWaitTimeSeconds.value = budget;
        // The same presentation fill-in the synchronous optimize() applies;
        // it needs artifact metadata the worker has no reason to carry.
        computedResults.value = finalizeSolutions(solutions, input.recipeDag);
        computing.value = false;
      } catch (err) {
        computeError.value = err instanceof Error ? err.message : String(err);
        computedResults.value = [];
        computing.value = false;
      }
    }

    // Auto-compute coalesces bursts of input changes (dragging the effort
    // slider, typing a time budget) into one solve. It's a plain debounce
    // rather than the old immediate call because the search now runs
    // asynchronously: without it every intermediate value would start a solve
    // that the next keystroke immediately supersedes.
    const AUTO_COMPUTE_DEBOUNCE_MS = 250;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Reading computeInputs.value here is what registers the dependency on
    // every setting the solve consumes; the debounced callback must not be the
    // thing that reads them, or the effect would only ever re-run on
    // autoCompute itself.
    watchEffect(() => {
      const input = computeInputs.value;
      // Every exit from here has to cancel the queued solve first. A timer
      // armed by the previous run would otherwise still fire: turning
      // auto-compute off inside the debounce window would compute anyway, and
      // runCompute clearing pendingCompute would leave the button reading
      // "Compute" next to a plan the user's latest input has already
      // invalidated.
      clearTimeout(debounceTimer);
      if (!autoCompute.value) {
        pendingCompute.value = true;
        return;
      }
      if (!input) {
        computedResults.value = [];
        return;
      }
      debounceTimer = setTimeout(runCompute, AUTO_COMPUTE_DEBOUNCE_MS);
    });

    onUnmounted(() => {
      clearTimeout(debounceTimer);
      client?.terminate();
    });

    // Name/icon lookup shared by every per-target label in the results UI,
    // reusing the same artifact metadata source as the recipe-tree builders
    // (optimizer-tree.ts) rather than inventing a second lookup.
    function artifactDisplay(nodeId: string): { name: string; iconUrl: string } {
      const props = getArtifactTierPropsFromId(nodeId);
      return { name: props.name, iconUrl: iconURL('egginc/' + props.icon_filename, 64) };
    }

    // Per-target inventory trees; with a single target this is the one tree
    // the panel has always shown, just reached through the same code path as
    // the multi-target case.
    const inventoryTrees = computed(() =>
      artifactIds.value.map(nodeId => ({
        nodeId,
        ...artifactDisplay(nodeId),
        tree: computeInventoryTree(nodeId, recipeDag.value, playerInventory.value),
      }))
    );

    const solutionViews = computed(() =>
      computedResults.value.map(solution => {
        // Built once per target so n=1 and n>=2 share the exact same
        // per-target computation; the n=1 render path reads targets[0].
        //
        // Iterate solution.perTarget (the solution's own actual target list)
        // rather than the live artifactIds: between the user changing their
        // selection and the next completed optimize() run, computedResults
        // is stale while artifactIds is live, so looking up live ids in the
        // stale solution would either miss (falling back to the wrong
        // target's data) or under/over-count targets vs what this solution
        // actually describes. Deriving purely from `solution` keeps this
        // view internally consistent no matter how out of sync the live
        // selection currently is.
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
            craftChainTree: computeCraftChainTree(solution, nodeId, playerInventory.value),
            missionLegendarySources: computeMissionLegendaryRows(solution, nodeId),
            dropDataIsSparse: legendaryDataIsSparse(nodeId),
          };
        });
        return { solution, targets };
      })
    );

    return {
      waitTimeDays,
      lastComputedMaxWaitTimeSeconds,
      timeBudgetValid,
      pendingCompute,
      computing,
      computeError,
      playerId,
      runCompute,
      submitPlayerId,
      playerInventory,
      inventoryTrees,
      solutionViews,
    };
  },
});
</script>
