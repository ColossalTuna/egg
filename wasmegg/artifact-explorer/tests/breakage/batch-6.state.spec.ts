// Batch 6 state/seam scenarios: STA-10, 11, 14, 17, 18, 19, 20, 22, 24, 26, 28, 29.
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ei, fuelTankSizes, MissionType, shipLevelLaunchPointThresholds } from 'lib';

import { parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { normalizeProblem } from '@/lib/solver/types';
import { finalizeSolutions } from '@/lib';
import { makeSolution } from '../unit/spec-helpers';

const Spaceship = ei.MissionInfo.Spaceship;
const DurationType = ei.MissionInfo.DurationType;
const Status = ei.MissionInfo.Status;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

let store: typeof import('@/store');
let plan: typeof import('@/store/plan');
let ls: Record<string, string>;

beforeEach(async () => {
  vi.resetModules();
  ls = {};
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/' } });
  vi.stubGlobal('localStorage', ls);
  store = await import('@/store');
  plan = await import('@/store/plan');
  store.clearPlayerData();
  store.setOverrideTankLevel(false);
});

function visitsFrom(mutate: (p: any) => void = () => {}) {
  const p = fixture('ascension-plan.json');
  mutate(p);
  return sliceHumilityVisits(parsePlanSave(p));
}

function backupWith(opts: {
  ftl?: number;
  missions?: Array<{ ship: number; status?: number; durationType?: number }>;
  tankLevel?: number;
  craftingXp?: number;
  tankFuels?: number[];
  artifactStatus?: ei.ICraftableArtifact[];
  virtueArtifactStatus?: ei.ICraftableArtifact[];
  virtueAfx?: any;
}): ei.IBackup {
  return {
    game: {
      epicResearch: opts.ftl === undefined ? [] : [{ id: 'afx_mission_time', level: opts.ftl }],
    },
    artifacts: { tankLevel: opts.tankLevel ?? 7, craftingXp: opts.craftingXp ?? 0 },
    virtue: { afx: { tankFuels: opts.tankFuels, ...(opts.virtueAfx ?? {}) } },
    artifactsDb: {
      missionArchive: opts.missions ?? [],
      artifactStatus: opts.artifactStatus ?? [],
      virtueAfxDb: { artifactStatus: opts.virtueArtifactStatus ?? [] },
    },
  } as unknown as ei.IBackup;
}

describe('STA-10 missing epic research in plan overrides the save', () => {
  it('a plan with no epicResearchLevels does not zero out the save FTL 60', () => {
    store.setPlayerData(backupWith({ ftl: 60 }));
    expect(store.playerShipsConfig.value!.epicResearchFTLLevel).toBe(60);
    plan.setLoadedPlan(
      'no-epic',
      visitsFrom(p => {
        p.initialState = {}; // no epicResearchLevels
      })
    );
    plan.setCurrentVisit(plan.loadedPlan.value!.visits[0].visitId);
    expect(plan.activePlanVisit.value!.epicResearchFTLLevel).toBe(0);
    // BREAKAGE STA-10: expected the save's 60 (the plan said nothing), actual 0
    expect(store.effectiveConfig.value.epicResearchFTLLevel).toBe(60);
  });
});

describe('STA-17 launch-point rounding', () => {
  it('25 LONG Millennium Chicken missions reach level 2 (threshold 35)', () => {
    expect(shipLevelLaunchPointThresholds(Spaceship.MILLENIUM_CHICKEN)[2]).toBe(35);
    const missions = Array.from({ length: 25 }, () => ({
      ship: Spaceship.MILLENIUM_CHICKEN,
      status: Status.COMPLETE,
      durationType: DurationType.LONG,
    }));
    store.setPlayerData(backupWith({ missions }));
    // BREAKAGE STA-17: 25 * 1.4 = 35 launch points, expected level 2
    expect(store.playerShipsConfig.value!.shipLevels[Spaceship.MILLENIUM_CHICKEN]).toBe(2);
  });
  it('25 EPIC Chicken Heavy missions reach level 3 (threshold 45)', () => {
    expect(shipLevelLaunchPointThresholds(Spaceship.CHICKEN_HEAVY)[3]).toBe(45);
    const missions = Array.from({ length: 25 }, () => ({
      ship: Spaceship.CHICKEN_HEAVY,
      status: Status.COMPLETE,
      durationType: DurationType.EPIC,
    }));
    store.setPlayerData(backupWith({ missions }));
    // BREAKAGE STA-17: 25 * 1.8 = 45 launch points, expected level 3
    expect(store.playerShipsConfig.value!.shipLevels[Spaceship.CHICKEN_HEAVY]).toBe(3);
  });
});

describe('STA-11 epic research out of range', () => {
  it('rejects or clamps FTL 150 / -5 and Zero-G 99 from a plan file', () => {
    let visits: ReturnType<typeof visitsFrom> | undefined;
    let threw = false;
    try {
      visits = visitsFrom(p => {
        p.initialState.epicResearchLevels = { afx_mission_time: 150, afx_mission_capacity: 99 };
      });
    } catch {
      threw = true;
    }
    if (!threw) {
      const v = visits![0];
      const dur = new MissionType(Spaceship.HENERPRISE, DurationType.EPIC).boostedDurationSecondsAtLevel(
        v.epicResearchFTLLevel
      );
      // BREAKAGE STA-11: expected throw or clamp; actual FTL 150 -> negative duration
      expect(dur).toBeGreaterThan(0);
      expect(v.epicResearchZerogLevel).toBeLessThanOrEqual(10);
    }
  });
  it('rejects or clamps a negative FTL level', () => {
    let visits: ReturnType<typeof visitsFrom> | undefined;
    try {
      visits = visitsFrom(p => {
        p.initialState.epicResearchLevels = { afx_mission_time: -5, afx_mission_capacity: 0 };
      });
    } catch {
      return;
    }
    // BREAKAGE STA-11
    expect(visits[0].epicResearchFTLLevel).toBeGreaterThanOrEqual(0);
  });
});

describe('STA-14 tank level out of range', () => {
  it('a plan tankLevel of 8 yields a usable capacity (or is rejected)', () => {
    let visits: ReturnType<typeof visitsFrom> | undefined;
    try {
      visits = visitsFrom(p => {
        for (const a of p.actions) a.endState.tankLevel = 8;
      });
    } catch {
      return; // rejecting is acceptable
    }
    plan.setLoadedPlan('tank8', visits);
    plan.setCurrentVisit(visits[0].visitId);
    expect(store.effectiveTankLevel.value).toBe(8);
    // BREAKAGE STA-14: expected finite positive capacity, actual undefined
    expect(Number.isFinite(store.effectiveFuelTankCapacity.value)).toBe(true);
  });
  it('the solver would see capacity 0 (not an error) for that undefined value', () => {
    const norm = normalizeProblem({ fuelCapacity: fuelTankSizes[8] } as never);
    // BREAKAGE STA-14: silently becomes 0
    expect(norm.fuelCapacity).toBeGreaterThan(0);
  });
  it('a fractional plan tankLevel (7.5) yields a usable capacity (or is rejected)', () => {
    let visits: ReturnType<typeof visitsFrom> | undefined;
    try {
      visits = visitsFrom(p => {
        for (const a of p.actions) a.endState.tankLevel = 7.5;
      });
    } catch {
      return;
    }
    plan.setLoadedPlan('tank75', visits);
    plan.setCurrentVisit(visits[0].visitId);
    // BREAKAGE STA-14
    expect(Number.isFinite(store.effectiveFuelTankCapacity.value)).toBe(true);
  });
  it('a stored extras.tankLevel of 9 or -1 is not accepted as-is', async () => {
    for (const bad of [9, -1]) {
      ls['/artifact-explorer/_extras'] = JSON.stringify({ craftingLevel: 30, previousCrafts: 0, tankLevel: bad });
      const loaded = store.loadExtras();
      // BREAKAGE STA-14: loaded.tankLevel is passed straight through
      expect(fuelTankSizes[loaded.tankLevel]).toBeDefined();
    }
  });
  it('a save tankLevel above 7 gives a usable capacity', () => {
    store.setPlayerData(backupWith({ tankLevel: 9 }));
    // BREAKAGE STA-14
    expect(Number.isFinite(store.effectiveFuelTankCapacity.value)).toBe(true);
  });
});

describe('STA-18 aborted missions (characterization; game rule undecided)', () => {
  it('records what the code does with an ABORTED-only ship', () => {
    const missions = [{ ship: Spaceship.HENERPRISE, status: Status.ABORTED, durationType: DurationType.SHORT }];
    store.setPlayerData(backupWith({ missions }));
    // Observation only: ABORTED (30) >= EXPLORING (10), so the ship counts as launched.
    expect(store.playerShipsConfig.value!.shipVisibility[Spaceship.HENERPRISE]).toBe(true);
  });
});

describe('STA-19 virtue crafted counts', () => {
  const spec = { name: ei.ArtifactSpec.Name.PUZZLE_CUBE, level: ei.ArtifactSpec.Level.INFERIOR };
  it('characterizes: standard 3 + virtue 4 are summed (game rule undecided)', () => {
    store.setPlayerData(
      backupWith({
        artifactStatus: [{ spec, count: 3 }] as any,
        virtueArtifactStatus: [{ spec, count: 4 }] as any,
      })
    );
    const crafted = store.playerInventory.value!.getItem(spec).crafted;
    // Observation only.
    expect(crafted).toBe(7);
  });
});

describe('STA-20 tank level and crafting xp source (characterization)', () => {
  it('records that standard artifacts data wins over virtue.afx', () => {
    store.setPlayerData(
      backupWith({
        tankLevel: 7,
        craftingXp: 1000,
        virtueAfx: { tankLevel: 2, craftingXp: 5 },
      })
    );
    expect(store.playerTankLevel.value).toBe(7);
    expect(store.playerTotalCraftingXp.value).toBe(1000);
  });
});

describe('STA-22 short virtue tank arrays', () => {
  it('characterizes: length 24 and 5 give null (documented fallback); 25 gives a map', () => {
    for (const len of [5, 24]) {
      store.setPlayerData(backupWith({ tankFuels: new Array(len).fill(1e9) }));
      expect(store.playerTankFuels.value).toBeNull();
    }
    store.setPlayerData(backupWith({ tankFuels: new Array(25).fill(1e9) }));
    expect(store.playerTankFuels.value).not.toBeNull();
    // With the flag on and a short array, the solve falls back to the pooled tank.
    store.setFuelFromTankContents(true);
    store.setPlayerData(backupWith({ tankFuels: new Array(24).fill(1e9) }));
    expect(store.effectiveFuelByEggCapacity.value).toBeNull();
  });
});

describe('STA-24 fuelByEgg total summation order', () => {
  it('finalizeSolutions total equals the core order accumulation bit for bit', () => {
    const data = [
      { s: Spaceship.VOYEGGER, rate: 131457.38571428572, k: 7 },
      { s: Spaceship.BCR, rate: 55843.24285714285, k: 9 },
      { s: Spaceship.ATREGGIES, rate: 46546.24285714285, k: 7 },
      { s: Spaceship.CORELLIHEN_CORVETTE, rate: 19136.52857142857, k: 4 },
    ];
    // Core (optimizer-core.ts:219-221): accumulate k * rate in allocation order.
    let core = 0;
    for (const c of data) core += c.k * c.rate;
    const choiceHistory = data.map(c => ({
      ship: new MissionType(c.s, DurationType.EPIC),
      actualFuel: c.rate,
      actualFuelByEgg: new Map([[ei.Egg.CURIOSITY, c.rate]]),
      actualTime: 1,
      target: '',
      targetAfxId: ei.ArtifactSpec.Name.PUZZLE_CUBE,
      numShipsLaunched: c.k,
      supplyVector: new Map(),
      legendarySupplyVector: new Map(),
    }));
    const [sol] = finalizeSolutions([makeSolution({ choiceHistory: choiceHistory as any })], new Map());
    const finalized = sol.fuelByEgg.get(ei.Egg.CURIOSITY)!;
    // BREAKAGE STA-24 (harmless): differs in the last bits
    expect(finalized).toBe(core);
  });
});

describe('STA-26 arrival dates are never consumed', () => {
  it('arrivalTimestamp is read by no module other than plan/read.ts', () => {
    const hits: string[] = [];
    const walk = (dir: URL) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) walk(u);
        else if (/\.(ts|vue)$/.test(e.name) && readFileSync(u, 'utf8').includes('arrivalTimestamp')) hits.push(u.pathname);
      }
    };
    walk(new URL('../../src/', import.meta.url));
    // Fact check only: the consumer the doc comment promises (2x capacity event lookup) does not exist.
    expect(hits.map(h => h.split('/src/')[1])).toEqual(['lib/plan/read.ts']);
  });
});

