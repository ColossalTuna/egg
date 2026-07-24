// Outer search for the Path of Virtue optimizer: pick integer counts of each
// launch option to maximize the chance of the desired legendary under a fuel
// budget R and a per-slot time horizon S. The game runs three independent
// mission slots, so a plan is realizable only if its mission durations pack
// into 3 bins of capacity S.
//
// Objective: score = sum_T Q_T * (crafts of T) + direct legendary drops, with
// Q_T = -log(1 - pCraftLegendary_T). Probability is monotone in score, and
// score is concave in inventory, which the searches below rely on.

import type { LaunchOption, LaunchSolution, OptimizerSolution, RecipeDAG, SlotSummary } from './types';
import { ei } from 'lib';
import { compileInnerLp, alphaToProb, InnerLp } from './value-function';
import { compileJointInnerLp, JointInnerLp, JOINT_TANGENTS, EPIGRAPH_SHIFT } from './value-function';
import { solveLp } from './lp';

const NUM_SLOTS = 3;
const TRIPLE_TOP_K = 20;
const DEFAULT_EPSILON = 1e-3;
const ZERO_TOL = 1e-9;

// Joint-path-only candidate pool bounds (see coreSearchJoint) -- deliberately
// separate from TRIPLE_TOP_K so tuning them can never perturb the n=1 path's
// ranked-candidate construction, which TRIPLE_TOP_K still governs unchanged.
const JOINT_PAIR_TOP_K = 30;
const JOINT_TRIPLE_TOP_K = 10;

interface OptimizeArgs {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  desiredArtifactNodeIds: string[];
  fuelCapacity: number;
  timeCapacity: number;
  baseYield: Map<string, number>;
  epsilon?: number;
}

type EvalFn = (multipliers: ReadonlyArray<readonly [number, number]>) => number;

// Budget-independent state, built once and reused across the relaxed and
// floor solves.
interface EvalContext {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  targets: string[];
  baseYield: Map<string, number>;
  QByTarget: Map<string, number>;
  innerLp: InnerLp;
  evalScoreAt: EvalFn;
  baseScore: number;
}

interface CoreResult {
  bestAlloc: Map<number, number>;
  bestScore: number;
  U: number; // joint-LP relaxation value: an upper bound on the score
  support: Set<number>; // options with positive weight at the LP optimum
}

interface PackResult {
  alloc: Map<number, number>;
  slots: SlotSummary[];
  score: number;
}

// Minimal shapes packAndFill/escalatePacking actually touch, so both the
// single-target EvalContext/CoreResult and the joint path's own
// JointEvalContext/JointCoreResult (which carry a differently-computed
// eval function and search bookkeeping) satisfy them structurally. This is a
// type-only widening -- it changes no runtime behavior of either path.
interface SearchContext {
  options: LaunchOption[];
  evalScoreAt: EvalFn;
}
interface SearchResult {
  support: Set<number>;
}

function buildEvalContext(
  options: LaunchOption[],
  recipeDag: RecipeDAG,
  desiredArtifactNodeIds: string[],
  baseYield: Map<string, number>
): EvalContext {
  // Q_T weights the inner LP's craft objective so a craft of a target with
  // better legendary odds counts for more.
  const targets = desiredArtifactNodeIds;
  const QByTarget = new Map<string, number>();
  for (const t of targets) {
    const pCraft = recipeDag.get(t)?.legendaryCraftProbability ?? 0;
    QByTarget.set(t, pCraft <= 0 ? 0 : pCraft >= 1 ? 1e6 : -Math.log(1 - pCraft));
  }

  const innerLp = compileInnerLp(recipeDag, desiredArtifactNodeIds, QByTarget);

  // The inner LP only sees inventory through its b vector, so the base yield
  // and each option's yield vector are preindexed down to constraint rows
  // here; yields to nodes without a conservation row can't affect the score.
  const nRows = innerLp.constraintNodes.length;
  const rowIdxByNode = new Map<string, number>();
  for (let i = 0; i < nRows; i++) {
    rowIdxByNode.set(innerLp.constraintNodes[i], i);
  }
  const bBase = new Float64Array(nRows);
  for (const [k, v] of baseYield) {
    const row = rowIdxByNode.get(k);
    if (row !== undefined && v > 0) {
      bBase[row] = v;
    }
  }

  const optYieldRows: Int32Array[] = new Array(options.length);
  const optYieldRates: Float64Array[] = new Array(options.length);
  for (let i = 0; i < options.length; i++) {
    const rows: number[] = [];
    const rates: number[] = [];
    for (const [n, r] of options[i].yieldVector) {
      const row = rowIdxByNode.get(n);
      if (row !== undefined) {
        rows.push(row);
        rates.push(r);
      }
    }
    optYieldRows[i] = new Int32Array(rows);
    optYieldRates[i] = new Float64Array(rates);
  }

  const bEval = new Float64Array(nRows);
  const evalScoreAt: EvalFn = multipliers => {
    bEval.set(bBase);
    let directLegendary = 0;
    for (const [idx, k] of multipliers) {
      if (k <= 0) continue;
      const rows = optYieldRows[idx];
      const rates = optYieldRates[idx];
      for (let j = 0; j < rows.length; j++) {
        bEval[rows[j]] += k * rates[j];
      }
      const opt = options[idx];
      for (const t of targets) {
        directLegendary += k * (opt.legendaryYieldVector.get(t) ?? 0);
      }
    }
    return innerLp.solveScore(bEval) + directLegendary;
  };

  const baseScore = innerLp.solveScore(bBase);

  return { options, recipeDag, targets, baseYield, QByTarget, innerLp, evalScoreAt, baseScore };
}

// Entry point: single-target (n<=1) search must stay byte-for-byte identical
// to its behavior before the joint/multi-target objective existed, so it is
// split out verbatim into optimizeFullSingle rather than sharing code paths
// with the new n>=2 joint search -- even a provably-equivalent refactor would
// risk a ULP of numeric drift, which correctness here cannot tolerate.
export function optimizeFull(args: OptimizeArgs): OptimizerSolution {
  if (args.desiredArtifactNodeIds.length <= 1) return optimizeFullSingle(args);
  return optimizeFullJoint(args);
}

// The pre-Phase-1 optimizeFull body, renamed and otherwise untouched. Also
// exported (alongside optimizeFullJoint) so tests can call either search
// directly regardless of what optimizeFull's target-count dispatch would
// choose.
export function optimizeFullSingle(args: OptimizeArgs): OptimizerSolution {
  const {
    options,
    recipeDag,
    desiredArtifactNodeIds,
    fuelCapacity: rawR,
    timeCapacity: rawS,
    baseYield,
    epsilon = DEFAULT_EPSILON,
  } = args;

  // Clamp NaN/negative budgets (e.g. an empty input field upstream) to zero
  // rather than let NaN comparisons leak into the search.
  const R = Number.isFinite(rawR) && rawR > 0 ? rawR : 0;
  const S = Number.isFinite(rawS) && rawS > 0 ? rawS : 0;

  // Only missions that fit a single slot's horizon can ever run; filtering
  // here also keeps the 3S relaxation's upper bound valid.
  const feasibleOptions = options.filter(o => o.actualTime > ZERO_TOL && o.actualTime <= S);

  const ctx = buildEvalContext(feasibleOptions, recipeDag, desiredArtifactNodeIds, baseYield);

  let bestAlloc = new Map<number, number>();
  let bestScore = ctx.baseScore;
  let bestSlots: SlotSummary[] = [];
  let U = ctx.baseScore;

  if (feasibleOptions.length > 0 && S > 0) {
    // Relaxed solve over 3S aggregate time: an upper bound U plus a candidate
    // allocation that may not be 3-bin packable.
    const relaxed = coreSearch(ctx, R, NUM_SLOTS * S, epsilon);
    U = Math.max(U, relaxed.U);

    // Floor solve: three identical single-slot plans, always packable.
    const floor = coreSearch(ctx, R / NUM_SLOTS, S, epsilon);
    const floorAlloc = new Map<number, number>();
    for (const [i, k] of floor.bestAlloc) floorAlloc.set(i, k * NUM_SLOTS);

    // Three packable candidates: the repaired relaxed optimum, the repaired
    // floor, and a greedy build from empty slots. All fill from the full
    // option list so dual-filtered budget-fillers are re-admitted.
    const candidates = [
      packAndFill(relaxed.bestAlloc, ctx, R, S),
      packAndFill(floorAlloc, ctx, R, S),
      packAndFill(new Map(), ctx, R, S),
    ];
    for (const cand of candidates) {
      if (cand.score > bestScore + ZERO_TOL) {
        bestScore = cand.score;
        bestAlloc = cand.alloc;
        bestSlots = cand.slots;
      }
    }

    // Escalate only when the packable best still trails the upper bound.
    if (U > ZERO_TOL && (U - bestScore) / U > epsilon) {
      const escalated = escalatePacking(relaxed, floor, ctx, R, S);
      if (escalated && escalated.score > bestScore + ZERO_TOL) {
        bestAlloc = escalated.alloc;
        bestSlots = escalated.slots;
      }
    }
  }

  return assembleFullSolution(ctx, bestAlloc, bestSlots, baseYield, desiredArtifactNodeIds, recipeDag);
}

