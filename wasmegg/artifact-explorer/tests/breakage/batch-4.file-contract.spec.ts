// Batch 4 export-file contract proofs: SEAM-20, 21, 22, 23, 24, 25, 26, 30.
// Run with: npx vitest run -c tests/breakage/batch-4.vitest.config.ts tests/breakage/batch-4.file-contract.spec.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ei } from 'lib';

import { gemBudgetFor, planLabelFor, type HumilityVisit } from '@/lib/plan/read';
import { buildHumilityMissionsFile, humilityMissionsFilename, projectSolvedVisit } from '@/lib/plan/write';
import type { OptimizerSolution } from '@/lib/types';
import {
  HumilityMissionsError,
  launchLabel,
  parseHumilityMissions,
  stageableVisitIds,
} from '../../../ascension-planner/src/lib/humilityMissions';
import { launchSchedule } from '../../../ascension-planner/src/lib/humilityMissions';

const fixtureFile = () =>
  JSON.parse(readFileSync(new URL('../fixtures/humility-missions.json', import.meta.url).pathname, 'utf8'));
const apParse = (x: unknown) => parseHumilityMissions(JSON.parse(JSON.stringify(x)));

afterEach(() => vi.useRealTimers());

describe('SEAM-21: filenames that yield a label AP rejects', () => {
  const bare = { version: 1, actions: [], initialState: {} };
  const visits = fixtureFile().visits;

  it.each(['.json', '   .json'])('a bare save named %j still exports a file AP accepts', name => {
    const label = planLabelFor(bare, name);
    const exported = buildHumilityMissionsFile(label, visits);
    // BREAKAGE SEAM-21: label is empty/whitespace and AP's requireString rejects the whole file.
    expect(() => apParse(exported)).not.toThrow();
  });

  it('a bare save named plan.json.gz is labelled "plan", not "plan.json.gz"', () => {
    const label = planLabelFor(bare, 'plan.json.gz');
    // BREAKAGE SEAM-21: only `.json` is stripped, unlike lib importedPlanName.
    expect(label).toBe('plan');
    expect(humilityMissionsFilename(label)).toBe('humility-missions-plan.json');
  });
});

describe('SEAM-22: one bad visit rejects the whole file', () => {
  it('keeps the good visit when visit 2 has duration TUTORIAL', () => {
    const f = fixtureFile();
    f.visits[1].launches[0].duration = 'TUTORIAL';
    // BREAKAGE SEAM-22: parse throws for the whole file, so visit 0 (valid) is lost too.
    expect(parseHumilityMissions(f).visits.map(v => v.visitIndex)).toContain(0);
  });

  it('a NaN gemCost (JSON null) on one visit loses every visit', () => {
    const f = fixtureFile();
    f.visits[1].gemCost = NaN;
    // BREAKAGE SEAM-22
    expect(() => apParse(f)).not.toThrow();
  });

  it('the explorer menu never offers TUTORIAL, so the trigger needs a bypass', async () => {
    const { missions } = await import('@/lib/missions');
    expect(missions.some(m => m.durationType === ei.MissionInfo.DurationType.TUTORIAL)).toBe(false);
  });
});

