// SEAM-08: AP reads FTL at stage time (context.epicResearchLevels.afx_mission_time), not at export
// time, and the file carries no FTL. Editing epic research after export changes durations silently.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { projectSolvedVisit } from '@/lib/plan/write';
import type { HumilityVisit } from '@/lib/plan/read';
import type { OptimizerSolution } from '@/lib/types';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { stageHumilityVisit } from '@planner/lib/humilityMissionsStage';
import { baseState, contextAt, plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }];

describe('SEAM-08 FTL edited after export', () => {
  it('control: staging at the export-time FTL reproduces the file window', () => {
    const makespanSeconds = launchSchedule(resolveLaunches(visitOf({ launches })), 55).totalSeconds; // 155520
    const staged = stageAt(55, plan(), visitOf({ launches, makespanSeconds }));
    const launch = staged.find(a => a.type === 'launch_missions')!;
    expect(launch.totalTimeSeconds).toBeCloseTo(makespanSeconds, 3);
  });

  // Rewritten with the KP fix. The contract (FTL mismatch: warn, do not refuse) rules out the old
  // `toThrow()`; the test's own note allowed "a warning/recorded FTL", which is what is checked now.
  it('staging at a different FTL than the file was solved at is not silent (BREAKAGE SEAM-08)', () => {
    const makespanSeconds = launchSchedule(resolveLaunches(visitOf({ launches })), 55).totalSeconds;
    // A file that records its FTL: staged anyway, with a warning naming both levels.
    const recorded = visitOf({ launches, makespanSeconds, epicResearchFTLLevel: 55 });
    const staged = stageHumilityVisit(plan(), recorded, baseState(), contextAt(0));
    expect(staged.actions.some(a => a.type === 'launch_missions')).toBe(true);
    // BREAKAGE SEAM-08
    expect(staged.warnings.join(' ')).toMatch(/FTL level 55.*FTL level 0/);
    // An older file without the field: the 2.2x longer launch is still reported, not quiet.
    const older = stageHumilityVisit(plan(), visitOf({ launches, makespanSeconds }), baseState(), contextAt(0));
    expect(older.warnings.join(' ')).toMatch(/longer than .* solved H1 for.*another FTL level/);
    // And no warning at the level the file was solved at.
    expect(stageHumilityVisit(plan(), recorded, baseState(), contextAt(55)).warnings).toEqual([]);
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
