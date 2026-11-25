// Batch 5 breakage tests that drive the REAL ArtifactMissionOptimizer.vue (headless renderer, real solver).
// Only the worker transport, the three presentational children and the network are stubbed.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBackup, makeStubComponents, memoryStorage, mountOptimizer, settle, sleep, unmountAll } from './batch-5.harness';

vi.mock('lib', async importOriginal => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requestFirstContact: (id: string) => (globalThis as any).__b5rfc(id),
    getSavedPlayerID: () => (globalThis as any).__b5saved,
    savePlayerID: () => {},
  };
});
vi.mock('@/components/optimizer/OptimizerSidebar.vue', async () => ({ default: makeStubComponents().Sidebar }));
vi.mock('@/components/optimizer/OptimizerSolutionCard.vue', async () => ({ default: makeStubComponents().Card }));
vi.mock('@/components/optimizer/OptimizerInventoryPanel.vue', async () => ({ default: makeStubComponents().Panel }));
vi.mock('@/lib/optimizer-client', async () => {
  const core = await import('@/lib/optimizer-core');
  return {
    createOptimizerClient: () => ({
      run: async (input: any) => [await core.optimizeFull(input)],
      terminate() {},
    }),
  };
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const T = 'lunar-totem-4';
// `loadConfig()` hands out lib's shared `perfectShipsConfig` object and `setPlayerData` mutates it through the
// ref, so a snapshot taken before any test keeps one test's save from leaking ship levels into the next.
const PRISTINE_CONFIG = JSON.parse(JSON.stringify((await import('lib')).perfectShipsConfig));
let store: typeof import('@/store');
let plan: typeof import('@/store/plan');
let Comp: any;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/', search: '' } });
  vi.stubGlobal('localStorage', memoryStorage());
  (globalThis as any).__b5saved = undefined;
  (globalThis as any).__b5rfc = async () => ({});
  store = await import('@/store');
  store.config.value = JSON.parse(JSON.stringify(PRISTINE_CONFIG));
  plan = await import('@/store/plan');
  const read = await import('@/lib/plan/read');
  plan.setLoadedPlan('fixture', read.sliceHumilityVisits(read.parsePlanSave(fixture('ascension-plan.json'))));
  Comp = (await import('@/components/ArtifactMissionOptimizer.vue')).default;
});

afterEach(() => unmountAll());

const visits = () => plan.loadedPlan.value!.visits;
const solved = () => plan.loadedPlan.value!.solved;
const marker = (visitId: string) => ({
  ...fixture('humility-missions.json').visits[0],
  visitId,
  jointProbability: 0.5,
  gemBudget: 123,
});

async function solveOn(m: ReturnType<typeof mountOptimizer>, visitId: string, ids = [T], wait = '2d') {
  plan.setCurrentVisit(visitId, ids);
  plan.setVisitWaitTime(visitId, wait);
  m.ids.value = ids;
  await settle(m.inst);
}


describe('STA-01 (fetch failure half): the first-contact rejection is unhandled', () => {
  it('a failing requestFirstContact on page load is handled (no unhandled promise rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      (globalThis as any).window.location.search = '?playerId=EI1111111111111111';
      (globalThis as any).__b5rfc = () => Promise.reject(new Error('network down'));
      const [a] = visits();
      plan.setCurrentVisit(a.visitId, [T]);
      const m = mountOptimizer(Comp, [T]);
      await sleep(300);
      m.unmount();
      console.log('STA-01 unhandled rejections:', unhandled.map(String));
      // BREAKAGE STA-01
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 60000);
});
