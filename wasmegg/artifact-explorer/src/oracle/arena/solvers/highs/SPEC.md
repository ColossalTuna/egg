# highs: the plan as a mixed-integer program

**The shipped planner**, and the arena's only registered entry (see
`../../ARENA.md` for the rules) — one module, not two: `src/lib/optimizer-core.ts`
imports this directory, so the solver users run is the solver the invariant
harness measures. The methodology is to stop searching and start *stating*: write the whole problem —
mission counts per slot, crafts as flow over the conservation polytope, fuel,
packing — as a single mixed-integer program, hand it to a branch-and-bound
solver that has had two decades of work put into it, and take back the answer.

The objective is not linear, so the one thing that cannot be stated directly is
`log(1 - e^-s)`. That is handled by outer approximation: hold each target's
contribution under a family of tangents, solve the resulting MILP exactly, add
tangents where the answer landed, repeat. Every model in the sequence
over-estimates, so its optimum is an upper bound on the true one.

The build is `highs` (lovasoa/highs-js), HiGHS compiled to WebAssembly, spoken
to in LP-format text. That is the only build that could ship: `artifact-explorer`
is a browser app and a native addon cannot go there. A `highs-native` entry
(`highs-addon`, typed arrays over a worker-thread bridge) existed to price what
the text interface costs, and answered the question — LP-text marshalling is
75-85% of a *continuous* call but under 5% of an expensive MILP one, so the thing
it removed was never the expensive part. It has been removed along with the
seam that let two builds coexist.

Everything is deterministic: no `Math.random`, no `Date.now`, no env reads, and
in particular **no wall-clock solver budget** — not in the arena and not in the
app. The search is bounded by node counts and a relative MIP gap, which are
reproducible; a time limit would make the returned plan a function of how loaded
the machine was, and the sidebar's search-effort control would be a knob that
silently lies.

## Module layout

```
solvers/common/
  model.ts                 # restricted DAG, normalized budgets, merged option groups
  evaluator.ts             # judge-equivalent value of an integer allocation
  simplex.ts               # the LP the evaluator prices craft splits with
  memo.ts                  # plan-level memoization on PlanProblem content
solvers/highs/
  solver.ts                # the MILP seam: model, limits, solution, options
  milp.ts                  # the model itself — columns, rows, cuts, decode
  oa.ts                    # the outer-approximation loop
  highs.ts                 # the wasm loader, and the LP text either way through it
  index.ts                 # the registered entry
  SPEC.md                  # this file
```

No harness imports and no value imports from `src/lib`; `arena:check` enforces
both, one way only. The dependency runs the other way — `src/lib/optimizer-core.ts`
imports this directory — which is what makes the shipped planner and the measured
one the same code. Closing that loop would make the app grade itself.

## 1. Preprocessing

`common/model.ts`, unchanged: downward closure of the targets, one row per
consumed item, fuel normalized to a budget of 1, options that cannot fit a slot
or carry nothing useful dropped, exact duplicates merged into groups under a
numeric canonical key, per-group count caps. Menu order and injected duplicates
are structurally inert (B1, B6) and fuel rescaling is exact rather than
tolerated (B3), because the model never sees the raw menu.

## 2. Columns

| column | count | type | meaning |
| --- | --- | --- | --- |
| `n[g][k]` | groups x slots | integer | missions of group `g` launched into slot `k` |
| `N[g]` | groups | continuous | the same missions summed over slots |
| `c[p]` | craftables | continuous | crafts of node `p` |
| `sigma[t]` | targets | continuous | target `t`'s score, in units of `theta_t` |
| `z[t]` | targets | continuous | the stand-in for `g(s_t)`; objective coefficient 1 |

`N[g]` is redundant as modelling — it is pinned to the `n` columns by one row
each — and load-bearing as arithmetic. Every row that does not care *which* slot
a mission went into (conservation, scores, fuel) reads `N` rather than the three
`n` columns, which takes those rows from `3G` nonzeros to `G`. On the widest
instances in the sweep that is a 35k-nonzero matrix against a 12k one, and it is
worth about a third of the wall clock: the LP relaxation, not the branching, is
where this candidate's time goes (section 7).

`c` stays continuous deliberately. The judge re-optimises the craft split as an
LP for whatever allocation it is handed, so integralising crafts here would be
optimising a different objective from the one being graded.

