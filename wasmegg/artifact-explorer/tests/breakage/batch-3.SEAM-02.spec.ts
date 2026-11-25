// SEAM-02: a multiset the explorer packs inside the per-slot budget S is scheduled by the planner's
// LPT heuristic past S, so the staged visit outlasts the window it was solved for.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { packWitness } from '@/lib/packing';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const S = 100800;
const launches = [
  { ship: 'GALEGGTICA', duration: 'LONG', targetAfxId: 0, count: 2 }, // 57600
  { ship: 'MILLENIUM_CHICKEN', duration: 'EPIC', targetAfxId: 0, count: 2 }, // 43200
  { ship: 'BCR', duration: 'EPIC', targetAfxId: 0, count: 3 }, // 28800
];

describe('SEAM-02 LPT versus exact packing', () => {
  it('the explorer packs the multiset within S', () => {
    const witness = packWitness([57600, 43200, 28800], [2, 2, 3], S);
    expect(witness).toBeTruthy();
    const load = [0, 0, 0];
    [57600, 43200, 28800].forEach((d, j) => witness![j].forEach(slot => (load[slot] += d)));
    expect(Math.max(...load)).toBeLessThanOrEqual(S);
  });

  it('the planner schedules the same launches within S (BREAKAGE SEAM-02)', () => {
    const lpt = launchSchedule(resolveLaunches(visitOf({ launches })), 0).totalSeconds;
    // BREAKAGE SEAM-02
    expect(lpt).toBeLessThanOrEqual(S);
  });

  it('the staged launch ends inside the solved window (BREAKAGE SEAM-02)', () => {
    const staged = stageAt(0, plan(), visitOf({ launches, makespanSeconds: S }));
    const launch = staged.find(a => a.type === 'launch_missions')!;
    // BREAKAGE SEAM-02
    expect(launch.totalTimeSeconds).toBeLessThanOrEqual(S);
    // and nothing reports that it overran: no wait, remaining clamps to 0
    expect(staged.some(a => a.type === 'wait_for_time')).toBe(false);
  });
});
