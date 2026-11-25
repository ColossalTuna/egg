// Batch 5: persistence and plan-reading scenarios that need no component (store + lib only).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ei } from 'lib';
import { gemBudgetFor, parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { buildHumilityMissionsFile, projectSolvedVisit } from '@/lib/plan/write';
import { makeSolution } from '../unit/spec-helpers';
import { memoryStorage } from './batch-5.harness';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
type PlanMod = typeof import('@/store/plan');
let storage: Record<string, any>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/', search: '' } });
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

const freshPlan = async (): Promise<PlanMod> => {
  vi.resetModules();
  return import('@/store/plan');
};
const marker = (visitId: string, over: Record<string, unknown> = {}) => ({
  ...fixture('humility-missions.json').visits[0],
  visitId,
  ...over,
});
function planKey(): string {
  const k = Object.keys(storage).find(key => key.endsWith('humility_plan'));
  if (!k) throw new Error('no persisted plan; keys: ' + Object.keys(storage).join(','));
  return k;
}
/** Persist a plan with `solved[A]` = overrides, optionally edit the raw blob, then "reload the page". */
async function reloadWith(over: Record<string, unknown>, editBlob?: (blob: any) => void): Promise<PlanMod> {
  const p = await freshPlan();
  p.setLoadedPlan('fixture', sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))));
  const a = p.loadedPlan.value!.visits[0];
  p.recordSolvedVisit(marker(a.visitId, over) as any);
  if (editBlob) {
    const blob = JSON.parse(storage[planKey()]);
    editBlob(blob);
    storage[planKey()] = JSON.stringify(blob);
  }
  return freshPlan();
}

describe('STA-04 / SEAM-13: reloaded answers are not re-validated', () => {
  it('STA-04: a stored solved entry with gemBudget null is not shown as solved', async () => {
    const p = await reloadWith({ gemBudget: null });
    console.log('STA-04(a) solvedVisitCount after reload:', p.solvedVisitCount.value);
    // BREAKAGE STA-04: the planner rejects the whole export on gemBudget null
    expect(p.solvedVisitCount.value).toBe(0);
  });

  it('STA-04: a stored solved entry with jointProbability 1.2 is not shown as solved', async () => {
    const p = await reloadWith({ jointProbability: 1.2 });
    console.log('STA-04(b) solvedVisitCount after reload:', p.solvedVisitCount.value);
    // BREAKAGE STA-04: the planner rejects jointProbability > 1
    expect(p.solvedVisitCount.value).toBe(0);
  });

  it('STA-04: a stored visit missing earningsPerSecond does not load as a visit with an undefined budget input', async () => {
    const p = await reloadWith({}, blob => delete blob.visits[0].earningsPerSecond);
    const v = p.loadedPlan.value?.visits[0];
    console.log('STA-04(c) reloaded earningsPerSecond:', v?.earningsPerSecond, 'gemBudgetFor:', v && gemBudgetFor(v, 3600));
    // BREAKAGE STA-04: either the plan is rejected or the visit is complete; never a NaN budget input
    expect(v === undefined || Number.isFinite(gemBudgetFor(v, 3600))).toBe(true);
  });

  it('SEAM-13: a stored answer launching a ship name the app no longer knows is not shown as solved', async () => {
    const p = await reloadWith({
      launches: [{ ship: 'REMOVED_SHIP', duration: 'SHORT', targetAfxId: 0, count: 3 }],
    });
    console.log('SEAM-13 solvedVisitCount after reload:', p.solvedVisitCount.value);
    // BREAKAGE SEAM-13
    expect(p.solvedVisitCount.value).toBe(0);
  });
});

describe('STA-15: two open tabs overwrite each other', () => {
  it('an answer recorded in tab 1 survives tab 2 recording a different visit', async () => {
    const tab1 = await freshPlan();
    tab1.setLoadedPlan('fixture', sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))));
    const [a, b] = tab1.loadedPlan.value!.visits;
    const tab2 = await freshPlan(); // opened earlier than the solve below; has read the same stored plan
    expect(tab2.loadedPlan.value).not.toBeNull();
    tab1.recordSolvedVisit(marker(a.visitId) as any);
    tab2.recordSolvedVisit(marker(b.visitId) as any);
    const reloaded = await freshPlan();
    const kept = Object.keys(reloaded.loadedPlan.value!.solved).sort();
    console.log('STA-15 solved after reload:', kept, 'expected both:', [a.visitId, b.visitId].sort());
    // BREAKAGE STA-15
    expect(kept).toEqual([a.visitId, b.visitId].sort());
  });
});

