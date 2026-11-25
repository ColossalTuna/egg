import { describe, it, expect } from 'vitest';
import { packWitness } from '@/lib/packing';

const TOL = 1e-9;

function bruteForcePacks(durations: number[], counts: number[], capacity: number): boolean {
  const items: number[] = [];
  durations.forEach((d, j) => {
    for (let k = 0; k < counts[j]; k++) items.push(d);
  });
  items.sort((a, b) => b - a);
  const loads = [0, 0, 0];
  const place = (i: number): boolean => {
    if (i === items.length) return true;
    for (let s = 0; s < 3; s++) {
      if (loads[s] + items[i] <= capacity + TOL) {
        loads[s] += items[i];
        if (place(i + 1)) return true;
        loads[s] -= items[i];
      }
    }
    return false;
  };
  return place(0);
}

describe('SOL-08 memo key rounds loads to whole units', () => {
  it('packs the sub-second instance the brute force packs', () => {
    const durations = [0.729, 0.247, 0.497, 0.671];
    const counts = [1, 2, 2, 3];
    const capacity = 1.469;
    expect(bruteForcePacks(durations, counts, capacity)).toBe(true);
    const w = packWitness(durations, counts, capacity);
    // BREAKAGE SOL-08
    expect(w).not.toBeNull();
    expect(w).not.toBeUndefined();
  });
});

// Exact rational arithmetic on doubles, so "this layout fits" is a fact about the reals and not about
// whichever float summation order a packer happens to use.
function exactDouble(x: number): bigint {
  // x * 2^60, exact for every double used here (they all carry at most 60 fractional bits)
  let v = x;
  let k = 0;
  while (!Number.isInteger(v)) {
    v *= 2;
    k++;
  }
  return BigInt(v) * (1n << BigInt(60 - k));
}

describe('SOL-09 fixed 1e-9 EPS at capacity ~1e7', () => {
  it('packs three identical slots whose exact real load is at most the capacity', () => {
    const durations = [1954285.7142857146, 1954285.7142857201, 1368000.0000000042];
    const perSlot = [2, 2, 3];
    const capacity = 11921142.857142882;
    const exactLoad = durations.reduce((s, d, i) => s + BigInt(perSlot[i]) * exactDouble(d), 0n);
    // Precondition: the identical-slot layout provably fits, with nothing borrowed from the tolerance.
    expect(exactLoad <= exactDouble(capacity)).toBe(true);
    const w = packWitness(
      durations,
      perSlot.map(m => m * 3),
      capacity
    );
    // BREAKAGE SOL-09
    expect(w).not.toBeNull();
  });
});
