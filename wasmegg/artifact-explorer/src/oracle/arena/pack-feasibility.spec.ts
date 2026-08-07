// Regression guard for `pack-feasibility.ts`, the arena's fixed goalpost: C1
// fails a plan on its verdict and every k-opt move filters on it.
//
// The bug this pins: the memo keyed infeasible states on slot loads rounded to
// whole seconds. Mission durations are fractional, so distinct states collided
// — [0, 1.075, 2.15] and [0, 1, 2] became the same key — and a packable plan
// came back `infeasible`. The named case below is one such plan; it failed on
// the old key and passes on the exact one.
//
// A 3000-instance brute-force fuzz sweep is what found it. That sweep was dev
// scaffolding and is gone; what is left is deterministic, fast, and pins the
// specific behaviours (fractional memo keys, and each of the by-inspection
// shortcuts) rather than re-running a search.
import { describe, expect, it } from 'vitest';
import { packFeasible } from './pack-feasibility';

describe('packFeasible', () => {
  it('packs the instance the rounded memo key rejected', () => {
    // Three 0.806s, two 0.64s and two 1.203s do fit three slots of 2.157:
    // 1.203+0.64, 1.203+0.64, 0.806+0.806 — and the last 0.806 goes with a
    // 1.203 (2.009) or alongside the pair (1.612). The rounded key said
    // `infeasible`.
    expect(packFeasible([0.806, 0.64, 1.203], [3, 2, 2], 2.157, 3)).toBe('packs');
  });

  it('still rejects what genuinely does not fit', () => {
    expect(packFeasible([1.075], [3], 1.075, 3)).toBe('packs');
    expect(packFeasible([1.075], [4], 1.075, 3)).toBe('infeasible');
  });

  it('decides the by-inspection cases without searching', () => {
    // No horizon: only zero-length work fits.
    expect(packFeasible([1], [1], 0, 3)).toBe('infeasible');
    expect(packFeasible([0], [5], 0, 3)).toBe('packs');
    // A mission longer than a whole slot is fatal on its own.
    expect(packFeasible([2.5], [1], 2, 3)).toBe('infeasible');
    // Zero-length missions are free everywhere and never consume load.
    expect(packFeasible([0, 1], [100, 3], 1, 3)).toBe('packs');
  });

  it('reports `undecided` rather than guessing when the node budget runs out', () => {
    expect(packFeasible([0.806, 0.64, 1.203], [3, 2, 2], 2.157, 3, 1)).toBe('undecided');
  });
});
