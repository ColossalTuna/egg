// SEAM-09: overrides.tankLevel (or a full-tank visit) lets the explorer budget fuel against a bigger
// tank than the plan has; AP's validateTank then refuses the visit as an overflow.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { fuelForLaunches } from 'lib/planners/rockets/launches';
import { resolveLaunches } from '@planner/lib/humilityMissions';
import { TANK_CAPACITIES } from '@planner/stores/fuelTank';
import { baseState, plan, stageAt, visitOf } from './batch-3.helpers';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
let store: typeof import('@/store');
let planStore: typeof import('@/store/plan');

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/' } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  store = await import('@/store');
  planStore = await import('@/store/plan');
  store.clearPlayerData();
});

describe('SEAM-09 tank-level override', () => {
  it('an explorer answer within its budgeted tank stages in a plan with a smaller tank (BREAKAGE SEAM-09)', () => {
    const visits = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))).map(v => ({ ...v, tankLevel: 4 }));
    planStore.setLoadedPlan('fixture', visits);
    planStore.setCurrentVisit(visits[0].visitId);
    store.setOverrideTankLevel(true);
    store.setTankLevel(7);
    planStore.setVisitFuelBudget(visits[0].visitId, 'full-tank'); // pooled tank row

    const explorerCapacity = store.effectiveFuelTankCapacity.value;
    expect(explorerCapacity).toBe(500e12);
    expect(store.effectiveFuelByEggCapacity.value).toBeNull();

    // 2 Atreggies EPIC need 330e12 of non-Humility fuel: inside the 500e12 the explorer budgeted against.
    const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 2 }];
    const fuel = fuelForLaunches(resolveLaunches(visitOf({ launches })));
    const nonHumility = fuel.curiosity + fuel.integrity + fuel.resilience + fuel.kindness;
    expect(nonHumility).toBeLessThanOrEqual(explorerCapacity);
    expect(nonHumility).toBeGreaterThan(TANK_CAPACITIES[4]);

    // BREAKAGE SEAM-09: the planner throws "would overflow the fuel tank" for this answer.
    expect(() => stageAt(0, plan(), visitOf({ launches }), baseState(4))).not.toThrow();
  });
});
