// Regressions introduced by KP (59f76a4) in the humility missions import, one test per defect:
// SAT-SEAM-03, 06, 08, 12 and 17. Each fails on 59f76a4. Kept beside the planner's own specs
// (src/lib/*.spec.ts), which is where the planner keeps its tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { allResearches, ei } from 'lib';
import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { simulate } from 'lib/planners/engine/simulate';
import { createEmptySnapshot, createSimAction, type Action, type CurrentFarmState, type VirtueEgg } from '@/types';
import { useActionsStore } from '@/stores/actions';
import { useHumilityMissionsStore } from '@/stores/humilityMissions';
import { humilitySourceTag, importPlanState, stageHumilityVisit } from './humilityMissionsStage';
import {
  assessFile,
  launchSchedule,
  MAX_SHIPS_PER_VISIT,
  parseHumilityMissions,
  planVisitBases,
  planVisitState,
  stageableVisitIds,
  type HumilityMissionsFile,
  type HumilityMissionsVisit,
  type ResolvedLaunch,
} from './humilityMissions';
import { DurationType, FUEL_REQUIREMENTS, getEffectiveDuration, Spaceship } from './missions';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} }));
beforeEach(() => setActivePinia(createPinia()));

const ctx = () => getSimulationContext();

function baseState() {
  const snapshot = createEmptySnapshot();
  snapshot.tankLevel = 7;
  snapshot.soulEggs = 1e20;
  snapshot.habIds = [18, 18, 18, 18];
  snapshot.researchLevels = Object.fromEntries(allResearches.map(r => [r.id, r.levels]));
  return createBaseEngineState(snapshot);
}
function shift(toEgg: VirtueEgg, id: string, fromEgg: VirtueEgg = 'curiosity'): Action<'shift'> {
  return { ...createSimAction('shift', { fromEgg, toEgg, newShiftCount: 0 }), id };
}
function bank(id?: string): Action {
  const action = createSimAction('modify_bank', { mode: 'set', amount: 1e60, previousValue: 0, delta: 1e60 });
  return id ? { ...action, id } : action;
}
function visit(over: Partial<HumilityMissionsVisit> = {}): HumilityMissionsVisit {
  return {
    visitId: 'h1',
    visitIndex: 0,
    label: 'H1',
    jointProbability: 0.5,
    launches: [{ ship: 'CHICKEN_ONE', duration: 'SHORT', targetAfxId: 0, count: 2 }],
    makespanSeconds: 172800,
    fuelRequired: {},
    gemCost: 0,
    gemBudget: 1e60,
    ...over,
  };
}
const fileOf = (visits: HumilityMissionsVisit[]) => ({ visits }) as unknown as HumilityMissionsFile;

describe('SAT-SEAM-03: a plan that opens on Humility with a fuel shortfall', () => {
  function setup() {
    const base = baseState();
    base.currentEgg = 'humility';
    base.bankValue = 5e30;
    const farm: CurrentFarmState = {
      eggType: ei.Egg.HUMILITY,
      cash: 5e30,
      cashEarned: 5e30,
      cashSpent: 0,
      population: 1e9,
      deliveredEggs: 0,
      lastStepTime: 0,
      numSilos: 1,
      commonResearches: Object.fromEntries(allResearches.map(r => [r.id, r.levels])),
      habs: [18, 18, 18, 18],
      vehicles: [],
    };
    const plan = simulate(
      [
        { ...createSimAction('start_ascension', { initialEgg: 'humility', initialFarmState: farm }), id: 'start' },
        bank('bank'),
      ],
      ctx(),
      base
    );
    const v = visit({
      visitId: 'start',
      launches: [{ ship: 'BCR', duration: 'SHORT', targetAfxId: 0, count: 6 }],
      basis: planVisitBases(plan).get('start')!,
    });
    return { base, plan, v };
  }

  it('stays current and restageable straight after staging, and the rewrite is tagged and undoable', () => {
    const { base, plan, v } = setup();
    const first = stageHumilityVisit(plan, v, base, ctx());
    expect(first.initialEgg).toBe('integrity');
    // Every action the stage changed carries the visit's tag, the rewritten start included.
    const tag = humilitySourceTag('start');
    expect(first.actions[0].type).toBe('start_ascension');
    expect(first.actions[0].sourceTag).toBe(tag);
    expect(first.actions.find(a => a.id === 'start')?.sourceTag).toBe(tag);

    // What the store does next: the initial snapshot takes the new starting egg.
    const staged = { ...base, currentEgg: first.initialEgg! };
    const assessment = assessFile(fileOf([v]), importPlanState(first.actions, ctx(), staged));
    expect(assessment.matches).toBe(true);
    expect(assessment.reasons.get('start')).toBeUndefined();
    const again = stageHumilityVisit(first.actions, v, staged, ctx());
    expect(again.actions.map(a => a.type)).toEqual(first.actions.map(a => a.type));

    // Undo: staging nothing for the visit puts the original start back, egg and all.
    const undone = stageHumilityVisit(first.actions, { ...v, launches: [], makespanSeconds: 0 }, staged, ctx());
    expect(undone.initialEgg).toBe('humility');
    expect(undone.actions.map(a => a.id)).toEqual(plan.map(a => a.id));
    expect(undone.actions.some(a => a.sourceTag)).toBe(false);
    const start = undone.actions[0];
    expect(start.type === 'start_ascension' && start.payload).toEqual(plan[0].payload);
    expect(undone.actions[0].endState.bankValue).toBe(plan[0].endState.bankValue);
  });

  it('round-trips through the store: stage, see it current, undo', async () => {
    const { base, plan, v } = setup();
    const actions = useActionsStore();
    actions._initialSnapshot = { ...createEmptySnapshot(), ...base };
    actions.actions = plan;
    const missions = useHumilityMissionsStore();
    missions.file = fileOf([v]);
    await missions.stage(v);
    expect(actions._initialSnapshot!.currentEgg).toBe('integrity');
    expect(missions.assessment!.matches).toBe(true);
    expect(missions.assessment!.reasons.has('start')).toBe(false);
    await missions.stage(v);
    await missions.stage({ ...v, launches: [], makespanSeconds: 0 });
    expect(actions._initialSnapshot!.currentEgg).toBe('humility');
    expect(actions.actions.map(a => a.id)).toEqual(plan.map(a => a.id));
  });
});

