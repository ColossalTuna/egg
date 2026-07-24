// Message shapes shared by the optimizer worker and its main-thread client.
//
// Only the search itself crosses into the worker. Launch-option enumeration
// stays on the main thread deliberately: it is the one cheap step that needs
// the loot dataset, and the main bundle already loads that dataset for the
// mission views, so enumerating there keeps the worker's bundle free of an
// 18MB duplicate. What's left in the worker (optimizeFull) is pure arithmetic
// over the options and the recipe DAG.
//
// Everything crossing the boundary goes through structured clone, which
// preserves Maps and plain objects but drops prototypes. The payloads are
// plain data except for `ship`, a `MissionType` instance whose entire API is
// getters over two numeric fields — a cloned copy would arrive with those
// fields intact and every getter gone, which fails far away from here (in
// whatever template reads `ship.shipName`). So the ship is explicitly narrowed
// to its two fields on the way out and reconstructed on the way in, rather
// than left to the clone algorithm's implicit behavior.

import { ei, MissionType } from 'lib';
import type { LaunchOption, LaunchSolution, OptimizerSolution, RecipeDAG } from './types';

export interface WireShip {
  shipType: ei.MissionInfo.Spaceship;
  durationType: ei.MissionInfo.DurationType;
}

export type WireLaunchOption = Omit<LaunchOption, 'ship'> & { ship: WireShip };
export type WireLaunchSolution = Omit<LaunchSolution, 'ship'> & { ship: WireShip };
export type WireSolution = Omit<OptimizerSolution, 'choiceHistory'> & { choiceHistory: WireLaunchSolution[] };

export interface OptimizerRequest {
  id: number;
  options: WireLaunchOption[];
  recipeDag: RecipeDAG;
  desiredArtifactNodeIds: string[];
  fuelCapacity: number;
  timeCapacity: number;
  baseYield: Map<string, number>;
}

export type OptimizerResponse =
  | { id: number; ok: true; solutions: WireSolution[] }
  | { id: number; ok: false; error: string };

const toWireShip = (ship: MissionType): WireShip => ({
  shipType: ship.shipType,
  durationType: ship.durationType,
});

const fromWireShip = (ship: WireShip): MissionType => new MissionType(ship.shipType, ship.durationType);

export function optionsToWire(options: LaunchOption[]): WireLaunchOption[] {
  return options.map(o => ({ ...o, ship: toWireShip(o.ship) }));
}

export function optionsFromWire(options: WireLaunchOption[]): LaunchOption[] {
  return options.map(o => ({ ...o, ship: fromWireShip(o.ship) }));
}

export function solutionsToWire(solutions: OptimizerSolution[]): WireSolution[] {
  return solutions.map(s => ({
    ...s,
    choiceHistory: s.choiceHistory.map(c => ({ ...c, ship: toWireShip(c.ship) })),
  }));
}

export function solutionsFromWire(solutions: WireSolution[]): OptimizerSolution[] {
  return solutions.map(s => ({
    ...s,
    choiceHistory: s.choiceHistory.map(c => ({ ...c, ship: fromWireShip(c.ship) })),
  }));
}
