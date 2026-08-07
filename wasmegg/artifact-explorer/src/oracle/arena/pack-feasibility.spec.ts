// `pack-feasibility.ts` is the arena's fixed goalpost: C1 fails a plan on its
// verdict and every k-opt move filters on it. Nothing else in the arena can
// check it, because everything else is what it is there to judge. So it is
// checked here against the definition directly — exhaustive assignment of every
// mission to a slot — on the regime that actually broke it.
//
// It did break. The memo keyed infeasible states on slot loads rounded to whole
// seconds; durations are fractional, so distinct states collided and a packable
// plan came back `infeasible`. This sweep reproduces that in ~30 trials, which
// is why it is a sweep over random instances rather than the one case found.
import { describe, expect, it } from 'vitest';
import { packFeasible } from './pack-feasibility';

// Exhaustive assignment of every mission to a slot.
function brute(durations: number[], counts: number[], capacity: number, slots: number): boolean {
  const items: number[] = [];
  for (let j = 0; j < durations.length; j++) {
    for (let k = 0; k < counts[j]; k++) items.push(durations[j]);
  }
  const loads = new Array<number>(slots).fill(0);
  const go = (i: number): boolean => {
    if (i === items.length) return true;
    for (let s = 0; s < slots; s++) {
      if (loads[s] + items[i] <= capacity + 1e-9) {
        loads[s] += items[i];
        if (go(i + 1)) return true;
        loads[s] -= items[i];
      }
    }
    return false;
  };
  return go(0);
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('packFeasible agrees with brute force', () => {
  it('over 3000 random fractional-duration instances', () => {
    const rng = mulberry32(20260807);
    const disagreements: string[] = [];
    for (let trial = 0; trial < 3000; trial++) {
      const kinds = 1 + Math.floor(rng() * 3);
      const durations: number[] = [];
      const counts: number[] = [];
      let total = 0;
      for (let j = 0; j < kinds; j++) {
        // Deliberately fractional, and close enough together that rounding
        // to whole seconds collapses distinct load triples.
        const d = Math.round((0.5 + rng() * 2.5) * 1000) / 1000;
        const c = 1 + Math.floor(rng() * 4);
        durations.push(d);
        counts.push(c);
        total += d * c;
      }
      if (total > 12) continue; // keep brute force cheap
      const capacity = Math.round((1 + rng() * 4) * 1000) / 1000;
      const slots = 3;
      const verdict = packFeasible(durations, counts, capacity, slots);
      if (verdict === 'undecided') continue;
      const truth = brute(durations, counts, capacity, slots);
      if ((verdict === 'packs') !== truth) {
        disagreements.push(
          `durations=${JSON.stringify(durations)} counts=${JSON.stringify(counts)} cap=${capacity} -> ${verdict}, brute=${truth}`
        );
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it('the instance the rounded memo key rejected', () => {
    // Found by the sweep above against the old key, and kept as the named case:
    // three 0.806s, two 0.64s and two 1.203s do fit three slots of 2.157
    // (1.203+0.64, 1.203+0.64, 0.806*2 leaves one 0.806 -- 0.806*2 = 1.612 and
    // 1.203+0.806 = 2.009, both under). The rounded key said `infeasible`.
    expect(packFeasible([0.806, 0.64, 1.203], [3, 2, 2], 2.157, 3)).toBe('packs');
  });

  it('still rejects what genuinely does not fit', () => {
    expect(packFeasible([1.075], [3], 1.075, 3)).toBe('packs');
    expect(packFeasible([1.075], [4], 1.075, 3)).toBe('infeasible');
  });
});
