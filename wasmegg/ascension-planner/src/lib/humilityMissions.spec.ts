// The planner half of the artifact-explorer seam. Reads the same two fixtures the explorer's
// `tests/unit/plan-seam.spec.ts` reads, from the explorer's tree. One copy with two readers gives
// the schema an executable definition rather than two prose ones. See the README beside them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assessFile,
  fileMatchesPlan,
  ftlMismatchWarning,
  fuelShortfalls,
  MAX_SHIPS_PER_VISIT,
  planVisitBases,
  planVisitState,
  visitPositionLabel,
  humilityVisitIds,
  humilityVisitInsertIndex,
  launchLabel,
  launchSchedule,
  stageableVisitIds,
  fuelDrift,
  HumilityMissionsError,
  parseHumilityMissions,
  resolveLaunches,
  type HumilityMissionsFile,
} from './humilityMissions';
import { fuelForLaunches, launchCost, launchEntries } from 'lib/planners/rockets/launches';
import { scheduleMissions } from 'lib/planners/rockets/scheduler';
import { DURATION_NAMES, DurationType, SHIP_INFO, Spaceship, FUEL_REQUIREMENTS } from './missions';
import { VIRTUE_EGGS } from '@/types';
import type { Action } from '@/types';

const FIXTURES = new URL('../../../artifact-explorer/tests/fixtures/', import.meta.url).pathname;

const humilityMissions = () =>
  parseHumilityMissions(JSON.parse(readFileSync(FIXTURES + 'humility-missions.json', 'utf8')));
const planSave = JSON.parse(readFileSync(FIXTURES + 'ascension-plan.json', 'utf8')) as { actions: Action[] };

describe('parsing a humility missions file', () => {
  it('accepts the fixture the explorer writes', () => {
    const file = humilityMissions();
    expect(file.visits.map(v => v.visitId)).toEqual(['shift_a1b2c3d', 'shift_e5e5e5e']);
  });

  it('refuses anything that is not this schema, at this version', () => {
    const file = humilityMissions() as HumilityMissionsFile;
    expect(() => parseHumilityMissions({ ...file, schema: 'something.else' })).toThrow(HumilityMissionsError);
    expect(() => parseHumilityMissions({ ...file, schemaVersion: 2 })).toThrow(/version 2/);
    expect(() => parseHumilityMissions({ ...file, visits: [] })).toThrow(/no solved visits/);
  });
  it.each([null, [], { visitId: 'v1' }])('rejects a malformed visit before it reaches the panel: %j', visit => {
    expect(() => parseHumilityMissions({ ...humilityMissions(), visits: [visit] })).toThrow(HumilityMissionsError);
  });

  it.each([
    ['visitId', ''],
    ['label', null],
    ['visitIndex', 0.5],
    ['visitIndex', -1],
    ['jointProbability', 1.1],
    ['jointProbability', -0.1],
    ['makespanSeconds', Infinity],
    ['makespanSeconds', '12'],
    ['gemCost', NaN],
    ['gemBudget', -1],
    ['fuelRequired', []],
    ['fuelRequired', { curiosity: -1 }],
    ['fuelRequired', { bogus: 1 }],
    ['launches', null],
    ['launches', [null]],
  ])('validates %s before accepting the file', (field, value) => {
    const file = humilityMissions();
    (file.visits[0] as unknown as Record<string, unknown>)[field] = value;
    expect(() => parseHumilityMissions(file)).toThrow(HumilityMissionsError);
  });

  it.each([
    { count: '2' },
    { count: true },
    { count: 1.5 },
    { targetAfxId: null },
    { targetAfxId: '25' },
    { targetAfxId: 99999 },
    { targetAfxId: 0.5 },
    { duration: 'toString' },
    { duration: 'TUTORIAL' },
    { ship: 'missing' },
  ])('validates each launch while loading: %j', fields => {
    const file = humilityMissions();
    Object.assign(file.visits[0].launches[0], fields);
    expect(() => parseHumilityMissions(file)).toThrow(HumilityMissionsError);
  });

  it('rejects duplicate visit ids and indices', () => {
    const file = humilityMissions();
    file.visits[1].visitId = file.visits[0].visitId;
    expect(() => parseHumilityMissions(file)).toThrow(/Duplicate/);
    file.visits[1].visitId = 'different';
    file.visits[1].visitIndex = file.visits[0].visitIndex;
    expect(() => parseHumilityMissions(file)).toThrow(/Duplicate/);
  });

  it('names a version mismatch when the file uses a ship, duration or target this planner does not know', () => {
    for (const fields of [{ ship: 'NEW_SHIP' }, { duration: 'TUTORIAL' }, { targetAfxId: 99999 }]) {
      const file = humilityMissions();
      Object.assign(file.visits[0].launches[0], fields);
      expect(() => parseHumilityMissions(file)).toThrow(/newer artifact explorer.*re-export/);
    }
  });

  it('caps the ships one visit may launch', () => {
    const file = humilityMissions();
    file.visits[0].launches[0].count = MAX_SHIPS_PER_VISIT;
    expect(() => parseHumilityMissions(file)).toThrow(/more than 1,000,000 ships/);
    file.visits[0].launches = [{ ...file.visits[0].launches[0], count: MAX_SHIPS_PER_VISIT }];
    expect(parseHumilityMissions(file).visits[0].launches[0].count).toBe(MAX_SHIPS_PER_VISIT);
  });

  it('reads the FTL level and basis newer explorers write, and still loads files without them', () => {
    const file = humilityMissions();
    expect(file.visits[0].epicResearchFTLLevel).toBe(55);
    expect(file.visits[0].basis?.tankLevel).toBe(6);
    for (const visit of file.visits) {
      delete visit.epicResearchFTLLevel;
      delete visit.basis;
    }
    expect(parseHumilityMissions(file).visits).toHaveLength(2);
  });

  it.each([
    ['epicResearchFTLLevel', 61],
    ['epicResearchFTLLevel', 1.5],
    ['basis', 'x'],
    ['basis', { bankValue: 1, earningsPerSecond: 1, tankLevel: 0.5, plannedDurationSeconds: 0, fuelByEgg: {} }],
    ['basis', { bankValue: -1, earningsPerSecond: 1, tankLevel: 1, plannedDurationSeconds: 0, fuelByEgg: {} }],
    ['basis', { bankValue: 1, earningsPerSecond: 1, tankLevel: 1, plannedDurationSeconds: 0, fuelByEgg: { bogus: 1 } }],
  ])('validates the optional %s when it is there', (field, value) => {
    const file = humilityMissions();
    (file.visits[0] as unknown as Record<string, unknown>)[field] = value;
    expect(() => parseHumilityMissions(file)).toThrow(HumilityMissionsError);
  });

  it('accepts an empty launch list for a solution satisfied by existing inventory', () => {
    const file = humilityMissions();
    file.visits[0].launches = [];
    expect(parseHumilityMissions(file).visits[0].launches).toEqual([]);
  });
});

