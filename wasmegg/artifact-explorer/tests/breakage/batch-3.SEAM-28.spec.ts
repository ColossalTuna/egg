// SEAM-28: re-solving after staging is not idempotent. Reading the staged AP plan back into the
// explorer folds the staged launch + wait into plannedDurationSeconds and the stored fuel into
// fuelByEgg, so the next solve is posed a different question than the first.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { simulate } from 'lib/planners/engine/simulate';
import { createSimAction, type Action } from '@planner/types';
import { parsePlanSave, sliceHumilityVisits, type PlanSave } from '@/lib/plan/read';
import { baseState, contextAt, plan, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const toSave = (actions: Action[]): PlanSave =>
  ({
    version: 1,
    initialState: { epicResearchLevels: { afx_mission_time: 55 } },
    actions: actions.map(a => ({
      id: a.id,
      type: a.type,
      totalTimeSeconds: a.totalTimeSeconds,
      endState: {
        tankLevel: a.endState.tankLevel,
        fuelTankAmounts: a.endState.fuelTankAmounts,
        bankValue: a.endState.bankValue,
        onlineEarnings: a.endState.onlineEarnings,
        offlineEarnings: a.endState.offlineEarnings,
        currentEgg: a.endState.currentEgg,
      },
    })),
  }) as PlanSave;

describe('SEAM-28 stage, export, re-load, re-solve', () => {
  const fuelOf = (m: Map<number, number>) => [...m].sort((x, y) => x[0] - y[0]);

  it('time budget: the window the plan already spends on Humility is unchanged by staging (BREAKAGE SEAM-28)', () => {
    const base = baseState();
    // The plan already spends P = 100000s on Humility (a wait), and the explorer solves against P.
    const P = 100000;
    const [start, arrival, bank] = plan(['curiosity', 'humility']);
    const wait = createSimAction('wait_for_time', { totalTimeSeconds: P });
    const original = simulate([start, arrival, wait, bank], contextAt(55), base);
    const [before] = sliceHumilityVisits(toSave(original));
    expect(before.plannedDurationSeconds).toBe(P);

    // An answer whose makespan (28800s, 3 BCR EPIC) fits inside P.
    const v = visitOf({
      launches: [{ ship: 'BCR', duration: 'EPIC', targetAfxId: 0, count: 3 }],
      makespanSeconds: 28800,
    });
    const [after] = sliceHumilityVisits(toSave(stageAt(55, original, v, base)));
    console.log({ P, planned: after.plannedDurationSeconds });
    // BREAKAGE SEAM-28
    expect(after.plannedDurationSeconds).toBe(before.plannedDurationSeconds);
  });

  it('fuel budget: staged fuel does not change the banked fuel of the next solve (BREAKAGE SEAM-28)', () => {
    const base = baseState();
    const original = simulate(plan(['curiosity', 'humility']), contextAt(55), base);
    const [before] = sliceHumilityVisits(toSave(original));
    const v = visitOf({
      launches: [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 3 }],
      makespanSeconds: 3 * 86400,
    });
    const [after] = sliceHumilityVisits(toSave(stageAt(55, original, v, base)));
    console.log({ before: fuelOf(before.fuelByEgg), after: fuelOf(after.fuelByEgg) });
    // BREAKAGE SEAM-28
    expect(fuelOf(after.fuelByEgg)).toEqual(fuelOf(before.fuelByEgg));
  });

  it('a planner missions file is rejected by the explorer plan loader, as it should be', () => {
    const file = JSON.parse(readFileSync(new URL('../fixtures/humility-missions.json', import.meta.url), 'utf8'));
    expect(() => parsePlanSave(file)).toThrow(/no `version`/);
  });
});
