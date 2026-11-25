# Plan exchange fixtures

- `ascension-plan.json`: ascension planner export, limited to fields read by
  `src/lib/plan/read.ts`.
- `humility-missions.json`: the artifact explorer's humility missions export,
  read by `wasmegg/ascension-planner/src/lib/humilityMissions.ts`.

Both apps assert against these same two files: `tests/unit/plan-seam.spec.ts`
here, and `wasmegg/ascension-planner/src/lib/humilityMissions.spec.ts` on the
other side. A schema change on either side needs the writer
(`src/lib/plan/write.ts` for `humility-missions.json`; the ascension planner's
save export for `ascension-plan.json`) and this checked-in JSON updated
together, or the matching spec fails on the mismatch.

## How `humility-missions.json` was produced

It is the output of the real writer (`projectSolvedVisit` and
`buildHumilityMissionsFile`), fed the visits `sliceHumilityVisits` reads from
`ascension-plan.json` (so `basis` and `epicResearchFTLLevel`, 55, are the
reader's), with `generatedAt` pinned to 1756000000000. The solutions were
built by hand, not by the solver, with these inputs:

| visit | launches | effort | time budget | `gemBudget` |
|---|---|---|---|---|
| 0 | 9 ATREGGIES EPIC, 4 HENERPRISE LONG, target 25 | medium | 8 days (691200 s) | `gemBudgetFor(visit, 691200)` |
| 1 | 2 VOYEGGER EPIC, target 27 | medium | 2 days (172800 s) | `gemBudgetFor(visit, 172800)` |

`makespanSeconds` and `rawMakespanSeconds` are the minimized three-slot
makespan (`packWitness` over the subset sums of the mission durations at FTL
55, rounded as `optimizer-core.ts` rounds them). Every duration is above the
medium launch period (43200 s), so the two figures are equal: 622080 s
(8 x 77760) for visit 0, and 116640 s for visit 1.

`gemBudget` is the visit's total gem budget, so `gemCost` is at or under it in
both visits. A solve with no gem limit writes `GEM_BUDGET_UNLIMITED`
(`Number.MAX_VALUE`; see `src/lib/plan/schema.ts`).

To change the fixture, rerun the writer on new inputs and update this table;
`plan-seam.spec.ts` ("reproduces the checked-in file for the first visit")
and `tests/breakage/batch-3.SEAM-17.spec.ts` check the result.