`z` is bounded above by 0 before any cut is added, because `g(s) = log(1 - e^-s)`
is the log of a probability.

## 3. Rows

```
aggregation      N_g - sum_k n_{g,k}                              =  0
conservation_i   sum_p cons[i][p] c_p - sum_g yield_g[i] N_g     <=  baseB_i
score_t          theta_t sigma_t - Q_t c_{target t}
                                 - sum_g leg_g[t] N_g             =  0
fuel             sum_g fuel_g N_g                                <=  1
slot_k           sum_g seconds_g n_{g,k}                         <=  timeCapacity
order_k          sum_g seconds_g (n_{g,k} - n_{g,k+1})           >=  0
cut(t, a)        z_t - theta_t g'(theta_t a) sigma_t             <=  g(theta_t a)
                                                                     - theta_t g'(theta_t a) a
```

Two of these are the reason to reach for a MILP at all.

**`slot_k` is the packing constraint, stated.** Not a volume bound on the total
that a repair pass has to make true afterwards — three rows, one per slot,
saying exactly what the game says. A plan that solves this model packs by
construction. That is the constraint `ARENA.md` warns is "a genuine 3-way bin
packing, not a check that the total fits in `3 * timeCapacity`", and it is the
one a relaxation cannot see: a retired `lp-truncate` entry, which floored the
relaxation and stopped, existed to measure exactly that gap.

The rows are in raw seconds rather than normalized, which is not cosmetic. HiGHS
accepts an integer solution violating a row by up to `mip_feasibility_tolerance`,
which is absolute on the row activity; a normalized row would license overfilling
a slot by that fraction of the entire horizon — seconds of it on a month-long
budget — while the judge's packer works to 1e-9 absolute seconds. Stating the
row in the judge's units puts the two tolerances on the same scale. The
tolerance itself is then pinned to 1e-9 in `SOLVER_OPTIONS`, three orders below
HiGHS's default, for the same reason: C1 is a hard arena failure, not a
difference of opinion about rounding.

**`score_t` makes the craft split part of the same optimisation.** The
incumbent chooses missions against a tangent-linearized value and works out the
crafts afterwards; here the conservation polytope and the mission counts are in
one matrix, and the solver trades a mission for a craft directly.

`order_k` breaks the slot symmetry. Without it every plan appears `slots!` times
and the tree spends its budget rediscovering relabellings.

### Row scaling, and the two entries HiGHS refuses

HiGHS discards any matrix entry at or below `small_matrix_value` — default 1e-9
— while *ingesting* a model. A discarded entry does not weaken a row, it deletes
a term: lose the coefficients from the fuel row and the fuel budget stops
existing, and nothing anywhere says so.

Fuel costs are normalized by the tank, and the smallest across the 40 sweep
instances is **2e-8**. A1-fuel doubles the tank as one of its perturbations,
which halves that. Ten times the filter is not a margin, and a different seed
base is not obliged to stay there.

The option is not the fix: the wasm build's `solve(text, options)` reads the
model *before* it applies any option (quoted in `highs.ts`), so
`small_matrix_value` is set too late to affect the ingestion it governs.

So `Rows.end` scales instead. Multiplying a row and its bounds by a positive
constant leaves the feasible set exactly unchanged, so any row carrying an entry
within `SAFE_COEFFICIENT` (1e-6) of the filter is scaled until its smallest
entry is 1. Rows already clear of it are untouched — the slot rows in
particular, whose units were picked to line up with the judge's packer and which
would lose that if rescaled. Measured: identical plans on every one of seeds
2000-2011 before and after, which is what an exact transformation should do.

**And then there is the other end of the window, which that scaling can walk you
straight into.** HiGHS also refuses any entry above `large_matrix_value`
(default 1e15) — not silently this time, but by rejecting the model outright:
`Unable to read LP model ... HiGHS error -1` out of the reader, which surfaces in
the app as a plan that could not be computed at all.

A tangent cut placed deep in the grid can have a slope ratio of ~1e17 between its
two coefficients. Normalizing the small side to 1 then puts the other at
**2.8e16**, and the model becomes unreadable. This was not hypothetical and it
was not caught by the arena: it took making this the production planner and
running the app's own unit tests, because the instance that triggers it is a
two-target toy with 60 fuel, not anything the sweep generates.

