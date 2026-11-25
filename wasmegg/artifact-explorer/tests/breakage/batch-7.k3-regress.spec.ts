// Batch 7: regressions introduced by K3's solve-record lifecycle (SAT-STATE-01, 04, 05, 09, 10, 14, 22).
// Component tests drive the REAL ArtifactMissionOptimizer.vue with the batch-5 headless renderer; only the
// worker transport, the three presentational children and the network are stubbed. Store tests import the
// real store/plan.ts; two "tabs" are two module instances sharing one fake localStorage.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBackup, makeStubComponents, memoryStorage, mountOptimizer, settle, unmountAll } from './batch-5.harness';

vi.mock('lib', async importOriginal => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requestFirstContact: (id: string) => (globalThis as any).__b7rfc(id),
    getSavedPlayerID: () => (globalThis as any).__b7saved,
    savePlayerID: () => {},
  };
});
vi.mock('@/components/optimizer/OptimizerSidebar.vue', async () => ({ default: makeStubComponents().Sidebar }));
vi.mock('@/components/optimizer/OptimizerSolutionCard.vue', async () => ({ default: makeStubComponents().Card }));
vi.mock('@/components/optimizer/OptimizerInventoryPanel.vue', async () => ({ default: makeStubComponents().Panel }));
// Only for the SAT-STATE-14 render of the real sidebar: the setting rows pull in a ui component that imports
// `ui/...` from inside the ui package, which this vitest config does not resolve. The copy under test is not
// in them.
vi.mock('@/components/optimizer/OptimizerSettingRow.vue', () => ({ default: { render: () => null } }));
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
const A = 'EI1111111111111111';
// `setPlayerData` mutates lib's shared ships config through the ref; restore it per load.
const PRISTINE_CONFIG = JSON.parse(JSON.stringify((await import('lib')).perfectShipsConfig));
const { ei, spaceshipList } = await import('lib');

let store: typeof import('@/store');
let plan: typeof import('@/store/plan');
let Comp: any;

// A save with every ship launched often enough to be unlocked and levelled.
function richBackup(eid: string): any {
  const b = makeBackup(eid, { craftingXp: 5e6 });
  b.artifactsDb.missionArchive = spaceshipList.flatMap((ship: any) =>
    Array.from({ length: 80 }, () => ({
      ship,
      durationType: ei.MissionInfo.DurationType.EPIC,
      status: ei.MissionInfo.Status.COMPLETE,
    }))
  );
  return b;
}
const saveOfA = async () => ({ backup: richBackup(A) });

/** A page (re)load: fresh modules over the same localStorage. `first` loads the fixture plan. */
async function load(first: boolean) {
  vi.resetModules();
  store = await import('@/store');
  store.config.value = JSON.parse(JSON.stringify(PRISTINE_CONFIG));
  plan = await import('@/store/plan');
  if (first) {
    const read = await import('@/lib/plan/read');
    plan.setLoadedPlan('fixture', read.sliceHumilityVisits(read.parsePlanSave(fixture('ascension-plan.json'))));
  }
  Comp = (await import('@/components/ArtifactMissionOptimizer.vue')).default;
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/', search: '' } });
  vi.stubGlobal('localStorage', memoryStorage());
  (globalThis as any).__b7saved = undefined;
  (globalThis as any).__b7rfc = async () => ({});
});
afterEach(() => unmountAll());

const visits = () => plan.loadedPlan.value!.visits;
const solvedIds = () => Object.keys(plan.loadedPlan.value!.solved).sort();
const storedBlob = () => {
  const ls = (globalThis as any).localStorage;
  const k = Object.keys(ls).find(key => key.endsWith('humility_plan'));
  return k ? JSON.parse(ls[k]) : null;
};

async function solveOn(m: ReturnType<typeof mountOptimizer>, visitId: string) {
  plan.setCurrentVisit(visitId, [T]);
  plan.setVisitWaitTime(visitId, '2d');
  m.ids.value = [T];
  await settle(m.inst);
}

