// Batch 7: regressions introduced by K5's plan-visit tank changes (SAT-STATE-15, SAT-STATE-16).
// Renders the REAL OptimizerSidebar.vue to a string against the real store and a loaded plan fixture.
import { readFileSync } from 'node:fs';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ei, formatEIValue, fuelTankSizes } from 'lib';
import { memoryStorage } from './batch-5.harness';

// ui's BaseIntegerInput imports BaseInput through the bare 'ui/...' specifier, which this package's vitest
// config cannot resolve from inside ui/. The setting row only uses it to hand its scoped slot the current
// value, so a stub that does just that stands in for it.
vi.mock('ui/components/BaseIntegerInput.vue', async () => {
  const { defineComponent } = await import('vue');
  return {
    default: defineComponent({
      props: { modelValue: Number, min: Number, max: Number },
      setup: (props, { slots }) => () =>
        slots.default?.({ value: props.modelValue, input: String(props.modelValue), invalid: false, updateInput: () => {} }),
    }),
  };
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const T = 'lunar-totem-4';
const fmt = (n: number) => formatEIValue(n, { trim: true });

let store: typeof import('@/store');
let plan: typeof import('@/store/plan');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { pathname: '/artifact-explorer/', search: '' } });
  vi.stubGlobal('localStorage', memoryStorage());
  store = await import('@/store');
  plan = await import('@/store/plan');
  const read = await import('@/lib/plan/read');
  plan.setLoadedPlan('fixture', read.sliceHumilityVisits(read.parsePlanSave(fixture('ascension-plan.json'))));
});

async function renderSidebar(): Promise<string> {
  const Sidebar = (await import('@/components/optimizer/OptimizerSidebar.vue')).default;
  const app = createSSRApp(Sidebar as any, {
    playerId: '',
    waitTimeDays: '2d',
    exportBlocked: false,
    timeBudgetInvalid: false,
  });
  app.use(createPinia());
  app.directive('tippy', { getSSRProps: () => ({}) });
  return renderToString(app);
}
const text = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
// The Fuel tank level row runs up to the next control (the per-egg checkbox text).
const tankRow = (html: string) => {
  const t = text(html);
  const start = t.indexOf('Fuel tank level');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = t.indexOf('Only use fuel', start);
  return t.slice(start, end > start ? end : start + 200);
};

function planVisit(tankLevel: number, fuelByEgg: Map<ei.Egg, number>) {
  const v = plan.loadedPlan.value!.visits[0];
  v.tankLevel = tankLevel;
  v.fuelByEgg = fuelByEgg;
  plan.setCurrentVisit(v.visitId, [T]);
  plan.setVisitFuelBudget(v.visitId, 'full-tank');
  return v;
}

describe('K5 regressions', () => {
  it('SAT-STATE-15: the tank capacity shown is the capacity the full-tank solve uses', async () => {
    planVisit(7, new Map([[ei.Egg.CURIOSITY, fuelTankSizes[7] / 2]]));
    const solved = store.effectiveFuelTankCapacity.value;
    expect(solved).toBe(fuelTankSizes[7] / 2);

    const row = tankRow(await renderSidebar());
    // The figure the solve budgets against must be on the row; the full tank alone is not it.
    expect(row).toContain(fmt(solved));
  });

  it('SAT-STATE-16: with a plan visit active, the tank override does not look as if it applies', async () => {
    planVisit(4, new Map());
    const before = store.effectiveFuelTankCapacity.value;
    store.setOverrideTankLevel(true);
    store.setTankLevel(7);
    // The solve ignores the override for plan visits (K5's design).
    expect(store.effectiveFuelTankCapacity.value).toBe(before);

    const html = await renderSidebar();
    const row = tankRow(html);
    // No editable level input carrying the ignored manual value, and no Override badge.
    expect(html).not.toMatch(/<input[^>]*aria-label="Fuel tank level"/);
    expect(row).not.toMatch(/\bOverride\b/);
    // The row shows the visit's level and its tank, and says the override is ignored.
    expect(row).toContain('Plan');
    expect(row).toMatch(/\b4 \/ 7\b/);
    expect(row).toContain(fmt(fuelTankSizes[4]));
    expect(row).toMatch(/override is ignored/i);
  });
});