So the scale is the *smaller* of "enough to clear the bottom" and "as much as the
top allows" — `min(1/smallest, SAFE_LARGE_COEFFICIENT/largest)` with
`SAFE_LARGE_COEFFICIENT` at 1e12, the same 1000x margin `SAFE_COEFFICIENT` keeps
below 1e-9. Every row that already fits is untouched, which is why the sweep
after this change reproduces the one before it to the unit (section 9). A row
whose own dynamic range is wider than the window still cannot be made to fit;
the least bad answer is to keep its large entries readable, and
`src/lib/optimizer-plan.spec.ts` asserts the property — every emitted entry
inside [1e-9, 1e15] — rather than the instance.

## 4. Scaling: why `sigma` and not `s`

The arena scores in a regime where `s ~ 1e-13`, and `g'(s) ~ 1/s`. Tangent cuts
written directly in `s` therefore carry slopes around `1e13`, which is a matrix
no amount of solver quality rescues.

So every target is measured in units of its own ceiling. `theta_t` is the
largest score target `t` can reach when every other target is ignored and the
counts are allowed to be fractional — one continuous LP per target, solved by the
same backend (`buildScaleLp`). Then `sigma_t = s_t / theta_t` lies in `[0, 1]`
for every feasible plan, and a tangent at `sigma = a` has slope `1/a` rather than
`1/s`. With the initial grid bottoming out at `1e-7`, its coefficients stay
under `1e7`.

`theta_t <= 0` for any target means no allocation scores that target at all, so
the joint probability is zero for every plan and the empty one is as good as any.
That is returned directly.

Refinement cuts may go deeper than the grid, down to `sigma = 1e-12`, so the
largest coefficient the matrix can carry is around `1e12`. That is well inside
HiGHS's `large_matrix_value` (1e15) but it is the top of the range, and it is
the reason the floor is a constant rather than "as deep as the search asks".

A `sigma_t` of exactly zero produces no cut, because there is no tangent at
zero: when the model wants to abandon a target outright, the deepest existing
cut is what prices that decision, and refinement has nothing to add. The grid's
`1e-7` point is therefore load-bearing rather than decorative.

### The scale LP has to shout to be heard

There is a trap in computing `theta` this way, and it cost a whole instance
before it was found.

Every other objective in this candidate is O(1) — the OA MILP maximizes a sum of
log-probabilities, around -16 in the regime the arena scores in. The scale LP is
the exception: what it maximizes is a *raw* score, and raw scores here run to
1e-7 and below. HiGHS's `dual_feasibility_tolerance` is absolute on reduced
costs, so at that magnitude every reduced cost at the all-zero vertex is inside
tolerance and HiGHS reports **optimal at zero** — confidently, with no warning —
while a feasible point three decades better sits in the same polytope.

A zero `theta` reads as "this target is unreachable", so the candidate returned
an *empty plan*. Measured on seed 2028: pinning the mission counts to a
known-good plan gives `sigma = 1.28e-7`; leaving them free gives 0. That was the
one instance in the first full sweep where this entry scored zero and
`baseline-main` scored 1.6e-14 — an infinite loss in log space, from a
tolerance.

The fix is structural rather than a looser bound: the scale LP's objective
column carries a weight of `1e9` (`SCALE_LP_OBJECTIVE`). Scaling an objective
does not move its argmax, and `theta` is read off the *column* rather than the
objective value, so this costs nothing and multiplies every reduced cost by 1e9.
`dual_feasibility_tolerance` is tightened one order alongside it, and only one:
at HiGHS's documented minimum of 1e-10 the simplex fails outright on the wider
instances, returning `HiGHS error -1` from `Highs_run`.

After the fix, seed 2028 returns 1.643e-14 against the baseline's 1.643e-14 —
an exact tie where there had been an infinite loss.

### One deviation, flagged

`common/evaluator.ts` exports `gPrime`, which clamps at `1e12` so the judge's
Frank-Wolfe linearizations stay finite. The cut generator here does **not** use
it, and computes `1 / expm1(s)` uncapped instead. Reusing the clamp would be a
bug rather than a shortcut: at `s ~ 1e-13` the clamp is active at every tangent
point at once, so every cut would come back with the identical slope and the
outer approximation would carry no curvature at all.

`Q = -log(1 - p)` is `+Infinity` when a craft is certain. Infinity cannot enter a
matrix, so certainty is proxied by `Q = 1e4`, large enough that one craft
saturates `g` to every bit of a double. The judge still sees the real Infinity;
the proxy only steers.

## 5. The loop

