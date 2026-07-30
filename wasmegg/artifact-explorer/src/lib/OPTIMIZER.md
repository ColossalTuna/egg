# The Path of Virtue mission optimizer

Given a player's ships, a fuel budget and a per-slot time horizon, the optimizer
picks integer counts of each launch option so as to maximize the chance of
ending up with a legendary of every artifact the player selected.

The game runs three independent mission slots, so a plan is realizable only if
its mission durations pack into three bins of capacity `S`.

## The objective

Each selected target `T` has a linear score:

```
score_T = Q_T * crafts_T + lambda_T        Q_T = -log(1 - pCraftLegendary_T)
```

`crafts_T` is how many copies of `T` the inventory supports crafting, and
`lambda_T` is `T`'s expected direct legendary drop count from the plan's
missions. With that definition `1 - e^(-score_T)` is exactly
`P(at least one legendary T)`.

The search maximizes

```
F = sum_T g(score_T)        g(s) = log(1 - e^-s)
```

so `e^F` is exactly the joint probability of getting a legendary of *every*
selected target — the number the UI reports as the headline for a multi-target
plan.

### A single target is not a special case

There is no separate single-target objective, and no weighted-sum mode. `g` is
strictly increasing, so with one target `argmax F = argmax score_1`. Maximizing
a plain weighted-sum score *is* this problem with one term. The same code path
runs at every target count.

Everything the search does — dominance pruning, the LP relaxation, the ternary
scans, greedy repair — needs only that `F` is concave and non-decreasing in
inventory. Each `score_T` is concave and non-decreasing, `g` is concave and
non-decreasing, a non-decreasing concave function of such an argument stays
concave and non-decreasing, and a sum of those keeps both properties. None of
that machinery cares how many terms it is climbing.

### Convergence is measured in probability space

`F` is a log-probability, so `F <= 0` and a *relative* gap on `F` would be
meaningless. Every convergence test is stated in probability space, where
`P = e^F`: `relativeProbGap(upper, best) = 1 - e^(best - upper)` is the relative
probability shortfall of settling for `best`.

One consequence worth knowing: `g` flattens as `score_T` grows
(`g'(s) = 1/(e^s - 1)`), so once a target is all but certain the search stops
distinguishing plans that differ only in how much further they overshoot it.
That is correct behaviour — at `P_T = 0.999` the next craft buys nearly nothing,
and with several targets that budget belongs to whichever one is still short —
but it does mean near-saturated instances settle for any plan inside the epsilon
band rather than the score-maximal one.

## The tangent epigraph LP

`sum_T g(score_T)` is not linear, but `g` is concave, so every tangent line to
`g` lies on or above it, with equality at the tangent point. Introducing one
epigraph variable `z_T` per target with a row

```
z_T <= alpha_k + beta_k * score_T
```

for each breakpoint `k` turns "maximize `sum_T g(score_T)`" into a linear
program: the LP drives each `z_T` up to `min_k(...)`, the tightest bound the
chosen breakpoints allow.

`JOINT_TANGENT_BREAKPOINTS` is the fixed grid of tangent points. It is spaced to
roughly equalize the envelope's probability-space slack over `s` in
`[0.05, 40]`; `g` is nearly flat above `s ~ 4`, so three points cover the tail.
The grid is deliberately small: every row is re-solved millions of times per run
(see `optimizer-perf.spec.ts`).

`EPIGRAPH_SHIFT` exists because `g(s) < 0` for `s < ln 2`, so `z_T` can be
negative, while the LP solver in `lp.ts` assumes `x >= 0`. Shifting every
epigraph row's RHS up by a constant keeps `z_T` positive without changing the
argmax; the objective has `targets.length * EPIGRAPH_SHIFT` subtracted back out
before being returned. Anything building its own epigraph rows — the outer LP
relaxation in `optimizer-core.ts` does — must subtract it too.

### Why the over-estimate is safe

The envelope is an *upper* bound on `g`, so the tangent LP always slightly
**over-estimates** the true joint objective.

This is safe because the approximation is used **only for search ranking and
pruning**. The final numbers the UI reports are never read off it. They are
computed exactly: `alphaToProb` converts each target's craft count and drop rate
into that target's probability, and those are multiplied to get the joint
probability. If you change anything about the tangent grid, this is the property
to preserve — an over-estimate reorders candidates slightly, whereas letting the
approximation leak into reporting would make the tool lie.

### Recovering the exact craft split

The tangent grid starts at `s = 0.05`, and below that its nearest-tangent
approximation of `g` is poor. The split it recovers is therefore biased whenever
a target lands on a tiny craft count — fine for ranking, not acceptable for
reporting.

