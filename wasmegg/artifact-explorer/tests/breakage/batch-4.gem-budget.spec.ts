// Batch 4: SEAM-05 (+STA-06) exported gemBudget vs the cap the solve used; SEAM-06 AP's reading of gemBudget.
// Run with: npx vitest run -c tests/breakage/batch-4.vitest.config.ts tests/breakage/batch-4.gem-budget.spec.ts
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gemBudgetFor, parsePlanSave, sliceHumilityVisits } from '@/lib/plan/read';
import { projectSolvedVisit } from '@/lib/plan/write';
import type { OptimizerSolution } from '@/lib/types';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const COMPONENT = readFileSync(new URL('../../src/components/ArtifactMissionOptimizer.vue', import.meta.url), 'utf8');

let store: typeof import('@/store');
let plan: typeof import('@/store/plan');
beforeEach(async () => {
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/' } });
  vi.stubGlobal('localStorage', {});
  store = await import('@/store');
  plan = await import('@/store/plan');
  store.clearPlayerData();
  plan.setLoadedPlan('fixture', sliceHumilityVisits(parsePlanSave(fixture('ascension-plan.json'))));
  plan.setCurrentVisit(plan.loadedPlan.value!.visits[0].visitId);
});

// The exact expression at ArtifactMissionOptimizer.vue:296, which sets the exported gemBudget:
//   const gemBudget = visit ? gemBudgetFor(visit, input.timeCapacityPerSlot) : 0;
// where input.timeCapacityPerSlot = maxWaitTimeSeconds = effectiveWaitTimeSeconds (lines 141, 264).
function exportedGemBudget(): number {
  expect(COMPONENT).toContain('const gemBudget = visit ? gemBudgetFor(visit, input.timeCapacityPerSlot) : 0;');
  expect(COMPONENT).toContain('timeCapacityPerSlot: maxWaitTimeSeconds.value,');
  expect(COMPONENT).toContain('const maxWaitTimeSeconds = effectiveWaitTimeSeconds;');
  return gemBudgetFor(plan.activePlanVisit.value!, store.effectiveWaitTimeSeconds.value);
}

describe('SEAM-05: gemBudget is the cap the solve used', () => {
  it("plan mode: exported gemBudget equals the solve's maximumCost (control)", () => {
    expect(store.gemCostMode.value).toBe('plan');
    expect(exportedGemBudget()).toBe(store.effectiveMaxGemCost.value);
  });

  it('custom mode: exported gemBudget equals the custom cap the solve used', () => {
    const planBudget = exportedGemBudget();
    store.setGemCostMode('custom');
    store.setGemCostInput('1e40');
    expect(store.effectiveMaxGemCost.value).toBe(1e40); // what is sent as maximumCost
    expect(planBudget).toBeLessThan(1e40); // the plan-derived budget is something else
    // BREAKAGE SEAM-05: file records the plan-derived budget, not 1e40.
    expect(exportedGemBudget()).toBe(store.effectiveMaxGemCost.value);
  });

  it('unlimited mode (STA-06): a ship costing more than the exported budget is allowed, so the file contradicts itself', () => {
    // A small plan budget: nothing banked on arrival and a one-hour wait.
    const raw = fixture('ascension-plan.json');
    for (const a of raw.actions) a.endState.bankValue = 0;
    plan.setLoadedPlan('small', sliceHumilityVisits(parsePlanSave(raw)));
    plan.setCurrentVisit(plan.loadedPlan.value!.visits[0].visitId);
    plan.setVisitWaitTime(plan.activePlanVisit.value!.visitId, '1h');
    store.setGemCostMode('unlimited');
    expect(store.effectiveMaxGemCost.value).toBeUndefined(); // solver may buy any ship
    const budget = exportedGemBudget();
    const shipCost = 419e36; // ATREGGIES virtueGemCost
    expect(shipCost).toBeGreaterThan(budget); // fixture plan budget is smaller (see assertion below)
    const out = projectSolvedVisit({
      visit: plan.activePlanVisit.value!,
      solution: {
        choiceHistory: [
          { ship: { shipType: 10, durationType: 2, virtueGemCost: shipCost }, targetAfxId: 25, numShipsLaunched: 1 },
        ],
        fuelByEgg: new Map(),
        perTarget: [],
        jointProbability: 0.5,
        timeUnitsUsed: 1,
        runningTimeSeconds: 1,
      } as unknown as OptimizerSolution,
      effort: 'max',
      gemBudget: budget,
    });
    // BREAKAGE STA-06: a one-ship answer whose per-ship price exceeds the recorded per-ship cap.
    expect(out.gemCost).toBeLessThanOrEqual(out.gemBudget);
  });
});

// Rewritten with the KP fix. Per the contract (section 2) gemBudget is now the visit's TOTAL gem budget, so AP's
// `gemCost > gemBudget` warning is a real invariant check and stays, reworded as totals. The old test asserted the
// "plan budget" wording and a fixture whose visit 0 cost more than its (then per-ship) budget; K4 rewrote the
// fixture with total budgets, so that precondition no longer holds either.
describe('SEAM-06: AP reads gemBudget as a total', () => {
  it('AP warns only when the total cost is over the total budget, and says so in totals', () => {
    const src = readFileSync(
      new URL('../../../../ui/components/planners/actions/rockets/HumilityMissionsImport.vue', import.meta.url).pathname,
      'utf8'
    );
    const cond = /<p v-if="(visit\.gemCost > visit\.gemBudget)"/.exec(src);
    expect(cond).not.toBeNull();
    const warns = (visit: unknown) => new Function('visit', `return ${cond![1]};`)(visit) as boolean;
    // BREAKAGE SEAM-06: valid explorer output must not trigger the warning.
    for (const v of fixture('humility-missions.json').visits) {
      expect(v.gemCost).toBeLessThanOrEqual(v.gemBudget);
      expect(warns(v)).toBe(false);
    }
    // An answer over its total budget is a broken invariant, and is still flagged.
    expect(warns({ gemCost: 2, gemBudget: 1 })).toBe(true);
    // The no-limit sentinel never trips it.
    expect(warns({ gemCost: 1e300, gemBudget: Number.MAX_VALUE })).toBe(false);
    expect(src).not.toContain('plan budget:');
    expect(src).not.toContain('Purchase limits apply per ship');
    expect(src).toMatch(/in total, more than its total gem budget/);
  });
});