// Single-time-budget integer search: LP relaxation + dominance/dual pruning +
// pair/triple ternary scans + greedy repair. The caller decides whether S is
// 3S (relaxed) or S (floor).
function coreSearch(ctx: EvalContext, R: number, S: number, epsilon: number): CoreResult {
  const { options, evalScoreAt, baseScore, innerLp, baseYield, targets, recipeDag, QByTarget } = ctx;

  // Single-option sweep. Also records each option's solo score, which the
  // triple fallback uses for its top-K ranking.
  const scoreAlone = new Float64Array(options.length).fill(-Infinity);
  const kAlone = new Int32Array(options.length);

  let bestScore = baseScore;
  let bestAlloc: Map<number, number> = new Map();

  const tryUpdateAllocations = (score: number, alloc: Map<number, number>) => {
    if (score > bestScore + ZERO_TOL) {
      bestScore = score;
      bestAlloc = alloc;
    }
  };

  for (let idx = 0; idx < options.length; idx++) {
    const o = options[idx];
    const r_i = o.actualFuel;
    const s_i = o.actualTime;
    if (s_i <= 0) continue;
    const k_i_R = r_i > ZERO_TOL ? Math.floor(R / r_i) : Infinity;
    const k_i_S = Math.floor(S / s_i);
    const k_i = Math.min(k_i_R, k_i_S);
    if (!isFinite(k_i) || k_i < 0) continue;
    const a = evalScoreAt([[idx, k_i]]);
    scoreAlone[idx] = a;
    kAlone[idx] = k_i;
    if (a > bestScore + ZERO_TOL) {
      tryUpdateAllocations(a, new Map([[idx, k_i]]));
    }
  }

  // Dominance pruning: j dominates i when it costs no more on either budget
  // and yields at least as much of every ingredient, strictly better
  // somewhere. Comparing yields pointwise (rather than by solo score) keeps
  // complementary options alive — the only good source of some ingredient
  // can't be pruned just because its standalone score is poor.
  const survives = new Uint8Array(options.length);
  for (let i = 0; i < options.length; i++) survives[i] = 1;

  for (let i = 0; i < options.length; i++) {
    if (!survives[i]) continue;
    for (let j = 0; j < options.length; j++) {
      if (i === j || !survives[j]) continue;
      if (dominates(options[j], options[i])) {
        survives[i] = 0;
        break;
      }
    }
  }

  const allSurvivors: number[] = [];
  for (let i = 0; i < options.length; i++) {
    if (survives[i]) {
      allSurvivors.push(i);
    }
  }

  // Joint LP relaxation: upper bound on the score, plus the support set.
  const jointLp = solveJointLp(allSurvivors, options, innerLp, R, S, baseYield, targets, recipeDag, QByTarget);
  const scoreLP = jointLp.score;
  const lpSupport = new Set<number>(jointLp.support);

  // Dual filter: an option's reduced cost at the LP optimum bounds how much
  // score the LP would lose if forced to include it. Drop options where even
  // the solo-max multiplicity would cost more than half the epsilon gap
  // budget. This is deliberately aggressive (it tends to cut the survivor set
  // down to the LP support, which keeps the pair/triple scans fast) and it
  // does discard cheap budget-filler options — the greedy repair at the end
  // re-admits those from the full list.
  if (scoreLP > ZERO_TOL) {
    const lossBudget = 0.5 * epsilon * scoreLP;
    const yR = jointLp.dualR;
    const yS = jointLp.dualS;
    const nodeDuals = jointLp.nodeDuals;
    for (let i = 0; i < options.length; i++) {
      if (!survives[i]) continue;
      if (lpSupport.has(i)) continue;
      const opt = options[i];
      let rc = 0;
      for (const t of targets) rc += opt.legendaryYieldVector.get(t) ?? 0;
      rc -= opt.actualFuel * yR;
      rc -= opt.actualTime * yS;
      for (const [n, dn] of nodeDuals) {
        if (dn === 0) continue;
        const v = opt.yieldVector.get(n);
        if (v) rc += v * dn;
      }
      const k = Math.max(1, kAlone[i]);
      const maxLoss = -rc * k;
      if (maxLoss > lossBudget) survives[i] = 0;
    }
  }

  const survivorsAfter = allSurvivors.filter(i => survives[i]);

  // Pairwise scans: P x P, then Z x P and Z x Z.
  for (let a = 0; a < survivorsAfter.length; a++) {
    for (let b = a + 1; b < survivorsAfter.length; b++) {
      pairwiseScan(survivorsAfter[a], survivorsAfter[b], options, R, S, evalScoreAt, tryUpdateAllocations);
    }
  }

  // If the LP gap is still large, try triples over the LP support plus the
  // top-K options by solo score. The support goes first: complementary
  // options with poor standalone scores live there, and with many
  // near-duplicate missions the solo ranking would otherwise fill up with
  // clones of the best standalone option and crowd them out.
  const gap = scoreLP > ZERO_TOL ? (scoreLP - bestScore) / scoreLP : 0;
  if (gap > epsilon) {
    const bySingle = survivorsAfter
      .filter(i => isFinite(scoreAlone[i]) && scoreAlone[i] > -Infinity)
      .sort((x, y) => scoreAlone[y] - scoreAlone[x])
      .slice(0, TRIPLE_TOP_K);
    const ranked = [...lpSupport].filter(i => survives[i]);
    const seen = new Set(ranked);
    for (const i of bySingle) {
      if (!seen.has(i)) {
        seen.add(i);
        ranked.push(i);
      }
    }
    ranked.length = Math.min(ranked.length, TRIPLE_TOP_K + lpSupport.size);
    for (let a = 0; a < ranked.length; a++) {
      for (let b = a + 1; b < ranked.length; b++) {
        for (let c = b + 1; c < ranked.length; c++) {
          tripleScan(ranked[a], ranked[b], ranked[c], options, R, S, evalScoreAt, tryUpdateAllocations);
        }
      }
    }
  }

  bestScore = repairAlloc(bestAlloc, bestScore, options, R, S, evalScoreAt);

  // Repair again from the floor-rounded LP solution (still feasible, and its
  // neighborhood is where the integer optimum usually lives). Keep whichever
  // start ends up better.
  const lpRounded = new Map<number, number>();
  for (let s = 0; s < allSurvivors.length; s++) {
    const k = Math.floor(jointLp.x[s]);
    if (k > 0) lpRounded.set(allSurvivors[s], k);
  }
  let lpRoundedScore = evalScoreAt([...lpRounded]);
  lpRoundedScore = repairAlloc(lpRounded, lpRoundedScore, options, R, S, evalScoreAt);
  if (lpRoundedScore > bestScore + ZERO_TOL) {
    bestScore = lpRoundedScore;
    bestAlloc = lpRounded;
  }

  return { bestAlloc, bestScore, U: scoreLP, support: lpSupport };
}

