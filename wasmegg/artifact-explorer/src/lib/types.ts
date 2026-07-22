import { ei, MissionType } from 'lib';

// documents intent only, not enforced
type integer = number;
export type { integer };

export interface LaunchOption {
  id: string;
  ship: MissionType;
  target: string | null;
  targetAfxId: ei.ArtifactSpec.Name; // UNKNOWN when untargeted
  actualFuel: number;
  fuelByEgg: Map<ei.Egg, number>;
  // effective (floored) duration the optimizer budgets against: at least the
  // launch period of the current effort level, so a mission shorter than the
  // period is stretched to occupy the whole period.
  actualTime: number;
  // the mission's true (unfloored) boosted duration; equals actualTime when the
  // mission is at least as long as the launch period.
  rawTime: number;
  // everything this launch drops, per single ship — display only
  supplyVector: Map<string, number>;
  // subset of supplyVector restricted to recipe ingredients; this is what
  // the optimizer feeds the inner LP
  yieldVector: Map<string, number>;
  legendaryYieldVector: Map<string, number>;
}

export interface DAGChildRef {
  nodeId: string;
  quantity: integer;
}

export interface DAGNode {
  id: string;
  isLeaf: boolean; // raw drop only, not craftable
  children: DAGChildRef[];
  legendaryCraftProbability: number; // non-zero only on the targeted root
}

export type RecipeDAG = Map<string, DAGNode>;

export interface LaunchSolution {
  ship: MissionType;
  actualFuel: number;
  actualFuelByEgg: Map<ei.Egg, number>;
  actualTime: number;
  target: string;
  targetAfxId: ei.ArtifactSpec.Name;
  // total count of single-ship missions of this type across all three slots
  numShipsLaunched: integer;
  supplyVector: Map<string, number>;
  legendarySupplyVector: Map<string, number>;
}

// One slot's share of the plan: how much of the horizon it occupies (floored
// mission durations) and how many single-ship missions it runs. The three slots
// run concurrently, so the plan's wall-clock is the busiest slot's load.
// rawLoadSeconds is the same sum over the missions' true durations, so the
// slot's floor-induced idle is loadSeconds - rawLoadSeconds.
export interface SlotSummary {
  loadSeconds: number;
  rawLoadSeconds: number;
  missionCount: integer;
}

export interface DropRow {
  itemId: string;
  name: string;
  iconUrl: string;
  expected: number;
  relevant: boolean;
}

export interface TargetProbability {
  nodeId: string;
  bestProbability: number;
  craftProbability: number;
  dropProbability: number;
  expectedCrafts: number;
}

export interface OptimizerSolution {
  // the scalar probability fields describe the primary target; multi-target
  // consumers should read perTarget instead
  bestProbability: number;
  craftProbability: number;
  dropProbability: number;
  expectedCrafts: number;
  fuelUsed: number;
  fuelByEgg: Map<ei.Egg, number>;
  // timeUnitsUsed is the plan's makespan: the busiest of the three concurrent
  // slots' floored load (<= the horizon).
  timeUnitsUsed: integer;
  // runningTimeSeconds is the busiest slot's real (raw) flight time. Idle time
  // (the rest of the budget spent waiting rather than relaunching sooner) is a
  // pure display delta — max wait time minus this — computed in the presentation
  // layer, so it is deliberately not stored on the solution.
  runningTimeSeconds: integer;
  // per-slot occupancy of the chosen plan (up to three entries); the packing
  // witness the optimizer used to prove every mission fits one slot's horizon
  slots?: SlotSummary[];
  choiceHistory: LaunchSolution[];
  expectedDrops: DropRow[];
  finalYieldVector: Map<string, number>;
  // owned-inventory head start already baked into finalYieldVector
  baseYield: Map<string, number>;
  recipeDag: RecipeDAG;
  craftPrimal: Map<string, number>;
  perTarget: TargetProbability[]; // perTarget[0] mirrors the scalar fields
}

export interface OptimizerConfig {
  desiredArtifactNodeIds: string[];
  includeNotEnoughData: boolean;
  fuelTankCapacity: integer;
  timeBudgetSeconds: number;
}
