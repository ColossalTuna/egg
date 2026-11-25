// SOL-26: missing drop data (totalDrops = 0) with showNodata. Loot is mocked, as loot.spec.ts does.
import { describe, expect, it, vi } from 'vitest';
import { ei, perfectShipsConfig, type ShipsConfig } from 'lib';
import { enumerateLaunchOptions } from '@/lib/problem-inputs';
import { optimizeFull } from '@/lib/optimizer-core';
import { finalizeSolutions } from '@/lib';
import { makeNode } from '../unit/spec-helpers';

vi.mock('@/lib/loot-json', async () => {
  const { ei } = await import('lib');
  const { missions: allMissions } = await import('@/lib/missions');
  const Name = ei.ArtifactSpec.Name;
  const Level = ei.ArtifactSpec.Level;
  const item = (itemId: string, afxId: any, afxLevel: any, counts: [number, number, number, number]) => ({ itemId, afxId, afxLevel, counts });
  return {
    default: {
      missions: allMissions
        .filter(m => m.shipType === ei.MissionInfo.Spaceship.CHICKEN_ONE)
        .map(m => ({
          afxShip: m.shipType,
          afxDurationType: m.durationType,
          missionId: m.missionTypeId,
          levels: [
            {
              level: 0,
              targets: [
                // A target nobody has data for: no drops recorded at all.
                { targetAfxId: Name.UNKNOWN, totalDrops: 0, items: [item('lunar-totem-1', Name.LUNAR_TOTEM, Level.INFERIOR, [0, 0, 0, 0])] },
              ],
            },
          ],
        })),
    },
  };
});

const Ship = ei.MissionInfo.Spaceship;

function cfg(): ShipsConfig {
  const c = structuredClone(perfectShipsConfig) as ShipsConfig;
  c.showNodata = true;
  for (const k of Object.keys(c.shipVisibility)) c.shipVisibility[Number(k) as ei.MissionInfo.Spaceship] = false;
  c.shipVisibility[Ship.CHICKEN_ONE] = true;
  c.shipLevels[Ship.CHICKEN_ONE] = 0;
  return c;
}

describe('SOL-26: totalDrops = 0 under showNodata', () => {
  const dag = new Map([
    ['lunar-totem-2', makeNode('lunar-totem-2', false, [['lunar-totem-1', 2]], 0.1)],
    ['lunar-totem-1', makeNode('lunar-totem-1', true)],
  ]);
  it('LATENT ONLY: enumerated options carry NaN in supplyVector (never reaches a user-visible row, see next test)', () => {
    const options = enumerateLaunchOptions(cfg(), dag as any, 0);
    const vals = options.flatMap(o => [...o.supplyVector.values(), ...o.yieldVector.values(), ...o.legendaryYieldVector.values()]);
    console.log('SOL-26 options', options.length, 'values', vals);
    expect(options.length).toBeGreaterThan(0);
    // BREAKAGE SOL-26
    expect(vals.every(Number.isFinite)).toBe(true);
  });
  it('end to end, no NaN drop rows reach the card (option is never allocated)', async () => {
    const options = enumerateLaunchOptions(cfg(), dag as any, 0);
    const sol = await optimizeFull({
      options, recipeDag: dag as any, desiredArtifactNodeIds: ['lunar-totem-2'], fuelCapacity: 1e12,
      timeCapacityPerSlot: 1e6, maximumCost: undefined, ownedStock: new Map(),
    });
    const [fin] = finalizeSolutions([sol], dag as any);
    expect(fin.choiceHistory.length).toBe(0);
    expect(fin.expectedDrops.every(r => Number.isFinite(r.expected))).toBe(true);
  });
});