// Turn a (possibly unpackable) allocation into a realizable plan: best-fit-
// decreasing pack into the three slots, drop the spillover, then greedily fill
// each slot's remaining time within the leftover fuel.
function packAndFill(
  startAlloc: Map<number, number>,
  ctx: SearchContext,
  R: number,
  S: number,
  fillOptions?: Set<number>
): PackResult {
  const options = ctx.options;

  const missionOpt: number[] = [];
  const missionDur: number[] = [];
  const missionRawDur: number[] = [];
  for (const [i, k] of startAlloc) {
    if (k <= 0) continue;
    const d = options[i].actualTime;
    if (d <= ZERO_TOL || d > S + ZERO_TOL) continue;
    for (let c = 0; c < k; c++) {
      missionOpt.push(i);
      missionDur.push(d);
      missionRawDur.push(options[i].rawTime);
    }
  }

  // Missions that fit no slot's remaining time, or that the fuel budget can
  // no longer afford, are dropped.
  const order = missionOpt.map((_, idx) => idx).sort((a, b) => missionDur[b] - missionDur[a]);
  const slotLoad = new Array<number>(NUM_SLOTS).fill(0);
  const slotRawLoad = new Array<number>(NUM_SLOTS).fill(0);
  const slotCount = new Array<number>(NUM_SLOTS).fill(0);
  const alloc = new Map<number, number>();
  let usedFuel = 0;
  for (const flat of order) {
    const i = missionOpt[flat];
    const d = missionDur[flat];
    const f = options[i].actualFuel;
    if (usedFuel + f > R + ZERO_TOL) continue;
    let best = -1;
    let bestLoad = -1;
    for (let b = 0; b < NUM_SLOTS; b++) {
      if (slotLoad[b] + d <= S + ZERO_TOL && slotLoad[b] > bestLoad) {
        best = b;
        bestLoad = slotLoad[b];
      }
    }
    if (best === -1) continue;
    slotLoad[best] += d;
    slotRawLoad[best] += missionRawDur[flat];
    slotCount[best] += 1;
    alloc.set(i, (alloc.get(i) ?? 0) + 1);
    usedFuel += f;
  }

  let score = evalOf(ctx, alloc);

  // Fill from the LP-relevant options plus whatever the start allocation
  // already carries; scanning every option per round is too slow.
  const fillList: number[] = [];
  if (fillOptions) {
    const seen = new Set<number>();
    for (const i of fillOptions) {
      if (!seen.has(i)) {
        seen.add(i);
        fillList.push(i);
      }
    }
    for (const i of alloc.keys()) {
      if (!seen.has(i)) {
        seen.add(i);
        fillList.push(i);
      }
    }
  } else {
    for (let i = 0; i < options.length; i++) fillList.push(i);
  }

  // Score is non-decreasing in inventory, so the best add of an option is as
  // many as fit the emptiest slot (and the fuel); each accepted add consumes
  // most of a slot's remaining time, so the loop ends in a few rounds.
  for (;;) {
    let bestAddScore = score;
    let bestOpt = -1;
    let bestSlot = -1;
    let bestCount = 0;
    for (const i of fillList) {
      const o = options[i];
      const d = o.actualTime;
      if (d <= ZERO_TOL || d > S + ZERO_TOL) continue;
      // slot with the most remaining time that can hold at least one
      let slot = -1;
      let bestRem = -1;
      for (let b = 0; b < NUM_SLOTS; b++) {
        const rem = S - slotLoad[b];
        if (rem + ZERO_TOL >= d && rem > bestRem) {
          bestRem = rem;
          slot = b;
        }
      }
      if (slot === -1) continue;
      const fitTime = Math.floor((bestRem + ZERO_TOL) / d);
      const fitFuel = o.actualFuel > ZERO_TOL ? Math.floor((R - usedFuel + ZERO_TOL) / o.actualFuel) : Infinity;
      const add = Math.min(fitTime, fitFuel);
      if (!isFinite(add) || add <= 0) continue;
      const trial = mergeAdd(alloc, i, add);
      const s = ctx.evalScoreAt(trial);
      if (s > bestAddScore + ZERO_TOL) {
        bestAddScore = s;
        bestOpt = i;
        bestSlot = slot;
        bestCount = add;
      }
    }
    if (bestOpt === -1) break;
    alloc.set(bestOpt, (alloc.get(bestOpt) ?? 0) + bestCount);
    usedFuel += bestCount * options[bestOpt].actualFuel;
    slotLoad[bestSlot] += bestCount * options[bestOpt].actualTime;
    slotRawLoad[bestSlot] += bestCount * options[bestOpt].rawTime;
    slotCount[bestSlot] += bestCount;
    score = bestAddScore;
  }

  const slots: SlotSummary[] = slotLoad.map((load, b) => ({
    loadSeconds: load,
    rawLoadSeconds: slotRawLoad[b],
    missionCount: slotCount[b],
  }));
  return { alloc, slots, score };
}

function mergeAdd(alloc: Map<number, number>, i: number, add: number): [number, number][] {
  const trial: [number, number][] = [];
  let merged = false;
  for (const [idx, k] of alloc) {
    if (idx === i) {
      trial.push([idx, k + add]);
      merged = true;
    } else {
      trial.push([idx, k]);
    }
  }
  if (!merged) trial.push([i, add]);
  return trial;
}

function evalOf(ctx: SearchContext, alloc: Map<number, number>): number {
  return ctx.evalScoreAt([...alloc]);
}

// Seed one slot full of each LP-support option and re-fill the rest, exploring
// per-slot specializations the balanced relaxation misses. Bounded to a few
// starts so it can never dominate the latency budget.
function escalatePacking(
  relaxed: SearchResult,
  floor: SearchResult,
  ctx: SearchContext,
  R: number,
  S: number
): PackResult | null {
  const support = new Set<number>([...relaxed.support, ...floor.support]);
  let best: PackResult | null = null;
  let starts = 0;
  for (const i of support) {
    if (starts++ >= 8) break;
    const d = ctx.options[i].actualTime;
    if (d <= ZERO_TOL || d > S + ZERO_TOL) continue;
    const seed = new Map<number, number>([[i, Math.floor(S / d)]]);
    const r = packAndFill(seed, ctx, R, S, support);
    if (!best || r.score > best.score) best = r;
  }
  return best;
}

