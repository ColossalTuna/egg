# The solver arena

A fixed set of correctness invariants, a fixed judge, and a one-function seam
where you plug in a mission planner. The point is to let several very different
optimisation methodologies be tried against the same bar without any of them
being able to move the bar.

If you are here to write a candidate solver, you need three things: **the
contract** (`contract.ts`), **the objective** (below, and `src/lib/OPTIMIZER.md`
for the long version), and **the rules** (below). You do not need to read the
harness, and you must not import it.

## The problem

Pick how many of each available mission to launch, so as to maximise the
probability of getting a legendary of **every** target artifact.

```ts
export type Planner = (problem: PlanProblem) => PlanResult;
```

You are given:

| field | meaning |
| --- | --- |
| `options` | the menu of launches, already enumerated from the player's ships, research and effort level. Your allocation is indexed against this array, in this order. |
| `dag` | the recipe graph for the targets: what crafts into what, how many of each ingredient a craft consumes, and each node's legendary craft chance. |
| `targets` | the desired artifact node ids. |
| `fuelCapacity` | total fuel for the whole plan. |
| `timeCapacity` | seconds available **per slot**. |
| `slots` | how many missions can be in flight at once. Always 3. |
| `baseYield` | copies of each node the player already owns. |

You return:

```ts
{
  allocation: number[],        // parallel to problem.options, non-negative integers
  reported?: {                 // optional; see "self-reporting" below
    jointProbability: number,
    perTarget: number[],
  },
}
```

### Feasibility

A plan is feasible when both hold:

- **Fuel.** `sum_i allocation[i] * options[i].actualFuel <= fuelCapacity`.
- **Packing.** The missions partition into `slots` groups, each with summed
  `actualTime` at most `timeCapacity`. This is a genuine 3-way bin packing, not
  a check that the total fits in `3 * timeCapacity` — a plan can pass the volume
  bound and still be infeasible.

The harness decides this with its own packer (`pack-feasibility.ts`), which
imports nothing and which no candidate may import. Returning an infeasible plan
is a hard failure, not a low score.

### The objective

For each target `T`, the plan produces a score

```
s_T = Q_T * (expected legendary crafts of T) + (direct legendary drops of T)
```

where `Q_T = -log(1 - legendaryCraftProbability(T))`, and the chance of landing
at least one legendary of `T` is `1 - exp(-s_T)`. Crafts are limited by the
ingredient conservation structure in the DAG: crafting a parent consumes its
children, and a fixed inventory of drops has to be split across whichever
targets want it. So the crafts themselves are the solution of an inner
allocation problem, not a closed form.

The objective is the **product** over targets:

```
maximise   prod_T (1 - exp(-s_T))
```

ALL-of, not ANY-of, deliberately: maximising ANY collapses onto whichever
target is cheapest. Equivalently, maximise `sum_T log(1 - exp(-s_T))`, which is
concave in `s` and is the form the incumbent solvers work in.

`src/oracle/evaluate.ts` is the harness's independent implementation of exactly
this, and is what scores you. It re-optimises the inner craft split for whatever
allocation you hand back, so you are never penalised for reporting a plan whose
craft accounting you did not work out yourself — hand back the allocation and
the judge will extract the best value it admits.

## Writing a candidate

1. Create `solvers/<your-id>.ts` exporting an `ArenaSolver`.
2. Register it in `registry.ts`.
3. Run `pnpm arena:check` — the independence guard — then `pnpm arena`.

```ts
import type { ArenaSolver, PlanProblem, PlanResult } from '../contract';

function plan(problem: PlanProblem): PlanResult {
  const allocation = new Array(problem.options.length).fill(0);
  // ... your methodology here ...
  return { allocation };
}

export const mySolver: ArenaSolver = {
  id: 'my-solver',
  description: 'one line for the scorecard',
  plan,
};
```

`solvers/optimizer-adapter.ts` is a worked example: it wraps the production
`optimizeFull` and maps its output back onto an allocation vector.

### Rules

- **Do not import the harness.** Not `evaluate.ts`, not `pack-feasibility.ts`,
  not `invariants.ts`, `harness.ts`, `instances.ts` or `scorecard.ts`.
  `independence.spec.ts` enforces this. Deriving your own copy of the objective
  or of a packing routine is fine and expected — sharing the harness's is not,
  because then the grader and the candidate are the same code.
- **Re-derive everything: no value import from `src/lib`.** `@/lib/lp`,
  `@/lib/value-function`, `@/lib/packing`, `@/lib/optimizer-core` and the rest
  are all off limits. `import type { LaunchOption, RecipeDAG } from '...'` is
  fine and is how you read the problem at all; the bare `lib` workspace package
  (egg, ship and artifact enums and tables) is game data rather than solver
  code and stays available.

  This is the point of the experiment. Calling into the incumbent's LP, tangent
  grid, packer or search would measure the incumbent's method wearing a
  different hat. Build your own — the objective is fully specified above and in
  `src/lib/OPTIMIZER.md`, and you are free to model it however your methodology
  wants. Reading `src/lib` for reference is encouraged; importing it is not.

  The two baselines are exempt because they *are* `src/lib` — they are the
  control, not entries.
- **Be deterministic.** Same problem in, same allocation out. If your method is
  stochastic, seed it from the problem, not from a clock or a global. B5 checks
  this, and non-determinism makes every other result unreproducible.
- **Do not read the seed, the instance label, or anything outside `PlanProblem`.**
  It is the whole input.
- **Do not mutate `problem`.** It is shared across the checks in a sweep.

### Self-reporting

`reported` is optional. Supplying it opts you into two extra checks:

- **C2-honesty** — your `jointProbability` must match what the judge computes
  for your own allocation. Failing this means your search is steering by a
  number that is not the objective.