```
theta   <- one LP per target
cuts    <- log-spaced grid, 15 points per target, 1 down to 1e-7
best    <- the empty plan

repeat maxRounds times:
    solve the MILP under the current cuts
    counts  <- round the n columns, sum over slots
    repair(counts)                       # see section 6
    value   <- common/evaluator on counts
    keep counts if value beats best
    stop if the MILP was proven optimal and its bound is within 1e-6 nats of best
    add a cut per target where the MILP thinks the plan landed
    add a cut per target where it actually landed
    stop if neither added anything new
```

The grid is log-spaced because the scores span thirteen decades; a linear grid
would put every point in a regime no plan reaches.

Refining at *both* points matters. The MILP's own `sigma*` is where the outer
approximation is loose, which is what makes the next bound tighter; the judged
score is where the plan really is, which is the value the next round has to beat.

What the loop returns is the best judged iterate, never the last one. Every
incumbent is scored by `common/evaluator`, the same re-derivation of the
objective the other candidates use, so the linearized model steers and the real
objective decides. The outer approximation never grades itself.

## 6. Decode and certify

Counts come out of the `n` columns rounded and summed over slots. Both budgets
are constraints of the model, so a decoded plan is feasible by construction, and
`certifies` says so out loud rather than assuming it: it re-checks the fuel row
against the rounded counts and reads the three slot loads straight off the MILP's
own columns — the packing witness the sum-over-slots threw away. An incumbent
that fails is dropped, not patched; the caller keeps the previous judged plan,
and the worst case is the empty plan, which is feasible and honest.

It used to be a `repair` loop that dropped the costliest mission until the fuel
row held, then the longest until a packer agreed. That loop was measured never to
fire — 40 instances, 105 refinement rounds, zero firings — and it was a hazard
while it sat there: its packing test was a *node-capped* search, so an
`undecided` verdict from exhaustion was indistinguishable from real
infeasibility, and the response to it was to start deleting missions from a sound
plan. A count-based cutoff wired to a destructive edit is the exact shape this
arena keeps showing breaks the A and B families.

The self-report (`reported`) is the exact-precision evaluation of the returned
counts, opting both entries into C2-honesty and C3-joint-product.

## 7. What the budget is worth, and where the time actually goes

The two levers are `maxRounds` and `maxNodes`. On seeds 2000-2011:

| rounds, nodes | median solve | max solve | mean delta vs `baseline-main` | better / worse |
| --- | --- | --- | --- | --- |
| 1, 1 | 564 ms | 1302 ms | +0.1164 | 9 / 2 |
| 2, 30 | 706 ms | 3851 ms | +0.1206 | 9 / 1 |
| 3, 30 | 1329 ms | 3807 ms | +0.1214 | 10 / 0 |
| 3, 150 | 1366 ms | 3938 ms | +0.1214 | 10 / 0 |
| 4, 600 | 1917 ms | 5759 ms | +0.1214 | 10 / 0 |
| 5, 4000 | 4925 ms | 12917 ms | +0.1214 | 10 / 0 |

(Deltas in log10; the first two rows predate the `N[g]` aggregation and so
overstate their own wall clock.)

The plan is **identical** from 30 nodes to 4000 on those instances, and the third
refinement round is the last one that ever moves an answer.

Over all 40 instances the picture is a cliff and then a plateau, and the plateau
starts much earlier than the table above suggested. Full sweeps, with the
invariant checks, are the bottom three rows; the top two are solve-only probes:

| rounds, nodes | median | p90 | max | violations | clean | worst A3 | mean log10(joint) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1, 0 | 46 ms | 82 ms | 130 ms | — | — | — | **p = 0 on 39/39** |
| 1, 50 | 658 ms | 1586 ms | 2487 ms | — | — | — | -6.7778 |
| **2, 5** | **1090 ms** | **2738 ms** | **3727 ms** | **63** | **23/40** | 0.1951 | **-6.775** |
| 2, 50 | 1208 ms | 2987 ms | 4064 ms | 62 | 24/40 | 0.2410 | -6.774 |
| 3, 200 | 2103 ms | 4814 ms | 5989 ms | 55 | 22/40 | 0.0790 | -6.771 |

Four things this settles.

**Branching is not optional.** `maxNodes: 0` returns probability zero on *every*
instance, even at `mip_heuristic_effort: 1.0` — the root heuristics never find an
incumbent — so the 46 ms floor is not a mode anyone can ship.

