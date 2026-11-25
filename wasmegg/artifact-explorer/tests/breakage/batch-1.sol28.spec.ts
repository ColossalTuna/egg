import { describe, it, expect } from 'vitest';
import { buildModel } from '@/lib/solver/model';
import { buildOaMilp, effectiveQs, scaleLps } from '@/lib/solver/milp';
import { INF, type PlanProblem } from '@/lib/solver/types';
import { logGrid } from '@/lib/solver/solve';
import { craftDag, makeNode, makeOpt } from '../unit/spec-helpers';

function problems(): PlanProblem[] {
  const base = { fuelCapacity: 1000, timeCapacityPerSlot: 100, slots: 3 };
  const two = new Map([
    ['A', makeNode('A', false, [['B', 2]], 0.1)],
    ['B', makeNode('B', true)],
    ['U', makeNode('U', true)],
  ]);
  return [
    { ...base, options: [makeOpt(1, 10, [['B', 1]])], dag: craftDag(0.1), targets: ['A'], ownedStock: new Map() },
    { ...base, options: [makeOpt(1, 10, [['B', 1]])], dag: craftDag(1), targets: ['A'], ownedStock: new Map([['B', 1e31]]) },
    {
      ...base,
      options: [makeOpt(1, 10, [['B', 1]], [['U', 0.01]])],
      dag: two,
      targets: ['A', 'U'],
      ownedStock: new Map([['B', 1e-12]]),
      craftBudget: { capacity: 0, unitPrices: new Map([['A', 5]]) },
    },
    {
      ...base,
      options: [makeOpt(1, 10, [['B', 1]], [['U', 0.01]])],
      dag: two,
      targets: ['A', 'U'],
      ownedStock: new Map(),
      craftBudget: { capacity: 1e12, unitPrices: new Map([['A', 1e-3]]) },
    },
  ];
}

describe('SOL-28 equality rows are only (0, 0)', () => {
  it('every lo === up row built by scaleLps / buildOaMilp is exactly zero-bounded, and nothing is +-inf equal', () => {
    for (const p of problems()) {
      const model = buildModel(p);
      const qs = effectiveQs(model);
      const theta = model.sortedTargets.map(() => 7);
      const models = [scaleLps(model, qs)(0), buildOaMilp(model, qs, theta, logGrid(0.01, 50))];
      for (const m of models) {
        for (let r = 0; r < m.rowCount; r++) {
          const lo = m.rowLower[r];
          const up = m.rowUpper[r];
          if (lo === up) {
            expect(lo, m.rowNames[r]).toBe(0);
          }
          expect(Math.abs(lo) >= INF && lo === up, m.rowNames[r]).toBe(false);
        }
      }
    }
  });
});
