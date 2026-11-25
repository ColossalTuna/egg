// Shared harness for batch-5 breakage tests. Mounts the REAL ArtifactMissionOptimizer.vue with a
// headless custom renderer (no DOM), stubbing only: the three child components, the Web Worker client
// (replaced by an in-process call to the real optimizeFull) and the network (requestFirstContact).
import { createRenderer, defineComponent, h, ref } from 'vue';

export interface FakeEl {
  tag: string;
  children: FakeEl[];
  parent: FakeEl | null;
  props: Record<string, unknown>;
  text?: string;
}

function makeRenderer() {
  return createRenderer<FakeEl, FakeEl>({
    patchProp: (el, key, _prev, next) => {
      el.props[key] = next;
    },
    insert: (child, parent, anchor) => {
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = parent;
      const i = anchor ? parent.children.indexOf(anchor) : -1;
      if (i >= 0) parent.children.splice(i, 0, child);
      else parent.children.push(child);
    },
    remove: child => {
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = null;
    },
    createElement: tag => ({ tag, children: [], parent: null, props: {} }),
    createText: text => ({ tag: '#text', children: [], parent: null, props: {}, text }),
    createComment: text => ({ tag: '#comment', children: [], parent: null, props: {}, text }),
    setText: (n, text) => {
      n.text = text;
    },
    setElementText: (el, text) => {
      el.children = [];
      el.text = text;
    },
    parentNode: n => n.parent,
    nextSibling: n => {
      const p = n.parent;
      if (!p) return null;
      return p.children[p.children.indexOf(n) + 1] ?? null;
    },
  });
}

export interface SidebarHandle {
  props: Record<string, any>;
  emit: (event: string, ...args: any[]) => void;
}

export function makeStubComponents() {
  const g = globalThis as any;
  const sidebar: { current: SidebarHandle | null } = (g.__b5sidebar ??= { current: null });
  const Sidebar = defineComponent({
    props: ['playerId', 'exportBlocked', 'waitTimeDays', 'timeBudgetInvalid'],
    emits: ['submitPlayerId', 'update:waitTimeDays'],
    setup(props, { emit }) {
      sidebar.current = { props, emit: emit as any };
      return () => h('sidebar');
    },
  });
  const Card = defineComponent({
    props: ['solution', 'maxWaitTimeSeconds', 'hasInventory', 'goldenEggBalance', 'targets', 'planCost', 'overProvisioned'],
    setup: () => () => h('card'),
  });
  const Panel = defineComponent({ props: ['tree', 'hasInventory'], setup: () => () => h('panel') });
  return { sidebar, Sidebar, Card, Panel };
}

/** Mounts the real component inside a wrapper whose `artifactIds` are driven by a ref. */
export function mountOptimizer(Component: any, artifactIds: string[]) {
  const { createApp } = makeRenderer();
  const root: FakeEl = { tag: 'root', children: [], parent: null, props: {} };
  const ids = ref<string[]>(artifactIds);
  const inst = ref<any>(null);
  const Wrapper = defineComponent({ setup: () => () => h(Component, { artifactIds: ids.value, ref: inst }) });
  const app = createApp(Wrapper);
  // vitest transforms SFCs in SSR mode here, and the SSR output registers itself on this context.
  app.provide(Symbol.for('v-scx'), { modules: new Set() });
  app.mount(root);
  const handle = { app, ids, inst, root, unmount: () => app.unmount() };
  ((globalThis as any).__b5mounts ??= []).push(handle);
  return handle;
}

/** Unmounts everything a failed (thrown) test left behind, so stale solves cannot bleed into the next test. */
export function unmountAll() {
  const l: any[] = (globalThis as any).__b5mounts ?? [];
  for (const h of l.splice(0)) {
    try {
      h.unmount();
    } catch {
      /* already unmounted */
    }
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits out the 250ms debounce and the solve. */
export async function settle(inst: { value: any }, minMs = 400, maxMs = 90000) {
  await sleep(minMs);
  const t0 = Date.now();
  while (inst.value?.computing && Date.now() - t0 < maxMs) await sleep(50);
  await sleep(50);
}

/** A minimal save the store accepts: game + artifactsDb. */
export function makeBackup(eid: string, opts: { craftingXp?: number; tankLevel?: number; ftl?: number } = {}): any {
  return {
    eiUserId: eid,
    game: {
      epicResearch: [
        { id: 'afx_mission_time', level: opts.ftl ?? 0 },
        { id: 'afx_mission_capacity', level: 0 },
      ],
      goldenEggsEarned: 1000,
      goldenEggsSpent: 0,
    },
    artifactsDb: {},
    artifacts: { craftingXp: opts.craftingXp ?? 0, tankLevel: opts.tankLevel ?? 0 },
  };
}

/** lib/utils reads and writes `localStorage[key]` as plain properties, so this is a plain object. */
export function memoryStorage(): Record<string, any> {
  const o: Record<string, any> = {};
  Object.defineProperty(o, 'removeItem', { value: (k: string) => void delete o[k], enumerable: false });
  return o;
}
