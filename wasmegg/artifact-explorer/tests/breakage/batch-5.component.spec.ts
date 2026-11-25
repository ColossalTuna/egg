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

describe('SEAM-12 / STA-02: global setting changes leave other visits answers recorded', () => {
  it('SEAM-12: after effort changes to max, no recorded answer still says another effort', async () => {
    store.setEffort('medium');
    const [a, b] = visits();
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId);
    await solveOn(m, b.visitId);
    expect(Object.keys(solved()).sort()).toEqual([a.visitId, b.visitId].sort());
    await solveOn(m, a.visitId); // switch back to H1
    store.setEffort('max');
    await settle(m.inst);
    const efforts = Object.fromEntries(Object.entries(solved()).map(([k, v]) => [k === a.visitId ? 'H1' : 'H2', v.effort]));
    console.log('SEAM-12 efforts after switching effort to max:', JSON.stringify(efforts));
    // BREAKAGE SEAM-12: H2 should be dropped (or re-solved) once the global effort changed
    for (const v of Object.values(solved())) expect(v.effort).toBe('max');
    m.unmount();
  }, 300000);

  it('STA-02: after crafting level 20 -> 30, the answer solved at level 20 is not still recorded', async () => {
    const [a, b] = visits();
    store.setCraftingLevel(20);
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId);
    expect(solved()[a.visitId]).toBeDefined();
    await solveOn(m, b.visitId); // switch to B (crafting level still 20)
    store.setCraftingLevel(30);
    await settle(m.inst);
    console.log('STA-02 recorded visits after level change:', Object.keys(solved()).length, 'A kept:', !!solved()[a.visitId]);
    // BREAKAGE STA-02: A was computed at level 20; it must not remain recorded next to B (level 30)
    expect(solved()[a.visitId]).toBeUndefined();
    m.unmount();
  }, 300000);
});

describe('STA-16: invalid global input keeps the old answer', () => {
  it('typing "abc" as craft cap drops (or keeps nothing stale of) the active visit answer', async () => {
    const [a] = visits();
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId);
    expect(solved()[a.visitId]).toBeDefined();
    store.setMaxGoldenEggCostEnabled(true);
    store.setCraftingCostInput('abc');
    await settle(m.inst);
    console.log('STA-16 inputsValid:', m.inst.value.inputsValid, 'solved A kept:', !!solved()[a.visitId]);
    expect(m.inst.value.inputsValid).toBe(false);
    // BREAKAGE STA-16: the answer to a question that can no longer be posed must go
    expect(solved()[a.visitId]).toBeUndefined();
    m.unmount();
  }, 300000);

  it('STA-16 flow: A solved at cap 2M, cap turned invalid on A, fixed to 50M on B: export must not carry A', async () => {
    const [a, b] = visits();
    store.setMaxGoldenEggCostEnabled(true);
    store.setCraftingCostInput('2M');
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId);
    store.setCraftingCostInput('abc');
    await solveOn(m, b.visitId); // still invalid: nothing solves
    store.setCraftingCostInput('50M');
    await settle(m.inst);
    const exported = visits().map(v => solved()[v.visitId]).filter(Boolean);
    console.log('STA-16 flow exported visits:', exported.map(v => v.visitId));
    // BREAKAGE STA-16: A (cap 2M) would be exported beside B (cap 50M)
    expect(exported.map(v => v.visitId)).toEqual([b.visitId]);
    m.unmount();
  }, 300000);
});

describe('STA-03 / STA-21: player data replaced', () => {
  it('STA-03: submitting a different player id leaves no answers built from player 1', async () => {
    const [a, b] = visits();
    store.setPlayerData(makeBackup('EI1111111111111111', { craftingXp: 5e6 }));
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId);
    await solveOn(m, b.visitId);
    expect(Object.keys(solved()).length).toBe(2);
    (globalThis as any).__b5rfc = async () => ({ backup: makeBackup('EI2222222222222222', { craftingXp: 0 }) });
    await m.inst.value.submitPlayerId('EI2222222222222222'); // what the sidebar's submit-player-id event calls
    await settle(m.inst, 800);
    console.log('STA-03 solved after player switch:', Object.keys(solved()).length, 'A kept:', !!solved()[a.visitId]);
    // BREAKAGE STA-03: A was solved with player 1 data
    expect(solved()[a.visitId]).toBeUndefined();
    m.unmount();
  }, 300000);

  it('STA-21: a save without artifactsDb must not leave player 1 data behind a new player id', async () => {
    store.setPlayerData(makeBackup('EI1111111111111111'));
    const inv1 = store.playerInventory.value;
    expect(inv1).not.toBeNull();
    const m = mountOptimizer(Comp, [T]);
    (globalThis as any).__b5rfc = async () => ({ backup: { eiUserId: 'EI2222222222222222', game: { epicResearch: [] } } });
    await m.inst.value.submitPlayerId('EI2222222222222222');
    await sleep(200);
    const shownId = m.inst.value.playerId;
    console.log('STA-21 playerId shown:', shownId, 'inventory is still player 1:', store.playerInventory.value === inv1);
    expect(shownId).toBe('EI2222222222222222');
    // BREAKAGE STA-21: new id shown but player 1 inventory still in place
    expect(store.playerInventory.value).not.toBe(inv1);
    m.unmount();
  }, 120000);
});

