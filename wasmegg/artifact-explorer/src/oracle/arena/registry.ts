// The arena roster.
//
// Add one line per candidate. Nothing else in the harness needs to know a
// candidate exists, and the harness never imports a solver module directly —
// it asks here.

import type { ArenaSolver } from './contract';
import { baselineMain } from './solvers/baseline-main';
import { baselineFixed } from './solvers/baseline-fixed';

export const SOLVERS: ArenaSolver[] = [
  baselineMain,
  baselineFixed,
  // <- register your candidate here
];

export function solverById(id: string): ArenaSolver {
  const found = SOLVERS.find(s => s.id === id);
  if (!found) {
    throw new Error(`unknown solver "${id}"; registered: ${SOLVERS.map(s => s.id).join(', ')}`);
  }
  return found;
}

// `SOLVER=a,b` selects a subset; unset runs the whole roster.
export function selectedSolvers(): ArenaSolver[] {
  const spec = process.env.SOLVER;
  if (!spec) return SOLVERS;
  return spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(solverById);
}
