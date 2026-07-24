<template>
  <spoiler-alert class="my-4" />
  <mission-selector :key="route.path" v-model="selectedMissionId" class="my-4" />
  <artifact-selector :key="route.path" v-model="selectedArtifactId" class="my-4" />
  <tank-artifact-selector :key="route.path" v-model="selectedTankArtifactIdsPrimary" class="my-4" />
  <router-view name="mission" />
  <div class="my-4 text-xs text-red-900">
    <p class="font-medium">Artifact notes:</p>
    <p>
      * Certain effect values shown may be 1% higher than the corresponding in-game values; those are caused by
      erroneous floating point handling in the game, i.e. values here are correct.
    </p>
    <p>&dagger; Artifacts marked with &dagger; are not available from missions.</p>
  </div>
  <router-view name="artifact" />
  <router-view name="tank" />
  <artifact-grid />
</template>

<script lang="ts">
import { computed, defineComponent, ref, PropType, toRefs, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { parseTankIds, serializeTankIds } from '@/lib';
import SpoilerAlert from '@/components/SpoilerAlert.vue';
import ArtifactGrid from '@/components/ArtifactGrid.vue';
import ArtifactSelector from '@/components/ArtifactSelector.vue';
import TankArtifactSelector from '@/components/TankArtifactSelector.vue';
import MissionSelector from '@/components/MissionSelector.vue';

export default defineComponent({
  components: {
    SpoilerAlert,
    ArtifactGrid,
    ArtifactSelector,
    TankArtifactSelector,
    MissionSelector,
  },
  props: {
    missionId: {
      type: String as PropType<string | null>,
      default: null,
    },
    artifactId: {
      type: String as PropType<string | null>,
      default: null,
    },
    tankPlannerArtifactId: {
      type: String as PropType<string | null>,
      default: null,
    },
  },
  setup(props) {
    const router = useRouter();
    const route = useRoute();
    const { missionId, artifactId, tankPlannerArtifactId } = toRefs(props);

    const selectedMissionId = ref(missionId.value);
    watch(missionId, current => {
      selectedMissionId.value = current;
    });
    watch(selectedMissionId, current => {
      if (current !== null) {
        router.push({
          name: 'mission',
          params: { missionId: current },
        });
      }
    });

    const selectedArtifactId = ref(artifactId.value);
    watch(artifactId, current => {
      selectedArtifactId.value = current;
    });
    watch(selectedArtifactId, current => {
      if (current !== null) {
        router.push({
          name: 'artifact',
          params: { artifactId: current },
        });
      }
    });

    // Array-shaped underneath so a future multi-select picker (Phase 4) has
    // something correct to plug into; for now the only writer is the
    // single-select TankArtifactSelector below, adapted through
    // selectedTankArtifactIdsPrimary.
    const selectedTankArtifactIds = ref<string[]>(parseTankIds(tankPlannerArtifactId.value));
    watch(tankPlannerArtifactId, current => {
      selectedTankArtifactIds.value = parseTankIds(current);
    });
    watch(
      selectedTankArtifactIds,
      current => {
        if (current.length > 0) {
          router.push({
            name: 'tank',
            params: { tankPlannerArtifactId: serializeTankIds(current) },
          });
        }
      },
      { deep: true }
    );

    // Temporary adapter for TankArtifactSelector.vue, which is still a
    // single-select dropdown until Phase 4 replaces it with a real
    // multi-select picker; selecting a new artifact through it collapses the
    // list down to just that one target.
    const selectedTankArtifactIdsPrimary = computed<string | null>({
      get: () => selectedTankArtifactIds.value[0] ?? null,
      set: value => {
        selectedTankArtifactIds.value = value === null ? [] : [value];
      },
    });

    return {
      route,
      selectedMissionId,
      selectedArtifactId,
      selectedTankArtifactIdsPrimary,
    };
  },
});
</script>
