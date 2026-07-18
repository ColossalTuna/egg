# Brute-force oracle for the artifact optimizer

Correctness assurance for the heuristic outer solver (`optimizeFull`). The
solver stacks heuristics — ternary search over batch counts, dominance
pruning, an aggressive dual filter with greedy repair — any of which can
silently return a suboptimal plan. This harness measures that, treating the
solver as a black box: nothing in this directory imports the solver's
internals, only the public entry point and types.

## How it works

For each generated instance the harness:

1. runs `optimizeFull` and maps its `choiceHistory` back onto the input
   options (the ships-per-batch scale is measured at runtime by a probe whose
   optimal batch count is provable from the reported probability alone);
2. **feasibility** — recomputes fuel/time usage and checks it against the
   budgets and against the reported totals;
3. **honesty** — re-evaluates the returned plan with an evaluator built from
   disparate logic (an exact BigInt-rational simplex over the recipe DAG,
   derived only from the documented objective) and checks the reported
   probability against it;
4. **optimality** — exhaustively enumerates every maximal feasible integer
   allocation (exact, because the objective is monotone in inventory),
   evaluates each with the independent evaluator, and requires the solver's
   plan to be within `ORACLE_GAP_TOL` of the best;
5. **second opinion** — any optimality gap is re-priced through the solver's
   *own* value function (the oracle's winning allocation is fed back through
   `optimizeFull` as a single take-it-or-leave-it synthetic option), so a
   reported gap cannot be an artifact of the oracle's independent model.

Calibration probes with closed-form answers run first; if those fail, either
the solver is broken on trivial input or the oracle's reading of the contract
has drifted, and the fuzz results are void.

## Instance families

Seeded and fully reproducible: `random-single`, `random-multi` (two targets
competing for shared ingredients), `cheap-filler` (leftover budget only cheap
options can fill — the case the dual filter knowingly discards),
`near-tie` (options with almost identical per-fuel value), `chunky-knapsack`
(large indivisible costs under a tight budget), `edge` (zero/degenerate
budgets, drop-only options, time-bound plans).

## Running it

```sh
pnpm test          # calibration + smoke tier only (~seconds)
pnpm test:oracle   # + deep campaign, 25 minutes by default
```

Knobs (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORACLE_TIME_BUDGET_MS` | 25 min | wall-clock budget of the deep campaign |
| `ORACLE_GAP_TOL` | `1e-3` | max tolerated optimality gap, in absolute probability |
| `ORACLE_HONESTY_TOL` | `1e-6` | tolerated reporting discrepancy |
| `ORACLE_SEED_BASE` | `1000` | first seed; change to explore fresh instances |

Every failure line carries the family and seed, so any finding can be
reproduced exactly.

## Baseline (2026-07-18, first run of the harness)

Feasibility, honesty, and calibration all pass across ~3.8M instances (a
24-minute campaign over seeds 200000–810924). Optimality does not: **2.9% of
instances have an optimality gap above 1e-3** (3.5% have any nonzero gap,
mean gap ~7e-4), with worst cases losing up to 0.95 in absolute probability.
The gap rate is highest for `near-tie` (~5%) and `chunky-knapsack` (~4.6%)
instances and lowest for `edge` (~0.8%). Every sampled gap was confirmed by
the solver's own value function, so this is the outer search (not the value
model) leaving probability on the table. Until
the solver improves, expect `pnpm test:oracle` to be red; the summary block
it prints (gap rate, mean/max gap, worst seeds) is the number to watch.
