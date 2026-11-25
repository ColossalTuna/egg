// Batch 2: solver model scenarios SOL-06, 07, 14, 15, 17, 18, 19, 21, 22 (SOL-05/20 live in batch-2.sol05-20.spec.ts).
import { describe, expect, it } from 'vitest';
import { ei } from 'lib';
import { buildRecipeDag } from '@/lib';
import { craftsToProbability } from '@/lib/objective';
import { optimizeFull, type OptimizeArgs } from '@/lib/optimizer-core';
import { loadHighs } from '@/lib/solver/highs';
import { DEFAULT_TUNING, solveWith } from '@/lib/solver/solve';
import { craftDag, makeNode, makeOpt } from '../unit/spec-helpers';
import type { LaunchOption } from '@/lib/types';

const base = (over: Partial<OptimizeArgs> & Pick<OptimizeArgs, 'options' | 'recipeDag' | 'desiredArtifactNodeIds'>): OptimizeArgs => ({
  fuelCapacity: 1000,
  timeCapacityPerSlot: 10000,
  maximumCost: undefined,
  ownedStock: new Map(),
  ...over,
});

describe('SOL-06: target with effects but no legendary tier', () => {
  it('buildRecipeDag does not throw for a T1 (common-only) target', () => {
    // BREAKAGE SOL-06
    expect(() => buildRecipeDag(['lunar-totem-1'], 30)).not.toThrow();
  });
  it('buildRecipeDag does not throw for a craftable tier with no legendary effect (puzzle-cube-3)', () => {
    // BREAKAGE SOL-06
    expect(() => buildRecipeDag(['puzzle-cube-3'], 30)).not.toThrow();
  });
});

describe('SOL-18: missing unit prices vs a zero golden-egg budget', () => {
  const run = async (unitPrices: Map<string, number>) => {
    const dag = craftDag(0.1);
    const options = [makeOpt(10, 1000, [['B', 5]])];
    return optimizeFull(
      base({ options, recipeDag: dag, desiredArtifactNodeIds: ['A'], craftBudget: { capacity: 0, unitPrices } })
    );
  };
  it('control: priced craft + capacity 0 => no crafts', async () => {
    const s = await run(new Map([['A', 100]]));
    expect(s.expectedCrafts).toBeCloseTo(0, 9);
  });
  it('empty price map + capacity 0 => still no crafts', async () => {
    const s = await run(new Map());
    console.log('SOL-18 crafts', s.expectedCrafts, 'best', s.bestProbability);
    // BREAKAGE SOL-18
    expect(s.expectedCrafts).toBeCloseTo(0, 9);
  });
});

describe('SOL-07: leaf-target figure depends on option order', () => {
  const LEAF = 'lunar-totem-1';
  const mk = (supply: number): LaunchOption => makeOpt(10, 1000, [[LEAF, supply]], [[LEAF, 0.001]]);
  const run = async (opts: LaunchOption[], pCraft: number) => {
    const dag = new Map([[LEAF, makeNode(LEAF, true, [], pCraft)]]);
    return optimizeFull(base({ options: opts, recipeDag: dag, desiredArtifactNodeIds: [LEAF] }));
  };
  it('pCraft=0 control: order does not matter', async () => {
    const a = await run([mk(1), mk(5)], 0);
    const b = await run([mk(5), mk(1)], 0);
    expect(a.bestProbability).toBeCloseTo(b.bestProbability, 12);
  });
  it('pCraft>0: swapping option indices must not change bestProbability', async () => {
    const a = await run([mk(1), mk(5)], 0.05);
    const b = await run([mk(5), mk(1)], 0.05);
    console.log('SOL-07', a.bestProbability, a.expectedCrafts, b.bestProbability, b.expectedCrafts);
    // BREAKAGE SOL-07
    expect(a.bestProbability).toBeCloseTo(b.bestProbability, 9);
  });
});

describe('SOL-14: equivalent ships, cost ignored', () => {
  it('allocation lands on the cheaper of two equivalent options', async () => {
    const solve = await loadHighs();
    const dag = craftDag(0.1);
    const pricey = makeOpt(10, 1000, [['B', 5]]);
    pricey.cost = 1000;
    const cheap = makeOpt(10, 1000, [['B', 5]]);
    cheap.cost = 10;
    const options = [pricey, cheap];
    const res = solveWith(
      { options, dag, targets: ['A'], fuelCapacity: 1000, timeCapacityPerSlot: 10000, slots: 3, ownedStock: new Map() },
      solve, DEFAULT_TUNING
    );
    const used = res.allocation.map((k, i) => (k > 0 ? options[i].cost : null)).filter(x => x !== null);
    console.log('SOL-14 alloc', res.allocation, 'costs used', used);
    expect(used.length).toBeGreaterThan(0);
    // BREAKAGE SOL-14
    expect(Math.max(...(used as number[]))).toBe(10);
  });
});

