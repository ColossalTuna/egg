// Preserve sourceTag through save/load paths so restaging replaces prior imports.

// The actions store reads localStorage as it is constructed, and the test environment is node.
const noopStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
(globalThis as { localStorage?: Storage }).localStorage ??= noopStorage as unknown as Storage;

import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { simulate } from 'lib/planners/engine/simulate';
import { resetAllStores } from '@/lib/modes';
import { exportPlanData, importPlanLogic } from '@/stores/actions/io';
import { useHumilityMissionsStore } from '@/stores/humilityMissions';
import { useActionsStore } from '@/stores/actions';
import { createEmptySnapshot, createSimAction } from '@/types';
import type { Action } from '@/types';

const TAG = 'humility-plan:shift_a1b2c3d';

function taggedAction(): Action {
  return {
    id: 'store_tagged',
    index: 0,
    timestamp: 1,
    type: 'store_fuel',
    payload: { egg: 'curiosity', amount: 10, timeSeconds: 0 },
    cost: 0,
    dependsOn: [],
    dependents: [],
    sourceTag: TAG,
  } as unknown as Action;
}

describe('the tag staged actions carry', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('survives simulation, which rebuilds every other field on the action', () => {
    const simulated = simulate([taggedAction()], getSimulationContext(), createBaseEngineState(createEmptySnapshot()));
    expect(simulated[0].sourceTag).toBe(TAG);
  });

  it('survives the file round trip, and so the library round trip, which is the same JSON', () => {
    const exported = exportPlanData([taggedAction()], createEmptySnapshot());
    const imported = importPlanLogic(JSON.stringify(exported));
    // By id, not by position: the import prepends a `start_ascension` when a plan does not open
    // with one, so the tagged action is not where it was put.
    expect(imported.actions.find((a: Action) => a.id === 'store_tagged')?.sourceTag).toBe(TAG);
  });
});

describe('switching plans', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('unloads the file, which belongs to the plan it was exported from', async () => {
    const fixture = new URL('../../../artifact-explorer/tests/fixtures/humility-missions.json', import.meta.url);
    const store = useHumilityMissionsStore();
    store.load(JSON.parse(readFileSync(fixture, 'utf8')));
    store.drift = [{ egg: 'curiosity', ours: 1, theirs: 2 }];
    expect(store.file).not.toBeNull();

    // Every mode flow (library load, start from scratch, plan future, continue, reconcile) starts here.
    await resetAllStores();

    expect(store.file).toBeNull();
    expect(store.drift).toEqual([]);
  });
});

describe('checking the loaded file against the plan', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('assesses the file against the plan in the actions store, and stages with its warnings kept', async () => {
    const fixture = new URL('../../../artifact-explorer/tests/fixtures/humility-missions.json', import.meta.url);
    const store = useHumilityMissionsStore();
    store.load(JSON.parse(readFileSync(fixture, 'utf8')));
    // The empty plan has none of the file's visits.
    expect(store.assessment?.matches).toBe(false);
    expect(store.assessment?.mismatch).toMatch(/None of its visits/);

    const actions = useActionsStore();
    const snapshot = { ...createEmptySnapshot(), tankLevel: 7 };
    actions._initialSnapshot = snapshot;
    actions.actions = simulate(
      [
        createSimAction('start_ascension', { initialEgg: 'curiosity' }),
        { ...createSimAction('shift', { fromEgg: 'curiosity', toEgg: 'humility', newShiftCount: 0 }), id: 'h1' },
        createSimAction('modify_bank', { mode: 'set', amount: 1e60, previousValue: 0, delta: 1e60 }),
      ],
      getSimulationContext(),
      createBaseEngineState(snapshot)
    );
    expect(store.planState.ids).toEqual(['h1']);
    await store.stage({
      visitId: 'h1',
      visitIndex: 0,
      label: 'H1',
      jointProbability: 0.5,
      launches: [{ ship: 'CHICKEN_ONE', duration: 'SHORT', targetAfxId: 0, count: 3 }],
      makespanSeconds: 1200,
      fuelRequired: {},
      gemCost: 0,
      gemBudget: 1,
      epicResearchFTLLevel: 60,
    });
    expect(store.warnings).toEqual([expect.stringMatching(/FTL level 60/)]);
    expect(store.planState.staged?.has('h1')).toBe(true);
    store.clear();
    expect(store.warnings).toEqual([]);
  });
});
