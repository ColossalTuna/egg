<template>
  <div class="space-y-1 text-sm">
    <!-- n=1 -->
    <template v-if="solution.perTarget.length <= 1">
      <div class="text-lg font-semibold text-green-700">
        <span v-tippy="chanceTooltip" class="cursor-help border-b border-dotted border-green-400/60">
          Chance of a legendary
        </span>
        : {{ (solution.bestProbability * 100).toFixed(2) }}%<sup
          v-if="primary.dropDataIsSparse"
          v-tippy="sparseTooltip"
          class="text-gray-500 cursor-help ml-0.5"
          >?</sup
        >
      </div>
      <div class="text-sm text-green-700 pl-3">
        <span v-tippy="craftTooltip" class="cursor-help border-b border-dotted border-green-400/60">…via crafting</span>
        : {{ (solution.craftProbability * 100).toFixed(2) }}%
      </div>
      <div class="text-sm text-green-700 pl-3">
        <span v-tippy="dropTooltip" class="cursor-help border-b border-dotted border-green-400/60"
          >…via direct drops</span
        >
        : {{ (solution.dropProbability * 100).toFixed(2) }}%<sup
          v-if="primary.dropDataIsSparse"
          v-tippy="sparseTooltip"
          class="text-gray-500 cursor-help ml-0.5"
          >?</sup
        >
      </div>
    </template>

    <!-- n>=2: joint headline plus one sub-block per target -->
    <template v-else>
      <div class="text-lg font-semibold text-green-700">
        <span v-tippy="jointTooltip" class="cursor-help border-b border-dotted border-green-400/60">
          Joint chance of getting all {{ solution.perTarget.length }} artifacts
        </span>
        : {{ (solution.jointProbability * 100).toFixed(2) }}%
      </div>

      <div v-for="target in targets" :key="'target-' + target.nodeId" class="mt-2 pl-2 border-l-2 border-green-100">
        <div class="flex items-center gap-1.5 font-medium text-gray-700">
          <img :src="target.iconUrl" class="h-4 w-4 flex-shrink-0" alt="" />
          <span>{{ target.name }}</span>
        </div>
        <div class="text-sm text-green-700 pl-3">
          <span v-tippy="chanceTooltip" class="cursor-help border-b border-dotted border-green-400/60">
            Chance of a legendary
          </span>
          : {{ (target.perTarget.bestProbability * 100).toFixed(2) }}%<sup
            v-if="target.dropDataIsSparse"
            v-tippy="sparseTooltip"
            class="text-gray-500 cursor-help ml-0.5"
            >?</sup
          >
        </div>
        <div class="text-sm text-green-700 pl-6">
          <span v-tippy="craftTooltip" class="cursor-help border-b border-dotted border-green-400/60"
            >…via crafting</span
          >
          : {{ (target.perTarget.craftProbability * 100).toFixed(2) }}%
        </div>
        <div class="text-sm text-green-700 pl-6">
          <span v-tippy="dropTooltip" class="cursor-help border-b border-dotted border-green-400/60"
            >…via direct drops</span
          >
          : {{ (target.perTarget.dropProbability * 100).toFixed(2) }}%<sup
            v-if="target.dropDataIsSparse"
            v-tippy="sparseTooltip"
            class="text-gray-500 cursor-help ml-0.5"
            >?</sup
          >
        </div>
        <div class="text-gray-600 pl-3">Expected crafts: {{ target.perTarget.expectedCrafts.toFixed(1) }}</div>
      </div>
    </template>

    <div class="text-gray-600 pt-1">Fuel used: {{ formatEIValue(solution.fuelUsed, { trim: true }) }} Eggs</div>

    <ul>
      <li v-for="[egg, qty] of solution.fuelByEgg.entries()" :key="'egg-' + egg" class="text-gray-600">
        {{ formatEIValue(qty, { trim: true }) }}
        <base-icon :icon-rel-path="eggIconPath(egg)" :size="64" class="inline-block -ml-0.5 h-4 w-4"></base-icon>
      </li>
    </ul>
    <div class="text-gray-600">Ships in flight: {{ formatDuration(solution.runningTimeSeconds, true) }}</div>
    <div v-if="idleTimeSeconds > 0" class="text-gray-600">
      <span v-tippy="idleTooltip" class="cursor-help border-b border-dotted border-gray-400/60">Idle</span>
      : {{ formatDuration(idleTimeSeconds, true) }}
    </div>
    <!-- for n>=2 this lives in each target's sub-block above -->
    <div v-if="solution.perTarget.length <= 1" class="text-gray-600">
      Expected crafts: {{ solution.expectedCrafts.toFixed(1) }}
    </div>

    <div class="text-xs font-medium text-gray-500 uppercase tracking-wide mt-3">Launch plan</div>
    <optimizer-choice-list :choices="solution.choiceHistory" />

    <optimizer-expected-drops :drops="solution.expectedDrops" />

    <optimizer-probability-breakdown
      v-if="solution.perTarget.length <= 1"
      :best-probability="solution.bestProbability"
      :craft-probability="solution.craftProbability"
      :drop-probability="solution.dropProbability"
      :expected-crafts="solution.expectedCrafts"
      :p-craft="primary.pCraft"
      :lambda="primary.lambda"
      :craft-chain-tree="primary.craftChainTree"
      :mission-legendary-sources="primary.missionLegendarySources"
      :has-inventory="hasInventory"
    />
    <template v-else>
      <optimizer-probability-breakdown
        v-for="target in targets"
        :key="'breakdown-' + target.nodeId"
        :heading="target.name"
        :best-probability="target.perTarget.bestProbability"
        :craft-probability="target.perTarget.craftProbability"
        :drop-probability="target.perTarget.dropProbability"
        :expected-crafts="target.perTarget.expectedCrafts"
        :p-craft="target.pCraft"
        :lambda="target.lambda"
        :craft-chain-tree="target.craftChainTree"
        :mission-legendary-sources="target.missionLegendarySources"
        :has-inventory="hasInventory"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, PropType } from 'vue';