function assembleFullSolution(
  ctx: EvalContext,
  bestAlloc: Map<number, number>,
  bestSlots: SlotSummary[],
  baseYield: Map<string, number>,
  desiredArtifactNodeIds: string[],
  recipeDag: RecipeDAG
): OptimizerSolution {
  const { finalYieldVector, totalLegendary, fuelUsed, fuelByEgg, choiceHistory } = assembleSolution(
    baseYield,
    bestAlloc,
    ctx.options
  );

  // wall-clock is the busiest slot's makespan; running time its raw flight time
  const busiest = bestSlots.reduce<SlotSummary | null>(
    (best, s) => (best === null || s.loadSeconds > best.loadSeconds ? s : best),
    null
  );
  const makespan = busiest?.loadSeconds ?? 0;
  const running = busiest?.rawLoadSeconds ?? 0;

  // One extra inner-LP solve at the chosen allocation to recover the
  // per-target craftable counts.
  const finalSolve = ctx.innerLp.solve(finalYieldVector);
  const perTarget = desiredArtifactNodeIds.map(t => {
    const craftCount =
      finalSolve.craftByTarget.get(t) ?? (recipeDag.get(t)?.isLeaf ? (finalYieldVector.get(t) ?? 0) : 0);
    const p = alphaToProb(craftCount, totalLegendary, [t], recipeDag);
    return { nodeId: t, expectedCrafts: craftCount, ...p };
  });
  const primary = perTarget[0] ?? {
    bestProbability: 0,
    craftProbability: 0,
    dropProbability: 0,
    expectedCrafts: 0,
  };

  return {
    bestProbability: primary.bestProbability,
    craftProbability: primary.craftProbability,
    dropProbability: primary.dropProbability,
    expectedCrafts: primary.expectedCrafts,
    fuelUsed: fuelUsed,
    fuelByEgg: fuelByEgg,
    timeUnitsUsed: Math.round(makespan),
    runningTimeSeconds: Math.round(running),
    slots: bestSlots.length > 0 ? bestSlots : undefined,
    choiceHistory: choiceHistory,
    expectedDrops: [], // populated by index.ts
    finalYieldVector: finalYieldVector,
    baseYield: new Map(baseYield),
    recipeDag: recipeDag,
    craftPrimal: finalSolve.primalByNode,
    perTarget: perTarget,
    // n=1, so the joint (AND-all-targets) probability is just the one target's.
    jointProbability: primary.bestProbability,
  };
}

function assembleSolution(baseYield: Map<string, number>, bestAlloc: Map<number, number>, options: LaunchOption[]) {
  const choiceHistory: LaunchSolution[] = [];
  let fuelUsed = 0;
  const finalYieldVector = new Map<string, number>(baseYield);
  const totalLegendary = new Map<string, number>();
  const fuelByEgg = new Map<ei.Egg, number>();
  for (const [idx, k] of bestAlloc) {
    if (k <= 0) continue;
    const opt = options[idx];
    fuelUsed += k * opt.actualFuel;
    for (const [n, r] of opt.yieldVector) {
      finalYieldVector.set(n, (finalYieldVector.get(n) ?? 0) + k * r);
    }
    for (const [n, r] of opt.legendaryYieldVector) {
      totalLegendary.set(n, (totalLegendary.get(n) ?? 0) + k * r);
    }
    for (const [egg, rate] of opt.fuelByEgg) {
      fuelByEgg.set(egg, (fuelByEgg.get(egg) ?? 0) + k * rate);
    }
    choiceHistory.push({
      ship: opt.ship,
      actualFuel: opt.actualFuel,
      actualFuelByEgg: opt.fuelByEgg,
      actualTime: opt.actualTime,
      target: opt.target ?? '',
      targetAfxId: opt.targetAfxId,
      numShipsLaunched: k,
      supplyVector: opt.supplyVector,
      legendarySupplyVector: opt.legendaryYieldVector,
    });
  }
  return { finalYieldVector, totalLegendary, fuelUsed, fuelByEgg, choiceHistory };
}

function dominates(oj: LaunchOption, oi: LaunchOption): boolean {
  if (oj.actualFuel > oi.actualFuel + ZERO_TOL) return false;
  if (oj.actualTime > oi.actualTime + ZERO_TOL) return false;
  let strictYield = false;
  for (const [n, vi] of oi.yieldVector) {
    const vj = oj.yieldVector.get(n) ?? 0;
    if (vj < vi - ZERO_TOL) return false;
    if (vj > vi + ZERO_TOL) strictYield = true;
  }
  // j producing an ingredient i lacks entirely also counts as strict
  if (!strictYield) {
    for (const [n, vj] of oj.yieldVector) {
      if (vj > ZERO_TOL && !oi.yieldVector.has(n)) {
        strictYield = true;
        break;
      }
    }
  }
  const strictCost = oj.actualFuel < oi.actualFuel - ZERO_TOL || oj.actualTime < oi.actualTime - ZERO_TOL;
  return strictCost || strictYield;
}

// Dominance check for the joint (product) path only: unlike the plain
// weighted-sum score (where every target's direct legendary drop is pooled
// into one scalar with uniform weight, so only the total matters), the
// product objective values each target's legendary yield inside its own
// g(score_T) term. An option that drops more of target A's legendary but less
// of target B's does not strictly dominate its opposite under a product
// objective, so legendaryYieldVector must be compared pointwise here too.
function dominatesJoint(j: LaunchOption, i: LaunchOption): boolean {
  if (j.actualFuel > i.actualFuel + ZERO_TOL) return false;
  if (j.actualTime > i.actualTime + ZERO_TOL) return false;
  let strict = false;
  for (const [n, vi] of i.yieldVector) {
    const vj = j.yieldVector.get(n) ?? 0;
    if (vj < vi - ZERO_TOL) return false;
    if (vj > vi + ZERO_TOL) strict = true;
  }
  for (const [n, vj] of j.yieldVector) {
    if (vj > ZERO_TOL && !i.yieldVector.has(n)) strict = true;
  }
  for (const [t, li] of i.legendaryYieldVector) {
    const lj = j.legendaryYieldVector.get(t) ?? 0;
    if (lj < li - ZERO_TOL) return false;
    if (lj > li + ZERO_TOL) strict = true;
  }
  for (const [t, lj] of j.legendaryYieldVector) {
    if (lj > ZERO_TOL && !i.legendaryYieldVector.has(t)) strict = true;
  }
  const strictCost = j.actualFuel < i.actualFuel - ZERO_TOL || j.actualTime < i.actualTime - ZERO_TOL;
  return strictCost || strict;
}

// Greedy repair: starting from an allocation, keep adding the best-scoring
// max-fitting batch from the full option list (including pruned options)
// until nothing improves. Score is non-decreasing in inventory, so the best
// add of an option is always its max fitting multiplicity, and each
// accepted add leaves less budget than one batch of that option costs —
// the loop terminates after a handful of rounds. Mutates alloc in place.
function repairAlloc(
  alloc: Map<number, number>,
  score: number,
  options: LaunchOption[],
  R: number,
  S: number,
  evalScoreAt: EvalFn
): number {
  let usedR = 0;
  let usedS = 0;
  for (const [idx, k] of alloc) {
    usedR += k * options[idx].actualFuel;
    usedS += k * options[idx].actualTime;
  }
  for (;;) {
    let bestAddScore = score;
    let bestAdd: [number, number] | null = null;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (o.actualTime <= 0) continue;
      const remR = R - usedR;
      const remS = S - usedS;
      const kR = o.actualFuel > ZERO_TOL ? Math.floor(remR / o.actualFuel) : Infinity;
      const kS = Math.floor(remS / o.actualTime);
      const kFit = Math.min(kR, kS);
      if (!isFinite(kFit) || kFit <= 0) continue;
      const trial: [number, number][] = [];
      let merged = false;
      for (const [idx, k] of alloc) {
        if (idx === i) {
          trial.push([idx, k + kFit]);
          merged = true;
        } else trial.push([idx, k]);
      }
      if (!merged) trial.push([i, kFit]);
      const s = evalScoreAt(trial);
      if (s > bestAddScore + ZERO_TOL) {
        bestAddScore = s;
        bestAdd = [i, kFit];
      }
    }
    if (!bestAdd) break;
    const [i, kAdd] = bestAdd;
    alloc.set(i, (alloc.get(i) ?? 0) + kAdd);
    usedR += kAdd * options[i].actualFuel;
    usedS += kAdd * options[i].actualTime;
    score = bestAddScore;
  }
  return score;
}

