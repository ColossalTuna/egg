<template>
  <spoiler-alert class="my-4" />
  <mission-selector :key="route.path" v-model="selectedMissionId" class="my-4" />
  <artifact-selector :key="route.path" v-model="selectedArtifactId" class="my-4" />
  <tank-artifact-multi-selector :key="route.name" v-model="selectedTankArtifactIds" class="my-4" />
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
import { defineComponent, ref, PropType, toRefs, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { parseTankIds, serializeTankIds } from '@/lib';
import { artifactIdToArtifact } from '@/lib/filter';
import SpoilerAlert from '@/components/SpoilerAlert.vue';
import ArtifactGrid from '@/components/ArtifactGrid.vue';
import ArtifactSelector from '@/components/ArtifactSelector.vue';
import TankArtifactMultiSelector from '@/components/TankArtifactMultiSelector.vue';
import MissionSelector from '@/components/MissionSelector.vue';

export default defineComponent({
  components: {
    SpoilerAlert,
    ArtifactGrid,
    ArtifactSelector,
    TankArtifactMultiSelector,
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

    // The route param is hand-editable, so an id that parses fine can still not
    // name a real artifact. FuelTankPlanner already drops those before they
    // reach getArtifactTierPropsFromId(); the selector has to drop them too, or
    // an unknown id stays in the model forever and gets written back into the
    // URL on the next add, leaving the Share link describing something other
    // than what is actually planned. Filtered here rather than inside
    // parseTankIds so that stays a pure string routine with no dependency on
    // artifact data (see tank-ids.spec.ts).
    const parseSelectedTankIds = (raw: string | null) => parseTankIds(raw).filter(id => artifactIdToArtifact.has(id));

    const selectedTankArtifactIds = ref<string[]>(parseSelectedTankIds(tankPlannerArtifactId.value));
    watch(tankPlannerArtifactId, current => {
      selectedTankArtifactIds.value = parseSelectedTankIds(current);
    });
    watch(selectedTankArtifactIds, current => {
      if (current.length === 0) {
        // Removing the last chip has to leave the tank route: staying on
        // /tank/<id>/ would keep the planner rendering the artifact that was
        // just removed. Same destination FuelTankPlanner falls back to when
        // none of its ids resolve. Guarded on the route so clearing a
        // selection that was never in the URL doesn't navigate anywhere.
        if (route.name === 'tank') {
          router.replace({ name: 'home' });
        }
        return;
      }
      const serialized = serializeTankIds(current);
      // When the incoming param was merely a non-canonical spelling of this
      // same selection (`#/tank/a,a`, `#/tank/a,,b`, stray whitespace, an
      // unknown id we just dropped), pushing the canonical URL would leave the
      // non-canonical entry one step back in history -- where Back lands, the
      // param watcher re-normalizes, and we push forward again, so the user
      // can never get past it. Replace in that case; a genuine selection
      // change still pushes so Back undoes it.
      const sameSelection = serialized === serializeTankIds(parseSelectedTankIds(tankPlannerArtifactId.value));
      const navigate = sameSelection ? router.replace : router.push;
      navigate({
        name: 'tank',
        params: { tankPlannerArtifactId: serialized },
      });
    });

    return {
      route,
      selectedMissionId,
      selectedArtifactId,
      selectedTankArtifactIds,
    };
  },
});
</script>
