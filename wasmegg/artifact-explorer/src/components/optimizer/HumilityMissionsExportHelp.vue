<template>
  <TransitionRoot as="template" :show="open">
    <HeadlessDialog as="div" class="fixed z-10 inset-0 overflow-y-auto" @close="close">
      <div class="min-h-screen text-center px-4">
        <TransitionChild
          as="template"
          enter="ease-out duration-300"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="ease-in duration-200"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <DialogOverlay class="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
        </TransitionChild>

        <!-- This element is to trick the browser into centering the modal contents. -->
        <span class="inline-block align-middle h-screen" aria-hidden="true">&#8203;</span>
        <TransitionChild
          as="template"
          enter="ease-out duration-300"
          enter-from="opacity-0 translate-y-0 scale-95"
          enter-to="opacity-100 translate-y-0 scale-100"
          leave="ease-in duration-200"
          leave-from="opacity-100 translate-y-0 scale-100"
          leave-to="opacity-0 translate-y-0 scale-95"
        >
          <div
            class="inline-block bg-white rounded-lg px-6 pt-4 pb-6 text-left overflow-hidden shadow-xl transform transition-all my-8 align-middle max-w-md w-full space-y-3 relative"
          >
            <DialogTitle as="h3" class="text-center text-base font-medium text-gray-900">
              Your humility missions file
            </DialogTitle>

            <button
              type="button"
              class="absolute -top-3 right-0 inline-flex rounded-md p-2 focus:outline-none"
              aria-label="Close"
              @click="close"
            >
              <XIcon class="h-4 w-4 text-gray-500 hover:text-gray-600" aria-hidden="true" />
            </button>

            <p class="text-sm text-gray-700">
              {{
                exported
                  ? "Your file is downloading. Here's what to do with it."
                  : "Export downloads a humility missions file. Here's what to do with it."
              }}
            </p>

            <!-- SCREENSHOT: the ascension planner's Rockets action with "From the artifact explorer" goes here. -->

            <ol class="list-decimal pl-5 space-y-1 text-sm text-gray-700">
              <li>Open the ascension planner and load the same plan this file was exported from.</li>
              <li>Open the Rockets tab while on a Humility visit.</li>
              <li>Under "From the artifact explorer", choose this file.</li>
              <li>Stage each visit into the plan.</li>
            </ol>

            <p class="text-xs text-gray-500">
              The file only matches the plan it was exported from. Load it into a different plan and its visits show as
              unavailable.
            </p>

            <div class="flex items-center justify-between gap-3 pt-1">
              <a :href="plannerUrl" target="_blank" rel="noopener" class="text-sm text-blue-500 hover:text-blue-600">
                Open the ascension planner
              </a>
              <button
                type="button"
                class="inline-flex items-center justify-center px-4 py-1.5 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none"
                @click="close"
              >
                Got it
              </button>
            </div>
          </div>
        </TransitionChild>
      </div>
    </HeadlessDialog>
  </TransitionRoot>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Dialog as HeadlessDialog, DialogOverlay, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { XIcon } from '@heroicons/vue/solid';

import { idToTool } from 'lib/tools';

const plannerUrl = idToTool.get('ascension-planner')?.url ?? '/ascension-planner/';

export default defineComponent({
  components: {
    HeadlessDialog,
    DialogOverlay,
    DialogTitle,
    TransitionChild,
    TransitionRoot,
    XIcon,
  },
  props: {
    open: { type: Boolean, required: true },
    // Opened by an export rather than from the help link, so the file really is downloading.
    exported: { type: Boolean, default: false },
  },
  emits: {
    close: () => true,
  },
  setup(_props, { emit }) {
    const close = () => emit('close');
    return {
      plannerUrl,
      close,
    };
  },
});
</script>