// Scan the (k_i, k_j) lattice with ternary search on k_j (score is concave in
// k_j for a fixed pair). Works for any mix of zero- and positive-fuel options:
// a zero fuel cost just makes the fuel bound infinite, leaving the time bound.
function pairwiseScan(
  iIdx: number,
  jIdx: number,
  options: LaunchOption[],
  R: number,
  S: number,
  evalScore: EvalFn,
  tryUpdate: (score: number, alloc: Map<number, number>) => void
) {
  const oi = options[iIdx];
  const oj = options[jIdx];
  const r_i = oi.actualFuel,
    s_i = oi.actualTime;
  const r_j = oj.actualFuel,
    s_j = oj.actualTime;
  if (s_i <= 0 || s_j <= 0) return;

  const k_j_max_R = r_j > ZERO_TOL ? Math.floor(R / r_j) : Infinity;
  const k_j_max_S = Math.floor(S / s_j);
  const k_j_max = Math.min(k_j_max_R, k_j_max_S);
  if (k_j_max < 0) return;

  // largest k_i that still fits once k_j batches of j are committed
  const kIatJ = (k_j: number): number => {
    const remR = R - k_j * r_j;
    const remS = S - k_j * s_j;
    if (remR < -ZERO_TOL || remS < -ZERO_TOL) return -1;
    const k_i_R = r_i > ZERO_TOL ? Math.floor(remR / r_i) : Infinity;
    const k_i_S = s_i > 0 ? Math.floor(remS / s_i) : 0;
    const k_i = Math.min(k_i_R, k_i_S);
    return k_i < 0 ? 0 : isFinite(k_i) ? k_i : 0;
  };

  const scoreAtKj = (k_j: number): { score: number; k_i: number } => {
    const k_i = kIatJ(k_j);
    if (k_i < 0) return { score: -Infinity, k_i: -1 };
    const score = evalScore([
      [iIdx, k_i],
      [jIdx, k_j],
    ]);
    return { score, k_i };
  };

  const best = ternaryMaxOver(0, k_j_max, scoreAtKj);
  if (best.k_i >= 0 && best.score > -Infinity) {
    const alloc = new Map<number, number>();
    if (best.k_i > 0) alloc.set(iIdx, best.k_i);
    if (best.k > 0) alloc.set(jIdx, best.k);
    tryUpdate(best.score, alloc);
  }
}

// Triple scan: nested ternary search on k_i and k_j, with k_k determined by
// the leftover budget.
function tripleScan(
  iIdx: number,
  jIdx: number,
  kIdx: number,
  options: LaunchOption[],
  R: number,
  S: number,
  evalScore: EvalFn,
  tryUpdate: (score: number, alloc: Map<number, number>) => void
) {
  const oi = options[iIdx];
  const oj = options[jIdx];
  const ok = options[kIdx];
  const r_i = oi.actualFuel,
    s_i = oi.actualTime;
  const r_j = oj.actualFuel,
    s_j = oj.actualTime;
  const r_k = ok.actualFuel,
    s_k = ok.actualTime;
  if (s_i <= 0 || s_j <= 0 || s_k <= 0) return;

  const k_i_max = Math.min(r_i > ZERO_TOL ? Math.floor(R / r_i) : Infinity, Math.floor(S / s_i));
  if (!isFinite(k_i_max) || k_i_max < 0) return;

  const scoreGivenIJ = (k_i: number, k_j: number) => {
    const remR = R - k_i * r_i - k_j * r_j;
    const remS = S - k_i * s_i - k_j * s_j;
    if (remR < -ZERO_TOL || remS < -ZERO_TOL) return { score: -Infinity, k_k: -1 };
    const k_k_R = r_k > ZERO_TOL ? Math.floor(remR / r_k) : Infinity;
    const k_k_S = Math.floor(remS / s_k);
    const k_k = Math.min(k_k_R, k_k_S);
    if (!isFinite(k_k) || k_k < 0) return { score: -Infinity, k_k: -1 };
    const score = evalScore([
      [iIdx, k_i],
      [jIdx, k_j],
      [kIdx, k_k],
    ]);
    return { score, k_k };
  };

  const outerEval = (k_i: number) => {
    const k_j_max = Math.min(
      r_j > ZERO_TOL ? Math.floor((R - k_i * r_i) / r_j) : Infinity,
      Math.floor((S - k_i * s_i) / s_j)
    );
    if (!isFinite(k_j_max) || k_j_max < 0) return { score: -Infinity, k_j: -1, k_k: -1 };
    const inner = ternaryMaxOver(0, k_j_max, k_j => {
      const r = scoreGivenIJ(k_i, k_j);
      return { score: r.score, k_k: r.k_k };
    });
    return { score: inner.score, k_j: inner.k, k_k: inner.k_k };
  };

  const outer = ternaryMaxOver(0, k_i_max, k_i => {
    const o = outerEval(k_i);
    return { score: o.score, k_j: o.k_j, k_k: o.k_k };
  });

  if (outer.score > -Infinity) {
    const alloc = new Map<number, number>();
    if (outer.k > 0) alloc.set(iIdx, outer.k);
    if (outer.k_j > 0) alloc.set(jIdx, outer.k_j);
    if (outer.k_k > 0) alloc.set(kIdx, outer.k_k);
    tryUpdate(outer.score, alloc);
  }
}

// Ternary search over an integer interval for the max of an approximately
// concave function. Extra fields returned by the probe ride along with the
// winning result.
function ternaryMaxOver<E extends Record<string, number>>(
  lo: number,
  hi: number,
  probe: (k: number) => { score: number } & E
): { score: number; k: number } & E {
  if (hi < lo) {
    return { score: -Infinity, k: lo, ...({} as E) };
  }
  let bestK = lo;
  let bestProbe = probe(lo);
  let bestScore = bestProbe.score;
  if (hi !== lo) {
    const ph = probe(hi);
    if (ph.score > bestScore) {
      bestScore = ph.score;
      bestK = hi;
      bestProbe = ph;
    }
  }
  while (hi - lo > 2) {
    const m1 = lo + Math.floor((hi - lo) / 3);
    const m2 = hi - Math.floor((hi - lo) / 3);
    const p1 = probe(m1);
    const p2 = probe(m2);
    if (p1.score > bestScore) {
      bestScore = p1.score;
      bestK = m1;
      bestProbe = p1;
    }
    if (p2.score > bestScore) {
      bestScore = p2.score;
      bestK = m2;
      bestProbe = p2;
    }
    if (p1.score < p2.score) lo = m1 + 1;
    else hi = m2 - 1;
  }
  for (let k = lo; k <= hi; k++) {
    const p = probe(k);
    if (p.score > bestScore) {
      bestScore = p.score;
      bestK = k;
      bestProbe = p;
    }
  }
  return { ...(bestProbe as E), score: bestScore, k: bestK };
}

interface JointLpResult {
  score: number;
  x: Float64Array; // multiplicity per surviving option
  support: number[]; // indices into `options` with x > 0
  dualR: number; // fuel budget shadow price
  dualS: number; // time budget shadow price
  nodeDuals: Map<string, number>; // per conservation row, keyed by node id
}

