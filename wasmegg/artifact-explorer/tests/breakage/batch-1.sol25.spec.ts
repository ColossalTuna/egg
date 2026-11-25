import { describe, it, expect } from 'vitest';
import { loadHighs } from '@/lib/solver/highs';
import { solveWith } from '@/lib/solver/solve';
import { buildModel } from '@/lib/solver/model';
import { packWitness } from '@/lib/packing';
import { makeNode, makeOpt } from '../unit/spec-helpers';

const solve = await loadHighs();
const SLOW = 684.0000000000001;
const S = 1111; // 684 / 1111 === 684.0000000000001 / 1111

function problem(times: number[]) {
  const dag = new Map([['T', makeNode('T', true)]]);
  return {
    options: times.map(t => makeOpt(0, t, [], [['T', 0.001]])),
    dag,
    targets: ['T'],
    fuelCapacity: 1,
    timeCapacityPerSlot: S,
    slots: 3,
    ownedStock: new Map<string, number>(),
  };
}

describe('SOL-25 merge on timeFraction vs exact seconds', () => {
  for (const times of [
    [SLOW, 684],
    [684, SLOW],
  ]) {
    it(`options ${times.join(' / ')}`, () => {
      const p = problem(times);
      const model = buildModel(p);
      // Precondition for the hypothesis: the two options really do land in one group.
      expect(SLOW / S === 684 / S).toBe(true);
      expect(model.groups.length).toBe(1);
      const grp = model.groups[0];
      // Exported time == optimized time: the group's seconds are those of the option that receives the launches.
      expect(grp.timeSeconds).toBe(p.options[grp.members[0]].actualTime);

      const res = solveWith(p, solve, undefined);
      const durations = p.options.map(o => o.actualTime);
      const w = packWitness(durations, res.allocation, S);
      expect(w, JSON.stringify(res.allocation)).not.toBeNull();
      const used = res.allocation.reduce((a, n, i) => a + n * durations[i], 0);
      // eslint-disable-next-line no-console
      expect(used).toBeLessThanOrEqual(3 * S + 1e-9);
    });
  }
});