describe('STA-25: duplicate or non-string action ids', () => {
  const planWithHumilityActions = (ids: unknown[]) => {
    const raw = fixture('ascension-plan.json');
    const byId = (id: string) => raw.actions.find((a: any) => a.id === id);
    const start = byChange();
    function byChange() {
      return byId('start_a0a0a0a');
    }
    const humility = byId('shift_a1b2c3d');
    const away = byId('shift_c3c3c3c');
    // humility run, away, humility run, away, ...: one visit per humility action
    const actions: any[] = [start];
    ids.forEach((id, i) => {
      actions.push({ ...humility, id });
      if (i < ids.length - 1) actions.push({ ...away, id: `away_${i}` });
    });
    return { ...raw, actions };
  };

  it('two Humility runs entered by actions sharing an id get distinct visit ids', () => {
    const visits = sliceHumilityVisits(parsePlanSave(planWithHumilityActions(['dup', 'dup'])));
    console.log('STA-25 duplicate visit ids:', visits.map(v => v.visitId));
    // BREAKAGE STA-25: the planner rejects "Duplicate Humility visit id or index"
    expect(new Set(visits.map(v => v.visitId)).size).toBe(visits.length);
  });

  it('a numeric action id does not become a non-string visit id', () => {
    const [v] = sliceHumilityVisits(parsePlanSave(planWithHumilityActions([7])));
    console.log('STA-25 numeric id ->', typeof v.visitId, v.visitId);
    // BREAKAGE STA-25: the planner's requireString rejects a non-string visit id
    expect(typeof v.visitId).toBe('string');
  });

  it('an empty action id does not become an empty visit id', () => {
    const [v] = sliceHumilityVisits(parsePlanSave(planWithHumilityActions([''])));
    console.log('STA-25 empty id ->', JSON.stringify(v.visitId));
    // BREAKAGE STA-25: the planner's requireString rejects an empty visit id
    expect(v.visitId.trim()).not.toBe('');
  });
});

describe('STA-27: a plan that opens on Humility', () => {
  it('characterization (not an intended-behaviour assertion): the rate is the arriving action own end state', () => {
    const raw = fixture('ascension-plan.json');
    const arrival = { ...raw.actions.find((a: any) => a.id === 'shift_a1b2c3d') };
    arrival.endState = { ...arrival.endState, onlineEarnings: 10, offlineEarnings: 4 }; // one-chicken trough after a shift
    const [v] = sliceHumilityVisits(parsePlanSave({ ...raw, actions: [arrival] }));
    console.log('STA-27 earningsPerSecond', v.earningsPerSecond, 'plannedDuration', v.plannedDurationSeconds);
    expect(v.earningsPerSecond).toBe(10);
  });
});

describe('STA-30: overflowing plan budgets', () => {
  it('gemBudgetFor stays finite for a large-but-valid plan and a long override', () => {
    const v = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json')))[0];
    v.earningsPerSecond = 1e300; // requireNumber accepts any finite non-negative number
    const budget = gemBudgetFor(v, 1e10);
    console.log('STA-30 gemBudgetFor', budget);
    // BREAKAGE STA-30
    expect(Number.isFinite(budget)).toBe(true);
  });

  it('an exported file never carries gemBudget null (JSON of Infinity)', () => {
    const v = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json')))[0];
    v.earningsPerSecond = 1e300;
    const gemBudget = gemBudgetFor(v, 1e10);
    const projected = projectSolvedVisit({ visit: v, solution: makeSolution({}), effort: 'medium', gemBudget });
    const file = JSON.parse(JSON.stringify(buildHumilityMissionsFile('p', [projected])));
    console.log('STA-30 exported gemBudget', file.visits[0].gemBudget);
    // BREAKAGE STA-30: the planner rejects gemBudget null
    expect(typeof file.visits[0].gemBudget).toBe('number');
  });
});
void ei;
