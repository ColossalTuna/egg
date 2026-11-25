// SEAM-18: run the existing seam spec with the writer's makespan semantics mutated.
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  json: { stringify: true, namedExports: false },
  resolve: {
    alias: [
      { find: /^@\/lib\/plan\/write$/, replacement: new URL('./batch-3.mutant-write.ts', import.meta.url).pathname },
      { find: /^@\//, replacement: new URL('../../src/', import.meta.url).pathname },
    ],
  },
  test: { environment: 'node', include: ['tests/unit/plan-seam.spec.ts'] },
});