import { eggIconPath, formatDuration, formatEIValue } from 'lib';
import type { OptimizerSolution, TargetView } from '@/lib';
import BaseIcon from 'ui/components/BaseIcon.vue';
import OptimizerChoiceList from './OptimizerChoiceList.vue';
import OptimizerExpectedDrops from './OptimizerExpectedDrops.vue';
import OptimizerProbabilityBreakdown from './OptimizerProbabilityBreakdown.vue';

export default defineComponent({
  components: { BaseIcon, OptimizerChoiceList, OptimizerExpectedDrops, OptimizerProbabilityBreakdown },
  props: {
    solution: { type: Object as PropType<OptimizerSolution>, required: true },
    maxWaitTimeSeconds: { type: Number, required: true },
    hasInventory: { type: Boolean, required: true },
    targets: { type: Array as PropType<TargetView[]>, required: true },
  },
  setup(props) {
    // targets can be empty and `length <= 1` routes that here, so this must
    // never dereference targets[0].
    const primary = computed<Omit<TargetView, 'nodeId' | 'name' | 'iconUrl' | 'perTarget'>>(
      () =>
        props.targets[0] ?? {
          pCraft: 0,
          lambda: 0,
          craftChainTree: null,
          missionLegendarySources: [],
          dropDataIsSparse: false,
        }
    );
    const sparseTooltip =
      'Drop data is sparse: no mission has 5+ recorded legendary observations of this artifact, so the displayed rate may be off by several multiples.';
    const chanceTooltip =
      'Probability of at least one legendary of this artifact from this ship set, via crafting or a direct drop.';
    const jointTooltip = 'The probability of ending up with at least one legendary of every selected artifact.';
    const craftTooltip =
      'Probability of crafting at least one legendary from the gathered ingredients (plus anything already in your inventory).';
    const dropTooltip = 'Probability of at least one legendary dropping directly from the missions.';
    const idleTooltip =
      'Budget time with no ships in flight — gaps between launches (per your effort setting) plus unused budget at the end. Ships in flight + idle = your max wait time.';
    const idleTimeSeconds = computed(() =>
      Math.max(0, Math.round(props.maxWaitTimeSeconds) - props.solution.runningTimeSeconds)
    );
    return {
      eggIconPath,
      formatDuration,
      formatEIValue,
      sparseTooltip,
      chanceTooltip,
      jointTooltip,
      craftTooltip,
      dropTooltip,
      idleTooltip,
      idleTimeSeconds,
      primary,
    };
  },
});
</script>
