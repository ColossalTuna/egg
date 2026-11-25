// STA-08: with FTL >= 100 the explorer's duration 1 - 0.01 * level is <= 0 (AP caps the level at 60).
// At max effort the zero/negative missions are dropped by ZERO_TOL; at low effort max(raw, 86400)
// keeps them, and the raw makespan written to the file goes negative.
import { describe, expect, it } from 'vitest';
import { perfectShipsConfig } from 'lib';
import { buildRecipeDag } from '@/lib';
import { enumerateLaunchOptions } from '@/lib/problem-inputs';
import { optimize } from '../unit/spec-helpers';

const dag = buildRecipeDag(['puzzle-cube-4'], 30);
const run = { desiredArtifactNodeIds: ['puzzle-cube-4'], includeNotEnoughData: false, fuelTankCapacity: 500e12, timeBudgetSeconds: 3 * 86400 };

describe('STA-08 FTL >= 100', () => {
  for (const ftl of [100, 120]) {
    const cfg = { ...perfectShipsConfig, epicResearchFTLLevel: ftl };

    it(`FTL ${ftl}: no option has a non-positive raw duration (BREAKAGE STA-08)`, () => {
      const options = enumerateLaunchOptions(cfg, dag, 0);
      const bad = options.filter(o => !(o.rawTime > 0));
      console.log(`FTL ${ftl}: ${bad.length}/${options.length} options with rawTime <= 0, e.g. ${bad[0]?.rawTime}`);
      // BREAKAGE STA-08
      expect(bad).toHaveLength(0);
    });

    it(`FTL ${ftl}: the file's rawMakespanSeconds is positive at low effort (BREAKAGE STA-08)`, async () => {
      const sol = await optimize(run, cfg, dag, new Map(), { launchPeriodSeconds: 86400 });
      console.log(`FTL ${ftl} low: timeUnitsUsed=${sol.timeUnitsUsed} runningTimeSeconds=${sol.runningTimeSeconds}`);
      // BREAKAGE STA-08
      expect(sol.runningTimeSeconds).toBeGreaterThan(0);
    });

    it(`FTL ${ftl}: effort low and max choose from the same mission menu (BREAKAGE STA-08)`, async () => {
      const low = await optimize(run, cfg, dag, new Map(), { launchPeriodSeconds: 86400 });
      const max = await optimize(run, cfg, dag, new Map(), { launchPeriodSeconds: 0 });
      const ships = (s: typeof low) => new Set(s.choiceHistory.map(c => c.ship.shipType));
      console.log(`FTL ${ftl}: low ships ${[...ships(low)]}, max ships ${[...ships(max)]}`);
      const hasFtl = (s: typeof low) => s.choiceHistory.some(c => c.ship.isFTL);
      // BREAKAGE STA-08
      expect(hasFtl(max)).toBe(hasFtl(low));
    });
  }
});
