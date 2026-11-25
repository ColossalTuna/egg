// SEAM-18: does the existing seam spec notice a change in what makespanSeconds means?
// Mutation: tests/breakage/batch-3.mutant-write.ts makes the writer emit the raw makespan instead.
// The hypothesis says both specs still pass. Result: the explorer spec fails (its hand-built solution
// carries 950400/933120 and the comparison is an exact toEqual), so the stated example IS caught.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('SEAM-18 mutation of the writer', () => {
  it('plan-seam.spec.ts fails when the writer writes raw makespan', () => {
    const run = spawnSync(
      'npx',
      ['vitest', 'run', '-c', 'tests/breakage/batch-3.mutant.vitest.config.ts', '--reporter=dot'],
      { cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8' }
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/reproduces the checked-in file for the first visit/);
  });
});
