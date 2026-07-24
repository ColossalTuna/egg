// Main-thread client for the optimizer worker.
//
// One worker is reused across runs (spinning one up per solve would pay the
// loot-data bundle cost every time). Requests are numbered and only the newest
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
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });

  let nextId = 1;
  let latestId = 0;
  const pending = new Map<number, { resolve(v: OptimizerSolution[] | null): void; reject(e: Error): void }>();

  worker.onmessage = (e: MessageEvent<OptimizerResponse>) => {
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

  worker.onerror = e => {
    // A worker-level failure (bundle load, uncaught throw) kills every request
    // in flight; failing them individually keeps callers from hanging.
    const err = new Error(e.message || 'optimizer worker failed');
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  };

  return {
    run(input: OptimizerRequestInput): Promise<OptimizerSolution[] | null> {
      const id = nextId++;
      latestId = id;
      const request: OptimizerRequest = { ...input, id, options: optionsToWire(input.options) };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage(request);
      });
    },
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}
