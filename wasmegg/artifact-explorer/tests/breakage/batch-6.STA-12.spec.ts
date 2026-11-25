// STA-12: a failed postMessage leaves a stale entry in the client's `pending` map.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOptimizerClient } from '@/lib/optimizer-client';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  posted: unknown[] = [];
  failNext = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown) {
    if (this.failNext) {
      this.failNext = false;
      const err = new Error('Failed to execute postMessage: #<Map> could not be cloned.');
      err.name = 'DataCloneError';
      throw err;
    }
    this.posted.push(msg);
  }
  terminate() {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

const input = {
  options: [],
  recipeDag: new Map(),
  desiredArtifactNodeIds: [],
  fuelCapacity: 1,
  maximumCost: 1,
  ownedStock: new Map(),
} as never;

describe('STA-12 optimizer-client pending cleanup', () => {
  it('does not leave an entry in pending when postMessage throws', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    // Capture the entry the client stores in its private `pending` Map.
    const entries: Array<{ reject: (e: Error) => void }> = [];
    const realSet = Map.prototype.set;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === 'number' && v && typeof (v as { reject?: unknown }).reject === 'function') {
        entries.push(v as { reject: (e: Error) => void });
      }
      return realSet.call(this, k, v);
    });

    const client = createOptimizerClient();
    // Spawn the worker with a harmless first call so we can flag the next post as failing.
    const first = client.run(input);
    first.catch(() => {});
    const w = FakeWorker.instances[0];
    w.failNext = true;
    await expect(client.run(input)).rejects.toThrow(/could not be cloned/); // cause is named
    vi.restoreAllMocks();

    expect(entries.length).toBe(2);
    const leaked = entries[1];
    const leakedReject = vi.fn();
    leaked.reject = leakedReject;
    // Worker dies: onerror rejects every entry still in pending.
    w.onerror!({ message: 'worker crashed' });
    // BREAKAGE STA-12: the failed request's entry should already have been removed.
    expect(leakedReject).not.toHaveBeenCalled();
    await expect(first).rejects.toThrow(/worker crashed/);
  });
});
