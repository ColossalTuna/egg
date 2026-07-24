// Worker entry point for the mission-plan search.
//
// A single-target plan solves in well under 100ms, but the multi-target joint
// search runs in seconds; running either on the main thread blocks paint, so
// the search lives here and the UI stays responsive (and can render a real
// progress state) while it runs.
//
// This imports optimizeFull directly rather than the lib barrel: the barrel
// re-exports the loot dataset, which would put an 18MB copy of it in this
// bundle for no reason (see optimizer-worker-protocol.ts).

import { optimizeFull } from './optimizer-core';
import {
  optionsFromWire,
  solutionsToWire,
  type OptimizerRequest,
  type OptimizerResponse,
} from './optimizer-worker-protocol';

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<OptimizerRequest>) => {
  const req = e.data;
  let response: OptimizerResponse;
  try {
    const solution = optimizeFull({
      options: optionsFromWire(req.options),
      recipeDag: req.recipeDag,
      desiredArtifactNodeIds: req.desiredArtifactNodeIds,
      fuelCapacity: req.fuelCapacity,
      timeCapacity: req.timeCapacity,
      baseYield: req.baseYield,
    });
    response = { id: req.id, ok: true, solutions: solutionsToWire([solution]) };
  } catch (err) {
    // The client turns this back into a thrown error; without it a failed
    // solve would simply never resolve and the UI would spin forever.
    response = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.postMessage(response);
};
