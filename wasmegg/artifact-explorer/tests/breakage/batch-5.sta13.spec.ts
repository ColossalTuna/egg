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
// Fault injection: the wasm solver throws out of Highs_run ("HiGHS error -1"), the case highs.ts:34-38 catches.
vi.mock('highs', () => ({
  default: async () => ({
    solve: () => {
      throw new Error('HiGHS error -1');
    },
  }),
}));
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


describe('STA-13: a HiGHS exception silently records an empty plan', () => {
  it('a solver throw surfaces as an error (or no recorded answer), not as a recorded zero-launch plan', async () => {
    const [a] = visits();
    const m = mountOptimizer(Comp, [T]);
    plan.setCurrentVisit(a.visitId, [T]);
    plan.setVisitWaitTime(a.visitId, '2d');
    await settle(m.inst);
    const rec = solved()[a.visitId];
    console.log('STA-13 computeError', JSON.stringify(m.inst.value.computeError), 'recorded', !!rec, 'launches', rec?.launches.length, 'joint', rec?.jointProbability);
    // BREAKAGE STA-13
    expect(m.inst.value.computeError !== '' || rec === undefined || rec.launches.length > 0).toBe(true);
    m.unmount();
  }, 120000);
});
