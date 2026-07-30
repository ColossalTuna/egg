<!-- The icon + name heading shown above a per-target section. Only meaningful
     with more than one target selected; callers own that condition. -->
<template>
  <div class="flex items-center gap-1.5 font-medium text-gray-700">
    <img :src="iconUrl" class="h-4 w-4 flex-shrink-0" alt="" />
    <span>{{ name }}</span>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  props: {
    name: { type: String, required: true },
    iconUrl: { type: String, required: true },
  },
});
</script>
