// SEAM-01: makespanSeconds is the busiest slot of a feasibility witness, not a minimized schedule,
// and the planner waits out the difference.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ei, MissionType } from 'lib';
import { optimizeFull } from '@/lib/optimizer-core';
import { projectSolvedVisit } from '@/lib/plan/write';
import type { HumilityVisit } from '@/lib/plan/read';
import { launchSchedule, resolveLaunches } from '@planner/lib/humilityMissions';
import { plan, baseState, stageAt, visitOf } from './batch-3.helpers';
import { lt1, lt2, makeNode, makeOpt } from '../unit/spec-helpers';
import type { RecipeDAG } from '@/lib/types';

beforeEach(() => setActivePinia(createPinia()));

const BCR_EPIC = 28800; // non-FTL, so AP's FTL level cannot move it

async function solve9Bcr(S: number) {
  const dag: RecipeDAG = new Map([
    [lt2, makeNode(lt2, false, [[lt1, 2]], 0.1)],
    [lt1, makeNode(lt1, true)],
  ]);
  const opt = {
    ...makeOpt(1, BCR_EPIC, [[lt1, 1]]),
    ship: new MissionType(ei.MissionInfo.Spaceship.BCR, ei.MissionInfo.DurationType.TUTORIAL), // placeholder, replaced below
  };
  // EPIC in the explorer's protobuf numbering is not the planner's; use the protobuf EPIC member by name.
  const epic = (ei.MissionInfo.DurationType as unknown as Record<string, number>)['EPIC'];
  opt.ship = new MissionType(ei.MissionInfo.Spaceship.BCR, epic as ei.MissionInfo.DurationType);
  const sol = await optimizeFull({
    options: [opt],
    recipeDag: dag,
    desiredArtifactNodeIds: [lt2],
    fuelCapacity: 9, // 1 fuel per ship: exactly 9 launches
    timeCapacityPerSlot: S,
    ownedStock: new Map(),
    maximumCost: Infinity,
  });
  return sol;
}

describe('SEAM-01 makespan is a witness packing, not the minimum', () => {
  it('explorer reports the LPT-optimal makespan for 9 equal missions (BREAKAGE SEAM-01)', async () => {
    const sol = await solve9Bcr(6 * BCR_EPIC);
    const launched = sol.choiceHistory.reduce((n, c) => n + c.numShipsLaunched, 0);
    expect(launched).toBe(9);
    // 9 equal missions fit 3 per slot: the shortest possible makespan is 3 * 28800.
    // BREAKAGE SEAM-01
    expect(sol.timeUnitsUsed).toBe(3 * BCR_EPIC);
  });

  it('planner stages no dead wait for the explorer answer (BREAKAGE SEAM-01)', async () => {
    const S = 6 * BCR_EPIC;
    const sol = await solve9Bcr(S);
    const visit = projectSolvedVisit({
      visit: { visitId: 'humility', visitIndex: 0, label: 'H1' } as HumilityVisit,
      solution: sol,
      effort: 'max',
      gemBudget: 1e60,
    });
    const launches = resolveLaunches(visit as never);
    const lpt = launchSchedule(launches, 0).totalSeconds;
    expect(lpt).toBe(3 * BCR_EPIC);

    const staged = stageAt(0, plan(), { ...visitOf(), launches: visit.launches, makespanSeconds: visit.makespanSeconds });
    const wait = staged.find(a => a.type === 'wait_for_time');
    // BREAKAGE SEAM-01
    expect(wait?.totalTimeSeconds ?? 0).toBe(0);
    void baseState;
  });
});
