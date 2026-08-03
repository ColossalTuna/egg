// Baseline entry 2: the same optimizer with the four ordering/seeding fixes
// from branch `optimizer-invariant-harness` (commits 02603a81, 7c640812).
//
//   1. intrinsic tie-break on LaunchOption.id, so ranking never falls through
//      to array position
//   2. contention-band beam retention instead of a flat top-K cutoff
//   3. adjacency candidates ranked by the LP's reduced cost, so the candidate
//      sources are no longer blind to combinatorial value
//   4. a forced alternate LP vertex, so a near-degenerate relaxation cannot
//      flip the integer seed on menu growth
//
// Vendored rather than merged into `src/lib` on purpose: this branch changes no
// shipping code, so the arena measures candidates against both versions without
// having decided which one production should carry.

import { optimizeFull } from './vendor/optimizer-core-fixed';
import type { ArenaSolver } from '../contract';
import { plannerFromOptimizeFull } from './optimizer-adapter';

export const baselineFixed: ArenaSolver = {
  id: 'baseline-fixed',
  description: 'optimizer-core.ts + the four tie-break / beam / candidate / LP-seed fixes',
  plan: plannerFromOptimizeFull(optimizeFull),
};
