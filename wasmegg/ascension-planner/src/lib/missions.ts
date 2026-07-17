/**
 * Mission data for virtue rocket missions.
 * Ship, fuel, duration, and pricing data all come from the shared workspace
 * lib (lib/missions.ts); this module adapts them to the planner's local
 * enums and VirtueEgg string keys.
 */

import {
  ei,
  MissionType,
  missionDurationTypeName,
  spaceshipIconPath,
  spaceshipList,
  spaceshipName,
  virtueShipGemCosts,
} from 'lib';
import type { VirtueEgg } from '@/types';

// ============================================================================
// Enums
// ============================================================================

// The planner's ship values are the shared proto enum's values.
export type Spaceship = ei.MissionInfo.Spaceship;
export const Spaceship = ei.MissionInfo.Spaceship;

// This numbering is baked into saved plans (launch_missions payloads persist
// the numeric values), so it must not change to match
// ei.MissionInfo.DurationType (SHORT=0/LONG=1/EPIC=2); toEiDurationType
// bridges to the shared data.
export enum DurationType {
  SHORT = 1,
  LONG = 2,
  EPIC = 3,
}

const toEiDurationType: Record<DurationType, ei.MissionInfo.DurationType> = {
  [DurationType.SHORT]: ei.MissionInfo.DurationType.SHORT,
  [DurationType.LONG]: ei.MissionInfo.DurationType.LONG,
  [DurationType.EPIC]: ei.MissionInfo.DurationType.EPIC,
};

function missionType(ship: Spaceship, duration: DurationType): MissionType {
  return new MissionType(ship, toEiDurationType[duration]);
}

export const ALL_DURATIONS: DurationType[] = [DurationType.SHORT, DurationType.LONG, DurationType.EPIC];

/** All ships ordered most expensive first (for grid display). */
export const ALL_SHIPS: Spaceship[] = [...spaceshipList].reverse();

function byShipAndDuration<T>(
  fn: (ship: Spaceship, duration: DurationType) => T
): Record<Spaceship, Record<DurationType, T>> {
  const result = {} as Record<Spaceship, Record<DurationType, T>>;
  for (const ship of spaceshipList) {
    const perDuration = {} as Record<DurationType, T>;
    for (const duration of ALL_DURATIONS) {
      perDuration[duration] = fn(ship, duration);
    }
    result[ship] = perDuration;
  }
  return result;
}

export const DURATION_NAMES: Record<DurationType, string> = {
  [DurationType.SHORT]: missionDurationTypeName(toEiDurationType[DurationType.SHORT]),
  [DurationType.LONG]: missionDurationTypeName(toEiDurationType[DurationType.LONG]),
  [DurationType.EPIC]: missionDurationTypeName(toEiDurationType[DurationType.EPIC]),
};

// ============================================================================
// Ship metadata
// ============================================================================

export interface ShipInfo {
  name: string;
  displayName: string;
  iconPath: string;
  price: number;
  isFTL: boolean;
}

// Shorter labels than the shared lib's full ship names, to fit the grid.
const DISPLAY_NAME_OVERRIDES: Partial<Record<Spaceship, string>> = {
  [Spaceship.MILLENIUM_CHICKEN]: 'Quintillion',
  [Spaceship.CORELLIHEN_CORVETTE]: 'Corvette',
  [Spaceship.ATREGGIES]: 'Henliner',
};

export const SHIP_INFO: Record<Spaceship, ShipInfo> = (() => {
  const result = {} as Record<Spaceship, ShipInfo>;
  for (const ship of spaceshipList) {
    const displayName = DISPLAY_NAME_OVERRIDES[ship] ?? spaceshipName(ship);
    result[ship] = {
      name: displayName,
      displayName,
      iconPath: spaceshipIconPath(ship),
      price: virtueShipGemCosts[ship],
      isFTL: missionType(ship, DurationType.SHORT).isFTL,
    };
  }
  return result;
})();

// ============================================================================
// Fuel requirements
// ============================================================================

export interface FuelRequirement {
  egg: VirtueEgg;
  amount: number;
}

const EGG_TO_VIRTUE_EGG: Partial<Record<ei.Egg, VirtueEgg>> = {
  [ei.Egg.CURIOSITY]: 'curiosity',
  [ei.Egg.INTEGRITY]: 'integrity',
  [ei.Egg.KINDNESS]: 'kindness',
  [ei.Egg.RESILIENCE]: 'resilience',
  [ei.Egg.HUMILITY]: 'humility',
};

export const VIRTUE_FUEL_REQUIREMENTS: Record<Spaceship, Record<DurationType, FuelRequirement[]>> = byShipAndDuration(
  (ship, duration) =>
    missionType(ship, duration).virtueFuels.map(fuel => {
      const egg = EGG_TO_VIRTUE_EGG[fuel.egg];
      if (egg === undefined) {
        throw new Error(`unexpected virtue fuel egg ${fuel.egg} for ship ${ship}`);
      }
      return { egg, amount: fuel.amount };
    })
);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the effective mission duration after FTL research reduction.
 * FTL research reduces duration by 1% per level (max 60), only for FTL ships.
 */
export function getEffectiveDuration(ship: Spaceship, duration: DurationType, ftlLevel: number): number {
  return missionType(ship, duration).boostedDurationSecondsAtLevel(Math.min(60, ftlLevel));
}