function solveJointLp(
  survivors: number[],
  options: LaunchOption[],
  innerLp: InnerLp,
  R: number,
  S: number,
  baseYield: Map<string, number>,
  targets: string[],
  recipeDag: RecipeDAG,
  QByTarget: Map<string, number>
): JointLpResult {
  const nx = survivors.length;
  const np = innerLp.nonLeafNodes.length;
  const totalVars = nx + np;
  if (totalVars === 0) {
    return {
      score: 0,
      x: new Float64Array(0),
      support: [],
      dualR: 0,
      dualS: 0,
      nodeDuals: new Map(),
    };
  }

  // Objective: weighted crafts plus each option's direct legendary yield.
  // Ordinary target drops aren't rewarded here — their value flows through
  // the conservation rows.
  const c = new Float64Array(totalVars);
  for (const [t, q] of QByTarget) {
    const tIdx = innerLp.varIndex.get(t);
    if (tIdx !== undefined) c[nx + tIdx] = q;
  }
  for (let s = 0; s < nx; s++) {
    const opt = options[survivors[s]];
    let ci = 0;
    for (const t of targets) ci += opt.legendaryYieldVector.get(t) ?? 0;
    if (ci) c[s] = ci;
  }

  const A: Float64Array[] = [];
  const bArr: number[] = [];

  // budget rows
  const rRow = new Float64Array(totalVars);
  const sRow = new Float64Array(totalVars);
  for (let s = 0; s < nx; s++) {
    rRow[s] = options[survivors[s]].actualFuel;
    sRow[s] = options[survivors[s]].actualTime;
  }
  A.push(rRow);
  bArr.push(R);
  A.push(sRow);
  bArr.push(S);

  // Conservation rows, one per consumed node n:
  //   sum_parents q * p_parent - (p_n if non-leaf) - sum_i x_i * yield_i[n] <= base_yield[n]
  const parentsOf = new Map<string, { parent: string; q: number }[]>();
  for (const [pid, pnode] of recipeDag) {
    if (pnode.isLeaf) continue;
    for (const child of pnode.children) {
      let arr = parentsOf.get(child.nodeId);
      if (!arr) {
        arr = [];
        parentsOf.set(child.nodeId, arr);
      }
      arr.push({ parent: pid, q: child.quantity });
    }
  }

  // remember which row belongs to which node so duals can be mapped back
  const constraintRowNode: string[] = [];
  for (const nodeId of recipeDag.keys()) {
    const parents = parentsOf.get(nodeId);
    if (!parents || parents.length === 0) continue;
    const row = new Float64Array(totalVars);
    for (const { parent, q } of parents) {
      const pIdx = innerLp.varIndex.get(parent);
      if (pIdx !== undefined) row[nx + pIdx] += q;
    }
    const myIdx = innerLp.varIndex.get(nodeId);
    if (myIdx !== undefined) row[nx + myIdx] -= 1;
    for (let s = 0; s < nx; s++) {
      const v = options[survivors[s]].yieldVector.get(nodeId) ?? 0;
      if (v) row[s] -= v;
    }
    A.push(row);
    bArr.push(baseYield.get(nodeId) ?? 0);
    constraintRowNode.push(nodeId);
  }

  const b = new Float64Array(bArr);
  const result = solveLp(c, A, b);
  if (result.status !== 'optimal') {
    return {
      score: 0,
      x: new Float64Array(nx),
      support: [],
      dualR: 0,
      dualS: 0,
      nodeDuals: new Map(),
    };
  }
  const x = new Float64Array(nx);
  const support: number[] = [];
  for (let s = 0; s < nx; s++) {
    x[s] = result.primal[s];
    if (x[s] > ZERO_TOL) support.push(survivors[s]);
  }
  let score = result.objective;
  for (const [t, q] of QByTarget) score += q * (baseYield.get(t) ?? 0);
  const dualR = result.duals[0];
  const dualS = result.duals[1];
  const nodeDuals = new Map<string, number>();
  for (let r = 0; r < constraintRowNode.length; r++) {
    nodeDuals.set(constraintRowNode[r], result.duals[2 + r]);
  }
  return { score, x, support, dualR, dualS, nodeDuals };
}

// ---------------------------------------------------------------------------
// Joint (product) objective search, for n >= 2 desired targets: maximize
// F = sum_T g(score_T) (see value-function.ts's JOINT_TANGENTS docs for the
// derivation), which is a concave over-estimate-safe proxy for
// log(product_T bestProbability_T). This mirrors optimizeFullSingle's overall
// shape (relaxed 3S solve, packable floor solve, greedy pack/fill,
// certificate-guided escalation) but with its own eval context, its own LP
// relaxation (tangent-augmented), its own dominance check (dominatesJoint),
// and gap arithmetic done in probability space rather than relative
// score-space, since F <= 0 makes a relative gap meaningless.
//
// Every heuristic this file reuses for the joint path -- ternary search
// (needs concavity in inventory), dominatesJoint/repairAlloc/packAndFill's
// greedy adds (need monotonicity: more inventory never scores worse) --
// carries over unchanged because F has both properties for the same reason
// each score_T does: g is concave and non-decreasing, each score_T is concave
// and non-decreasing in inventory (see the file-top comment), a non-decreasing
// concave function of a concave non-decreasing argument is itself concave and
// non-decreasing (composition rule), and a sum of such functions keeps both
// properties. None of that machinery cares which concave, non-decreasing
// function it's climbing.

// exp(min(v, 0)): converts a (possibly very negative, always <= 0 at the
// optimum) joint log-probability bound into an actual probability in (0, 1],
// so gap comparisons for the n>=2 path can be made in probability space
// rather than the n=1 path's relative score-space (which assumes score >= 0).
function toProb(v: number): number {
  return Math.exp(Math.min(v, 0));
}

interface JointEvalContext {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  targets: string[];
  baseYield: Map<string, number>;
  QByTarget: Map<string, number>;
  jointInnerLp: JointInnerLp;
  evalScoreAt: EvalFn; // returns the tangent-approximated F, not a probability
  baseF: number;
}

function buildJointEvalContext(
  options: LaunchOption[],
  recipeDag: RecipeDAG,
  desiredArtifactNodeIds: string[],
  baseYield: Map<string, number>
): JointEvalContext {
  const targets = desiredArtifactNodeIds;
  const QByTarget = new Map<string, number>();
  for (const t of targets) {
    const pCraft = recipeDag.get(t)?.legendaryCraftProbability ?? 0;
    QByTarget.set(t, pCraft <= 0 ? 0 : pCraft >= 1 ? 1e6 : -Math.log(1 - pCraft));
  }

  const jointInnerLp = compileJointInnerLp(recipeDag, targets, QByTarget);

  const nRows = jointInnerLp.constraintNodes.length;
  const rowIdxByNode = new Map<string, number>();
  for (let i = 0; i < nRows; i++) {
    rowIdxByNode.set(jointInnerLp.constraintNodes[i], i);
  }
  const bBase = new Float64Array(nRows);
  for (const [k, v] of baseYield) {
    const row = rowIdxByNode.get(k);
    if (row !== undefined && v > 0) {
      bBase[row] = v;
    }
  }

  const optYieldRows: Int32Array[] = new Array(options.length);
  const optYieldRates: Float64Array[] = new Array(options.length);
  const optLegRates: Float64Array[] = new Array(options.length); // per-target legendary rate, targets order
  for (let i = 0; i < options.length; i++) {
    const rows: number[] = [];
    const rates: number[] = [];
    for (const [n, r] of options[i].yieldVector) {
      const row = rowIdxByNode.get(n);
      if (row !== undefined) {
        rows.push(row);
        rates.push(r);
      }
    }
    optYieldRows[i] = new Int32Array(rows);
    optYieldRates[i] = new Float64Array(rates);
    const legRates = new Float64Array(targets.length);
    for (let ti = 0; ti < targets.length; ti++) {
      legRates[ti] = options[i].legendaryYieldVector.get(targets[ti]) ?? 0;
    }
    optLegRates[i] = legRates;
  }

  const bEval = new Float64Array(nRows);
  const lambdaEval = new Float64Array(targets.length);
  const evalScoreAt: EvalFn = multipliers => {
    bEval.set(bBase);
    lambdaEval.fill(0);
    for (const [idx, k] of multipliers) {
      if (k <= 0) continue;
      const rows = optYieldRows[idx];
      const rates = optYieldRates[idx];
      for (let j = 0; j < rows.length; j++) {
        bEval[rows[j]] += k * rates[j];
      }
      const legRates = optLegRates[idx];
      for (let ti = 0; ti < legRates.length; ti++) {
        lambdaEval[ti] += k * legRates[ti];
      }
    }
    return jointInnerLp.solveScore(bEval, lambdaEval);
  };

  const baseF = jointInnerLp.solveScore(bBase, new Float64Array(targets.length));

  return { options, recipeDag, targets, baseYield, QByTarget, jointInnerLp, evalScoreAt, baseF };
}