**`{2,5}` and `{2,50}` are near-identical solvers.** 36 of 40 plans come out
identical; the violation delta is eight instances moving in both directions for a
net of one; the node budget costs 11% of the wall clock to achieve that. Between
those two, take the cheap one.

**Quality is flat across the whole table.** The three swept means sit inside
0.004 log10 of each other. Nothing here is a quality decision.

**What the extra rounds buy is monotonicity.** Going from three rounds to two
roughly triples the worst-case violation magnitude (A3-menu 0.0790 -> 0.1951
nats) while leaving the count and the quality broadly alone. The likely mechanism
— stated as a hypothesis, not a finding — is that refinement cuts are placed
where the *previous* round landed, so a second round re-linearizes around a
budget-dependent point and amplifies path dependence, which a third round damps
by converging.

The default is **`maxRounds: 2, maxNodes: 5`** (`DEFAULT_TUNING` in `oa.ts`, and
what ships): the cheap end of the two-round plateau, chosen for the instances
real players bring rather than for the arena's uniform-random tail. Both budgets
are counts rather than a number of seconds, for the determinism reason at the top
of this file — a wall clock would make the plan a function of machine load.

The residual A/B violations are bought here and nowhere else. Real harness checks
at `maxNodes: 5000` over the 18 instances carrying every violation take them from
**55 to 8**, and 0/18 clean to 12/18, worst magnitude 0.0790 -> 0.0065 nats. That
is the confirmation that the truncated tree is the cause — and also why raising
the cap is not the fix: it costs 7x the wall clock and provokes `HiGHS error -1`
on two instances.

What is emphatically *not* true is that the budget is therefore free. The first
few dozen nodes cost nearly the whole solve; they simply stop paying after that.
Measured on the real MILP the loop builds for seed 2011 (953 columns, 684 of
them integer, 353 rows):

| | wall clock | status |
| --- | --- | --- |
| the same matrix as a pure LP | 18 ms | optimal |
| MILP, root only (`mip_max_nodes=0`) | 39 ms | node limit |
| MILP, 30 nodes | 1410 ms | node limit |
| MILP, 200 nodes | 1794 ms | **optimal** |
| MILP, 5000 nodes | 1837 ms | optimal |
| MILP, integrality on `N[g]` only | 433 ms | optimal |

Two things fall out of that table, and section 7's title is only half right.

**The integer search is where the time goes** — 18 ms to 1794 ms on the same
matrix, a factor of 100 — even though the tree is inert past 30 nodes. Inert
is not the same as absent: the nodes are bought and paid for, they just stop
changing the answer early. `mip_heuristic_effort: 0` recovers nothing (1799 ms
against 1802 ms), so this is branching, not HiGHS's primal heuristics.

**The three-fold slot symmetry is the largest single driver.** Moving
integrality from the 684 per-slot columns onto the 228 aggregate `N[g]` columns
takes the same instance from 1794 ms to 433 ms. That is a real 4x, and it is not
available: aggregate integrality is precisely the model that cannot see the
packing, and stating the packing is what section 9's collapse-free scorecard is
bought with. `order_k` breaks the
symmetry on aggregate slot *load*; it does not break it on which group lands
where, and that residue is what the tree pays for.

## 8. The backend

`solver.ts` is the whole interface: a matrix, a node budget and a gap, a
solution.

**`highs.ts`.** The wasm module exposes one entry point taking a model in CPLEX
LP format, so every solve serializes the matrix to text and has HiGHS parse it
back — and then hands the answer back the same way, via
`Highs_writeSolutionPretty` into an in-memory file that JS parses line by line,
one line per column. The loader is async and `Planner` is not, so `loadHighs()`
returns a promise the arena entry awaits at import time and the app awaits per
solve; nothing is stateful across solves.

Asset resolution is why this is a loader function rather than a bare import.
Left alone, the Emscripten glue looks for `highs.wasm` beside itself, which is
right under Node and wrong inside a bundled worker; handing it the URL from
`import wasmUrl from 'highs/runtime?url'` lets Vite emit and fingerprint the file
like any other asset. Under Node that URL arrives as a `/@fs/...` dev path and
the prefix has to come back off before the loader reads from disk. One module
serves both, so there is no second binding to drift.

