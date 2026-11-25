// SOL-16: a NaN launch period (real loot data; the app's EFFORT_LAUNCH_PERIOD_SECONDS is a constant table).
import { describe, expect, it } from 'vitest';
import { perfectShipsConfig } from 'lib';
import { buildRecipeDag } from '@/lib';
import { enumerateLaunchOptions } from '@/lib/problem-inputs';
import { optimizeFull } from '@/lib/optimizer-core';

describe('SOL-16: NaN launch period', () => {
  const dag = buildRecipeDag(['puzzle-cube-4'], 30);
  const run = async (period: number) => {
    const options = enumerateLaunchOptions(perfectShipsConfig, dag, period);
    const sol = await optimizeFull({
      options, recipeDag: dag, desiredArtifactNodeIds: ['puzzle-cube-4'], fuelCapacity: 2e9,
      timeCapacityPerSlot: 3 * 86400, maximumCost: undefined, ownedStock: new Map(),
    });
    return { options, sol };
  };
  it('control: period 0 yields a non-empty plan', async () => {
    const { options, sol } = await run(0);
    expect(options.length).toBeGreaterThan(0);
    expect(sol.choiceHistory.length).toBeGreaterThan(0);
  }, 120000);
  it('NaN period does not turn a valid menu into an empty plan', async () => {
    const { options, sol } = await run(NaN);
    console.log('SOL-16 options', options.length, 'finite actualTime', options.filter(o => Number.isFinite(o.actualTime)).length, 'launches', sol.choiceHistory.length);
    // BREAKAGE SOL-16
    expect(sol.choiceHistory.length).toBeGreaterThan(0);
  }, 120000);
});
