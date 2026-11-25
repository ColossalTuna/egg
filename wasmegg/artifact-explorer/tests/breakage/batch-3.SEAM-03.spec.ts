// SEAM-03: AP prices the launch at arrival and saves up first, so the launch lasts T + schedule.
// The explorer budgets gems as bank + earnings over the whole window, so gemCost may exceed the
// arrival bank by design; the staged visit then ends T after the makespan it was solved for.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { gemBudgetFor } from '@/lib/plan/read';
import { launchCost } from 'lib/planners/rockets/launches';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { baseState, plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

describe('SEAM-03 gem saving time pushes the schedule back', () => {
  it('a launch priced above the arrival bank still ends within the solved makespan (BREAKAGE SEAM-03)', () => {
    const launches = [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }];
    const v = visitOf({ launches });
    const schedule = launchSchedule(resolveLaunches(v), 0).totalSeconds; // 345600
    const cost = launchCost(resolveLaunches(v)); // 3 * 60e18
    const base = baseState();
    base.population = 1e9;
    // Bank well under the price, but plenty of earnings over the window: the explorer's own budget
    // (bank + earnings * window) would approve this purchase.
    // Calibrate the planner's effective saving rate: launch with an empty bank, T = cost / rate.
    const probe = stageAt(0, plan(['curiosity', 'humility'], 0), v, base);
    const T0 = probe.find(a => a.type === 'launch_missions')!.totalTimeSeconds - schedule;
    const earnings = cost / T0;
    expect(earnings).toBeGreaterThan(0);
    // Bank is short by 90% of what the farm earns over the window: the explorer's budget
    // (bank + earnings * window) approves the purchase, yet it cannot be paid at arrival.
    const bank = cost - 0.9 * earnings * schedule;
    expect(bank).toBeGreaterThan(0);
    expect(gemBudgetFor({ bankValue: bank, earningsPerSecond: earnings } as never, schedule)).toBeGreaterThan(cost);
    const actions = plan(['curiosity', 'humility'], bank);

    const staged = stageAt(0, actions, { ...v, makespanSeconds: schedule, gemCost: cost }, base);
    const launch = staged.find(a => a.type === 'launch_missions')!;
    console.log('schedule', schedule, 'launch.totalTimeSeconds', launch.totalTimeSeconds, 'cost', launch.cost, 'bankBefore', staged[staged.indexOf(launch) - 1].endState.bankValue);
    // BREAKAGE SEAM-03
    expect(launch.totalTimeSeconds).toBeLessThanOrEqual(schedule);
  });
});
