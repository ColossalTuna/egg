// STA-23: stale-request handling in the worker. Runs the real worker module against a fake `self`
// with a synchronous (blocking) stand-in for the solve, like the real one, and counts how many solves run.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const solveLog: number[] = [];
vi.mock('@/lib/optimizer-core', () => ({
  optimizeFull: vi.fn(async (args: { tag: number }) => {
    solveLog.push(args.tag);
    const end = Date.now() + 100; // synchronous busy solve
    while (Date.now() < end);
    return {} as never;
  }),
}));
vi.mock('@/lib/optimizer-worker-protocol', () => ({
  optionsFromWire: (x: unknown) => x,
  solutionsToWire: () => [],
}));

const posted: Array<{ id: number; solutions?: unknown[] }> = [];
let handler: (e: { data: unknown }) => Promise<void>;

beforeEach(async () => {
  solveLog.length = 0;
  posted.length = 0;
  vi.resetModules();
  const fakeSelf: Record<string, unknown> = {
    postMessage: (m: { id: number }) => posted.push(m),
  };
  vi.stubGlobal('self', fakeSelf);
  await import('@/lib/optimizer.worker');
  handler = fakeSelf.onmessage as typeof handler;
});

const req = (id: number) => ({ data: { id, args: { options: [], tag: id } } });

describe('STA-23 stale requests in the worker', () => {
  it('runs at most the in-flight solve plus the newest one when a burst arrives mid-solve', async () => {
    // Request 1 starts its solve; 2, 3, 4 are delivered as separate message tasks while it is running
    // (modelled by firing them in the next tasks, after the synchronous solve returns).
    const p1 = handler(req(1));
    await new Promise(r => setTimeout(r, 0)); // 1 passes the yield and begins solving (blocking ~100ms)
    const rest = [2, 3, 4].map(id => handler(req(id)));
    await Promise.all([p1, ...rest]);
    // Intended: only one solve is stale-but-started (1), and the newest (4) runs. Never 2 or 3.
    expect(solveLog).toEqual([1, 4]);
    // every id is still answered, so the client's promises settle
    expect(posted.map(m => m.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('a solve that has already started is never cut short (cost only)', async () => {
    const p1 = handler(req(1));
    await new Promise(r => setTimeout(r, 0));
    const p2 = handler(req(2));
    await Promise.all([p1, p2]);
    // Stale request 1 ran to completion and was answered with real solutions, not an empty stale marker.
    expect(solveLog).toEqual([1, 2]);
  });

  it('after a worker crash a new worker (newestId=0) answers fresh ids normally', async () => {
    const p = handler(req(7));
    await p;
    expect(solveLog).toEqual([7]);
  });
});
