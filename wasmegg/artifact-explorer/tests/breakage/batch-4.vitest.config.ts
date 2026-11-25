// Vitest config for batch-4 breakage specs that need both the explorer and the planner's pure modules.
// The two apps both use the `@` alias, so it is resolved by importer location.
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { existsSync } from 'node:fs';

const EX = new URL('../../src/', import.meta.url).pathname;
const AP = new URL('../../../ascension-planner/src/', import.meta.url).pathname;

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'at-alias-by-importer',
      enforce: 'pre',
      async resolveId(source, importer, opts) {
        if (!source.startsWith('@/') && !source.startsWith('@planner/')) return null;
        const base = source.startsWith('@planner/') || (importer && importer.startsWith(AP)) ? AP : EX;
        const rel = source.replace(/^@(planner)?\//, '');
        const hit = [rel, rel + '.ts', rel + '.vue', rel + '/index.ts'].map(r => base + r).find(p => existsSync(p) && !p.endsWith('/'));
        return this.resolve(hit ?? base + rel, importer, { ...opts, skipSelf: true });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^lib$/, replacement: '/home/user/egg/lib/index.ts' },
      { find: /^lib\//, replacement: '/home/user/egg/lib/' },
    ],
  },
  json: { stringify: true, namedExports: false },
  define: { __SIM_VERSION__: JSON.stringify('test') },
  root: new URL('../../', import.meta.url).pathname,
  test: { environment: 'node', include: ['tests/breakage/batch-4.*.spec.ts'] },
});
