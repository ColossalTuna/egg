// SEAM-17: the checked-in humility-missions.json carries makespan figures the writer cannot produce.
// At effort "medium" (43200s floor) with every mission longer than the floor, makespanSeconds must
// equal rawMakespanSeconds, and both must be a sum of whole-mission durations at the plan's FTL.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ei, MissionType } from 'lib';
import { parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { EFFORT_LAUNCH_PERIOD_SECONDS } from '@/store/schema';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const file = fixture('humility-missions.json');
const ftl = sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json')))[0].epicResearchFTLLevel;

function durations(visit: (typeof file.visits)[number]) {
  const floor = EFFORT_LAUNCH_PERIOD_SECONDS[visit.effort as 'medium'];
  const out: { raw: number; floored: number }[] = [];
  for (const l of visit.launches) {
    const ship = (ei.MissionInfo.Spaceship as unknown as Record<string, number>)[l.ship];
    const dur = (ei.MissionInfo.DurationType as unknown as Record<string, number>)[l.duration];
    const raw = new MissionType(ship, dur as ei.MissionInfo.DurationType).boostedDurationSecondsAtLevel(ftl);
    for (let i = 0; i < l.count; i++) out.push({ raw, floored: Math.max(raw, floor) });
  }
  return out;
}

// Every load one slot can carry: a subset sum of the mission durations.
function subsetSums(ds: number[]): Set<number> {
  let sums = new Set<number>([0]);
  for (const d of ds) sums = new Set([...sums, ...[...sums].map(s => Math.round((s + d) * 1e6) / 1e6)]);
  return sums;
}

describe('SEAM-17 fixture timing figures', () => {
  it('fixture plan is at FTL 55', () => expect(ftl).toBe(55));

  for (const [i, visit] of file.visits.entries()) {
    describe(`visit ${i}`, () => {
      const ds = durations(visit);
      it('the effort floor does not bind, so makespan equals raw makespan (BREAKAGE SEAM-17)', () => {
        expect(ds.every(d => d.raw > EFFORT_LAUNCH_PERIOD_SECONDS.medium)).toBe(true);
        // BREAKAGE SEAM-17
        expect(visit.makespanSeconds).toBe(visit.rawMakespanSeconds);
      });
      it('makespanSeconds is a load the writer could produce (BREAKAGE SEAM-17)', () => {
        const sums = subsetSums(ds.map(d => d.floored));
        // BREAKAGE SEAM-17
        expect(sums.has(visit.makespanSeconds)).toBe(true);
      });
      it('rawMakespanSeconds is a load the writer could produce', () => {
        expect(subsetSums(ds.map(d => d.raw)).has(visit.rawMakespanSeconds)).toBe(true);
      });
    });
  }
});