describe('STA-28 craft cap comments no longer claim "no cap" for bad capacities', () => {
  // K5 rewrite (doc-only): the comments in store/schema.ts and store/index.ts now say what the code does.
  it('normalizeProblem rejects a NaN / -1 / Infinity craft capacity, and the store never produces one', () => {
    for (const capacity of [NaN, -1, Infinity]) {
      expect(() =>
        normalizeProblem({ craftBudget: { capacity, unitPrices: new Map() }, fuelCapacity: 1 } as never)
      ).toThrow();
    }
  });
});

describe('STA-29 stored mission filters without maxGemCost', () => {
  it('maxGemCostEnabled:true with no maxGemCost does not become a zero price cap', () => {
    ls['/artifact-explorer/_mission_filters'] = JSON.stringify({ maxGemCostEnabled: true });
    const loaded = store.loadMissionFilters();
    expect(loaded.maxGemCostEnabled).toBe(true);
    // BREAKAGE STA-29: expected the default (Atreggies price), actual 0
    expect(loaded.maxGemCost).toBeGreaterThan(0);
  });
  it('and the effective cap is then not zero', () => {
    ls['/artifact-explorer/_mission_filters'] = JSON.stringify({ maxGemCostEnabled: true });
    store.missionFilters.value = store.loadMissionFilters();
    // BREAKAGE STA-29
    expect(store.effectiveMaxGemCost.value).toBeGreaterThan(0);
  });
});
