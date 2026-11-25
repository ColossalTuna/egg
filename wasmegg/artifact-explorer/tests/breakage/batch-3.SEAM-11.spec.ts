// SEAM-11: the explorer reads the tank at the visit's arrival action; AP checks shortfalls at the end
// of the Humility run. A remove_fuel between them makes AP insert an extra egg visit the explorer
// never budgeted.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ei } from 'lib';
import { simulate } from 'lib/planners/engine/simulate';
import { createSimAction, type Action } from '@planner/types';
import { humilitySourceTag } from '@planner/lib/humilityMissionsStage';
import { sliceHumilityVisits, type PlanSave } from '@/lib/plan/read';
import { baseState, contextAt, plan, shift, stageAt, visitOf } from './batch-3.helpers';

beforeEach(() => setActivePinia(createPinia()));

const toSave = (actions: Action[]): PlanSave =>
  ({
    version: 1,
    initialState: { epicResearchLevels: {} },
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

describe('SEAM-11 remove_fuel between arrival and launch', () => {
  it('control: without the remove_fuel AP adds no fuel phase', () => {
    const base = baseState();
    base.fuelTankAmounts.curiosity = 100e12;
    base.fuelTankAmounts.kindness = 100e12;
    const actions = simulate(plan(['curiosity', 'humility']), contextAt(0), base);
    const v = visitOf({
      launches: [{ ship: 'CHICKFIANT', duration: 'SHORT', targetAfxId: 0, count: 100 }],
      makespanSeconds: 1,
    });
    const staged = stageAt(0, actions, v, base);
    const tag = humilitySourceTag(v.visitId);
    expect(staged.filter(a => a.sourceTag === tag && (a.type === 'shift' || a.type === 'store_fuel'))).toHaveLength(0);
  });

  it('AP adds no fuel phase for an answer budgeted against the arrival tank (BREAKAGE SEAM-11)', () => {
    const base = baseState();
    base.fuelTankAmounts.curiosity = 100e12;
    base.fuelTankAmounts.kindness = 100e12;
    const removeFuel = {
      ...createSimAction('remove_fuel', { egg: 'kindness', amount: 10e12 }),
      id: 'rm',
    };
    const [start, arrival, bank] = plan(['curiosity', 'humility']);
    const actions = simulate([start, arrival, removeFuel as Action, bank], contextAt(0), base);

    // What the explorer sees: the arrival snapshot, before the remove_fuel.
    const [visit] = sliceHumilityVisits(toSave(actions));
    expect(visit.fuelByEgg.get(ei.Egg.KINDNESS)).toBe(100e12);
    expect(visit.fuelByEgg.get(ei.Egg.CURIOSITY)).toBe(100e12);

    // 100 Defihent SHORT need exactly 100e12 curiosity and 100e12 kindness: banked fuel covers it.
    const v = visitOf({
      visitId: visit.visitId,
      launches: [{ ship: 'CHICKFIANT', duration: 'SHORT', targetAfxId: 0, count: 100 }],
      makespanSeconds: 1,
    });
    const staged = stageAt(0, actions, v, base);
    const tag = humilitySourceTag(v.visitId);
    const inserted = staged.filter(a => a.sourceTag === tag && (a.type === 'shift' || a.type === 'store_fuel'));
    console.log(inserted.map(a => `${a.type}:${JSON.stringify((a.payload as { egg?: string; toEgg?: string }).egg ?? (a.payload as { toEgg?: string }).toEgg)}`));
    // BREAKAGE SEAM-11
    expect(inserted).toHaveLength(0);
    void shift;
  });
});
