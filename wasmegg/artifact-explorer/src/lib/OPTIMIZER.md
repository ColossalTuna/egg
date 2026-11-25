# The Path of Virtue mission optimizer

Given a set of budgets and game state (player's ships, a fuel budget, a per-slot time horizon, an optional total
gem budget for every launch in the plan, etc.), the optimizer
picks integer counts of each launch option so as to maximize the chance of ending
up with a legendary of **every** artifact the player selected.

## The objective

Each selected target `T` has a score linear in the crafts the plan supports:

$$
score(T) = Q_T \cdot crafts_T + \lambda_T
$$

$crafts_T$ is how many copies of `T` the player's inventory merged with the dropped
items from the optimizer's selected missions supports crafting, $\lambda_T$ is `T`'s
expected direct legendary drop count, and $Q_T = -\log(1 - p_{CraftLegendary_T})$ is
what one craft is worth. The search maximizes

$$
F = \sum_T g(score(T)), \qquad g(s) = \log(1 - e^{-s})
$$

$e^F$ is exactly the joint probability of getting a legendary of _every_ selected
target, so maximizing $F$ and maximizing that probability are the same problem — and
$F$ is a sum of per-target terms, which is what a matrix can carry. That identity
holds for a specific model: mission yields are treated as deterministic expected
supply rather than random drops, craft counts are continuous, direct legendary
drops are Poisson with mean $\lambda_T$, and targets are treated as independent of
each other. $e^F$ is this model's probability, not a measured game rate. `objective.ts`
holds $g$, $g'$ and $Q$ as `logHit`, `gPrime` and `qOf`; the search and the judge both
read them, so the two agree to the bit on what a target is worth.

One consequence worth knowing: $g'(s) = 1/(e^s - 1)$, so $g$ flattens as
$score_T$ grows and the search stops distinguishing plans that differ only in how
far they overshoot an already-certain target. Above $P_T = 0.999$,
the next craft buys nearly nothing, and, with several targets, that budget belongs
to whichever one is still short — but it means near-saturated instances settle
for any plan inside the epsilon band rather than the score-maximal one.

## The tangent outer approximation

$\sum_T g(score_T)$ is not linear, so it has to be linearized to serve as a MILP's
objective. `src/lib/solver/SPEC.md`'s introduction defines the general terms this
section uses (MILP, concave, tangent, envelope, outer approximation). The concave
function here is $g$, the per-target term from "The objective" above; $z_T$ is the
one envelope variable per target, bounded by a row $z_T <= \alpha_k + \beta_k *
score_T$ per tangent point, so the solver drives each $z_T$ up to $\min_k(...)$ and
the maximization stays linear.

The envelope over-estimates $g$ everywhere except one edge case: when a
tangent's slope falls under `FLAT_CUT_SLOPE` (1e-12), `buildOaMilp` omits the
slope term and keeps the cut flat, which can let it sit under $g$ by at most that
many nats (`SPEC.md` section 3 derives the bound). Over-estimating is safe only because
nothing reported is read off the approximation: the chosen plan is re-scored by
the judge (`solver/evaluator.ts`) against the exact objective, and the card's
probabilities come from `craftsToProbability` on the judge's craft counts and the
plan's drop rates. If you change anything about the tangent grid, this is the
property to preserve: an over-estimate reorders candidates slightly, whereas
letting the approximation leak into a reported figure would make the tool lie.

The grid sits in units of each target's own ceiling theta, capped at a score of 30,
past which $g$ is flat to the judge's resolution (`SPEC.md` section 4). Without
the cap, a target that saturates easily put every tangent where $g$ is flat, and
the search could not tell the empty plan from a certain one. With more than one
target, a few refinement rounds then add a tangent at the incumbent wherever the
envelope over-states it, and keep the best judged plan (`SPEC.md` section 5).

## Search structure

`optimizeFull` states the whole problem as one MILP and hands it to HiGHS, re-solving
it with a tighter envelope for up to four rounds when there are several targets.
A HiGHS failure propagates as an error rather than reading as an empty plan. The model,
the outer approximation and HiGHS's own numeric traps are in
`src/lib/solver/SPEC.md`; the judge's simplex has a separate set, in the header of
`src/lib/solver/simplex.ts`. What follows is only what a reader of this file needs.

**Why an MILP.** Missions are allocated _per slot_ and crafts are continuous columns
over the same conservation polytope — the feasible set the recipe's rows carve out — so
packing and the craft split are both decided inside the one matrix and no repair phase
exists. `SPEC.md` section 3 states the two rows and the argument.

