// Adapts the production `optimizeFull` shape to the arena's `Planner`.
//
// Both baseline entries are the same function under different code, so the
// translation lives here once. This is also the reference for what an adapter
// has to do: turn whatever your solver produces into an allocation vector
// indexed against `problem.options`.
//
// `optimizeFull` returns a plan as a list of launch lines that carry no option
// id, so the lines are matched back onto the menu by the fields that identify a
// mission: mission type, target, and duration. Where several menu entries are
// indistinguishable on all three (the duplicated-option invariant creates
// exactly that), the count lands on the first — they are interchangeable by
// construction, so the judged value is unaffected.

import type { OptimizerSolution } from '../../../lib/types';
import type { PlanProblem, PlanResult, Planner } from '../contract';

export interface OptimizeFullShape {
  (args: {
    options: PlanProblem['options'] extends readonly (infer T)[] ? T[] : never;
    recipeDag: PlanProblem['dag'];
    desiredArtifactNodeIds: string[];
    fuelCapacity: number;
    timeCapacity: number;
    baseYield: Map<string, number>;
  }): OptimizerSolution;
}

export function plannerFromOptimizeFull(optimizeFull: OptimizeFullShape): Planner {
  return (problem: PlanProblem): PlanResult => {
    const solution = optimizeFull({
      options: problem.options.slice() as never,
      recipeDag: problem.dag,
      desiredArtifactNodeIds: problem.targets.slice(),
      // The production entry point takes the per-slot horizon and applies the
      // 3-slot budget itself.
      fuelCapacity: problem.fuelCapacity,
      timeCapacity: problem.timeCapacity,
      baseYield: new Map(problem.baseYield),
    });

    const allocation = new Array<number>(problem.options.length).fill(0);
    for (const line of solution.choiceHistory) {
      let i = problem.options.findIndex(
        o =>
          o.ship.missionTypeId === line.ship.missionTypeId &&
          o.targetAfxId === line.targetAfxId &&
          o.actualTime === line.actualTime
      );
      if (i < 0) {
        i = problem.options.findIndex(
          o => o.ship.missionTypeId === line.ship.missionTypeId && o.targetAfxId === line.targetAfxId
        );
      }
      if (i < 0) {
        throw new Error(
          `solver returned a mission that was never offered: ${line.ship.name} -> ${line.target}`
        );
      }
      allocation[i] += line.numShipsLaunched;
    }

    return {
      allocation,
      reported: {
        jointProbability: solution.jointProbability,
        perTarget: solution.perTarget.map(t => t.bestProbability),
      },
    };
  };
}
