// Persist the loaded plan, selected visit and per-visit settings across reloads.
// Store solved visits in export format; OptimizerSolution contains non-JSON Maps.

import { computed, ref } from 'vue';

import { ei, formatDuration, fuelTankSizes, getLocalStorage, parseDurationDays, setLocalStorage } from 'lib';

import { parseBudgetInput } from '@/store/budget-input';

import type { HumilityVisit } from '@/lib/plan/read';
import type { HumilityMissionsVisit } from '@/lib/plan/schema';

// Predates the humility missions rename; kept so a plan loaded before the update survives it.
const PLAN_LOCALSTORAGE_KEY = 'humility_plan';

// Bumped when the persisted shape changes. A mismatch discards rather than migrates: the plan is
// one file re-pick away, and a half-understood blob would solve against budgets nobody can see.
const PLAN_STORE_VERSION = 1;

// The blob this tab last wrote or read. Another tab writing the same key is what makes the stored
// blob differ from it; see `syncFromStorage`.
let lastSyncedBlob: string | undefined;

// banked uses per-egg fuel on arrival; full-tank uses pooled tank capacity
// to plan fuel that has not yet been stored.
export type VisitFuelBudget = 'banked' | 'full-tank';
export type GemCostMode = 'plan' | 'custom' | 'unlimited';

export interface VisitSettings {
  // Artifact node ids the optimizer should aim at for this visit.
  targetIds: string[];
  // Null means "use the duration the plan itself spends on Humility here". A plan that has not
  // scheduled this visit's missions yet reports zero, so the page takes a typed value instead.
  waitTimeOverride: string | null;
  fuelBudget: VisitFuelBudget;
  gemCostMode: GemCostMode;
  gemCostInput: string;
}

export interface LoadedPlan {
  label: string;
  loadedAt: number;
  visits: HumilityVisit[];
  // The visit the optimizer is pointed at, or null for the off-plan entry, which budgets against
  // the loaded save exactly as the page does with no plan at all.
  currentVisitId: string | null;
  settings: Record<string, VisitSettings>;
  solved: Record<string, HumilityMissionsVisit>;
  // The global inputs (effort, crafting level, player, ship levels, ...) each solved visit was
  // answered under, as an opaque key the optimizer page builds, keyed by visit id. When those inputs
  // change, `retainSolvedVisitsMatching` drops every answer whose key no longer matches. An answer
  // recorded without a key is judged only by the per-visit edits below.
  solvedInputs: Record<string, string>;
}

function newVisitSettings(): VisitSettings {
  return {
    targetIds: [],
    waitTimeOverride: null,
    // The plan's own numbers, until the player says otherwise.
    fuelBudget: 'banked',
    gemCostMode: 'plan',
    gemCostInput: '0',
  };
}

export const loadedPlan = ref<LoadedPlan | null>(loadPlan());

export const activePlanVisit = computed<HumilityVisit | null>(() => {
  const plan = loadedPlan.value;
  if (!plan || plan.currentVisitId === null) return null;
  return plan.visits.find(v => v.visitId === plan.currentVisitId) ?? null;
});

export function setLoadedPlan(label: string, visits: HumilityVisit[]): void {
  // A freshly loaded plan starts off-plan: the file says nothing about which visit the player came
  // here to solve, and guessing one would silently swap the budgets under a selection they made
  // before loading it.
  loadedPlan.value = {
    label,
    loadedAt: Date.now(),
    visits,
    currentVisitId: null,
    settings: {},
    solved: {},
    solvedInputs: {},
  };
  persistPlan();
}

// Unloading discards the cycle's recorded answers with it: they are keyed to this plan's visits,
// and keeping them for the next file would attach one plan's budgets to another's.
export function clearLoadedPlan(): void {
  loadedPlan.value = null;
  persistPlan();
}

