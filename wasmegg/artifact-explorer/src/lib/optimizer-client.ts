// Main-thread client for the optimizer worker.
//
// One worker is reused across runs (spinning one up per solve would pay the
// loot-data bundle cost every time); it is created on the first run and
// replaced only if it dies. Requests are numbered and only the newest
// one's result is delivered: with auto-compute on, a burst of input changes
// queues several solves behind each other, and every result but the last
// describes settings the user has already moved past.

import {
  optionsToWire,
  solutionsFromWire,
  type OptimizerRequest,
  type OptimizerResponse,
} from './optimizer-worker-protocol';
import type { LaunchOption, OptimizerSolution, RecipeDAG } from './types';

// What callers pass: real LaunchOptions, converted to the wire form here so
// the protocol's ship-narrowing stays an implementation detail of this seam.
export interface OptimizerRequestInput {
  options: LaunchOption[];
  recipeDag: RecipeDAG;
  desiredArtifactNodeIds: string[];
  fuelCapacity: number;
  timeCapacity: number;
  baseYield: Map<string, number>;
}

export interface OptimizerClient {
  // Resolves with the solutions for this request, or with null if a newer
  // request superseded it before it finished.
  run(input: OptimizerRequestInput): Promise<OptimizerSolution[] | null>;
  terminate(): void;
}

export function createOptimizerClient(): OptimizerClient {
  let nextId = 1;
  let latestId = 0;
  const pending = new Map<number, { resolve(v: OptimizerSolution[] | null): void; reject(e: Error): void }>();

  // The live worker, or null when there isn't one: before the first run(),
  // after a worker-level failure, and after terminate(). Request ids keep
  // counting across workers, so a reply can never be mistaken for one destined
  // to a different generation of the same client.
  let worker: Worker | null = null;
  let terminated = false;

  function spawn(): Worker {
    const w = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<OptimizerResponse>) => {
      // A worker we've already discarded can still have a message sitting in
      // the queue at the moment we drop it; its answer describes a run this
      // client has given up on, so nothing it says may settle a request
      // belonging to its replacement.
      if (w !== worker) return;
      const res = e.data;
      const entry = pending.get(res.id);
      if (!entry) return;
      pending.delete(res.id);
      if (res.id !== latestId) {
        entry.resolve(null); // superseded
        return;
      }
      if (res.ok) entry.resolve(solutionsFromWire(res.solutions));
      else entry.reject(new Error(res.error));
    };
    w.onerror = e => {
      if (w !== worker) return;
      // A worker-level failure (bundle load, OOM, uncaught throw) kills every
      // request in flight; failing them individually keeps callers from
      // hanging. The worker itself doesn't recover, so drop it here -- posting
      // into a dead worker is silently ignored, which would strand every later
      // request -- and let the next run() spawn a replacement. Recovering that
      // way matters because callers hold onto one client for the lifetime of
      // the page; a single failure used to poison every subsequent solve until
      // a full reload.
      const err = new Error(e.message || 'optimizer worker failed');
      worker = null;
      w.terminate();
      for (const [, entry] of pending) entry.reject(err);
      pending.clear();
    };
    return w;
  }

  return {
    run(input: OptimizerRequestInput): Promise<OptimizerSolution[] | null> {
      // After teardown there is deliberately no respawn: null is the "no result
      // is coming, leave state alone" signal terminate() itself uses, and
      // resurrecting a worker for a client the caller has already disposed of
      // would leak one past unmount.
      if (terminated) return Promise.resolve(null);
      const w = (worker ??= spawn());
      const id = nextId++;
      latestId = id;
      const request: OptimizerRequest = { ...input, id, options: optionsToWire(input.options) };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage(request);
      });
    },
    terminate() {
      terminated = true;
      worker?.terminate();
      worker = null;
      // Settle whatever was in flight rather than dropping it: a cleared entry
      // is a promise nobody will ever resolve, which strands its awaiting frame.
      // null (rather than reject) is the "no result is coming, leave state
      // alone" signal callers already handle for superseded requests -- a
      // rejection here would surface teardown as a solve error instead.
      for (const [, entry] of pending) entry.resolve(null);
      pending.clear();
    },
  };
}