interface JointCoreResult {
  bestAlloc: Map<number, number>;
  bestF: number;
  U: number; // tangent-LP relaxation value: an upper bound on F
  support: Set<number>;
}

// A small, bounded stand-in for the dual-cost-filtered survivor set the n=1
// path gets for free: the LP relaxation's chosen support (its complementary
// providers) plus the topK best-scoring standalone options, deduplicated and
// capped at topK + support.size candidates total.
function boundedCandidatePool(
  survivors: number[],
  scoreAlone: Float64Array,
  lpSupport: Set<number>,
  topK: number
): number[] {
  const bySingle = survivors
    .filter(i => isFinite(scoreAlone[i]) && scoreAlone[i] > -Infinity)
    .sort((x, y) => scoreAlone[y] - scoreAlone[x])
    .slice(0, topK);
  const pool = [...lpSupport];
  const seen = new Set(pool);
  for (const i of bySingle) {
    if (!seen.has(i)) {
      seen.add(i);
      pool.push(i);
    }
  }
  pool.length = Math.min(pool.length, topK + lpSupport.size);
  return pool;
}

function coreSearchJoint(ctx: JointEvalContext, R: number, S: number, epsilon: number): JointCoreResult {
  const { options, evalScoreAt, baseF, jointInnerLp, baseYield, targets, recipeDag, QByTarget } = ctx;

  const scoreAlone = new Float64Array(options.length).fill(-Infinity);

  let bestF = baseF;
  let bestAlloc: Map<number, number> = new Map();

  const tryUpdateAllocations = (score: number, alloc: Map<number, number>) => {
    if (score > bestF + ZERO_TOL) {
      bestF = score;
      bestAlloc = alloc;
    }
  };

  for (let idx = 0; idx < options.length; idx++) {
    const o = options[idx];
    const r_i = o.actualFuel;
    const s_i = o.actualTime;
    if (s_i <= 0) continue;
    const k_i_R = r_i > ZERO_TOL ? Math.floor(R / r_i) : Infinity;
    const k_i_S = Math.floor(S / s_i);
    const k_i = Math.min(k_i_R, k_i_S);
    if (!isFinite(k_i) || k_i < 0) continue;
    const a = evalScoreAt([[idx, k_i]]);
    scoreAlone[idx] = a;
    if (a > bestF + ZERO_TOL) {
      tryUpdateAllocations(a, new Map([[idx, k_i]]));
    }
  }

  // Dominance pruning (dominatesJoint: legendary yield compared per-target).
  const survives = new Uint8Array(options.length);
  for (let i = 0; i < options.length; i++) survives[i] = 1;

  for (let i = 0; i < options.length; i++) {
    if (!survives[i]) continue;
    for (let j = 0; j < options.length; j++) {
      if (i === j || !survives[j]) continue;
      if (dominatesJoint(options[j], options[i])) {
        survives[i] = 0;
        break;
      }
    }
  }

  const allSurvivors: number[] = [];
  for (let i = 0; i < options.length; i++) {
    if (survives[i]) allSurvivors.push(i);
  }

  // Joint LP relaxation (tangent-augmented): upper bound on F, plus support.
  const jointLp = solveJointLpProduct(
    allSurvivors,
    options,
    jointInnerLp,
    R,
    S,
    baseYield,
    targets,
    recipeDag,
    QByTarget
  );
  const scoreLP = jointLp.F;
  const lpSupport = new Set<number>(jointLp.support);

  // No dual-cost filter here (judgment call, see optimizer-regression report):
  // the single-target dual filter's loss budget is a fraction of a
  // nonnegative score, which doesn't translate to this path's F <= 0 without
  // risking wrongly aggressive pruning. But leaving every dominance survivor
  // to reach the pair/triple scans unfiltered is combinatorially infeasible at
  // production scale -- each probe re-solves the pricier tangent-augmented LP,
  // and hundreds of survivors squared (or cubed) is millions of LP solves,
  // measured in minutes on a real 2-target instance. jointPairPool /
  // jointTriplePool substitute a bound already trusted elsewhere in this
  // file for that missing filter: the LP relaxation's own support (its
  // complementary providers) unioned with the best standalone options.
  // repairAlloc afterwards still scans every option regardless, so a good
  // budget-filler outside these pools is never permanently lost, only left
  // for repair to find.
  const jointPairPool = boundedCandidatePool(allSurvivors, scoreAlone, lpSupport, JOINT_PAIR_TOP_K);
  for (let a = 0; a < jointPairPool.length; a++) {
    for (let b = a + 1; b < jointPairPool.length; b++) {
      pairwiseScan(jointPairPool[a], jointPairPool[b], options, R, S, evalScoreAt, tryUpdateAllocations);
    }
  }

  // Gap check in probability space (F <= 0 makes a relative gap meaningless).
  const gapProb = toProb(scoreLP) - toProb(bestF);
  if (gapProb > epsilon) {
    // Triple scan's nested ternary search costs an order of magnitude more
    // probes per candidate tuple than the pairwise scan, so it gets its own
    // (smaller) pool rather than reusing jointPairPool.
    const jointTriplePool = boundedCandidatePool(allSurvivors, scoreAlone, lpSupport, JOINT_TRIPLE_TOP_K);
    for (let a = 0; a < jointTriplePool.length; a++) {
      for (let b = a + 1; b < jointTriplePool.length; b++) {
        for (let c = b + 1; c < jointTriplePool.length; c++) {
          tripleScan(
            jointTriplePool[a],
            jointTriplePool[b],
            jointTriplePool[c],
            options,
            R,
            S,
            evalScoreAt,
            tryUpdateAllocations
          );
        }
      }
    }
  }

  bestF = repairAlloc(bestAlloc, bestF, options, R, S, evalScoreAt);

  const lpRounded = new Map<number, number>();
  for (let s = 0; s < allSurvivors.length; s++) {
    const k = Math.floor(jointLp.x[s]);
    if (k > 0) lpRounded.set(allSurvivors[s], k);
  }
  let lpRoundedScore = evalScoreAt([...lpRounded]);
  lpRoundedScore = repairAlloc(lpRounded, lpRoundedScore, options, R, S, evalScoreAt);
  if (lpRoundedScore > bestF + ZERO_TOL) {
    bestF = lpRoundedScore;
    bestAlloc = lpRounded;
  }

  return { bestAlloc, bestF, U: scoreLP, support: lpSupport };
}

export function optimizeFullJoint(args: OptimizeArgs): OptimizerSolution {
  const {
    options,
    recipeDag,
    desiredArtifactNodeIds,
    fuelCapacity: rawR,
    timeCapacity: rawS,
    baseYield,
    epsilon = DEFAULT_EPSILON,
  } = args;

  const R = Number.isFinite(rawR) && rawR > 0 ? rawR : 0;
  const S = Number.isFinite(rawS) && rawS > 0 ? rawS : 0;

  const feasibleOptions = options.filter(o => o.actualTime > ZERO_TOL && o.actualTime <= S);

  const ctx = buildJointEvalContext(feasibleOptions, recipeDag, desiredArtifactNodeIds, baseYield);

  let bestAlloc = new Map<number, number>();
  let bestF = ctx.baseF;
  let bestSlots: SlotSummary[] = [];
  let U = ctx.baseF;

  if (feasibleOptions.length > 0 && S > 0) {
    const relaxed = coreSearchJoint(ctx, R, NUM_SLOTS * S, epsilon);
    U = Math.max(U, relaxed.U);

    const floor = coreSearchJoint(ctx, R / NUM_SLOTS, S, epsilon);
    const floorAlloc = new Map<number, number>();
    for (const [i, k] of floor.bestAlloc) floorAlloc.set(i, k * NUM_SLOTS);

    const candidates = [
      packAndFill(relaxed.bestAlloc, ctx, R, S),
      packAndFill(floorAlloc, ctx, R, S),
      packAndFill(new Map(), ctx, R, S),
    ];
    for (const cand of candidates) {
      if (cand.score > bestF + ZERO_TOL) {
        bestF = cand.score;
        bestAlloc = cand.alloc;
        bestSlots = cand.slots;
      }
    }

    // Certificate-guided escalation, gated on the probability-space gap.
    if (toProb(U) - toProb(bestF) > epsilon) {
      const escalated = escalatePacking(relaxed, floor, ctx, R, S);
      if (escalated && escalated.score > bestF + ZERO_TOL) {
        bestAlloc = escalated.alloc;
        bestSlots = escalated.slots;
      }
    }
  }

  return assembleFullJointSolution(ctx, bestAlloc, bestSlots, baseYield, desiredArtifactNodeIds, recipeDag);
}