describe('empty solutions recorded as answers', () => {
  it('STA-05: plan price mode that filters every ship does not record an empty answer', async () => {
    const [a] = visits();
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId, [T], '12h'); // control: the fixture's rich bank affords ships
    expect(solved()[a.visitId].launches.length).toBeGreaterThan(0);
    a.bankValue = 0;
    a.earningsPerSecond = 1; // gemBudgetFor(12h) = 43200 << 9.7e9
    await settle(m.inst);
    const rec = solved()[a.visitId];
    console.log('STA-05 gemBudget', rec?.gemBudget, 'launches', rec?.launches.length, 'computeError', JSON.stringify(m.inst.value.computeError));
    // BREAKAGE STA-05: zero-launch result must not be recorded as a solved visit
    expect(rec === undefined || rec.launches.length > 0).toBe(true);
    m.unmount();
  }, 300000);

  it('STA-07: effort low with a 12h budget does not record an empty answer', async () => {
    const [a] = visits();
    store.setEffort('medium');
    const m = mountOptimizer(Comp, [T]);
    await solveOn(m, a.visitId, [T], '12h');
    store.setGemCostMode('unlimited');
    await settle(m.inst);
    expect(solved()[a.visitId].launches.length).toBeGreaterThan(0); // control: medium effort launches fine
    store.setEffort('low'); // 86400 s launch period > 12h budget
    await settle(m.inst);
    const rec = solved()[a.visitId];
    console.log('STA-07 launches', rec?.launches.length, 'computeError', JSON.stringify(m.inst.value.computeError));
    // BREAKAGE STA-07
    expect(rec === undefined || rec.launches.length > 0).toBe(true);
    m.unmount();
  }, 300000);

  it('STA-09: a visit with no targets is not recorded as solved', async () => {
    const [a] = visits();
    const m = mountOptimizer(Comp, []);
    plan.setCurrentVisit(a.visitId, [T]);
    plan.setVisitTargets(a.visitId, []); // explicit empty, allowed by plan-store.spec.ts:102
    plan.setVisitWaitTime(a.visitId, '2d');
    await settle(m.inst);
    const rec = solved()[a.visitId];
    console.log('STA-09 recorded', !!rec, 'launches', rec?.launches.length, 'targets', rec?.targets.length, 'joint', rec?.jointProbability, 'computeError', JSON.stringify(m.inst.value.computeError));
    // BREAKAGE STA-09
    expect(rec).toBeUndefined();
    m.unmount();
  }, 300000);
});

describe('STA-01: page-load solve before the save arrives', () => {
  it('does not overwrite a recorded answer with one built from placeholder inputs while the save is still loading', async () => {
    const [a] = visits();
    plan.setCurrentVisit(a.visitId, [T]);
    plan.setVisitWaitTime(a.visitId, '2d');
    plan.recordSolvedVisit(marker(a.visitId));
    (globalThis as any).window.location.search = '?playerId=EI1111111111111111';
    (globalThis as any).__b5rfc = () =>
      new Promise(res => setTimeout(() => res({ backup: makeBackup('EI1111111111111111') }), 6000));
    const m = mountOptimizer(Comp, [T]);
    await settle(m.inst, 600); // solve runs without any save; the fetch is still pending
    const rec = solved()[a.visitId];
    console.log('STA-01 inventory loaded:', !!store.playerInventory.value, 'recorded:', JSON.stringify({ joint: rec?.jointProbability, launches: rec?.launches.length, gemBudget: rec?.gemBudget, targets: rec?.targets.length }), '(marker joint 0.5 gemBudget 123)');
    expect(store.playerInventory.value).toBeNull(); // precondition: still no save
    // BREAKAGE STA-01
    expect(rec.jointProbability).toBe(0.5);
    m.unmount();
    await sleep(6000);
  }, 300000);
});
