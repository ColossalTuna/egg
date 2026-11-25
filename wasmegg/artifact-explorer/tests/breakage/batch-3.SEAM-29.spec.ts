// SEAM-29: staging H1 inserts time, gem spend and fuel phases ahead of H2. H2's file answer was solved
// against the un-staged plan, yet it still passes the prefix-id check and stages without a note.
//
// Rewritten with the KP fix. The old assertions demanded that H2's bank, fuel and arrival stay put after H1 is
// staged, which no fix can give: H1's launch spends fuel and time ahead of H2 by design. The defect is that H2's
// answer was still offered. H2's total gem budget (contract section 2: bank on arrival plus earnings over the
// window), tank and time are part of the visit inputs the file now records (`basis`), so the check is that once
// they move H2 is withheld and staging it is refused, while H1 can still be restaged.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { simulate } from 'lib/planners/engine/simulate';
import { createSimAction, type Action } from '@planner/types';
import {
  planVisitBases,
  stageableVisitIds,
  type HumilityMissionsFile,
} from '@planner/lib/humilityMissions';
import { importPlanState } from '@planner/lib/humilityMissionsStage';
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
  it('H2 is withheld once staging H1 has moved the inputs it was solved against (BREAKAGE SEAM-29)', () => {
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

    // The file as the explorer writes it: each visit carries the inputs it was solved against.
    const bases = planVisitBases(original);
    const h1 = visitOf({
      visitId: 'h1',
      launches: [{ ship: 'CHICKFIANT', duration: 'SHORT', targetAfxId: 0, count: 100 }],
      makespanSeconds: 86400,
      basis: bases.get('h1'),
    });
    const h2 = visitOf({ visitId: 'h2', visitIndex: 1, label: 'H2', basis: bases.get('h2') });
    const file = { visits: [h1, h2] } as unknown as HumilityMissionsFile;
    expect(stageableVisitIds(file, importPlanState(original, contextAt(0), base))).toEqual(new Set(['h1', 'h2']));

    const stagedH1 = stageAt(0, original, h1, base);
    const [, h2After] = sliceHumilityVisits(toSave(stagedH1));
    expect(h2After.visitId).toBe('h2');
    // H1's launch runs ahead of H2, so H2 arrives later: the plan H2 was solved against is gone.
    expect(h2After.arrivalTimestamp).not.toBe(h2Before.arrivalTimestamp);

    const state = importPlanState(stagedH1, contextAt(0), base);
    // BREAKAGE SEAM-29: H2 is no longer offered; H1 can still be restaged.
    expect(stageableVisitIds(file, state)).toEqual(new Set(['h1']));
    expect(() => stageAt(0, stagedH1, h2, base)).toThrow(/changed since H2 was solved/);
    expect(() => stageAt(0, stagedH1, h1, base)).not.toThrow();
    // A file from before `basis` was written has nothing to compare, so H2 is withheld because H1 was staged.
    const older = { visits: [{ ...h1, basis: undefined }, { ...h2, basis: undefined }] } as unknown as HumilityMissionsFile;
    expect(stageableVisitIds(older, importPlanState(original, contextAt(0), base))).toEqual(new Set(['h1', 'h2']));
    expect(stageableVisitIds(older, state)).toEqual(new Set(['h1']));
  });
});