describe("mapping the wire format onto this app's enums", () => {
  it('reads ships and durations by name, not by number', () => {
    const [visit] = humilityMissions().visits;
    const launches = resolveLaunches(visit);
    expect(launches).toEqual([
      { ship: Spaceship.HENERPRISE, duration: DurationType.LONG, targetAfxId: 25, count: 4 },
      { ship: Spaceship.ATREGGIES, duration: DurationType.EPIC, targetAfxId: 25, count: 9 },
    ]);
  });

  it("does not silently read the protobuf's EPIC as this app's", () => {
    // The collision this seam exists to avoid: the protobuf numbers EPIC 2 and TUTORIAL 3, this
    // app numbers EPIC 3. A file carrying the integer 3 would mean two different missions.
    expect(DurationType.EPIC).toBe(3);
    const [visit] = humilityMissions().visits;
    const withInteger = { ...visit, launches: [{ ...visit.launches[0], duration: 3 as unknown as string }] };
    expect(() => resolveLaunches(withInteger)).toThrow(HumilityMissionsError);
  });

  it('rejects a duration it cannot plan rather than defaulting one', () => {
    const [visit] = humilityMissions().visits;
    const tutorial = { ...visit, launches: [{ ...visit.launches[0], duration: 'TUTORIAL' }] };
    expect(() => resolveLaunches(tutorial)).toThrow(/TUTORIAL/);
  });

  it('rejects an unknown ship rather than dropping it from the plan', () => {
    const [visit] = humilityMissions().visits;
    const bogus = { ...visit, launches: [{ ...visit.launches[0], ship: 'CHICKEN_TWELVE' }] };
    expect(() => resolveLaunches(bogus)).toThrow(/CHICKEN_TWELVE/);
  });

  it('lists a launch under the names the mission grid uses', () => {
    const [visit] = humilityMissions().visits;
    expect(visit.launches.map(launchLabel)).toEqual([
      `${DURATION_NAMES[DurationType.LONG]} ${SHIP_INFO[Spaceship.HENERPRISE].displayName}`,
      `${DURATION_NAMES[DurationType.EPIC]} ${SHIP_INFO[Spaceship.ATREGGIES].displayName}`,
    ]);
    // The list renders before staging validates it, so a name we cannot map shows as it came
    // rather than taking the row down.
    expect(launchLabel({ ...visit.launches[0], ship: 'CHICKEN_TWELVE' })).toBe('LONG CHICKEN_TWELVE');
  });

  it('rejects a count that would launch nothing or a fraction of a ship', () => {
    const [visit] = humilityMissions().visits;
    for (const count of [0, -1, 1.9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = { ...visit, launches: [{ ...visit.launches[0], count }] };
      expect(() => resolveLaunches(bad)).toThrow(HumilityMissionsError);
    }
  });
});

describe('fuel', () => {
  it("adds back the Humility the explorer strips, from this app's own table", () => {
    const [visit] = humilityMissions().visits;
    const ours = fuelForLaunches(resolveLaunches(visit));

    // The file has no humility key at all; the tank is charged for it here, so an importer that
    // copied the file's figures straight across would under-deduct.
    expect(visit.fuelRequired).not.toHaveProperty('humility');
    const expectedHumility =
      FUEL_REQUIREMENTS[Spaceship.ATREGGIES][DurationType.EPIC].find(r => r.egg === 'humility')!.amount * 9 +
      FUEL_REQUIREMENTS[Spaceship.HENERPRISE][DurationType.LONG].find(r => r.egg === 'humility')!.amount * 4;
    expect(ours.humility).toBe(expectedHumility);
    expect(ours.humility).toBeGreaterThan(0);
  });

  it('agrees with the explorer on the four eggs it does report', () => {
    // This is the tripwire, and it passing is the claim that the two tables have not drifted.
    for (const visit of humilityMissions().visits) {
      expect(fuelDrift(visit, fuelForLaunches(resolveLaunches(visit)))).toEqual([]);
    }
  });

  it('reports drift instead of reconciling it', () => {
    const [visit] = humilityMissions().visits;
    const ours = fuelForLaunches(resolveLaunches(visit));
    const drifted = { ...visit, fuelRequired: { ...visit.fuelRequired, curiosity: ours.curiosity * 1.5 } };
    expect(fuelDrift(drifted, ours)).toEqual([
      { egg: 'curiosity', ours: ours.curiosity, theirs: ours.curiosity * 1.5 },
    ]);
  });

  it('does not mistake float noise for drift', () => {
    const [visit] = humilityMissions().visits;
    const ours = fuelForLaunches(resolveLaunches(visit));
    const nudged = { ...visit, fuelRequired: { ...visit.fuelRequired, curiosity: ours.curiosity * (1 + 1e-12) } };
    expect(fuelDrift(nudged, ours)).toEqual([]);
  });
});

describe('finding the visits a file was solved for', () => {
  const actions = planSave.actions;

  it('keys on the action that entered Humility, the same rule the explorer slices by', () => {
    expect(humilityVisitIds(actions)).toEqual(['shift_a1b2c3d', 'shift_e5e5e5e']);
    expect(humilityVisitIds([])).toEqual([]);
    // A run is keyed once, not once per action in it.
    expect(humilityVisitIds(actions.slice(0, 3))).toEqual(['shift_a1b2c3d']);
  });

  it('matches every visit id the explorer wrote into the humility missions file', () => {
    // The join key, end to end: what the explorer put in the file is findable in the save it read.
    const ids = new Set(humilityVisitIds(actions));
    for (const visit of humilityMissions().visits) {
      expect(ids.has(visit.visitId)).toBe(true);
    }
  });

  it('lands the launch at the end of the visit, after what the plan already does there', () => {
    // Visit 1 runs actions 1-2, so its launch goes at 3, before the shift away.
    expect(humilityVisitInsertIndex(actions, 'shift_a1b2c3d')).toBe(3);
    // Visit 2 is the last thing in the plan; its launch goes at the end.
    expect(humilityVisitInsertIndex(actions, 'shift_e5e5e5e')).toBe(actions.length);
    expect(humilityVisitInsertIndex(actions, 'shift_gone')).toBeNull();
  });

  it('withholds every visit after one the plan has lost, not just that one', () => {
    const file = humilityMissions();
    const stageable = (plan: Action[]) => stageableVisitIds(file, humilityVisitIds(plan));
    expect(stageable(actions)).toEqual(new Set(['shift_a1b2c3d', 'shift_e5e5e5e']));

    // The second visit is still in the plan, but the answers were solved as a sequence and the
    // plan they were solved against no longer exists once the first one is gone.
    expect(stageable(actions.filter(a => a.id !== 'shift_a1b2c3d'))).toEqual(new Set());

    expect(stageable(actions.filter(a => a.id !== 'shift_e5e5e5e'))).toEqual(new Set(['shift_a1b2c3d']));
  });

  it('tells a file from another plan apart from one that has lost some visits', () => {
    const file = humilityMissions();
    const matches = (plan: Action[]) => fileMatchesPlan(file, humilityVisitIds(plan));
    expect(matches(actions)).toBe(true);
    // A partial match keeps the per-visit reasons, even when nothing is stageable.
    expect(matches(actions.filter(a => a.id !== 'shift_a1b2c3d'))).toBe(true);
    // No visit in common: the file came from another plan.
    expect(matches(actions.filter(a => a.id !== 'shift_a1b2c3d' && a.id !== 'shift_e5e5e5e'))).toBe(false);
    expect(fileMatchesPlan(file, [])).toBe(false);
  });
});

describe('whether the plan still poses the question the file answers', () => {
  const actions = planSave.actions;

  it("reads each visit's inputs exactly as the explorer does, so the fixture's own plan is never stale", () => {
    // The fixture's `basis` is the explorer reader's output on the fixture plan; AP's reading of the same
    // end states must agree with it, or every file would be flagged as stale.
    const bases = planVisitBases(actions);
    for (const visit of humilityMissions().visits) expect(bases.get(visit.visitId)).toEqual(visit.basis);
    expect(stageableVisitIds(humilityMissions(), planVisitState(actions))).toEqual(
      new Set(['shift_a1b2c3d', 'shift_e5e5e5e'])
    );
  });

  it('withholds a visit whose inputs changed, and says which', () => {
    const edited = actions.map(a =>
      a.id === 'wait_b1b1b1b' ? { ...a, totalTimeSeconds: a.totalTimeSeconds + 3600 } : a
    ) as Action[];
    const assessment = assessFile(humilityMissions(), planVisitState(edited));
    expect(assessment.matches).toBe(true);
    expect(assessment.reasons.get('shift_a1b2c3d')).toMatch(/time already planned on Humility/);
    // The second visit has inputs of its own, and those did not move.
    expect(assessment.reasons.has('shift_e5e5e5e')).toBe(false);
  });

  it('calls a plan with every visit changed not this plan', () => {
    const edited = actions.map(a => ({ ...a, endState: { ...a.endState, tankLevel: 1 } })) as Action[];
    expect(fileMatchesPlan(humilityMissions(), planVisitState(edited))).toBe(false);
  });

  it('does not take a plan that shares the first visit and then goes elsewhere for the file’s plan', () => {
    const file = humilityMissions();
    expect(fileMatchesPlan(file, ['shift_a1b2c3d', 'somewhere_else'])).toBe(false);
    expect(stageableVisitIds(file, ['shift_a1b2c3d', 'somewhere_else'])).toEqual(new Set());
    // A Humility visit added after the solved ones changes nothing.
    expect(stageableVisitIds(file, ['shift_a1b2c3d', 'shift_e5e5e5e', 'later'])).toEqual(
      new Set(['shift_a1b2c3d', 'shift_e5e5e5e'])
    );
  });

  it('withholds later visits of an older file once an earlier one is staged', () => {
    const file = humilityMissions();
    for (const visit of file.visits) delete visit.basis;
    const state = { ids: ['shift_a1b2c3d', 'shift_e5e5e5e'], staged: new Set(['shift_a1b2c3d']) };
    expect(stageableVisitIds(file, state)).toEqual(new Set(['shift_a1b2c3d']));
    expect(assessFile(file, state).reasons.get('shift_e5e5e5e')).toMatch(
      /earlier visit from this file has been staged/
    );
  });

  it('labels a visit by its place in the plan now', () => {
    const [visit] = humilityMissions().visits;
    expect(visitPositionLabel(visit, ['new', 'shift_a1b2c3d', 'shift_e5e5e5e'])).toBe('H2 of 3');
    expect(visitPositionLabel(visit, ['other'])).toBe('H1');
  });

  it('warns, naming both levels, when the solve used another FTL level', () => {
    const [visit] = humilityMissions().visits;
    expect(ftlMismatchWarning(visit, 55)).toBeNull();
    expect(ftlMismatchWarning(visit, 40)).toMatch(/FTL level 55.*FTL level 40/);
    expect(ftlMismatchWarning({ ...visit, epicResearchFTLLevel: undefined }, 40)).toBeNull();
  });
});

describe('what staging a visit costs', () => {
  it('stores only what the tank is short of, not the whole requirement', () => {
    const [visit] = humilityMissions().visits;
    const required = fuelForLaunches(resolveLaunches(visit));

    expect(fuelShortfalls(required, required)).toEqual([]);
    expect(fuelShortfalls(required, {})).toEqual(
      VIRTUE_EGGS.filter(egg => required[egg] > 0).map(egg => ({ egg, amount: required[egg] }))
    );
    const half = { ...required, curiosity: required.curiosity / 2 };
    expect(fuelShortfalls(required, half)).toContainEqual({ egg: 'curiosity', amount: required.curiosity / 2 });
  });

  it('schedules the makespan here, because the FTL level it depends on lives here', () => {
    const [visit] = humilityMissions().visits;
    const launches = resolveLaunches(visit);
    const totalShips = launches.reduce((sum, l) => sum + l.count, 0);

    const noFtl = launchSchedule(launches, 0);
    expect(noFtl.totalMissions).toBe(totalShips);
    expect(noFtl.totalSeconds).toBeGreaterThan(0);
    // FTL shortens the file's figure, so copying `makespanSeconds` across would overstate the plan.
    expect(launchSchedule(launches, 60).totalSeconds).toBeLessThan(noFtl.totalSeconds);
  });

  it("is never longer than the explorer's packing of the same missions", () => {
    // 2 x 16 h, 2 x 12 h, 3 x 8 h: LPT needs 115200 s, an exact packing 100800 s.
    const launches = resolveLaunches({
      ...humilityMissions().visits[0],
      launches: [
        { ship: 'GALEGGTICA', duration: 'LONG', targetAfxId: 0, count: 2 },
        { ship: 'MILLENIUM_CHICKEN', duration: 'EPIC', targetAfxId: 0, count: 2 },
        { ship: 'BCR', duration: 'EPIC', targetAfxId: 0, count: 3 },
      ],
    });
    expect(scheduleMissions(launchEntries(launches, 0)).totalSeconds).toBe(115200);
    expect(launchSchedule(launches, 0).totalSeconds).toBe(100800);
    expect(launchSchedule(launches, 0, 100800).totalSeconds).toBe(100800);
    const schedule = launchSchedule(launches, 0, 100800);
    expect(schedule.slots.map(slot => slot.totalSeconds).sort()).toEqual([100800, 100800, 86400]);
    expect(schedule.slots.flatMap(slot => slot.launches).reduce((n, l) => n + l.count, 0)).toBe(7);
  });

  it("never reports more than the explorer's rounded makespan for the same missions", () => {
    const [visit] = humilityMissions().visits;
    const launches = resolveLaunches(visit);
    // 3 Atreggies EPIC at FTL 55 is 155520 s give or take float noise. The explorer rounds its figure to
    // whole seconds, so a schedule a fraction of a second over it is that rounding, and is reported as it.
    const atreggies = resolveLaunches({ ...visit, launches: [{ ...visit.launches[1], count: 3 }] });
    expect(launchSchedule(atreggies, 55).totalSeconds).toBeCloseTo(155520, 6);
    expect(launchSchedule(atreggies, 55, 155519.6).totalSeconds).toBe(155519.6);
    expect(launchSchedule(atreggies, 55, 155518).totalSeconds).toBeCloseTo(155520, 6);
    const schedule = launchSchedule(launches, 55, visit.makespanSeconds).totalSeconds;
    expect(schedule).toBeLessThanOrEqual(visit.makespanSeconds);
    expect(schedule).toBeCloseTo(visit.makespanSeconds, 6);
  });

  it('schedules a huge fleet without walking every ship', () => {
    const t0 = performance.now();
    const schedule = launchSchedule(
      [{ ship: Spaceship.CHICKEN_ONE, duration: DurationType.SHORT, targetAfxId: 0, count: 1e7 }],
      0
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(schedule.totalMissions).toBe(1e7);
  });

  it("prices the launch from this app's ship prices", () => {
    const [visit] = humilityMissions().visits;
    const launches = resolveLaunches(visit);
    expect(launchCost(launches)).toBe(launches.reduce((cost, l) => cost + SHIP_INFO[l.ship].price * l.count, 0));
    expect(launchCost(launches)).toBeGreaterThan(0);
  });
});