So the tangent-LP split is used only as a seed. `refineJointCraftSplit`
(`value-function.ts`) then recovers the split that maximizes the *exact* concave
objective `sum_T g(Q_T*craft_T + lambda_T)` at the final chosen inventory, over
the recipe's craft-conservation polytope, by **Frank-Wolfe with an exact line
search**: linearize `g` at the current scores (`weight_T = g'(score_T) * Q_T`,
by the chain rule), maximize the resulting weighted-sum craft LP — the ordinary
`compileInnerLp`, compiled once and re-aimed through `solve`'s weights
argument, its polytope being the same one — and golden-section search along
the segment from the current point to that vertex. Each iterate's true objective
is non-decreasing and the iteration converges to the polytope optimum. This runs
once per returned solution, never in the search loop.

## Search structure

`optimizeFull` solves twice and repairs:

- a **relaxed** solve over `3S` aggregate time, giving an upper bound `U` plus a
  candidate allocation that may not be three-bin packable;
- a **floor** solve over `R/3` fuel and `S` time, tripled — three identical
  single-slot plans, always packable.

Both are then run through `packAndFill` (best-fit-decreasing into three slots,
drop the spillover, greedily fill the remaining time), alongside a greedy build
from empty slots. If the best packable plan still trails `U` by more than
epsilon, `escalatePacking` seeds one slot full of each LP-support option and
re-fills, exploring per-slot specializations the balanced relaxation misses.

`coreSearch` is the single-time-budget integer search inside each of those:

1. **Dominance pruning.** `j` dominates `i` when it costs no more on either
   budget and yields at least as much of everything, strictly better somewhere.
   Yields are compared pointwise rather than by solo score, so complementary
   options survive — the only good source of some ingredient must not be pruned
   for having a poor standalone score. "Everything" includes each target's
   direct legendary drops compared *per target*, never pooled: an option
   dropping more of target A's legendary and less of target B's dominates
   neither. Only search targets are compared, since they are the only nodes
   whose legendary rate reaches the objective.
2. **Single-option sweep**, which also records each option's solo score for the
   triple scan's ranking.
3. **LP relaxation** (`solveRelaxationLp`), giving the upper bound `U` and the
   support set. It carries the same tangent rows as the inner LP, except that
   here `lambda_T` is itself a linear combination of the option-count variables
   rather than a precomputed constant, which is why it is built directly instead
   of reusing the inner LP's fixed matrix.
4. **Dual filter.** An option's reduced cost at the LP optimum bounds how much
   `F` the relaxation would give up if forced to include it; half the epsilon
   budget is allowed to go that way. This is deliberately aggressive and does
   discard cheap budget-filler options — greedy repair re-admits those from the
   full list.
5. **Pair scans** over all survivors, then **triple scans** if the gap is still
   wide. The triple scan costs an order of magnitude more probes per tuple, so
   its pool is capped: the LP support first (complementary options with poor
   standalone scores live there), then the top-K by solo score.
6. **Greedy repair** from the best allocation and again from the floor-rounded
   LP solution, keeping whichever start ends up better.

Both scans are nested integer ternary searches, valid because the score is
concave in each multiplicity.

## The worker boundary

The search runs off the main thread (`optimizer.worker.ts`). A single-target
plan solves in well under 100ms, but a multi-target joint search runs in
seconds; on the main thread that would block paint.

**Launch-option enumeration stays on the main thread.** It is the only step that
needs the ~18MB loot dataset, and the main bundle already loads that dataset for
the mission views — enumerating in the worker would put a second copy in the
worker bundle. For the same reason `optimizer.worker.ts` imports `optimizeFull`
directly rather than through the `lib` barrel, which re-exports the loot data.

`optimizer-worker-protocol.ts` exists because structured clone preserves Maps
and plain objects but **drops prototypes**. Every payload is plain data except
`ship`, a `MissionType` whose entire API is getters over two numeric fields; a
cloned copy would arrive with the fields intact and every getter gone, failing
far away from the boundary in whatever template reads `ship.shipName`. So the
ship is explicitly narrowed to its two fields on the way out and reconstructed
on the way in.

`optimizer-client.ts` reuses one worker across runs, replacing it only if it
dies, and numbers requests so that only the newest one's result is delivered —
with auto-compute on, a burst of input changes queues several solves and every
result but the last describes settings the user has already moved past. A
superseded (or torn-down) request resolves with `null`, which callers read as
"no result is coming, leave state alone".

Presentation-only fields (`expectedDrops`, `fuelByEgg`, sorted `choiceHistory`)
are filled in by `finalizeSolutions` on the main thread. The client applies it
to every reply before resolving, so the worker path and the synchronous
`optimize()` hand back identical solutions and no caller has to remember the
step.

## Previous crafts

A target's `legendaryCraftProbability` depends on how many times the player has
already crafted it. With a save loaded, each target uses **its own** crafted
count from the inventory. A manual override applies to **every** target.
`buildRecipeDag` implements this by treating an undefined `previousCraftsOverride`
as "read per-target".

## Owned inventory

`computeBaseYield` counts the player's stock across all rarities, because any
rarity can be fed to a recipe. This is "how many copies you can feed a recipe",
never "you already own a legendary" — the legendary side of the objective comes
solely from mission drops.

