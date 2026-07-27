<template>
  <div class="space-y-2">
    <label class="block text-sm font-medium text-gray-700">
      What is the most efficient ship to get this item, or items, when on the Path of Virtue?
    </label>

    <div v-if="selectedArtifacts.length > 0" class="flex flex-wrap gap-2">
      <span
        v-for="artifact in selectedArtifacts"
        :key="artifact.id"
        class="inline-flex items-center pl-1 pr-1.5 py-1 rounded-full bg-gray-100 border border-gray-300 text-sm text-gray-700"
      >
        <img class="h-5 w-5 flex-shrink-0 mr-1" :src="iconURL('egginc/' + artifact.icon_filename, 32)" alt="" />
        <span class="truncate max-w-[10rem]">{{ artifact.display }}</span>
        <button
          type="button"
          class="ml-1 flex-shrink-0 rounded-full p-0.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 focus:outline-none"
          :aria-label="`Remove ${artifact.display}`"
          @click="remove(artifact.id)"
        >
          <XIcon class="h-3.5 w-3.5" />
        </button>
      </span>
    </div>

    <base-select-filterable
      :items="availableArtifacts"
      :get-item-id="artifact => artifact.id"
      :get-item-display="artifact => artifact.display"
      :get-item-icon-path="artifact => 'egginc/' + artifact.icon_filename"
      :item-from-id="id => artifactIdToArtifact.get(id)!"
      :search-items="searchAvailableArtifacts"
      placeholder="Add artifact (type to filter)"
      :model-value="pendingId"
      @update:model-value="onAdd"
    />

    <div
      v-if="modelValue.length > 2 && !warningDismissed"
      role="status"
      class="flex items-start gap-2 rounded-md bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm px-3 py-2"
    >
      <span class="flex-1">
        Optimizing for 3 or more artifacts at once splits your missions across every target, so the joint chance of
        getting all of them drops quickly. You can still proceed.
      </span>
      <button
        type="button"
        class="flex-shrink-0 rounded-full p-0.5 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-100 focus:outline-none"
        aria-label="Dismiss warning"
        @click="warningDismissed = true"
      >
        <XIcon class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, PropType, ref, watch } from 'vue';
import { XIcon } from '@heroicons/vue/solid';

import { iconURL } from 'lib';
import { artifactIdToArtifact, legendaryArtifacts, searchLegendaryArtifacts } from '@/lib/filter';
import { GenericBaseSelectFilterable } from 'ui/components/BaseSelectFilterable.vue';

const BaseSelectFilterable = GenericBaseSelectFilterable<(typeof legendaryArtifacts)[number]>();

const props = defineProps({
  modelValue: {
    type: Array as PropType<string[]>,
    required: true,
  },
});

const emit = defineEmits({
  'update:modelValue': (_payload: string[]) => true,
});

const selectedArtifacts = computed(() =>
  props.modelValue
    .map(id => artifactIdToArtifact.get(id))
    .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined)
);

// Exclude already-selected artifacts from the adder dropdown/search results so
// the same artifact can't be picked twice.
const selectedIdSet = computed(() => new Set(props.modelValue));
const availableArtifacts = computed(() => legendaryArtifacts.filter(artifact => !selectedIdSet.value.has(artifact.id)));
function searchAvailableArtifacts(query: string) {
  return searchLegendaryArtifacts(query).filter(artifact => !selectedIdSet.value.has(artifact.id));
}

// The adder's own selection is transient: picking an item appends its id to
// the outer array (deduped defensively, though availableArtifacts already
// keeps duplicates out of the dropdown) and resets back to null so the
// picker is immediately ready to add another artifact.
const pendingId = ref<string | null>(null);
function onAdd(id: string | null) {
  if (id === null) return;
  if (!props.modelValue.includes(id)) {
    emit('update:modelValue', [...props.modelValue, id]);
  }
  pendingId.value = null;
}

function remove(id: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter(existing => existing !== id)
  );
}

const warningDismissed = ref(false);
// Only re-arm the dismissal when the selection count crosses UP from at-or-
// below the threshold to at-or-above it (e.g. 2 -> 3). Any other length
// change while already at/above the threshold (3 -> 4, 4 -> 3, etc) leaves a
// prior dismissal in place, since the user already acknowledged the warning
// in that regime; dropping back to <=2 hides the warning outright (see the
// v-if above) without touching the dismissal, so re-entering >=3 later
// re-arms it correctly.
watch(
  () => props.modelValue.length,
  (newLength, oldLength) => {
    if (oldLength <= 2 && newLength >= 3) {
      warningDismissed.value = false;
    }
  }
);
</script>