/** Player A's save loaded, H1 and H2 solved (H2 active). Returns the mounted page and the two ids. */
async function twoSolved() {
  (globalThis as any).__b7saved = A;
  (globalThis as any).__b7rfc = saveOfA;
  await load(true);
  const [h1, h2] = visits().map(v => v.visitId);
  const m = mountOptimizer(Comp, [T]);
  store.setEffort('medium');
  await solveOn(m, h1);
  await solveOn(m, h2);
  expect(solvedIds()).toEqual([h1, h2].sort());
  return { m, h1, h2 };
}

describe('SAT-STATE-01: a failed or empty save fetch on reload keeps the recorded answers', () => {
  for (const [name, rfc] of [
    ['rejects', () => Promise.reject(new Error('network down'))],
    ['returns no backup', async () => ({ errorCode: 500 })],
  ] as const) {
    it(`first contact ${name}: both answers survive, in memory and in storage, and after the network is back`, async () => {
      const { m, h1, h2 } = await twoSolved();
      m.unmount();
      (globalThis as any).__b7rfc = rfc;
      await load(false);
      expect(solvedIds()).toEqual([h1, h2].sort());
      const m2 = mountOptimizer(Comp, [T]);
      await settle(m2.inst, 1500);
      expect(solvedIds()).toEqual([h1, h2].sort());
      expect(Object.keys(storedBlob().solved).sort()).toEqual([h1, h2].sort());
      expect(m2.inst.value.playerLoadError).not.toBe(''); // the failure is reported
      m2.unmount();

      (globalThis as any).__b7rfc = saveOfA;
      await load(false);
      const m3 = mountOptimizer(Comp, [T]);
      await settle(m3.inst, 1500);
      expect(solvedIds()).toEqual([h1, h2].sort());
      m3.unmount();
    }, 300000);
  }
});

describe('SAT-STATE-09: display-only config toggles do not change the inputs key', () => {
  it('ticking a drop-stats target checkbox (config.targets) keeps every answer', async () => {
    const { m, h1, h2 } = await twoSolved();
    const k = Object.keys(store.config.value.targets)[0] as any;
    store.config.value.targets[k] = !store.config.value.targets[k];
    await settle(m.inst, 1000);
    expect(solvedIds()).toEqual([h1, h2].sort());
    m.unmount();
  }, 300000);
});

describe('SAT-STATE-10 (K3 side): the tank-level override is not part of the inputs key', () => {
  it('ticking Override on the tank row and setting a level does not delete the other visit answer', async () => {
    const { m, h1, h2 } = await twoSolved();
    store.setOverrideTankLevel(true);
    store.setTankLevel(3);
    await settle(m.inst, 1000);
    expect(solvedIds()).toEqual([h1, h2].sort());
    m.unmount();
  }, 300000);
});

describe('SAT-STATE-22: another spelling of the same player id is the same player', () => {
  it('resubmitting the id as "mk2!EI..." (same save) keeps every answer', async () => {
    const { m, h1, h2 } = await twoSolved();
    await m.inst.value.submitPlayerId('mk2!' + A);
    await settle(m.inst, 1500);
    expect(solvedIds()).toEqual([h1, h2].sort());
    for (const key of Object.values(plan.loadedPlan.value!.solvedInputs)) expect(JSON.parse(key).player).toBe(A);
    m.unmount();
  }, 300000);
});

// ---------------------------------------------------------------------------------------------------------
// Store level: two tabs, one localStorage.
// ---------------------------------------------------------------------------------------------------------

type PlanMod = typeof import('@/store/plan');
const answer = (visitId: string, extra: Record<string, unknown> = {}) => ({
  ...fixture('humility-missions.json').visits[0],
  visitId,
  jointProbability: 0.5,
  gemBudget: 123,
  ...extra,
});
async function newTab(first = false): Promise<PlanMod> {
  vi.resetModules();
  const p = await import('@/store/plan');
  if (first) {
    const read = await import('@/lib/plan/read');
    p.setLoadedPlan('P1', read.sliceHumilityVisits(read.parsePlanSave(fixture('ascension-plan.json'))));
  }
  return p;
}
const idsOf = (p: PlanMod) => p.loadedPlan.value!.visits.map(v => v.visitId);

