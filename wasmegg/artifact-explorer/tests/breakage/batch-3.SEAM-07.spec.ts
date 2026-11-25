// SEAM-07: with overrides.epicResearchFTLLevel set, the explorer solves at the override level while
// the planner reschedules at the plan's own `afx_mission_time`. The file records no FTL level.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ei, MissionType } from 'lib';
import { parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { visitOf } from './batch-3.helpers';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
let store: typeof import('@/store');
let plan: typeof import('@/store/plan');

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/' } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  store = await import('@/store');
  plan = await import('@/store/plan');
  store.clearPlayerData();
});

describe('SEAM-07 FTL override', () => {
  it('the FTL the explorer solves at equals the FTL the planner will schedule at (BREAKAGE SEAM-07)', () => {
    const visits = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))).map(v => ({
      ...v,
      epicResearchFTLLevel: 0, // the plan's afx_mission_time
    }));
    plan.setLoadedPlan('fixture', visits);
    plan.setCurrentVisit(visits[0].visitId);
    store.setOverrideFTL(true);
    store.setEpicResearchFTLLevel(60);

    const solvedFtl = store.effectiveConfig.value.epicResearchFTLLevel;
    const planFtl = plan.activePlanVisit.value!.epicResearchFTLLevel;

    // One Atreggies EPIC per slot: the makespan is the single mission's duration.
    const epic = (ei.MissionInfo.DurationType as unknown as Record<string, number>)['EPIC'];
    const explorerMakespan = new MissionType(
      ei.MissionInfo.Spaceship.ATREGGIES,
      epic as ei.MissionInfo.DurationType
    ).boostedDurationSeconds(store.effectiveConfig.value);
    const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }];
    const plannerMakespan = launchSchedule(resolveLaunches(visitOf({ launches })), planFtl).totalSeconds;
    console.log({ solvedFtl, planFtl, explorerMakespan, plannerMakespan, ratio: plannerMakespan / explorerMakespan });

    // BREAKAGE SEAM-07
    expect(plannerMakespan).toBeCloseTo(explorerMakespan, 3);
  });
});