That round trip is **not** where this candidate's wall clock goes. Building the
LP text in JS is 0.1-1.2 ms even on the widest instance. Ingestion plus solution
round trip is 12-35 ms per call, which is 75-85% of a *continuous* solve (a scale
LP is 7-17 ms of which only 1-5 ms is simplex) and under 5% of an expensive MILP
one. On a typical plan it is somewhere around a twentieth of the total.
Everything else is branch-and-bound, and branch-and-bound costs the same shape
natively — which is what the retired `highs-native` entry was there to establish,
and did.

One trap, worth recording because it is silent: the solution's `Index` field is
the column's position *in the LP file*, which is the order the reader first saw
it, not the order the model built its columns in. Mapping through `Index`
type-checks, runs, and reads the wrong columns. Map through the name.

### The retired native entry, and the environment note behind it

`highs-addon` ships prebuilt binaries for darwin-arm64, linux-x64 and
linux-arm64 (glibc and musl), and builds from source otherwise. Every published
prebuild links `GLIBCXX_3.4.30`, i.e. GCC 12 or newer. This container carries
RHEL 9.7's libstdc++ 3.4.29 and has no compiler or CMake for the source fallback,
so the entry threw on every instance here and its column was always empty. It is
recorded because the same wall would be hit again by anyone reaching for a native
solver in this repo, and because the question it was asked — how much does the
text interface cost — has an answer now.

## 9. Measured

Two full cheap sweeps, seeds 2000-2039, this container, at the shipped
`{maxRounds: 2, maxNodes: 5}`. The second was run after the
`SAFE_LARGE_COEFFICIENT` fix in section 3 and **reproduces the first to the
unit** — same violation count, same clean count, same per-invariant counts, same
worst magnitudes — which is what says that fix only touches rows that would
otherwise have made the model unreadable.

| | run 1 | run 2 |
| --- | --- | --- |
| violations | 63 | 63 |
| clean instances | 23/40 | 23/40 |
| invariants firing | 5 | 5 |
| `p -> 0` / `0 -> p` collapses | **0** | **0** |
| worst finite violation | 0.1951 nats | 0.1951 nats |
| solve latency median / p90 / max | 1090 / 2738 / 3727 ms | 1093 / 2756 / 3745 ms |
| sweep wall clock | 2228 s | 2223 s |
| mean log10(joint) | -6.775 | -6.775 |

| invariant | count | instances | worst finite |
| --- | --- | --- | --- |
| A3-menu | 39 | 13 | 0.1951 nats |
| B2-target-order | 11 | 11 | 0.1620 nats |
| A5-effort | 8 | 7 | -0.0366 nats |
| A1-fuel | 4 | 4 | -0.0148 nats |
| A2-time | 1 | 1 | -0.0595 nats |

**Five invariants fire and eight do not.** `A7-crafting`, `A8-targets`,
`M1`/`M2`/`M3`, `B1-option-order`, `B5`/`B6` and `C2`/`C3` are held outright.

**Every violation is a truncated search, and none is a collapse.** They all have
the form "a more constrained problem scored better", they are all under 0.2 nats,
and no plan goes to or comes from probability zero. That last row is the one that
mattered for shipping this: the LP-relaxation-and-beam search it replaced
produced **eight** `p -> 0` collapses on the same 40 instances, where relaxing a
constraint drove a plan from positive probability to a plan that cannot craft the
target at all, and a worst finite violation of **-1.0917 nats**. Its own numbers
were 59 violations and 11/40 clean at a median solve of 77 ms, so this is roughly
fourteen times slower, half as often wrong in a way anyone would notice, and
never wrong in the way that matters most.

Violations concentrate rather than spread: 17 instances carry all 63, and
`arena:2038` alone carries 10.

### Two caveats on these numbers

**Two sweeps, not three.** The bar for calling a result durable in this arena is
three fresh full sweeps compared per instance. This is two, and they agree
exactly. The `{2,50}` and `{3,200}` rows in section 7 are single sweeps.

**The comparison against the old search is historical.** `baseline-main` wrapped
`src/lib`'s `optimizeFull`, which no longer exists, so its column cannot be
re-measured — those figures come from the sweeps run while both entries were
registered. They were measured in the same invocation as this candidate, under
the same load. One wrinkle worth recording: that entry was never fully
deterministic, because `optimizer-core.ts` time-boxed its polish phase with a
15 ms wall clock, and two identical sweeps of it returned 55 and 54 violations.
The MILP has no such term, which is why its two runs agree to the unit.
