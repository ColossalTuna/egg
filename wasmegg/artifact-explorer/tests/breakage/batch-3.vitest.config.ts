// Config for the batch-3 seam specs. Runs from the artifact-explorer's toolchain and resolves the
// '@/' alias per importer: files under wasmegg/ascension-planner/ get the planner's src, everything
// else gets the explorer's. (The planner has no node_modules in this checkout, and its '@' collides
// with the explorer's.) Run:  npx vitest run -c tests/breakage/batch-3.vitest.config.ts <file>
import { defineConfig, type Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const planner = '/home/user/egg/wasmegg/ascension-planner';
const explorer = '/home/user/egg/wasmegg/artifact-explorer';
const nm = `${explorer}/node_modules`;

const perImporterAt: Plugin = {
  name: 'batch3-at-alias',
  enforce: 'pre',
  async resolveId(source, importer, opts) {
    if (!importer) return null;
    const fromPlanner = importer.startsWith(planner + '/');
    let base: string | null = null;
    if (source.startsWith('@planner/')) base = `${planner}/src/${source.slice('@planner/'.length)}`;
    else if (source.startsWith('@/')) base = `${fromPlanner ? planner : explorer}/src/${source.slice(2)}`;
    if (!base) return null;
    return this.resolve(base, importer, { ...opts, skipSelf: true });
  },
};

export default defineConfig({
  plugins: [perImporterAt, vue()],
  json: { stringify: true, namedExports: false },
  resolve: {
    alias: [
      { find: /^lib$/, replacement: '/home/user/egg/lib/index.ts' },
      { find: /^lib\/(.*)$/, replacement: '/home/user/egg/lib/$1' },
      { find: /^pinia$/, replacement: `${nm}/pinia` },
      { find: /^vue$/, replacement: `${nm}/vue` },
    ],
  },
  define: { __SIM_VERSION__: JSON.stringify('test') },
  server: { fs: { strict: false } },
  test: {
    environment: 'node',
    include: ['tests/breakage/batch-3.*.spec.ts'],
  },
});