describe('SAT-STATE-04: a tab takes in another tab answer only under its own inputs key', () => {
  it('tab 2 (effort medium) does not export tab 1 answer (effort max); tab 1 keeps it after tab 2 key changes', async () => {
    const t1 = await newTab(true);
    const [h1, h2] = idsOf(t1);
    const t2 = await newTab(false);
    t1.recordSolvedVisit(answer(h1, { effort: 'max' }) as any, 'KEY{effort:max}');
    t2.recordSolvedVisit(answer(h2, { effort: 'medium' }) as any, 'KEY{effort:medium}');
    const p2 = t2.loadedPlan.value!;
    const exported = p2.visits.map(v => p2.solved[v.visitId]).filter(Boolean);
    expect(exported.map(v => v.effort)).toEqual(['medium']);
    expect(t2.solvedVisitCount.value).toBe(1);

    t2.retainSolvedVisitsMatching('KEY{effort:medium,crafting:30}');
    t1.setCurrentVisit(h1); // any write syncs
    expect(t1.loadedPlan.value!.solved[h1]?.effort).toBe('max');
    expect(t1.loadedPlan.value!.solved[h2]).toBeUndefined();
  });
});

describe('SAT-STATE-05: a failed storage write does not roll back the tab own answer', () => {
  it('after a quota failure the answer stays in memory through the next sync, and the failure is reported', async () => {
    let failing = false;
    const backing: Record<string, any> = memoryStorage();
    vi.stubGlobal(
      'localStorage',
      new Proxy(backing, {
        set(target, key: string, value) {
          if (failing && key.endsWith('humility_plan')) throw new DOMException('quota', 'QuotaExceededError');
          target[key] = value;
          return true;
        },
      })
    );
    const t = await newTab(true);
    const [h1, h2] = idsOf(t);
    failing = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      t.recordSolvedVisit(answer(h1) as any, 'K');
      t.setCurrentVisit(h2); // what the visit picker does; syncs first
      expect(t.loadedPlan.value!.solved[h1]).toBeDefined();
      expect(t.solvedVisitCount.value).toBe(1);
      expect(t.planChangedInAnotherTab.value).toBe(false);
      expect((t as any).planSaveFailed?.value).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Sidebar copy: the real OptimizerSidebar.vue rendered with vue/server-renderer.
// ---------------------------------------------------------------------------------------------------------

describe('SAT-STATE-14: the gem cap is described as the total budget for the plan', () => {
  it('plan and custom (Override) modes say total budget, not per ship', async () => {
    const { renderToString } = await import('vue/server-renderer');
    const { createSSRApp } = await import('vue');
    await load(true);
    plan.setCurrentVisit(visits()[0].visitId, [T]);
    const Sidebar = ((await vi.importActual('@/components/optimizer/OptimizerSidebar.vue')) as any).default;
    const render = async () => {
      const { createPinia } = await import('pinia');
      const app = createSSRApp(Sidebar, {
        playerId: '',
        waitTimeDays: '2d',
        exportBlocked: false,
        timeBudgetInvalid: false,
      });
      app.use(createPinia());
      app.directive('tippy', { getSSRProps: () => ({}) });
      return (await renderToString(app))
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
    };
    const planMode = await render();
    expect(planMode).not.toMatch(/Per ship/i);
    expect(planMode).toMatch(/Total budget for the plan/);
    store.setGemCostMode('custom');
    const customMode = await render();
    expect(customMode).not.toMatch(/Only schedule ships costing at most/);
    expect(customMode).toMatch(/Total budget for the plan/);
  }, 120000);
});
