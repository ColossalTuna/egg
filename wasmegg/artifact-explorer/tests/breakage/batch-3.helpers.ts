// Shared harness for the batch-3 seam specs: the planner's staging entry points driven the way
// wasmegg/ascension-planner/src/lib/humilityMissionsStage.spec.ts drives them.
import { vi } from 'vitest';
import { allResearches } from 'lib';
import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { createEmptySnapshot, createSimAction, type Action, type VirtueEgg } from '@planner/types';
import { stageHumilityVisit } from '@planner/lib/humilityMissionsStage';
import type { HumilityMissionsVisit } from '@planner/lib/humilityMissions';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} }));

export function baseState(tankLevel = 7) {
  const snapshot = createEmptySnapshot();
  snapshot.tankLevel = tankLevel;
  snapshot.soulEggs = 1e20;
  snapshot.habIds = [18, 18, 18, 18];
  snapshot.researchLevels = Object.fromEntries(allResearches.map(research => [research.id, research.levels]));
  return createBaseEngineState(snapshot);
}

export function shift(toEgg: VirtueEgg, id: string = toEgg, fromEgg: VirtueEgg = 'curiosity'): Action<'shift'> {
  return { ...createSimAction('shift', { fromEgg, toEgg, newShiftCount: 0 }), id };
}

export function plan(eggs: VirtueEgg[] = ['curiosity', 'humility'], bank = 1e60): Action[] {
  return [
    createSimAction('start_ascension', { initialEgg: eggs[0] }),
    ...eggs.slice(1).map(egg => shift(egg)),
    createSimAction('modify_bank', { mode: 'set', amount: bank, previousValue: 0, delta: bank }),
  ];
}

export function visitOf(over: Partial<HumilityMissionsVisit> = {}): HumilityMissionsVisit {
  return {
    visitId: 'humility',
    visitIndex: 0,
    label: 'H1',
    jointProbability: 0.5,
    launches: [{ ship: 'ATREGGIES', count: 9, duration: 'EPIC', targetAfxId: 0 }],
    makespanSeconds: 172800,
    fuelRequired: {},
    gemCost: 0,
    gemBudget: 1e60,
    ...over,
  };
}

export function contextAt(ftl: number) {
  const context = getSimulationContext();
  return { ...context, epicResearchLevels: { ...context.epicResearchLevels, afx_mission_time: ftl } };
}

export function stageAt(ftl: number, actions: Action[], v: HumilityMissionsVisit, base = baseState()) {
  return stageHumilityVisit(actions, v, base, contextAt(ftl)).actions;
}