// Selecting a visit repoints the one target selector on the page at that visit's saved targets. A
// newly opened visit starts with the current targets. An explicitly emptied visit stays empty.
export function setCurrentVisit(visitId: string | null, seedTargets: readonly string[] = []): void {
  syncFromStorage();
  const plan = loadedPlan.value;
  if (!plan) return;
  plan.currentVisitId = visitId;
  if (visitId !== null) {
    const isNew = !plan.settings[visitId];
    const settings = mutableSettingsFor(visitId);
    if (settings && isNew) settings.targetIds = [...seedTargets];
  }
  persistPlan();
}

// Computed readers must not mutate loadedPlan. Use a stable frozen default
// for visits without saved settings.
const DEFAULT_VISIT_SETTINGS: VisitSettings = Object.freeze({
  ...newVisitSettings(),
  targetIds: Object.freeze([]) as readonly string[] as string[],
});

export function settingsFor(visitId: string): VisitSettings {
  return loadedPlan.value?.settings[visitId] ?? DEFAULT_VISIT_SETTINGS;
}

/** The writable entry, created on demand. Only the setters below reach for it, and each persists. */
function mutableSettingsFor(visitId: string): VisitSettings | null {
  const plan = loadedPlan.value;
  if (!plan) return null;
  return (plan.settings[visitId] ??= newVisitSettings());
}

export const activeVisitSettings = computed<VisitSettings | null>(() => {
  const visit = activePlanVisit.value;
  if (!visit || !loadedPlan.value) return null;
  return settingsFor(visit.visitId);
});

// Seconds a visit is solved against: what the player typed for it, or what the plan already
// spends on Humility there.
function waitTimeSecondsOf(settings: VisitSettings, plannedDurationSeconds: number): number {
  const override = settings.waitTimeOverride;
  return override === null ? plannedDurationSeconds : parseDurationDays(override);
}

export function waitTimeSecondsFor(visit: HumilityVisit): number {
  return waitTimeSecondsOf(settingsFor(visit.visitId), visit.plannedDurationSeconds);
}

export function waitTimeInputFor(visit: HumilityVisit): string {
  const settings = settingsFor(visit.visitId);
  return settings.waitTimeOverride ?? formatDurationInput(visit.plannedDurationSeconds);
}

// Invalidate a solved visit only when its effective inputs change.
// `asks` normalizes equivalent input text (e.g. "11" and "11d") so blur
// normalization does not discard a result without triggering a new solve.
function editVisit(
  visitId: string,
  edit: (settings: VisitSettings) => void,
  asks?: (settings: VisitSettings) => number | string
): void {
  syncFromStorage();
  const plan = loadedPlan.value;
  const settings = mutableSettingsFor(visitId);
  if (!plan || !settings) return;
  const before = asks?.(settings);
  edit(settings);
  // `!==`, not `Object.is`: an unparseable duration is NaN on both sides, and an answer to a
  // question that can no longer be posed has to go.
  if (asks === undefined || before !== asks(settings)) dropSolved(plan, visitId);
  persistPlan();
}

export function setVisitTargets(visitId: string, targetIds: readonly string[]): void {
  editVisit(
    visitId,
    s => {
      s.targetIds = [...targetIds];
    },
    s => JSON.stringify(s.targetIds)
  );
}

export function setVisitWaitTime(visitId: string, value: string | null): void {
  const planned = loadedPlan.value?.visits.find(v => v.visitId === visitId)?.plannedDurationSeconds ?? NaN;
  editVisit(
    visitId,
    s => {
      s.waitTimeOverride = value;
    },
    s => waitTimeSecondsOf(s, planned)
  );
}

export function setVisitFuelBudget(visitId: string, budget: VisitFuelBudget): void {
  editVisit(
    visitId,
    s => {
      s.fuelBudget = budget;
    },
    s => s.fuelBudget
  );
}

export function setVisitGemCostMode(visitId: string, mode: GemCostMode): void {
  editVisit(
    visitId,
    s => {
      s.gemCostMode = mode;
    },
    s => s.gemCostMode
  );
}