describe('SAT-SEAM-06: deleting a solved visit that has an unsolved visit after it', () => {
  it('keeps the file, keeps the earlier visit stageable, and calls the deleted one gone', () => {
    const plan = simulate(
      [
        createSimAction('start_ascension', { initialEgg: 'curiosity' }),
        shift('humility', 'h1'),
        bank(),
        shift('curiosity', 'c1', 'humility'),
        shift('humility', 'h2'),
        shift('curiosity', 'c2', 'humility'),
        shift('humility', 'h3'),
        bank(),
      ],
      ctx(),
      baseState()
    );
    const bases = planVisitBases(plan);
    const file = fileOf([
      visit({ basis: bases.get('h1')! }),
      visit({ visitId: 'h2', visitIndex: 1, label: 'H2', basis: bases.get('h2')! }),
    ]);
    // The user deletes H2's Humility run; the unsolved H3 now sits where H2 was.
    const edited = simulate(
      plan.filter(a => a.id !== 'h2' && a.id !== 'c2'),
      ctx(),
      baseState()
    );
    const state = planVisitState(edited);
    expect(state.ids).toEqual(['h1', 'h3']);
    const assessment = assessFile(file, state);
    expect(assessment.matches).toBe(true);
    expect(assessment.reasons.has('h1')).toBe(false);
    expect(assessment.reasons.get('h2')).toBe('This visit is no longer in the plan.');
    expect(stageableVisitIds(file, state)).toEqual(new Set(['h1']));
    expect(() => stageHumilityVisit(edited, file.visits[0], baseState(), ctx())).not.toThrow();
  });
});

describe('SAT-SEAM-08: staging a later visit first', () => {
  function setup() {
    const base = baseState();
    const plan = simulate(
      [
        createSimAction('start_ascension', { initialEgg: 'curiosity' }),
        shift('humility', 'h1'),
        bank(),
        shift('kindness', 'k2', 'humility'),
        shift('humility', 'h2', 'kindness'),
        bank(),
      ],
      ctx(),
      base
    );
    const bases = planVisitBases(plan);
    const v1 = visit({ basis: bases.get('h1')! });
    const v2 = visit({
      visitId: 'h2',
      visitIndex: 1,
      label: 'H2',
      launches: [{ ship: 'ATREGGIES', duration: 'EPIC', targetAfxId: 0, count: 1 }],
      basis: bases.get('h2')!,
    });
    return { base, plan, v1, v2, file: fileOf([v1, v2]) };
  }

  it('does not make an earlier visit stale, so either order stages and the earlier one restages', () => {
    const { base, plan, v1, v2, file } = setup();
    const h2First = stageHumilityVisit(plan, v2, base, ctx()).actions;
    // H2's curiosity store lands before H1's arrival.
    const h1Arrival = h2First.findIndex(a => a.id === 'h1');
    expect(h2First.findIndex(a => a.sourceTag === humilitySourceTag('h2'))).toBeLessThan(h1Arrival);
    expect(assessFile(file, importPlanState(h2First, ctx(), base)).reasons.has('h1')).toBe(false);
    const both = stageHumilityVisit(h2First, v1, base, ctx()).actions;

    const h1First = stageHumilityVisit(plan, v1, base, ctx()).actions;
    const bothOtherOrder = stageHumilityVisit(h1First, v2, base, ctx()).actions;
    for (const staged of [both, bothOtherOrder]) {
      expect(() => stageHumilityVisit(staged, v1, base, ctx())).not.toThrow();
      expect(assessFile(file, importPlanState(staged, ctx(), base)).reasons.has('h1')).toBe(false);
    }
  });

  it("does not let the earlier visit spend fuel the later visit's staging stored ahead of it", () => {
    const { base, plan, v2 } = setup();
    // H1 now needs curiosity and integrity too, which H2's staging also stores before H1's arrival.
    const v1 = visit({
      launches: [{ ship: 'GALEGGTICA', duration: 'SHORT', targetAfxId: 0, count: 1 }],
      basis: planVisitBases(plan).get('h1')!,
    });
    const h2First = stageHumilityVisit(plan, v2, base, ctx()).actions;
    const both = stageHumilityVisit(h2First, v1, base, ctx()).actions;
    const h2Launch = both.findIndex(a => a.type === 'launch_missions' && a.sourceTag === humilitySourceTag('h2'));
    const tank = both[h2Launch - 1].endState.fuelTankAmounts;
    const needed = h2First.find(a => a.type === 'launch_missions')!;
    if (needed.type !== 'launch_missions') throw new Error('no launch');
    for (const [egg, amount] of Object.entries(needed.payload.fuelConsumed) as [VirtueEgg, number][]) {
      if (egg === 'humility') continue;
      expect(tank[egg]).toBeGreaterThanOrEqual(amount * (1 - 1e-12));
    }
  });
});

