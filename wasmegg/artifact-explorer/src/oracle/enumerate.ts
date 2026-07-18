// Brute-force side of the oracle: exhaustively search integer launch
// allocations under the fuel/time budgets and return the best achievable
// score according to the independent evaluator.
//
// Yields and direct drops are nonnegative and the LP value is monotone in
// inventory, so the objective is monotone in every k_i: some optimal
// allocation is always "maximal" (no option can be incremented without
// busting a budget). Enumerating only maximal allocations is therefore an
// exact search, not a heuristic.

import { evaluateAllocation, OracleInstance } from './evaluate';

export interface BruteForceResult {
  bestScore: number;
  bestProbability: number;
  bestAllocation: number[];
  feasibleCount: number; // all feasible integer vectors
  evaluatedCount: number; // maximal vectors actually run through the LP
}

export function countFeasible(inst: OracleInstance, cap: number): number | null {
  const n = inst.options.length;
  let count = 0;
  const walk = (i: number, fuelLeft: number, timeLeft: number): boolean => {
    if (i === n) {
      count++;
      return count <= cap;
    }
    const opt = inst.options[i];
    const maxK = Math.min(Math.floor(fuelLeft / opt.actualFuel), Math.floor(timeLeft / opt.actualTime));
    for (let k = 0; k <= maxK; k++) {
      if (!walk(i + 1, fuelLeft - k * opt.actualFuel, timeLeft - k * opt.actualTime)) {
        return false;
      }
    }
    return true;
  };
  return walk(0, inst.fuelCapacity, inst.timeCapacity) ? count : null;
}

export function bruteForceBest(inst: OracleInstance): BruteForceResult {
  const n = inst.options.length;
  const allocation = new Array<number>(n).fill(0);
  let best: BruteForceResult = {
    bestScore: -Infinity,
    bestProbability: 0,
    bestAllocation: allocation.slice(),
    feasibleCount: 0,
    evaluatedCount: 0,
  };

  const isMaximal = (fuelLeft: number, timeLeft: number): boolean =>
    !inst.options.some(opt => opt.actualFuel <= fuelLeft && opt.actualTime <= timeLeft);

  const walk = (i: number, fuelLeft: number, timeLeft: number) => {
    if (i === n) {
      best.feasibleCount++;
      if (!isMaximal(fuelLeft, timeLeft)) {
        return;
      }
      const evaluation = evaluateAllocation(inst, allocation);
      best.evaluatedCount++;
      if (evaluation.score > best.bestScore) {
        best.bestScore = evaluation.score;
        best.bestProbability = evaluation.probability;
        best.bestAllocation = allocation.slice();
      }
      return;
    }
    const opt = inst.options[i];
    const maxK = Math.min(Math.floor(fuelLeft / opt.actualFuel), Math.floor(timeLeft / opt.actualTime));
    for (let k = 0; k <= maxK; k++) {
      allocation[i] = k;
      walk(i + 1, fuelLeft - k * opt.actualFuel, timeLeft - k * opt.actualTime);
    }
    allocation[i] = 0;
  };

  walk(0, inst.fuelCapacity, inst.timeCapacity);
  return best;
}
