import { describe, it, expect } from 'vitest';
import { packMultiset, fitsAll, mayPack3, exactPack3, canPack3 } from './packing';

describe('packMultiset (best-fit-decreasing)', () => {
  it('places everything when it fits and reports no unplaced', () => {
    const p = packMultiset([5, 5, 5, 5, 5, 5], 10);
    expect(p.unplaced).toEqual([]);
    for (const load of p.loads) expect(load).toBeLessThanOrEqual(10);
    expect(p.loads.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('never overfills a bin; excess is reported unplaced', () => {
    // seven items of 6 into 3 bins of 10: each bin holds only one, so 4 spill
    const p = packMultiset([6, 6, 6, 6, 6, 6, 6], 10);
    for (const load of p.loads) expect(load).toBeLessThanOrEqual(10);
    expect(p.unplaced.length).toBe(4);
  });

  it('returns valid witnesses (each bin within capacity)', () => {
    const durations = [9, 8, 2, 2, 1, 7, 3];
    const p = packMultiset(durations, 10);
    p.bins.forEach((bin, b) => {
      const load = bin.reduce((s, idx) => s + durations[idx], 0);
      expect(load).toBeCloseTo(p.loads[b], 9);
      expect(load).toBeLessThanOrEqual(10);
    });
  });
});

describe('fitsAll', () => {
  it('true when a partition into 3 bins exists', () => {
    expect(fitsAll([10, 10, 10], 10)).toBe(true);
    expect(fitsAll([5, 5, 5, 5, 5, 5], 10)).toBe(true);
  });
  it('false when total exceeds 3 bins', () => {
    expect(fitsAll([10, 10, 10, 1], 10)).toBe(false);
  });
});

describe('mayPack3 necessary conditions', () => {
  it('rejects an item longer than a single slot', () => {
    expect(mayPack3([1], [11], 10)).toBe(false);
  });
  it('rejects when total exceeds 3 slots', () => {
    expect(mayPack3([4], [10], 10)).toBe(false); // 40 > 30
  });
  it('rejects more than 3 items over half capacity', () => {
    expect(mayPack3([4], [6], 10)).toBe(false); // four 6s can't share 3 bins
    expect(mayPack3([3], [6], 10)).toBe(true);
  });
});

describe('exactPack3 / canPack3', () => {
  it('produces a valid witness for a feasible instance', () => {
    // 9,1,8,2,7,3 (sum 30) into 3 bins of 10 -> {9,1},{8,2},{7,3}
    const counts = [1, 1, 1, 1, 1, 1];
    const durations = [9, 1, 8, 2, 7, 3];
    const w = exactPack3(counts, durations, 10);
    expect(w).not.toBeNull();
    // verify witness: bins within capacity, all items placed
    const placed = [0, 0, 0, 0, 0, 0];
    w!.forEach(binCounts => {
      let load = 0;
      binCounts.forEach((cnt, j) => {
        load += cnt * durations[j];
        placed[j] += cnt;
      });
      expect(load).toBeLessThanOrEqual(10);
    });
    expect(placed).toEqual(counts);
  });

  it('agrees with a known-infeasible instance', () => {
    // four items of 7 into 3 bins of 10: only one per bin -> infeasible
    expect(canPack3([4], [7], 10)).toBe(false);
  });

  it('handles multiple copies of few distinct durations', () => {
    // 3x6 + 3x4 into 3 bins of 10: each bin {6,4}=10 -> feasible
    expect(canPack3([3, 3], [6, 4], 10)).toBe(true);
    // 3x6 + 4x4: total 34 > 30 -> infeasible
    expect(canPack3([3, 4], [6, 4], 10)).toBe(false);
  });

  it('is exact where best-fit-decreasing gives up', () => {
    // durations chosen so greedy leaves an item unplaced but a partition exists
    const durations = [5, 5, 5, 5, 5, 5];
    expect(fitsAll(durations, 10)).toBe(true);
    expect(canPack3([6], [5], 10)).toBe(true);
  });
});
