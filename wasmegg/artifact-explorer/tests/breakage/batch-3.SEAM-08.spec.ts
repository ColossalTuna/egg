// SEAM-08: AP reads FTL at stage time (context.epicResearchLevels.afx_mission_time), not at export
// time, and the file carries no FTL. Editing epic research after export changes durations silently.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { projectSolvedVisit } from '@/lib/plan/write';
import type { HumilityVisit } from '@/lib/plan/read';
import type { OptimizerSolution } from '@/lib/types';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }];

describe('SEAM-08 FTL edited after export', () => {
  it('control: staging at the export-time FTL reproduces the file window', () => {
    const makespanSeconds = launchSchedule(resolveLaunches(visitOf({ launches })), 55).totalSeconds; // 155520
    const staged = stageAt(55, plan(), visitOf({ launches, makespanSeconds }));
    const launch = staged.find(a => a.type === 'launch_missions')!;
    expect(launch.totalTimeSeconds).toBeCloseTo(makespanSeconds, 3);
  });

  it('staging at a different FTL than the file was solved at is not silent (BREAKAGE SEAM-08)', () => {
    const makespanSeconds = launchSchedule(resolveLaunches(visitOf({ launches })), 55).totalSeconds;
    const v = visitOf({ launches, makespanSeconds });
    // BREAKAGE SEAM-08: expected an error (or a warning/recorded FTL); actual is a quiet 2.2x longer launch.
    expect(() => stageAt(0, plan(), v)).toThrow();
  });

  it('the writer records the FTL the visit was solved at (BREAKAGE SEAM-08)', () => {
    const solution = {
      timeUnitsUsed: 155520, runningTimeSeconds: 155520, fuelByEgg: new Map(), choiceHistory: [], perTarget: [],
      jointProbability: 0,
    } as unknown as OptimizerSolution;
    const out = projectSolvedVisit({
      visit: { visitId: 'v', visitIndex: 0, label: 'H1' } as HumilityVisit,
      solution,
      effort: 'medium',
      gemBudget: 0,
    });
    // BREAKAGE SEAM-08
    expect(Object.keys(out).join(',')).toMatch(/ftl/i);
  });
});
