// Batch 4 planner-side proofs: SEAM-14, SEAM-15, SEAM-16, SEAM-19, SEAM-27.
// Run with: npx vitest run -c tests/breakage/batch-4.vitest.config.ts tests/breakage/batch-4.planner-seams.spec.ts
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { allResearches } from 'lib';
import { createBaseEngineState, getSimulationContext } from 'lib/planners/engine/adapter';
import { simulate } from 'lib/planners/engine/simulate';

import { createEmptySnapshot, createSimAction, type Action, type VirtueEgg } from '../../../ascension-planner/src/types';
import {
  fileMatchesPlan,
  humilityVisitIds,
  parseHumilityMissions,
  planVisitBases,
  planVisitState,
  stageableVisitIds,
  visitPositionLabel,
  type HumilityMissionsVisit,
} from '../../../ascension-planner/src/lib/humilityMissions';
import { stageHumilityVisit } from '../../../ascension-planner/src/lib/humilityMissionsStage';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} }));

beforeEach(() => setActivePinia(createPinia()));

function baseState() {
  const snapshot = createEmptySnapshot();
  snapshot.tankLevel = 7;
  snapshot.soulEggs = 1e20;
  snapshot.habIds = [18, 18, 18, 18];
  snapshot.researchLevels = Object.fromEntries(allResearches.map(r => [r.id, r.levels]));
  return createBaseEngineState(snapshot);
}
const ctx = () => getSimulationContext();

function shift(toEgg: VirtueEgg, id: string): Action<'shift'> {
  return { ...createSimAction('shift', { fromEgg: 'curiosity', toEgg, newShiftCount: 0 }), id };
}
function start(): Action {
  return { ...createSimAction('start_ascension', { initialEgg: 'curiosity' }), id: 'start' };
}
function bank(amount: number, id = 'bank'): Action {
  return { ...createSimAction('modify_bank', { mode: 'set', amount, previousValue: 0, delta: amount }), id };
}
function wait(totalTimeSeconds: number, id = 'wait'): Action {
  return { ...createSimAction('wait_for_time', { totalTimeSeconds }), id };
}
const sim = (actions: Action[]) => simulate(actions, ctx(), baseState());

function visit(over: Partial<HumilityMissionsVisit> = {}): HumilityMissionsVisit {
  return {
    visitId: 'h1',
    visitIndex: 0,
    label: 'H1',
    jointProbability: 0.5,
    launches: [{ ship: 'CHICKEN_ONE', duration: 'SHORT', targetAfxId: 0, count: 6 }],
    makespanSeconds: 172800,
    fuelRequired: {},
    gemCost: 0,
    gemBudget: 1e60,
    ...over,
  };
}
function file(visits: HumilityMissionsVisit[]) {
  return parseHumilityMissions({
    schema: 'eggverse.humility-plan',
    schemaVersion: 1,
    source: 'artifact-explorer',
    generatedAt: 1,
    planLabel: 'p',
    visits,
  });
}

// SEAM-14 and SEAM-15 rewritten with the KP fix. An id list cannot tell two plans with the same ids apart, so
// the check now reads the plan itself (`planVisitState`) against the visit inputs the explorer records in the file
// (`basis`, written by K4). The edits are now ones those inputs see: under the K4 reader the budget is the bank on
// arrival plus earnings over the window, so a bank set after arrival alone does not change the question the file
// answers. The edited plans therefore also spend a day on Humility before the launch.
describe('SEAM-14: visitId is the only staleness check', () => {
  const exportedPlan = () => sim([start(), shift('humility', 'h1'), bank(1e60)]);
  const editedPlan = () => sim([start(), shift('humility', 'h1'), bank(1), wait(86400)]);
  const solved = () => visit({ gemBudget: 1e60, basis: planVisitBases(exportedPlan()).get('h1')! });

  it('refuses to stage when the plan was edited after export but the ids survive', () => {
    const exported = exportedPlan();
    const edited = editedPlan();
    const f = file([solved()]);

    expect(humilityVisitIds(edited)).toEqual(humilityVisitIds(exported)); // same ids
    expect([...stageableVisitIds(f, planVisitState(exported))]).toEqual(['h1']); // control
    // BREAKAGE SEAM-14: an edited plan must not be stageable.
    expect([...stageableVisitIds(f, planVisitState(edited))]).toEqual([]);
  });

  it('refuses to stage into an edited plan (end to end through stageHumilityVisit)', () => {
    // BREAKAGE SEAM-14: staging should refuse, and say what changed.
    expect(() => stageHumilityVisit(editedPlan(), solved(), baseState(), ctx())).toThrow(/time already planned/);
    expect(() => stageHumilityVisit(exportedPlan(), solved(), baseState(), ctx())).not.toThrow();
  });
});