function assembleFullJointSolution(
  ctx: JointEvalContext,
  bestAlloc: Map<number, number>,
  bestSlots: SlotSummary[],
  baseYield: Map<string, number>,
  desiredArtifactNodeIds: string[],
  recipeDag: RecipeDAG
): OptimizerSolution {
  const { finalYieldVector, totalLegendary, fuelUsed, fuelByEgg, choiceHistory } = assembleSolution(
    baseYield,
    bestAlloc,
    ctx.options
  );

  const busiest = bestSlots.reduce<SlotSummary | null>(
    (best, s) => (best === null || s.loadSeconds > best.loadSeconds ? s : best),
    null
  );
  const makespan = busiest?.loadSeconds ?? 0;
  const running = busiest?.rawLoadSeconds ?? 0;

  // Recover the per-target craft split at the final chosen inventory using
  // the JOINT (tangent-balanced) inner LP, not the weighted-sum
  // compileInnerLp, which would winner-take-all a shared ingredient and
  // misreport the other targets' craft counts. The reported probabilities are
  // then computed EXACTLY via alphaToProb per target (never via the tangent
  // approximation used during search), so the displayed numbers are always
  // exact even though the search that picked this allocation was ranked
  // using the tangent relaxation.
  const finalSolve = ctx.jointInnerLp.solve(finalYieldVector, totalLegendary);
  const perTarget = desiredArtifactNodeIds.map(t => {
    const craftCount =
      finalSolve.craftByTarget.get(t) ?? (recipeDag.get(t)?.isLeaf ? (finalYieldVector.get(t) ?? 0) : 0);
    const p = alphaToProb(craftCount, totalLegendary, [t], recipeDag);
    return { nodeId: t, expectedCrafts: craftCount, ...p };
  });
  const primary = perTarget[0] ?? {
    bestProbability: 0,
    craftProbability: 0,
    dropProbability: 0,
    expectedCrafts: 0,
  };

  let jointProbability = 1;
  for (const t of perTarget) jointProbability *= t.bestProbability;

  return {
    bestProbability: primary.bestProbability,
    craftProbability: primary.craftProbability,
    dropProbability: primary.dropProbability,
    expectedCrafts: primary.expectedCrafts,
    fuelUsed: fuelUsed,
    fuelByEgg: fuelByEgg,
    timeUnitsUsed: Math.round(makespan),
    runningTimeSeconds: Math.round(running),
    slots: bestSlots.length > 0 ? bestSlots : undefined,
    choiceHistory: choiceHistory,
    expectedDrops: [], // populated by index.ts
    finalYieldVector: finalYieldVector,
    baseYield: new Map(baseYield),
    recipeDag: recipeDag,
    craftPrimal: finalSolve.primalByNode,
    perTarget: perTarget,
    jointProbability,
  };
}

interface JointLpProductResult {
  F: number; // objective (tangent-shift already removed): an upper bound on F
  x: Float64Array; // multiplicity per surviving option
  support: number[]; // indices into `options` with x > 0
}

// The outer LP relaxation for the joint path: same decision-variable shape as
// solveJointLp (option counts + craft vars) plus one epigraph z_T per target
// and the same tangent rows as compileJointInnerLp, except here lambda_T is
// itself a linear combination of the option-count variables (via each
// option's legendaryYieldVector), not a precomputed constant -- so this LP is
// built directly rather than reusing compileJointInnerLp's fixed matrix.
function solveJointLpProduct(
  survivors: number[],
  options: LaunchOption[],
  jointInnerLp: JointInnerLp,
  R: number,
  S: number,
  baseYield: Map<string, number>,
  targets: string[],
  recipeDag: RecipeDAG,
  QByTarget: Map<string, number>
): JointLpProductResult {
  const nx = survivors.length;
  const np = jointInnerLp.nonLeafNodes.length;
  const nt = targets.length;
  const totalVars = nx + np + nt;
  if (totalVars === 0) {
    return { F: 0, x: new Float64Array(0), support: [] };
  }
  const zBase = nx + np;

  const c = new Float64Array(totalVars);
  for (let i = 0; i < nt; i++) c[zBase + i] = 1;

  const A: Float64Array[] = [];
  const bArr: number[] = [];

  const rRow = new Float64Array(totalVars);
  const sRow = new Float64Array(totalVars);
  for (let s = 0; s < nx; s++) {
    rRow[s] = options[survivors[s]].actualFuel;
    sRow[s] = options[survivors[s]].actualTime;
  }
  A.push(rRow);
  bArr.push(R);
  A.push(sRow);
  bArr.push(S);

  const parentsOf = new Map<string, { parent: string; q: number }[]>();
  for (const [pid, pnode] of recipeDag) {
    if (pnode.isLeaf) continue;
    for (const child of pnode.children) {
      let arr = parentsOf.get(child.nodeId);
      if (!arr) {
        arr = [];
        parentsOf.set(child.nodeId, arr);
      }
      arr.push({ parent: pid, q: child.quantity });
    }
  }
  for (const nodeId of recipeDag.keys()) {
    const parents = parentsOf.get(nodeId);
    if (!parents || parents.length === 0) continue;
    const row = new Float64Array(totalVars);
    for (const { parent, q } of parents) {
      const pIdx = jointInnerLp.varIndex.get(parent);
      if (pIdx !== undefined) row[nx + pIdx] += q;
    }
    const myIdx = jointInnerLp.varIndex.get(nodeId);
    if (myIdx !== undefined) row[nx + myIdx] -= 1;
    for (let s = 0; s < nx; s++) {
      const v = options[survivors[s]].yieldVector.get(nodeId) ?? 0;
      if (v) row[s] -= v;
    }
    A.push(row);
    bArr.push(baseYield.get(nodeId) ?? 0);
  }

  for (let ti = 0; ti < nt; ti++) {
    const t = targets[ti];
    const q = QByTarget.get(t) ?? 0;
    const pIdx = jointInnerLp.varIndex.get(t);
    for (let k = 0; k < JOINT_TANGENTS.length; k++) {
      const row = new Float64Array(totalVars);
      row[zBase + ti] = 1;
      if (pIdx !== undefined && q !== 0) row[nx + pIdx] = -JOINT_TANGENTS[k].beta * q;
      for (let s = 0; s < nx; s++) {
        const lv = options[survivors[s]].legendaryYieldVector.get(t) ?? 0;
        if (lv) row[s] -= JOINT_TANGENTS[k].beta * lv;
      }
      A.push(row);
      bArr.push(JOINT_TANGENTS[k].alpha + EPIGRAPH_SHIFT);
    }
  }

  const b = new Float64Array(bArr);
  const result = solveLp(c, A, b);
  if (result.status !== 'optimal') {
    return { F: -Infinity, x: new Float64Array(nx), support: [] };
  }
  const x = new Float64Array(nx);
  const support: number[] = [];
  for (let s = 0; s < nx; s++) {
    x[s] = result.primal[s];
    if (x[s] > ZERO_TOL) support.push(survivors[s]);
  }
  const F = result.objective - nt * EPIGRAPH_SHIFT;
  return { F, x, support };
}
