// SEAM-29: staging H1 inserts time, gem spend and fuel phases ahead of H2. H2's file answer was solved
// against the un-staged plan, yet it still passes the prefix-id check and stages without a note.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { simulate } from 'lib/planners/engine/simulate';
import { createSimAction, type Action } from '@planner/types';
import { humilityVisitIds, stageableVisitIds, type HumilityMissionsFile } from '@planner/lib/humilityMissions';
import { sliceHumilityVisits, type PlanSave } from '@/lib/plan/read';
import { baseState, contextAt, shift, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const toSave = (actions: Action[]): PlanSave =>
  ({
    version: 1,
    initialState: { epicResearchLevels: { afx_mission_time: 0 } },
    virtueState: { ascensionDate: '2026-03-01', ascensionTime: '12:00', ascensionTimezone: 'UTC' },
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

describe('SEAM-29 staging H1 moves H2s inputs', () => {
  it('H2 still sees the bank, fuel and time it was solved against (BREAKAGE SEAM-29)', () => {
    const base = baseState();
    // 100e12 curiosity and kindness are already banked at the start; the un-staged plan leaves them for H2.
    base.fuelTankAmounts.curiosity = 100e12;
    base.fuelTankAmounts.kindness = 100e12;
    const bank = createSimAction('modify_bank', { mode: 'set', amount: 1e60, previousValue: 0, delta: 1e60 });
    const original = simulate(
      [
        createSimAction('start_ascension', { initialEgg: 'curiosity' }),
        bank,
        shift('humility', 'h1'),
        shift('curiosity', 'c2', 'humility'),
        shift('humility', 'h2', 'curiosity'),
      ],
      contextAt(0),
      base
    );
    const [h1Before, h2Before] = sliceHumilityVisits(toSave(original));
    expect([h1Before.visitId, h2Before.visitId]).toEqual(['h1', 'h2']);

    const h1 = visitOf({
      visitId: 'h1',
      launches: [{ ship: 'CHICKFIANT', duration: 'SHORT', targetAfxId: 0, count: 100 }],
      makespanSeconds: 86400,
    });
    const stagedH1 = stageAt(0, original, h1, base);
    const [, h2After] = sliceHumilityVisits(toSave(stagedH1));
    expect(h2After.visitId).toBe('h2');

    // H2's answer would still be offered for staging: the prefix check only looks at ids.
    const file = { visits: [h1, visitOf({ visitId: 'h2', visitIndex: 1 })] } as unknown as HumilityMissionsFile;
    expect(stageableVisitIds(file, humilityVisitIds(stagedH1)).has('h2')).toBe(true);

    const fuel = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]);
    console.log({
      bank: [h2Before.bankValue, h2After.bankValue],
      fuel: [fuel(h2Before.fuelByEgg).map(String), fuel(h2After.fuelByEgg).map(String)],
      earnings: [h2Before.earningsPerSecond, h2After.earningsPerSecond],
      arrival: [h2Before.arrivalTimestamp, h2After.arrivalTimestamp],
    });
    // BREAKAGE SEAM-29 (arrival time)
    expect.soft(h2After.arrivalTimestamp).toBe(h2Before.arrivalTimestamp);
    expect.soft(h2After.bankValue).toBe(h2Before.bankValue);
    expect.soft(fuel(h2After.fuelByEgg)).toEqual(fuel(h2Before.fuelByEgg));
  });
});
