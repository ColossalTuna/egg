// Worker entry point for the mission-plan search.
//
// Imports optimizeFull directly rather than the lib barrel: the barrel
// re-exports the ~18MB loot dataset, which this bundle has no use for.
//
// The planner is a WebAssembly MILP, so the first request in a worker's life
// pays to fetch and instantiate it; the rest resolve off a cached promise. That
// is also why this file is the only place the solve is awaited — everything
// below the seam is synchronous.

import { optimizeFull } from './optimizer-core';
import {
  optionsFromWire,
  solutionsToWire,
  type OptimizerRequest,
  type OptimizerResponse,
} from './optimizer-worker-protocol';

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<OptimizerRequest>) => {
  const req = e.data;
  let response: OptimizerResponse;
  try {
    const solution = await optimizeFull({
      options: optionsFromWire(req.options),
      recipeDag: req.recipeDag,
      desiredArtifactNodeIds: req.desiredArtifactNodeIds,
      fuelCapacity: req.fuelCapacity,
      timeCapacity: req.timeCapacity,
      baseYield: req.baseYield,
    });
    response = { id: req.id, ok: true, solutions: solutionsToWire([solution]) };
  } catch (err) {
    // Without this a failed solve never resolves and the UI spins forever.
    response = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.postMessage(response);
};
