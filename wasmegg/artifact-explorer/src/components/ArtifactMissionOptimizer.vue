<template>
  <div class="lg:grid lg:grid-cols-[minmax(280px,340px)_1fr] lg:gap-6 space-y-6 lg:space-y-0">
    <!-- Left: inputs sidebar -->
    <div class="lg:sticky lg:top-4 self-start">
      <optimizer-sidebar
        :player-id="playerId"
        :pending-compute="pendingCompute"
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
          :p-craft="view.pCraft"
          :lambda="view.lambda"
          :craft-chain-tree="view.craftChainTree"
          :mission-legendary-sources="view.missionLegendarySources"
          :has-inventory="!!playerInventory"
          :drop-data-is-sparse="view.dropDataIsSparse"
          :targets="view.targets"
        />
        <p v-if="solutionViews.length === 0" class="text-sm text-gray-400">
          {{
            timeBudgetValid
              ? 'No ship set found for the current settings.'
              : 'Enter a time budget (e.g. 30, 12d12h, 10h5m) to compute a plan.'
          }}
        </p>
      </div>

      <optimizer-inventory-panel
        v-if="artifactIds.length <= 1"
        :tree="inventoryTree"
        :has-inventory="!!playerInventory"
      />
      <template v-else>
        <div v-for="target in inventoryTrees" :key="'inventory-' + target.nodeId">
          <div class="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
            <img :src="target.iconUrl" class="h-4 w-4 flex-shrink-0" />
            <span>{{ target.name }}</span>
          </div>
          <optimizer-inventory-panel :tree="target.tree" :has-inventory="!!playerInventory" />
        </div>
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
  lambdaFromDropProbability,
  legendaryCraftProbabilityOf,
  legendaryDataIsSparse,
  optimize,
  type OptimizerSolution,
  type TargetView,
} from '@/lib';
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
    // The override modal (and other single-target-only presentation, e.g. the
    // inventory/craft-chain trees below) only ever reflects the primary
    // target; Phase 5 owns generalizing that presentation to all targets.
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

    function runCompute() {
      if (!timeBudgetValid.value) {
        computedResults.value = [];
        pendingCompute.value = false;
        return;
      }
      const launchPeriodSeconds = EFFORT_LAUNCH_PERIOD_SECONDS[missionFilters.value.effort];
      const maxGemCost = missionFilters.value.maxGemCostEnabled ? missionFilters.value.maxGemCost : undefined;
      lastComputedMaxWaitTimeSeconds.value = maxWaitTimeSeconds.value;
      computedResults.value = optimize(
        {
          desiredArtifactNodeIds: artifactIds.value,
          includeNotEnoughData: effectiveConfig.value.showNodata,
          fuelTankCapacity: effectiveFuelTankCapacity.value,
          timeBudgetSeconds: maxWaitTimeSeconds.value,
        },
        effectiveConfig.value,
        recipeDag.value,
        playerBaseYield.value,
        launchPeriodSeconds,
        maxGemCost
      );
      pendingCompute.value = false;
    }

    // Recompute on any relevant change while auto-compute is on; otherwise
    // just flag that a manual recompute is due. Note that with auto-compute
    // off this effect only tracks autoCompute itself.
    watchEffect(() => {
      if (autoCompute.value) {
        runCompute();
      } else {
        pendingCompute.value = true;
      }
    });

    const inventoryTree = computed(() =>
      computeInventoryTree(primaryArtifactId.value, recipeDag.value, playerInventory.value)
    );

    // Name/icon lookup shared by every per-target label in the results UI,
    // reusing the same artifact metadata source as the recipe-tree builders
    // (optimizer-tree.ts) rather than inventing a second lookup.
    function artifactDisplay(nodeId: string): { name: string; iconUrl: string } {
      const props = getArtifactTierPropsFromId(nodeId);
      return { name: props.name, iconUrl: iconURL('egginc/' + props.icon_filename, 64) };
    }

    // Per-target inventory trees, for the n>=2 inventory panel below; unused
    // (and not rendered) when there's a single target, which keeps using the
    // plain `inventoryTree` above so its markup stays unchanged.
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
        // per-target computation; the n=1 render path additionally gets the
        // primary target's values duplicated onto flat props below so it can
        // keep reading them exactly as it did before this existed.
        const targets: TargetView[] = artifactIds.value.map(nodeId => {
          const display = artifactDisplay(nodeId);
          const perTarget = solution.perTarget.find(t => t.nodeId === nodeId) ?? solution.perTarget[0];
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
        return {
          solution,
          targets,
          // Flat primary-target fields, kept for the n=1 render branch of
          // OptimizerSolutionCard, which must read the exact same values it
          // did before multi-target support existed.
          pCraft: targets[0].pCraft,
          lambda: targets[0].lambda,
          craftChainTree: targets[0].craftChainTree,
          missionLegendarySources: targets[0].missionLegendarySources,
          dropDataIsSparse: targets[0].dropDataIsSparse,
        };
      })
    );

    return {
      waitTimeDays,
      lastComputedMaxWaitTimeSeconds,
      timeBudgetValid,
      pendingCompute,
      playerId,
      runCompute,
      submitPlayerId,
      playerInventory,
      inventoryTree,
      inventoryTrees,
      solutionViews,
    };
  },
});
</script>
