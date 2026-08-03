// Baseline entry 1: the optimizer as it ships on `main`.
//
// LP relaxation -> dominance-pruned integer search -> pack -> beam polish.
// Known to violate A1-fuel, A2-time, A3-menu, A5-effort and B1-option-order.

import { optimizeFull } from '@/lib/optimizer-core';
import type { ArenaSolver } from '../contract';
import { plannerFromOptimizeFull } from './optimizer-adapter';

export const baselineMain: ArenaSolver = {
  id: 'baseline-main',
  description: 'src/lib/optimizer-core.ts as shipped on main',
  plan: plannerFromOptimizeFull(optimizeFull),
};