A target is skipped only when nothing in the DAG consumes it. Such a node has no
conservation row in the inner LP, so owned copies could never be spent and would
only look like free progress. A target that *is* an ingredient of another target
— which covers 21 of the 22 selectable legendaries — keeps its stock, which can
only relax the consumption side of its row.

## Per-target display attribution

For a multi-target solution the LP crafts a shared component once and splits it
across the targets that consume it, so `craftPrimal` / `finalYieldVector` are
solution-wide pooled totals. `computeCraftChainTree` attributes each node's
pooled crafted/dropped/consumed/owned to a target in proportion to that target's
share of total recursive demand for the node, so the per-target breakdowns sum
back to the pooled totals instead of showing each artifact "using" the whole
pool. The root target itself is never scaled: every craft of it rolls for its
own legendary. With a single target every share is 1.

## File map

| File | Role |
| --- | --- |
| `optimizer-core.ts` | The outer search: pruning, LP relaxation, pair/triple scans, packing, repair. `optimizeFull` is the entry point. |
| `value-function.ts` | `buildConservationPolytope` (the recipe-conservation rows every LP here is built on), the inner crafting LPs, the tangent epigraph construction, `alphaToProb`, and `refineJointCraftSplit`. |
| `lp.ts` | Small dense-tableau simplex with Bland's rule, tuned for many small re-solves. |
| `phases.ts` | Recipe DAG construction and launch-option enumeration from loot data. |
| `index.ts` | Pipeline glue: `buildRecipeDag`, `computeBaseYield`, synchronous `optimize`. |
| `optimizer.worker.ts` | Worker entry point; runs `optimizeFull` only. |
| `optimizer-worker-protocol.ts` | Wire types and `MissionType` narrow/reconstruct across structured clone. |
| `optimizer-client.ts` | Main-thread worker lifecycle, request numbering, supersession, and finalization of replies. |
| `optimizer-tree.ts` | Recipe-tree builders for the inventory and craft-chain panels. |
| `optimizer-views.ts` | Flat presentation helpers derived from a solution, including `artifactDisplay` and `finalizeSolutions`. |
| `types.ts` | Shared types for all of the above. |
| `../oracle/` | Brute-force correctness harness; see its own README. |
| `../components/ArtifactMissionOptimizer.vue` | Top-level planner: assembles inputs, drives the worker, debounces auto-compute. |
| `../components/optimizer/` | Sidebar, solution card, probability breakdown, tree rows. |

## The oracle

`src/oracle/` is an independent correctness harness that treats `optimizeFull`
as a black box: nothing in it imports the solver's internals, the three-slot
packing check is re-derived, and the objective is re-derived from this document
rather than from `value-function.ts`. It checks feasibility, honesty (the
reported probability matches an independent re-evaluation) and optimality
(no enumerated feasible allocation beats the plan by more than the tolerance).

Its joint evaluator solves the true objective directly — no LP relaxation, no
tangent lines — via **away-step Frank-Wolfe** over the craft polytope, so it can
catch bugs in the tangent approximation instead of repeating its logic. Away
steps rather than plain Frank-Wolfe because plain FW converges at `O(1/k)` and
zig-zags badly when the optimum lies in the interior of a polytope face, which
happens whenever one target is another's ingredient; retreating from the worst
active vertex restores effectively linear convergence. The iteration is seeded
at the centroid of the per-target max-craft vertices rather than an LP vertex,
because a vertex seed leaves `n-1` targets at zero crafts where `g(0) = -Infinity`
pins the line search.

See `src/oracle/README.md` for how to run it and what the tunables mean.

## Known accuracy limits

Both of the following are long-standing and are asserted by tests, not bugs
awaiting a fix.

- **Tangent envelope slack.** The worst-case over-estimate at the breakpoint
  midpoints is ~5.4e-3 in probability space (at `s = 0.55`), against the 1e-2
  bound `joint-objective.spec.ts` asserts; over the whole `[0.05, 30]` band it
  reaches ~7.9e-3. Below the first breakpoint (`s < 0.05`) the error is larger —
  ~1.8e-2 in probability space at `s = 0.001` — which is exactly why the final
  split is refined off-grid.
- **Oracle deep fuzz, seed 1019, family `cheap-filler`, single target.** The
  solver reports 0.055312 against a brute-force 0.056447: a 1.14e-3 gap against
  a 1e-3 tolerance, about 2% relative. This predates multi-target work and is a
  known limitation of the heuristic search, not a regression.

## Tests are local-only

Nothing in `.github/workflows/` runs the test suite — CI only builds. Every spec
in `src/lib/` and `src/oracle/`, including the latency caps in
`optimizer-perf.spec.ts`, is a local development tool. Run them yourself:

```sh
pnpm exec vitest run src/    # unit + smoke oracle
pnpm test:oracle             # + deep oracle campaign
RUN_PERF=1 pnpm exec vitest run src/lib/optimizer-perf.spec.ts
```

A perf cap failing on your machine means your machine, not necessarily a
regression; the caps are calibrated against a reference machine and documented
in that spec.