- **C3-joint-product** — your `perTarget` factors must multiply to your
  `jointProbability`.

Omitting `reported` is legal and costs nothing else. Nothing you report is ever
used as your score.

## What gets measured

**Correctness**, as invariant violations. Every invariant is a property that
holds without knowing the optimum, so none of them needs a reference answer:

| group | asserts |
| --- | --- |
| **C0** contract | the returned allocation is the right shape, non-negative and integral |
| **C1** feasibility | the plan fits the fuel tank and packs into the slots |
| **C2/C3** honesty | what you report matches what you returned (opt-in) |
| **A** monotonicity | more fuel, more time, more ships, more inventory, more crafting level, less launch-period floor, or fewer targets can never make the answer worse |
| **B** invariance | shuffling the menu, reversing the target list, rescaling every fuel figure, duplicating an option, or simply running twice must not move the answer |
| **M** cross-path | the joint answer must not beat the product of per-target optima (M1), must not be beaten by a solo solve on a target it already covers (M2), and must not lose to the union of per-target plans on split budgets (M3) |
| **D** local optimality | no improving feasible 2-opt (D1) or 4-opt (D2) move exists over the plan's support |

**Quality**, as the judged joint probability on the unperturbed instance,
reported in log10 and compared head-to-head against the other entries. This is
the only relative measure; everything else is absolute.

**Latency**, as median/p90/max of a single solve.

### Comparisons are in log space

A four-target plan on a mediocre fleet lands around `1e-13`. The tolerance in
this harness is an absolute number of **nats** on `log(joint)`, so a drop from
`1e-13` to `1e-14` is 2.30 nats and reads exactly as loudly as `0.5 -> 0.05`.
Probability zero is `-Infinity`, so returning nothing where another solver
returns `1e-13` is a failure rather than a rounding artefact.

This matters more than it sounds. Under the relative-with-a-floor comparison
this harness originally used, 13 of the 40 sweep instances — including 10 of the
15 four-target ones — were silently skipped by every A, B and M check.

## Running it

```sh
pnpm arena                                  # smoke: 4 instances, whole roster
ARENA=sweep pnpm arena                      # 40 instances, cheap checks
ARENA=deep pnpm arena                       # + D1/D2 local optimality
SOLVER=my-solver ARENA=sweep pnpm arena     # one entry
ARENA_INSTANCES=80 ARENA_SEED_BASE=9000 ARENA=sweep pnpm arena
pnpm arena:check                            # independence guard only
```

Per-solver JSON lands in `results/<solver-id>.json`, which is gitignored — every
sweep rewrites it, so re-run rather than expecting a committed reference.

**Gating.** `C0-contract` and `C1-feasibility` hard-fail: a plan that is not a
plan is broken outright. Everything else is reported rather than thrown, because
no entry holds all of them yet and a suite that goes red for everyone measures
nothing. `ARENA_GATE=all` promotes the rest to failures.

**Cost.** A 40-instance cheap sweep is roughly 15-25 minutes per solver on this
container; the deep tier adds substantially more. Instances range from 63 to 285
options and from 1 to 4 targets.

**Validation bar.** A result is not durable until the full sweep has been re-run
three times fresh and compared per instance, not just on aggregate counts — a
stable total can hide one instance regressing while another improves.

## The baselines

| id | what it is |
| --- | --- |
| `baseline-main` | `src/lib/optimizer-core.ts` as shipped: LP relaxation, dominance-pruned integer search, packing, beam polish |
| `baseline-fixed` | the same with four ordering/seeding fixes from `optimizer-invariant-harness`: an intrinsic tie-break on option id, contention-band beam retention, reduced-cost-ranked adjacency candidates, and a forced alternate LP vertex |

Both are wrappers, not privileged: they go through the same `Planner` seam as
any candidate, and the harness does not know which entry is which. `baseline-fixed`
is vendored under `solvers/vendor/` rather than merged into `src/lib`, so this
branch changes no shipping code.

Neither is clean. Measured on the default 40-instance cheap sweep
(`ARENA=sweep pnpm arena`, seeds 2000-2039, this container):

| | `baseline-main` | `baseline-fixed` |
| --- | --- | --- |
| violations | 59 | 50 |
| clean instances | 11/40 | 15/40 |
| invariants firing | 11 | 10 |
| solve latency median / p90 / max | 77 / 262 / 356 ms | 156 / 493 / 1885 ms |
| sweep wall clock | 344 s | 950 s |
| mean log10(joint) | -6.488 | -6.481 |

Head-to-head on plan quality: `baseline-fixed` better on 19 instances, worse on
3, tied on 18; mean delta +0.0074 log10. It buys that with ~2.8x the runtime.

Per-invariant counts:

| invariant | main | fixed |
| --- | --- | --- |
| A3-menu | 19 | 12 |
| A2-time | 12 | 12 |
| A1-fuel | 8 | 9 |
| A5-effort | 6 | 7 |
| B1-option-order | 6 | 4 |
| A8-targets | 2 | 1 |
| M3-union | 2 | 2 |
| A7-crafting | 1 | 1 |
| B2-target-order | 1 | 1 |
| C2-honesty | 1 | 1 |
| B6-duplicate | 1 | 0 |

So there is a lot of room. A candidate that holds A1, A2, A3 and A5 is doing
something the incumbent method structurally cannot — those are the failures
that survived four separate root-cause fixes to the incumbent's ranking, beam,
candidate generation and LP seeding.

Some of these are severe rather than marginal: several A1/A5/A7/A8 violations
are `p->0` collapses, where relaxing a constraint drove the plan from a positive
probability to exactly zero. The scorecard counts those separately from finite
regressions, because averaging a collapse together with a 0.01-nat wobble hides
both.
