// SEAM-10: in full-tank mode the explorer's pooled capacity is the whole tank, ignoring fuel already
// stored on arrival (including other eggs). AP's per-step validateTank sums the real contents.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ei } from 'lib';
import { parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { fuelForLaunches } from 'lib/planners/rockets/launches';
import { resolveLaunches } from '@planner/lib/humilityMissions';
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

describe('SEAM-10 full-tank budget ignores stored fuel', () => {
  it('pooled budget leaves room for what is stored, so the answer stages (BREAKAGE SEAM-10)', () => {
    // Tank level 7 (500e12), 450e12 of it already curiosity on arrival.
    const visits = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))).map(v => ({
      ...v,
      tankLevel: 7,
      fuelByEgg: new Map([[ei.Egg.CURIOSITY, 450e12]]),
    }));
    planStore.setLoadedPlan('fixture', visits);
    planStore.setCurrentVisit(visits[0].visitId);
    planStore.setVisitFuelBudget(visits[0].visitId, 'full-tank');
    expect(store.effectiveFuelByEggCapacity.value).toBeNull();
    const pooled = store.effectiveFuelTankCapacity.value;

    // K5: the pooled budget is the tank less what is stored: 500e12 - 450e12 = 50e12.
    expect(pooled).toBe(50e12);
    // The answer fills the pooled budget with integrity: 1000 Quintillion EPIC = 50e12 integrity.
    const launches = [{ ship: 'MILLENIUM_CHICKEN', duration: 'EPIC', targetAfxId: 0, count: 1000 }];
    const fuel = fuelForLaunches(resolveLaunches(visitOf({ launches })));
    expect(fuel.integrity).toBe(50e12);
    expect(fuel.integrity).toBeLessThanOrEqual(pooled);

    const base = baseState(7);
    base.fuelTankAmounts.curiosity = 450e12;
    // BREAKAGE SEAM-10 (was: AP threw "would overflow the fuel tank" (750e12 in a 500e12 tank) for a 300e12 answer).
    expect(() => stageAt(0, plan(), visitOf({ launches }), base)).not.toThrow();
  });
});