describe('SAT-SEAM-12: the ships-per-visit cap', () => {
  const fileWith = (counts: number[]) => ({
    schema: 'eggverse.humility-plan',
    schemaVersion: 1,
    source: 'artifact-explorer',
    generatedAt: 1,
    planLabel: 'p',
    visits: [
      visit({
        launches: counts.map((count, i) => ({
          ship: i === 0 ? 'CHICKEN_ONE' : 'CHICKEN_NINE',
          duration: 'SHORT',
          targetAfxId: 0,
          count,
        })),
      }),
      visit({ visitId: 'h2', visitIndex: 1, label: 'H2' }),
    ],
  });

  it('accepts what a long explorer window writes, and names the window when it refuses', () => {
    // 2.1e6 is what the explorer wrote for a 10000-day window; 1,000,001 is the scenario's file.
    expect(parseHumilityMissions(fileWith([600_000, 400_001])).visits).toHaveLength(2);
    expect(parseHumilityMissions(fileWith([2_100_000])).visits).toHaveLength(2);
    expect(MAX_SHIPS_PER_VISIT).toBeGreaterThanOrEqual(100_000_000);
    // The cap is still there for crafted counts, and the message says what to do, not that the file is damaged.
    let message = '';
    try {
      parseHumilityMissions(fileWith([MAX_SHIPS_PER_VISIT, 1]));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/shorter window/);
    expect(message).not.toMatch(/damaged|not written by the artifact explorer/);
    // And a fleet at the cap schedules without walking every ship.
    const t0 = performance.now();
    const schedule = launchSchedule(
      [{ ship: Spaceship.CHICKEN_ONE, duration: DurationType.SHORT, targetAfxId: 0, count: MAX_SHIPS_PER_VISIT }],
      0
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(schedule.totalMissions).toBe(MAX_SHIPS_PER_VISIT);
    expect(schedule.slots.reduce((n, slot) => n + slot.launches.reduce((m, l) => m + l.count, 0), 0)).toBe(
      MAX_SHIPS_PER_VISIT
    );
  });
});

describe("SAT-SEAM-17: never longer than the explorer's packing", () => {
  // prove-seam/seam17.spec.ts, SEED=777, instance 125: the explorer's own packer reaches 4298640 s at FTL 55,
  // KP's step-limited probe returned 4298760 s.
  const durations = [1200, 3600, 77760, 2700, 19440, 5400, 38880, 6480, 155520, 9720, 14400, 1800];
  const counts = [18, 23, 36, 36, 43, 56, 105, 37, 25, 24, 19, 22];
  const target = 4298640;
  function launches(): ResolvedLaunch[] {
    const out: ResolvedLaunch[] = [];
    durations.forEach((seconds, j) => {
      let found: ResolvedLaunch | undefined;
      for (const ship of Object.values(Spaceship).filter(s => typeof s === 'number') as Spaceship[])
        for (const duration of [DurationType.SHORT, DurationType.LONG, DurationType.EPIC])
          if (
            !found &&
            Array.isArray(FUEL_REQUIREMENTS[ship]?.[duration]) &&
            Math.abs(getEffectiveDuration(ship, duration, 55) - seconds) < 1e-6
          )
            found = { ship, duration, targetAfxId: 0, count: counts[j] };
      out.push(found!);
    });
    return out;
  }

  it('matches the explorer at its makespan, and a repeat (every plan edit) costs nothing', () => {
    const t0 = performance.now();
    const schedule = launchSchedule(launches(), 55, target);
    const first = performance.now() - t0;
    expect(schedule.totalSeconds).toBeLessThanOrEqual(target);
    expect(schedule.totalMissions).toBe(counts.reduce((a, b) => a + b, 0));
    for (const slot of schedule.slots) expect(slot.totalSeconds).toBeLessThanOrEqual(target + 0.5);
    const t1 = performance.now();
    launchSchedule(launches(), 55, target);
    expect(performance.now() - t1).toBeLessThan(50);
    console.log(`SAT-SEAM-17 first ${first.toFixed(0)} ms`);
  }, 20000);
});