**What it costs.** About a second on a production-scale instance.

**What is still wrong with it.** Invariant violations across the arena sweep are
all of the form "a more constrained problem scored better" and all small. They
are consistent with the node budget: investigation showed even extreme node
budgets didn't fully resolve the invariants, so the current deployment was
tuned to balance runtime with the frequency and severity of the violations. But
there is a latent mechanism the sweep does not isolate from that explanation:
the per-target scale $\theta_t$ is an LP maximum computed _subject to the
budgets_, and the tangent grid is placed in units of theta (capped at 30), so changing a
budget re-approximates the objective rather than merely enlarging the feasible
set. How much of the observed violation each mechanism accounts for is open, and
the A1/A2 monotonicity invariants are not theorems even at proven optimality until
it is settled.

## The worker boundary

The planner runs off the main thread (`optimizer.worker.ts`). Every solve is
around a second, and the first one in a worker's life also fetches and
instantiates the WebAssembly module.

**Launch-option enumeration stays on the main thread.** It is the only step that
needs the loot dataset, which the main bundle already loads for the mission
views; enumerating in the worker would put a second copy in the worker bundle.
For the same reason `optimizer.worker.ts` imports `optimizeFull` directly rather
than through the `lib` barrel, which re-exports the loot data.

The traffic goes the other way too, and for the mirror-image reason: components import
the barrel, so a static edge from it to `optimizer-core` would drag the solver and its
Emscripten glue into the main chunk. Keeping that edge out of the module graph rather
than relying on a lazy import is what makes it hard to undo by accident ("Module
boundaries that are load-bearing", below).

`optimizer-worker-protocol.ts` exists because structured clone drops prototypes
(see its header for why); the consequence is that `ship` is narrowed to two
fields on the way out and rebuilt on the way in.

`optimizer-client.ts` reuses one worker across runs and numbers requests so only
the newest one's result is delivered — with auto-compute on, a burst of input
changes queues several solves and every result but the last describes settings
the user has already moved past. A superseded or torn-down request resolves with
`null`, which callers read as "no result is coming, leave state alone".

The request carries the problem and nothing else; the search budget is fixed at
compile time in `DEFAULT_TUNING`, as a node count rather than a wall clock, so the
same request produces the same plan however loaded the machine is.

## Inventory and previous crafts

A target's `legendaryCraftProbability` depends on how many times the player has
already crafted it. With a save loaded each target uses **its own** crafted count;
a manual override applies to **every** target. `buildRecipeDag` implements this by
treating an undefined `previousCraftsOverride` as "read per-target". The override
feeds `legendaryCraftProbability` only — pricing always reads the real counts.

`computeOwnedStock` counts the player's stock across all rarities, because each
can be demoted to common. This is "how many copies you can feed a recipe",
never "you already own a legendary"; the legendary side of the objective comes
solely from mission drops.

A target is skipped only when nothing in the DAG consumes it. `solver/model.ts` gives a
conservation row only to nodes some recipe consumes, so such a node has no row at all:
owned copies could never be spent and would only look like free progress. A target that _is_ an ingredient of another keeps its
stock, which can only relax the consumption side of its row.

## Per-target display attribution

`craftPrimal` / `supplyByItem` are solution-wide pooled totals: the judge settles on one
point of the craft polytope for the whole plan (`solver/evaluator.ts`), which crafts a
shared component once for every target that consumes it.
`computeCraftChainTree` attributes each node's pooled quantities to a target in
proportion to that target's share of total recursive demand, so the per-target
breakdowns sum back to the pooled totals instead of showing each artifact "using" the
whole pool. The root is scaled by that same rule, not exempt from it: a target that is
itself an ingredient of another selected target gets only its own share of its pool,
and keeps the pool whole only when nothing else demands it.

## Golden egg cost

**One linear row, in two matrices.** The cap has to be written wherever craft counts
are decided or it does not bind on the number the card prints. The MILP is where it
changes which ingredients get gathered; the judge's craft LP is where the reported
`craftPrimal` comes from, so it carries the same row. The judge maximizes by away-step
Frank-Wolfe over that same polytope, and the row is linear, so every iterate it visits
stays inside the budget.

**Why the row is linear when the cost is not, and what that costs.** `computeCraftUnitPrices`
in `optimizer-cost.ts` carries the pricing argument: why a linear per-craft price
over-states the true bill, and by how much in the worst case.

**The card reports that same linear price.** Reporting the true curve instead
reads as a bug in the cap: a player who sets a maximum craft cost and is shown a
plan priced well below it sees a cap that did not bind where it said it did. The
cost of that consistency is that the reported figure over-states what the game
will charge, by the same ratio — the two now err together instead of disagreeing.
The same over-stating price drives the solution card's "costs more than you have"
demarcation, so it marks a little early rather than a little late.

Pricing linearly also sidesteps the crafts being continuous — the LP relaxation that
lets a plan craft 2.5 of something: lib's curve is indexed by an integer craft number,
while `linearCraftCost` is proportional in the craft count with no index to round
to.

Two numbers, one bill. The card's total prices the **unsplit** `craftPrimal`; the
per-node `goldenEggCost` in a craft-chain tree prices that same pooled quantity
and takes the target's demand-weighted share. Under a linear price, the two orders
agree, so the split decides which target carries a shared node's bill, not how
large it is.

## Plan visits: the gem budget and the recorded answer

**`gemBudget` is a total.** The gem mode a visit is solved under (plan, custom or
unlimited) yields one number: the most that all of the visit's launches together
may spend. In plan mode that is `gemBudgetFor(visit, time budget)`, the bank on
arrival plus what the farm earns over the time budget; in custom mode it is the
typed figure. `ArtifactMissionOptimizer.vue` sends it to the solve as
`OptimizeArgs.gemBudget`, which `optimizer-core.ts` passes through to the MILP's
total-spend row (`solver/SPEC.md`), and also as `maximumCost`, the per-ship menu
filter, which the total already implies (no single ship can cost more than the
whole budget) and which only prunes the menu. Unlimited mode leaves both out. The
humility missions file records the same figure the solve ran under, so
`gemCost <= gemBudget` holds for every exported visit; an unlimited solve is
written as `GEM_BUDGET_UNLIMITED` (`plan/schema.ts`).

**`epicResearchFTLLevel` is the FTL the solve used.** Each recorded visit carries
the FTL level of the effective config at the moment the solve was requested (the
visit's own level unless the player overrides it), so the planner can warn when it
would schedule the missions at another level. `schemaVersion` stays 1; files
without the field still load.

**When an answer is recorded.** A solve's answer is recorded for the active visit
only if it is still the answer to the question the page poses when it returns, it
launches at least one ship, and the visit has at least one target. An empty answer
is not recorded; the page says which limit emptied it (the effort's launch-period
floor against the time budget, the gem budget against every ship's price, or
neither). A solve error clears the visit's answer. No solve starts while a player's
save is being fetched, so a page load cannot record an answer built from the
placeholder inputs over a good one; a failed fetch is reported and the page then
solves on what it has.

**When an answer is dropped.** A visit's own inputs (targets, time budget, fuel and
gem settings) drop its answer when they change (`store/plan.ts`). Everything else an
answer depends on (the player id, the save's inventory, ship levels, epic research
fallbacks, crafting level, previous crafts, the craft cap and its validity, and the
effort) forms a global key recorded next to each answer in `LoadedPlan.solvedInputs`.
When that key changes, every answer recorded under another key is dropped, other
visits' included, so an export never mixes answers to different questions. Switching
visits changes no global input and keeps every answer. Answers recorded without a key
are judged only by their visit's own edits.

**Reload and other tabs.** On reload, `loadPlan` validates each stored visit and each
recorded answer and drops the bad ones (an unknown ship or duration name, a
probability outside 0..1, a missing or non-finite number, no launches, no targets).
Every write to the stored plan first adopts what another tab stored for the same plan
(its answers and visit settings), so two tabs recording different visits keep both;
the `storage` event does the same while a tab is idle. A tab that finds a different
plan stored under it keeps its own and says so on the page.

## Module boundaries that are load-bearing

Most of `src/lib` reads as it looks. Two edges do not, and both exist to keep
something from becoming circular or from landing in the wrong bundle:

- `packing.ts` imports nothing, and in particular nothing from `tests/`,
  because the arena re-checks every plan against its own independent packer
  (invariant C1). Sharing one implementation would make that check circular.
- `index.ts` (the barrel every component imports) has no path to
  `optimizer-core`, so the solver stays out of the main chunk;
  `tests/unit/spec-helpers.ts` holds the in-process `optimize()` for the same
  reason.

A third load-bearing edge sits outside `src/lib`: `tests/arena/solvers/highs/index.ts`
is a shim registering `solver/` as the arena's entry, so the shipped solver and the
measured one are one code path.