describe('SEAM-23: gemBudget overflow', () => {
  const visitWith = (earningsPerSecond: number): HumilityVisit => ({
    visitId: 'v',
    visitIndex: 0,
    label: 'H1',
    arrivalTimestamp: null,
    plannedDurationSeconds: 0,
    fuelByEgg: new Map(),
    tankLevel: 7,
    bankValue: 0,
    earningsPerSecond,
    epicResearchFTLLevel: 0,
    epicResearchZerogLevel: 0,
  });

  it('gemBudgetFor stays finite for earnings 1e300 and a 10000d budget', () => {
    // BREAKAGE SEAM-23: 1e300 * 864e6 overflows to Infinity.
    expect(Number.isFinite(gemBudgetFor(visitWith(1e300), 10000 * 86400))).toBe(true);
  });

  it('an Infinity gemBudget survives into a file AP accepts', () => {
    const f = fixtureFile();
    f.visits[0].gemBudget = gemBudgetFor(visitWith(1e300), 10000 * 86400);
    // JSON.stringify writes Infinity as null; AP rejects the file.
    expect(() => apParse(f)).not.toThrow();
  });

  it('a NaN per-ship cost (ship missing from the cost table) must not poison gemCost', () => {
    const run = {
      ship: { shipType: 0, durationType: 0, virtueGemCost: undefined as unknown as number },
      targetAfxId: 25,
      numShipsLaunched: 1,
    };
    const solution = {
      choiceHistory: [run],
      fuelByEgg: new Map(),
      perTarget: [],
      jointProbability: 0.5,
      timeUnitsUsed: 1,
      runningTimeSeconds: 1,
    } as unknown as OptimizerSolution;
    const visit = { ...visitWith(1), visitId: 'v' } as HumilityVisit;
    const out = projectSolvedVisit({ visit, solution, effort: 'max', gemBudget: 1 });
    expect(Number.isFinite(out.gemCost)).toBe(true);
  });
});

describe('SEAM-24: enum drift across deployments', () => {
  it('today every explorer ship name is known to AP (premise holds)', () => {
    const f = fixtureFile();
    const names = Object.keys(ei.MissionInfo.Spaceship).filter(k => Number.isNaN(Number(k)));
    expect(names.length).toBe(11);
    f.visits = [
      {
        ...f.visits[0],
        launches: names.map(ship => ({ ship, duration: 'SHORT', targetAfxId: 25, count: 1 })),
      },
    ];
    expect(() => apParse(f)).not.toThrow();
  });

  it('an unknown ship tells the user the files come from mismatched versions', () => {
    const f = fixtureFile();
    f.visits[0].launches[0].ship = 'NEW_SHIP';
    let message = '';
    try {
      parseHumilityMissions(f);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('NEW_SHIP'); // it is rejected
    // BREAKAGE SEAM-24: message is just `Unknown ship "NEW_SHIP".`, nothing about version skew.
    expect(message).toMatch(/version|update|newer|re-export/i);
  });

  it('an unknown target id also names a version mismatch', () => {
    const f = fixtureFile();
    f.visits[0].launches[0].targetAfxId = 99999;
    let message = '';
    try {
      parseHumilityMissions(f);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('invalid target id');
    // BREAKAGE SEAM-24
    expect(message).toMatch(/version|update|newer|re-export/i);
  });
});

describe('SEAM-25 (refuted-pre): prototype names are rejected', () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '0', 'length'];
  it.each(names)('duration %s is rejected', name => {
    const f = fixtureFile();
    f.visits[0].launches[0].duration = name;
    expect(() => parseHumilityMissions(f)).toThrow(HumilityMissionsError);
  });
  it.each(names)('ship %s is rejected', name => {
    const f = fixtureFile();
    f.visits[0].launches[0].ship = name;
    expect(() => parseHumilityMissions(f)).toThrow(HumilityMissionsError);
  });
  it('launchLabel on such names returns a plain string without throwing', () => {
    expect(() => launchLabel({ ship: '__proto__', duration: 'constructor', targetAfxId: 0, count: 1 })).not.toThrow();
    expect(typeof launchLabel({ ship: 'constructor', duration: 'toString', targetAfxId: 0, count: 1 })).toBe('string');
  });
});