export function setVisitGemCostInput(visitId: string, value: string): void {
  editVisit(
    visitId,
    s => {
      s.gemCostInput = value;
    },
    s => parseBudgetInput(s.gemCostInput)
  );
}

function dropSolved(plan: LoadedPlan, visitId: string): void {
  delete plan.solved[visitId];
  delete plan.solvedInputs[visitId];
}

// `inputsKey` is the global-inputs key the answer was solved under; see `LoadedPlan.solvedInputs`.
export function recordSolvedVisit(visit: HumilityMissionsVisit, inputsKey?: string): void {
  syncFromStorage();
  const plan = loadedPlan.value;
  if (!plan) return;
  plan.solved[visit.visitId] = visit;
  if (inputsKey === undefined) delete plan.solvedInputs[visit.visitId];
  else plan.solvedInputs[visit.visitId] = inputsKey;
  persistPlan();
}

export function clearSolvedVisit(visitId: string): void {
  syncFromStorage();
  const plan = loadedPlan.value;
  if (!plan || !(visitId in plan.solved)) return;
  dropSolved(plan, visitId);
  persistPlan();
}

// Drops every recorded answer solved under global inputs other than `inputsKey`: an answer to a
// question the page can no longer pose (another effort, crafting level, player, or an input that is
// now invalid) must not be exported next to answers to the current one. Answers recorded without a
// key are kept; nothing says what they were solved under.
export function retainSolvedVisitsMatching(inputsKey: string): void {
  syncFromStorage();
  const plan = loadedPlan.value;
  if (!plan) return;
  let changed = false;
  for (const visitId of Object.keys(plan.solved)) {
    const recorded = plan.solvedInputs[visitId];
    if (recorded !== undefined && recorded !== inputsKey) {
      dropSolved(plan, visitId);
      changed = true;
    }
  }
  if (changed) persistPlan();
}

export const solvedVisitCount = computed<number>(() => Object.keys(loadedPlan.value?.solved ?? {}).length);

