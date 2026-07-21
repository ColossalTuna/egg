// Three-slot mission packing.
//
// The player has three mission slots. Each slot independently runs a
// back-to-back sequence of single-ship missions, and the total duration of a
// slot's sequence must not exceed the shared horizon S. So a chosen multiset
// of missions is realizable iff its durations can be partitioned into 3 bins
// each of capacity S (a bin-packing feasibility question). The HARD CONTRACT
// is per-slot: a mission fits only if it fits ONE slot's remaining time, never
// the sum across slots.
//
// Two routines, for two callers:
//   - packMultiset: fast best-fit-decreasing placement used on the optimizer's
//     hot path. It never claims a false witness — a returned placement is
//     always valid (every bin <= capacity); items it cannot place are reported
//     as `unplaced` rather than force-fit.
//   - exactPack3 / canPack3: exact feasibility (with witness) for the few
//     distinct durations a candidate touches, used to close the residual gap
//     on small supports. Bounded so it can never dominate the 100ms budget.
//
// The oracle deliberately re-derives its own packing check (see
// oracle/enumerate.ts) rather than importing this module, to keep the
// correctness harness independent of the code under test.

const KEY_SCALE = 1; // durations are in seconds; sub-second precision is noise
const ZERO = 1e-9;

/** A best-fit-decreasing placement of `durations` into `nBins` bins of `capacity`. */
export interface Placement {
  bins: number[][]; // per bin: indices into the input `durations`
  loads: number[]; // per bin: summed duration
  unplaced: number[]; // indices that did not fit any bin
}

// Place items largest-first into the fullest bin that still has room
// (best-fit). Best-fit-decreasing packs tightly and, because we only ever add
// to a bin when it stays within capacity, every returned bin is feasible by
// construction. Items that fit nowhere are returned in `unplaced` — the caller
// decides whether to drop them (they are marginal excess from a relaxation) or
// treat the candidate as needing repair.
export function packMultiset(durations: number[], capacity: number, nBins = 3): Placement {
  const order = durations.map((_, i) => i).sort((a, b) => durations[b] - durations[a]);
  const bins: number[][] = Array.from({ length: nBins }, () => []);
  const loads = new Array<number>(nBins).fill(0);
  const unplaced: number[] = [];

  for (const idx of order) {
    const d = durations[idx];
    let best = -1;
    let bestLoad = -1;
    for (let b = 0; b < nBins; b++) {
      if (loads[b] + d <= capacity + ZERO && loads[b] > bestLoad) {
        best = b;
        bestLoad = loads[b];
      }
    }
    if (best === -1) {
      unplaced.push(idx);
    } else {
      bins[best].push(idx);
      loads[best] += d;
    }
  }

  return { bins, loads, unplaced };
}

/** True iff every item fit — i.e. the whole multiset packs into `nBins` bins. */
export function fitsAll(durations: number[], capacity: number, nBins = 3): boolean {
  return packMultiset(durations, capacity, nBins).unplaced.length === 0;
}

// Cheap one-way necessary conditions for 3-bin feasibility. A `false` here is a
// definitive "cannot pack"; a `true` means "not obviously infeasible" and says
// nothing more. Used to reject hopeless candidates before the exact check.
export function mayPack3(counts: number[], durations: number[], capacity: number): boolean {
  let total = 0;
  let big = 0; // items larger than half the capacity — at most one per bin
  for (let j = 0; j < counts.length; j++) {
    const c = counts[j];
    if (c <= 0) continue;
    const d = durations[j];
    if (d > capacity + ZERO) return false;
    total += c * d;
    if (d > capacity / 2 + ZERO) big += c;
  }
  if (total > 3 * capacity + ZERO) return false;
  if (big > 3) return false;
  return true;
}

type Loads = readonly [number, number, number];