describe('SEAM-26: ship counts are unbounded', () => {
  it('a crafted count of 1e9 is rejected at parse', () => {
    const f = fixtureFile();
    f.visits[0].launches[0].count = 1e9;
    // BREAKAGE SEAM-26: only isSafeInteger is checked.
    expect(() => parseHumilityMissions(f)).toThrow(HumilityMissionsError);
  });

  it('rescheduling an explorer-sized fleet (2.1e6 Chicken One SHORT) does not hang (NOT a breakage: evidence against the explorer-side claim)', () => {
    const t0 = performance.now();
    const res = launchSchedule([{ ship: 0, duration: 1, targetAfxId: 0, count: 2_100_000 }], 0);
    const ms = performance.now() - t0;
    console.log(`SEAM-26 launchSchedule 2.1e6 ships: ${ms.toFixed(0)}ms, missions=${res.totalMissions}`);
    expect(ms).toBeLessThan(5000);
  });

  it('a crafted 1e7-ship launch does not block the main thread for a second (previewLaunchDurations reruns reactively)', () => {
    const t0 = performance.now();
    launchSchedule([{ ship: 0, duration: 1, targetAfxId: 0, count: 10_000_000 }], 0);
    const ms = performance.now() - t0;
    console.log(`SEAM-26 launchSchedule 1e7 ships: ${ms.toFixed(0)}ms`);
    // BREAKAGE SEAM-26: parse accepts this count, and one synchronous recompute is far over a UI frame budget.
    expect(ms).toBeLessThan(1000);
  });
});

// Rewritten with the K4 fix: the defect was the header's claim, not the extra fields, so the check is now
// that every field the planner does not read is named in write.ts's header as informational.
describe('SEAM-20: write.ts header says only needed fields are exported', () => {
  it('every exported visit field is read by the planner or named in the write.ts header', () => {
    const visit = projectSolvedVisit({
      visit: { visitId: 'v', visitIndex: 0, label: 'H1' } as HumilityVisit,
      solution: {
        choiceHistory: [],
        fuelByEgg: new Map(),
        perTarget: [],
        jointProbability: 0,
        timeUnitsUsed: 0,
        runningTimeSeconds: 0,
      } as unknown as OptimizerSolution,
      effort: 'max',
      gemBudget: 0,
    });
    const root = new URL('../../../ascension-planner/src/', import.meta.url).pathname;
    const files = [
      root + 'lib/humilityMissions.ts',
      root + 'lib/humilityMissionsStage.ts',
      root + 'stores/humilityMissions.ts',
      new URL('../../../../ui/components/planners/actions/rockets/HumilityMissionsImport.vue', import.meta.url).pathname,
    ];
    // Strip comments: a doc comment mentioning a field is not a read.
    const code = files
      .map(f => readFileSync(f, 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const unread = Object.keys(visit).filter(k => !new RegExp(`\\b${k}\\b`).test(code));
    const writer = readFileSync(new URL('../../src/lib/plan/write.ts', import.meta.url).pathname, 'utf8');
    const header = writer.slice(0, writer.search(/^import /m));
    expect(header).not.toMatch(/only the fields the planner needs/);
    const undocumented = unread.filter(k => !new RegExp(`\\b${k}\\b`).test(header));
    // SEAM-20 (rewritten): was `expect(unread).toEqual([])`, which no doc fix could satisfy.
    expect(undocumented).toEqual([]);
    void readdirSync;
    void statSync;
    void join;
  });
});

describe('SEAM-30 (refuted-pre): generatedAt does not affect anything', () => {
  it('two exports at different times parse and stage identically apart from the timestamp', () => {
    const visits = fixtureFile().visits;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const a = buildHumilityMissionsFile('p', visits);
    vi.setSystemTime(new Date('2030-06-01T00:00:00Z'));
    const b = buildHumilityMissionsFile('p', visits);
    expect(a.generatedAt).not.toBe(b.generatedAt);
    const pa = apParse(a);
    const pb = apParse(b);
    expect({ ...pa, generatedAt: 0 }).toEqual({ ...pb, generatedAt: 0 });
    const ids = visits.map((v: { visitId: string }) => v.visitId);
    expect(stageableVisitIds(pa, ids)).toEqual(stageableVisitIds(pb, ids));
  });
  it('AP code outside the parser never reads generatedAt', () => {
    const root = new URL('../../../ascension-planner/src/', import.meta.url).pathname;
    for (const f of ['lib/humilityMissionsStage.ts', 'stores/humilityMissions.ts']) {
      expect(readFileSync(root + f, 'utf8')).not.toMatch(/generatedAt/);
    }
  });
});
