import { describe, it, expect } from 'vitest';
import { perfectShipsConfig } from 'lib';
import { buildRecipeDag, computeBaseYield } from '.';
import { enumerateLaunchOptions } from './phases';
import { optimizeFull } from './optimizer-core';

// Latency guard for the outer solver. The tight bar is gated behind RUN_PERF=1
// (shared runners are noisy); the loose cap catches gross regressions.
// Reference measurement on the slowest machine this was calibrated on: median
// ~71ms, worst observed process median ~85ms. The strict cap is set to trip on
// a ~25% regression, the loose one on a ~2x one.
const STRICT = process.env.RUN_PERF === '1';
const LOOSE_CAP_MS = 150;
const STRICT_CAP_MS = 90;

// tachyon-deflector-4 has the most launch options of any craftable target
// under perfectShipsConfig (~240), so it is the heaviest realistic instance.
const TARGET = 'tachyon-deflector-4';
const HORIZON_SECONDS = 30 * 24 * 3600;

describe('optimizer performance', () => {
  it(`solves a production-scale instance under ${STRICT ? STRICT_CAP_MS : LOOSE_CAP_MS}ms`, () => {
    const dag = buildRecipeDag([TARGET], 30);
    const baseYield = computeBaseYield(null, [TARGET], dag);
    const options = enumerateLaunchOptions(perfectShipsConfig, dag);
    expect(options.length).toBeGreaterThan(0);

    const run = () =>
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: [TARGET],
        fuelCapacity: 1e18,
        timeCapacity: HORIZON_SECONDS,
        baseYield,
      });

    run(); // warm up the JIT

    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];
    console.log(`[perf] ${options.length} options, median ${median.toFixed(1)}ms, max ${max.toFixed(1)}ms`);

    expect(median).toBeLessThan(LOOSE_CAP_MS);
    if (STRICT) {
      expect(median).toBeLessThan(STRICT_CAP_MS);
    }
  });
});

// n=2 latency guard. There is one search, so this differs from the guard above
// only in instance size -- but that size costs: the inner and relaxation LPs
// each carry one epigraph variable and a block of tangent rows per target, so a
// second target roughly doubles the per-eval LP the search re-solves millions
// of times. A second real target sharing tachyon-deflector-4's option pool is a
// realistic worst case, not a pathological one.
// Reference: median ~136ms on the same machine, worst observed ~177ms.
const JOINT_LOOSE_CAP_MS = 300;
const JOINT_STRICT_CAP_MS = 175;
const SECOND_TARGET = 'puzzle-cube-4';

describe('optimizer performance (n=2)', () => {
  it(`solves a production-scale 2-target instance under ${STRICT ? JOINT_STRICT_CAP_MS : JOINT_LOOSE_CAP_MS}ms`, () => {
    const targets = [TARGET, SECOND_TARGET];
    const dag = buildRecipeDag(targets, 30);
    const baseYield = computeBaseYield(null, targets, dag);
    const options = enumerateLaunchOptions(perfectShipsConfig, dag);
    expect(options.length).toBeGreaterThan(0);

    const run = () =>
      optimizeFull({
        options,
        recipeDag: dag,
        desiredArtifactNodeIds: targets,
        fuelCapacity: 1e18,
        timeCapacity: HORIZON_SECONDS,
        baseYield,
      });

    run(); // warm up the JIT

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];
    console.log(`[perf-joint] ${options.length} options, median ${median.toFixed(1)}ms, max ${max.toFixed(1)}ms`);

    expect(median).toBeLessThan(JOINT_LOOSE_CAP_MS);
    if (STRICT) {
      expect(median).toBeLessThan(JOINT_STRICT_CAP_MS);
    }
  }, 60_000);
});