function key(loads: Loads): number {
  // canonicalize: bins are identical, so sort loads; scale+round to a stable key
  const s = [...loads].sort((a, b) => a - b);
  const q0 = Math.round(s[0] / KEY_SCALE);
  const q1 = Math.round(s[1] / KEY_SCALE);
  const q2 = Math.round(s[2] / KEY_SCALE);
  // pack three bounded integers into one number key
  return (q0 * 2097152 + q1) * 2097152 + q2;
}

// Exact 3-bin feasibility for a multiset given as per-duration counts, with a
// witness (per-bin counts of each duration). Returns null when infeasible OR
// when the search exceeds `nodeBudget` — callers must treat null as "no usable
// witness" and never as "feasible", so a budget cutout is always safe (it can
// only make us miss an improvement, never fabricate one).
export function exactPack3(
  counts: number[],
  durations: number[],
  capacity: number,
  nodeBudget = 200_000
): number[][] | null {
  const m = counts.length;
  if (!mayPack3(counts, durations, capacity)) return null;

  const memo = new Map<string, boolean>();
  let nodes = 0;
  let budgetHit = false;

  // Feasibility of assigning durations j..m-1 given current bin loads.
  const feasible = (j: number, loads: Loads): boolean => {
    if (j === m) return true;
    if (budgetHit) return false;
    if (++nodes > nodeBudget) {
      budgetHit = true;
      return false;
    }
    const memoKey = `${j}#${key(loads)}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;

    const c = counts[j];
    const d = durations[j];
    let result = false;
    // distribute c copies of size d as (x0, x1, x2) across the three bins
    const room = (l: number) => Math.floor((capacity - l + ZERO) / d);
    const r0 = Math.min(c, room(loads[0]));
    for (let x0 = 0; x0 <= r0 && !result; x0++) {
      const l0 = loads[0] + x0 * d;
      const rem1 = c - x0;
      const r1 = Math.min(rem1, room(loads[1]));
      for (let x1 = 0; x1 <= r1; x1++) {
        const x2 = rem1 - x1;
        const l2 = loads[2] + x2 * d;
        if (l2 > capacity + ZERO) continue; // too many left for bin 2
        const l1 = loads[1] + x1 * d;
        if (feasible(j + 1, [l0, l1, l2])) {
          result = true;
          break;
        }
      }
    }
    memo.set(memoKey, result);
    return result;
  };

  if (!feasible(0, [0, 0, 0])) return null;

  // Reconstruct a concrete witness by replaying the feasible splits on the
  // actual (un-canonicalized) loads.
  const witness: number[][] = [
    new Array<number>(m).fill(0),
    new Array<number>(m).fill(0),
    new Array<number>(m).fill(0),
  ];
  let loads: Loads = [0, 0, 0];
  for (let j = 0; j < m; j++) {
    const c = counts[j];
    const d = durations[j];
    const room = (l: number) => Math.floor((capacity - l + ZERO) / d);
    let placed = false;
    const r0 = Math.min(c, room(loads[0]));
    for (let x0 = 0; x0 <= r0 && !placed; x0++) {
      const rem1 = c - x0;
      const r1 = Math.min(rem1, room(loads[1]));
      for (let x1 = 0; x1 <= r1; x1++) {
        const x2 = rem1 - x1;
        const l0 = loads[0] + x0 * d;
        const l1 = loads[1] + x1 * d;
        const l2 = loads[2] + x2 * d;
        if (l2 > capacity + ZERO) continue;
        if (feasible(j + 1, [l0, l1, l2])) {
          witness[0][j] = x0;
          witness[1][j] = x1;
          witness[2][j] = x2;
          loads = [l0, l1, l2];
          placed = true;
          break;
        }
      }
    }
    if (!placed) return null; // should not happen once feasible() succeeded
  }
  return witness;
}

/** Boolean form of {@link exactPack3}. */
export function canPack3(counts: number[], durations: number[], capacity: number, nodeBudget = 200_000): boolean {
  return exactPack3(counts, durations, capacity, nodeBudget) !== null;
}