// `parseDurationDays` takes whole-unit tokens, so this rounds to the minute. Only ever seeds an
// input the player can then edit, and a visit budgeted to the second was never meaningful.
function formatDurationInput(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return formatDuration(Math.round(seconds / 60) * 60, true);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// `fuelByEgg` is a Map, so the blob carries it as a plain record keyed by the egg's enum value
// and rebuilds it on the way back in.
interface PersistedVisit extends Omit<HumilityVisit, 'fuelByEgg'> {
  fuelByEgg: Record<string, number>;
}

interface PersistedPlan {
  version: number;
  label: string;
  loadedAt: number;
  currentVisitId: string | null;
  visits: PersistedVisit[];
  settings: Record<string, VisitSettings>;
  solved: Record<string, HumilityMissionsVisit>;
  solvedInputs?: Record<string, string>;
}

function persistPlan(): void {
  const plan = loadedPlan.value;
  if (!plan) {
    lastSyncedBlob = '';
    setLocalStorage(PLAN_LOCALSTORAGE_KEY, '');
    return;
  }
  const blob: PersistedPlan = {
    version: PLAN_STORE_VERSION,
    label: plan.label,
    loadedAt: plan.loadedAt,
    currentVisitId: plan.currentVisitId,
    visits: plan.visits.map(v => ({ ...v, fuelByEgg: Object.fromEntries(v.fuelByEgg) })),
    settings: plan.settings,
    solved: plan.solved,
    solvedInputs: plan.solvedInputs,
  };
  lastSyncedBlob = JSON.stringify(blob);
  setLocalStorage(PLAN_LOCALSTORAGE_KEY, lastSyncedBlob);
}

// Settings written before a field existed come back without it. Filled from the defaults rather
// than answered with a version bump, which would discard a plan mid-cycle over an additive change.
function normalizeSettings(stored: Record<string, VisitSettings> | undefined): Record<string, VisitSettings> {
  const settings: Record<string, VisitSettings> = {};
  for (const [visitId, value] of Object.entries(stored ?? {})) {
    settings[visitId] = { ...newVisitSettings(), ...value };
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Validation of the persisted blob
// ---------------------------------------------------------------------------

// The blob is this app's own output, but it outlives builds and can be edited by hand. Each visit and
// each recorded answer is checked on the way in and dropped if it is not one this build would write,
// so a bad entry costs that entry, not the plan, and nothing unreadable is offered for export.

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isNonNegative(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}
function isCount(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0;
}
function isProbability(x: unknown): x is number {
  return isNonNegative(x) && x <= 1;
}
function isOptionalLevel(x: unknown): boolean {
  return x === undefined || isCount(x);
}
function isEnumName(enumObject: object, name: unknown): boolean {
  return typeof name === 'string' && typeof (enumObject as Record<string, unknown>)[name] === 'number';
}

function restoreVisit(raw: unknown): HumilityVisit | null {
  if (!isRecord(raw)) return null;
  const v = raw;
  if (typeof v.visitId !== 'string' || v.visitId === '') return null;
  if (!isCount(v.visitIndex) || typeof v.label !== 'string') return null;
  if (!isNonNegative(v.plannedDurationSeconds) || !isNonNegative(v.bankValue) || !isNonNegative(v.earningsPerSecond)) {
    return null;
  }
  if (!isCount(v.tankLevel) || v.tankLevel >= fuelTankSizes.length) return null;
  if (!isOptionalLevel(v.epicResearchFTLLevel) || !isOptionalLevel(v.epicResearchZerogLevel)) return null;
  const fuel = v.fuelByEgg ?? {};
  if (!isRecord(fuel)) return null;
  const fuelByEgg = new Map<ei.Egg, number>();
  for (const [egg, amount] of Object.entries(fuel)) {
    if (!Number.isInteger(Number(egg)) || !isNonNegative(amount)) return null;
    fuelByEgg.set(Number(egg) as ei.Egg, amount);
  }
  // Fields no solve reads (the arrival date) pass through unchecked.
  return { ...(v as unknown as HumilityVisit), fuelByEgg };
}

// The planner's own import checks, as far as this app can make them: a recorded answer that would
// fail there, or that launches nothing or aims at nothing, is not an answer.
function isValidSolvedVisit(raw: unknown, visitId: string): raw is HumilityMissionsVisit {
  if (!isRecord(raw)) return false;
  const v = raw;
  if (v.visitId !== visitId || !isCount(v.visitIndex) || typeof v.label !== 'string') return false;
  if (typeof v.effort !== 'string' || !isProbability(v.jointProbability)) return false;
  if (!isNonNegative(v.makespanSeconds) || !isNonNegative(v.rawMakespanSeconds)) return false;
  if (!isNonNegative(v.gemCost) || !isNonNegative(v.gemBudget)) return false;
  if (!isOptionalLevel(v.epicResearchFTLLevel)) return false;
  if (v.basis !== undefined && !isRecord(v.basis)) return false;
  if (!isRecord(v.fuelRequired) || !Object.values(v.fuelRequired).every(isNonNegative)) return false;
  const targets = v.targets;
  if (!Array.isArray(targets) || targets.length === 0) return false;
  for (const t of targets) {
    if (!isRecord(t) || typeof t.nodeId !== 'string' || t.nodeId === '' || !isCount(t.targetAfxId)) return false;
    if (!isProbability(t.probability) || !isNonNegative(t.expectedCrafts)) return false;
  }
  const launches = v.launches;
  if (!Array.isArray(launches) || launches.length === 0) return false;
  for (const l of launches) {
    if (!isRecord(l) || !isEnumName(ei.MissionInfo.Spaceship, l.ship)) return false;
    if (!isEnumName(ei.MissionInfo.DurationType, l.duration) || !isCount(l.targetAfxId)) return false;
    if (!isCount(l.count) || l.count === 0) return false;
  }
  return true;
}

function parsePersistedPlan(str: string): LoadedPlan | null {
  const parsed = JSON.parse(str) as PersistedPlan;
  if (!parsed || parsed.version !== PLAN_STORE_VERSION || !Array.isArray(parsed.visits)) return null;
  const visits: HumilityVisit[] = [];
  const visitIds = new Set<string>();
  for (const raw of parsed.visits) {
    const visit = restoreVisit(raw);
    if (!visit || visitIds.has(visit.visitId)) {
      console.warn('dropping an unreadable visit from the stored plan');
      continue;
    }
    visits.push(visit);
    visitIds.add(visit.visitId);
  }
  const solved: Record<string, HumilityMissionsVisit> = {};
  const solvedInputs: Record<string, string> = {};
  const storedInputs = isRecord(parsed.solvedInputs) ? parsed.solvedInputs : {};
  for (const [visitId, answer] of Object.entries(isRecord(parsed.solved) ? parsed.solved : {})) {
    if (!visitIds.has(visitId) || !isValidSolvedVisit(answer, visitId)) {
      console.warn(`dropping an unreadable recorded answer for visit ${visitId}`);
      continue;
    }
    solved[visitId] = answer;
    const key = storedInputs[visitId];
    if (typeof key === 'string') solvedInputs[visitId] = key;
  }
  const currentVisitId = typeof parsed.currentVisitId === 'string' ? parsed.currentVisitId : null;
  return {
    label: typeof parsed.label === 'string' ? parsed.label : 'Plan',
    loadedAt: typeof parsed.loadedAt === 'number' ? parsed.loadedAt : 0,
    currentVisitId: currentVisitId !== null && visitIds.has(currentVisitId) ? currentVisitId : null,
    visits,
    settings: normalizeSettings(isRecord(parsed.settings) ? (parsed.settings as Record<string, VisitSettings>) : {}),
    solved,
    solvedInputs,
  };
}

function loadPlan(): LoadedPlan | null {
  const str = getLocalStorage(PLAN_LOCALSTORAGE_KEY);
  lastSyncedBlob = str;
  if (!str) return null;
  try {
    return parsePersistedPlan(str);
  } catch (err) {
    console.warn(`error parsing stored plan: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Other tabs
// ---------------------------------------------------------------------------

// Two tabs share one stored plan. Each write here is a read-modify-write: before changing anything,
// a tab adopts what another tab stored for the same plan (its recorded answers and visit settings),
// so an answer recorded in one tab is not overwritten by another tab that read the plan earlier.
// The selected visit stays this tab's own.
function samePlan(a: LoadedPlan, b: LoadedPlan): boolean {
  return a.label === b.label && a.loadedAt === b.loadedAt;
}

// Set when another tab stored a different plan (or unloaded it) under this one. This tab keeps its
// own plan, and its next write replaces the other tab's, so the page says so.
export const planChangedInAnotherTab = ref(false);

function syncFromStorage(): void {
  const plan = loadedPlan.value;
  if (!plan) return;
  const str = getLocalStorage(PLAN_LOCALSTORAGE_KEY);
  if (str === undefined || str === lastSyncedBlob) return;
  let stored: LoadedPlan | null;
  try {
    stored = str ? parsePersistedPlan(str) : null;
  } catch {
    stored = null;
  }
  lastSyncedBlob = str;
  if (!stored || !samePlan(stored, plan)) {
    planChangedInAnotherTab.value = true;
    return;
  }
  plan.settings = stored.settings;
  plan.solved = stored.solved;
  plan.solvedInputs = stored.solvedInputs;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => {
    if (event.key !== `${window.location.pathname}_${PLAN_LOCALSTORAGE_KEY}`) return;
    syncFromStorage();
  });
}