describe('SEAM-15: plans loaded from one save share action ids', () => {
  it('a file does not load into a plan that was edited after import', () => {
    const original = [start(), shift('kindness', 'k1'), shift('humility', 'h1'), bank(1e60)];
    // "Import twice": the same JSON yields the same ids. Copy B is then edited (bank, plus an extra Humility wait).
    const copyB = sim([
      ...JSON.parse(JSON.stringify(original)).map((a: Action) => (a.type === 'modify_bank' ? bank(5, a.id) : a)),
      wait(3600),
    ]);
    const f = file([visit({ basis: planVisitBases(sim(original)).get('h1')! })]);
    expect(fileMatchesPlan(f, planVisitState(sim(original)))).toBe(true); // control
    // BREAKAGE SEAM-15: the edited copy is a different plan, yet the file matches and stages.
    expect(fileMatchesPlan(f, planVisitState(copyB))).toBe(false);
  });
});

describe('SEAM-15b: importPlanLogic keeps action ids', () => {
  it('two imports of one plan file produce disjoint action ids', async () => {
    const { importPlanLogic } = await import('../../../ascension-planner/src/stores/actions/io');
    const text = readFileSync(new URL('../fixtures/ascension-plan.json', import.meta.url).pathname, 'utf8');
    const a = importPlanLogic(text).actions.map((x: Action) => x.id);
    const b = importPlanLogic(text).actions.map((x: Action) => x.id);
    // BREAKAGE SEAM-15: ids are not regenerated, so a file solved against copy A also stages into copy B.
    expect(a.filter((id: string) => b.includes(id))).toEqual([]);
  });
});

describe('SEAM-19: help text says a different plan will not load the file', () => {
  it('does not treat a plan sharing only its first Humility visit as the plan the file came from', () => {
    // File was exported from a plan with two Humility visits h1, h2.
    const f = file([visit(), visit({ visitId: 'h2', visitIndex: 1, label: 'H2' })]);
    // A different plan: shares h1 only, then goes somewhere else entirely and has an unrelated second visit.
    const other = sim([start(), shift('humility', 'h1'), shift('curiosity', 'x1'), shift('humility', 'zzz'), bank(1e60)]);
    const ids = humilityVisitIds(other);
    expect(ids).toEqual(['h1', 'zzz']);
    // BREAKAGE SEAM-19: "a different plan will not load them", but one shared id is enough.
    expect(stageableVisitIds(f, ids).size).toBe(0);
    expect(fileMatchesPlan(f, ids)).toBe(false);
  });
});

// Rewritten with the KP fix: the component now labels a visit with `visitPositionLabel`, its place in the plan as
// it is now, so the test checks the component calls it and that it names the right position.
describe('SEAM-16: label drifts after inserting a visit', () => {
  it("H-label names the visit's current position in the plan", () => {
    const src = readFileSync(
      new URL('../../../../ui/components/planners/actions/rockets/HumilityMissionsImport.vue', import.meta.url).pathname,
      'utf8'
    );
    expect(src).toContain('return visitPositionLabel(visit, planVisitIds.value);');
    expect(src).not.toContain('return `H${visit.visitIndex + 1} of ${planVisitIds.value.length}`;');

    const f = file([visit(), visit({ visitId: 'h2', visitIndex: 1, label: 'H2' })]);
    // The user inserts a new Humility visit before h1 in AP.
    const edited = sim([
      start(),
      shift('humility', 'new'),
      shift('curiosity', 'c'),
      shift('humility', 'h1'),
      shift('curiosity', 'c2'),
      shift('humility', 'h2'),
      bank(1e60),
    ]);
    const ids = humilityVisitIds(edited);
    expect(ids).toEqual(['new', 'h1', 'h2']);
    const h1 = f.visits[0];
    const actualPosition = ids.indexOf(h1.visitId) + 1;
    // BREAKAGE SEAM-16: label should say H2 of 3 (its place now), not H1 of 3.
    expect(visitPositionLabel(h1, ids)).toBe(`H${actualPosition} of ${ids.length}`);
    expect(visitPositionLabel(f.visits[1], ids)).toBe('H3 of 3');
  });
});

describe('SEAM-27: a visit with zero launches', () => {
  it('is rejected or at least not staged as an empty launch_missions action', () => {
    const empty = visit({ launches: [], makespanSeconds: 0 });
    const parsed = (() => {
      try {
        return file([empty]);
      } catch {
        return null;
      }
    })();
    // Rejecting at parse is one acceptable outcome.
    if (parsed === null) return;
    const plan = sim([start(), shift('humility', 'h1'), bank(1e60)]);
    let staged: Action[] | null = null;
    try {
      staged = stageHumilityVisit(plan, parsed.visits[0], baseState(), ctx()).actions;
    } catch {
      return; // refusing to stage is also acceptable
    }
    const launches = staged.filter(a => a.type === 'launch_missions');
    // BREAKAGE SEAM-27: an empty launch action should not be staged.
    expect(launches.filter(a => (a.payload as { missions: unknown[] }).missions.length === 0)).toEqual([]);
  });
});