describe('SOL-15: merged options report order-dependent running time', () => {
  it('runningTimeSeconds is independent of option order', async () => {
    const dag = craftDag(0.1);
    const slow = makeOpt(10, 4 * 3600, [['B', 5]]);
    slow.rawTime = 2 * 3600;
    const fast = makeOpt(10, 4 * 3600, [['B', 5]]);
    fast.rawTime = 1 * 3600;
    const args = (options: LaunchOption[]) =>
      base({ options, recipeDag: dag, desiredArtifactNodeIds: ['A'], timeCapacityPerSlot: 40 * 3600 });
    const ab = await optimizeFull(args([slow, fast]));
    const ba = await optimizeFull(args([fast, slow]));
    console.log('SOL-15', ab.runningTimeSeconds, ba.runningTimeSeconds, ab.timeUnitsUsed, ba.timeUnitsUsed);
    // BREAKAGE SOL-15
    expect(ab.runningTimeSeconds).toBe(ba.runningTimeSeconds);
  });
});

describe('SOL-17: NaN maximumCost', () => {
  it('does not silently return an empty plan from a non-empty menu', async () => {
    const dag = craftDag(0.1);
    const options = [makeOpt(10, 1000, [['B', 5]])];
    const ctl = await optimizeFull(base({ options, recipeDag: dag, desiredArtifactNodeIds: ['A'] }));
    expect(ctl.choiceHistory.length).toBeGreaterThan(0);
    let threw = false;
    let nonEmpty = false;
    try {
      const s = await optimizeFull(base({ options, recipeDag: dag, desiredArtifactNodeIds: ['A'], maximumCost: NaN }));
      nonEmpty = s.choiceHistory.length > 0;
    } catch {
      threw = true;
    }
    console.log('SOL-17', { threw, nonEmpty });
    // BREAKAGE SOL-17
    expect(threw || nonEmpty).toBe(true);
  });
});

describe('SOL-19: per-egg fuel map missing an egg', () => {
  it('does not burn an egg the player has no budget for', async () => {
    const dag = craftDag(0.1);
    const opt = makeOpt(1e12, 1000, [['B', 5]]);
    opt.fuelByEgg = new Map([[ei.Egg.INTEGRITY, 1e12]]);
    const s = await optimizeFull(
      base({
        options: [opt], recipeDag: dag, desiredArtifactNodeIds: ['A'], fuelCapacity: 1e15,
        fuelByEggCapacity: new Map([[ei.Egg.KINDNESS, 1e15]]),
      })
    );
    const burned = s.fuelByEgg.get(ei.Egg.INTEGRITY) ?? 0;
    console.log('SOL-19 integrity burned', burned, 'launches', s.choiceHistory.length);
    // BREAKAGE SOL-19
    expect(burned).toBe(0);
  });
});

describe('SOL-21: precision at tiny probabilities', () => {
  it('drop probability at lambda=1e-13 matches -expm1(-lambda)', () => {
    const lam = 1e-13;
    const truth = -Math.expm1(-lam);
    const p = craftsToProbability(0, new Map([['T', lam]]), ['T'], new Map([['T', makeNode('T', true)]]));
    const rel = Math.abs(p.dropProbability - truth) / truth;
    console.log('SOL-21 drop', p.dropProbability, truth, rel, 'best', p.bestProbability, Math.abs(p.bestProbability - truth) / truth);
    // BREAKAGE SOL-21
    expect(rel).toBeLessThan(1e-6);
  });
  it('best probability at lambda=1e-13 matches -expm1(-lambda)', () => {
    const lam = 1e-13;
    const truth = -Math.expm1(-lam);
    const p = craftsToProbability(0, new Map([['T', lam]]), ['T'], new Map([['T', makeNode('T', true)]]));
    // BREAKAGE SOL-21
    expect(Math.abs(p.bestProbability - truth) / truth).toBeLessThan(1e-6);
  });
});

describe('SOL-22: many tiny targets', () => {
  const N = 25;
  const ids = Array.from({ length: N }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const dag = new Map(ids.map(id => [id, makeNode(id, true)] as const));
  // One option whose per-launch lambda for each target is ~1e-14; the plan launches it once.
  const opts = [makeOpt(1, 1, [], ids.map(id => [id, 1e-14] as [string, number]))];
  it('a joint of ~1e-350 is exported as 0, which is also what the judge exports (no finite double exists)', async () => {
    const s = await optimizeFull(
      base({ options: opts, recipeDag: dag, desiredArtifactNodeIds: ids, fuelCapacity: 1, timeCapacityPerSlot: 1 })
    );
    const launches = s.choiceHistory.reduce((a, c) => a + c.numShipsLaunched, 0);
    expect(launches).toBe(1);
    const solve = await loadHighs();
    const res = solveWith(
      { options: opts, dag, targets: ids, fuelCapacity: 1, timeCapacityPerSlot: 1, slots: 3, ownedStock: new Map() },
      solve, DEFAULT_TUNING, { report: true }
    );
    console.log('SOL-22 core', s.jointProbability, 'judge reported', res.reported!.jointProbability);
    // True value is (1e-14)^25 = 1e-350 < Number.MIN_VALUE (5e-324): 0 is the correctly rounded double in both places.
    expect(res.reported!.jointProbability).toBe(0);
    expect(s.jointProbability).toBe(0);
    expect(s.jointProbability).toBe(res.reported!.jointProbability);
  });
});
