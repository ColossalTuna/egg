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

// Ids only ever increase, so anything below the newest one seen has already
// been superseded on the main thread. A solve is about a second and the UI
// posts one per input change, so without this a user editing three fields pays
// for three full solves and the client discards the first two on arrival.
//
// The yield below is what makes the check mean anything. `solveWith` is
// synchronous, so it blocks this thread for the whole solve and the queued
// messages behind it are not dispatched until it returns — every request would
// otherwise observe itself as the newest one. Handing control back to the event
// loop once drains the queue first, so a superseded request can see that it is.
//
// The reply still goes out. `optimizer-client` settles every id it has pending
// and resolves a superseded one to null, so dropping the message rather than
// answering it would leave that promise hanging forever.
let newestId = 0;
const drainQueue = () => new Promise<void>(resolve => setTimeout(resolve, 0));

ctx.onmessage = async (e: MessageEvent<OptimizerRequest>) => {
  const req = e.data;
  if (req.id > newestId) newestId = req.id;
  let response: OptimizerResponse;
  try {
    await drainQueue();
    if (req.id < newestId) {
      ctx.postMessage({ id: req.id, ok: true, solutions: [] } satisfies OptimizerResponse);
      return;
    }
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
