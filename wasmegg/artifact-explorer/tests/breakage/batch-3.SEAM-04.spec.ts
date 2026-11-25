// SEAM-04: the explorer rounds makespan to whole seconds; AP's LPT sum is a raw float, so the
// leftover `remaining` is ~1e-11 s and AP inserts a junk wait_for_time.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

describe('SEAM-04 float rounding', () => {
  it('3 Atreggies EPIC at FTL 55 stage with no wait action (BREAKAGE SEAM-04)', () => {
    const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }];
    const raw = launchSchedule(resolveLaunches(visitOf({ launches })), 55).totalSeconds;
    const rounded = Math.round(raw); // what optimizer-core.ts:189 writes as timeUnitsUsed
    expect(rounded).toBe(155520);
    console.log('raw', raw, 'rounded', rounded);

    const staged = stageAt(55, plan(), visitOf({ launches, makespanSeconds: rounded }));
    const waits = staged.filter(a => a.type === 'wait_for_time');
    console.log(waits.map(w => w.totalTimeSeconds));
    // BREAKAGE SEAM-04
    expect(waits).toHaveLength(0);
  });
});
