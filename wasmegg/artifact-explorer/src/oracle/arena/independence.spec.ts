// The arena is only worth running if the harness and the candidates cannot see
// each other. That is a property of the import graph, so it is asserted here
// rather than left to review.
//
// Two directions, and they fail for different reasons:
//
//   harness -> solver   would mean the harness is testing one specific
//                       implementation again, which is the thing this branch
//                       exists to undo
//   solver -> judge     would let a candidate read or tune against the scoring
//                       code and the feasibility rule it is being graded by

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ARENA = __dirname;

function readSource(rel: string): string {
  return readFileSync(resolve(ARENA, rel), 'utf8');
}

function importsOf(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = bare.exec(source)) !== null) out.push(m[1]);
  // A dynamic import and a re-export move the same bindings a static import
  // does. This file itself reaches `./registry` through the first form, so a
  // candidate could reach the judge the same way and leave the guard green.
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamic.exec(source)) !== null) out.push(m[1]);
  const reexport = /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  while ((m = reexport.exec(source)) !== null) out.push(m[1]);
  return out;
}

// Type-only imports move no code and cannot change behaviour, so they are not
// a coupling. This strips the `import type { X } from ...` statement form only;
// an inline `import { type X }` is still reported as a value import, which errs
// towards flagging a coupling that is not one rather than missing one that is.
function valueImportsOf(source: string): string[] {
  const withoutTypeImports = source.replace(/(?:^|\n)\s*import\s+type\s[^;]*?;/g, '\n');
  return importsOf(withoutTypeImports);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Files that make up the fixed part of the arena: the problem, the rules, the
// judge and the scoreboard.
const HARNESS_FILES = [
  'contract.ts',
  'harness.ts',
  'instances.ts',
  'invariants.ts',
  'pack-feasibility.ts',
  'scorecard.ts',
];

// Modules that are, or belong to, a solver implementation.
const IMPLEMENTATION = [
  'optimizer-core',
  'optimizer-tree',
  'optimizer-views',
  'optimizer-client',
  'optimizer.worker',
  'value-function',
  '/lp',
  'lib/lp',
  'lib/packing',
];

describe('arena independence', () => {
  it('the harness imports no solver implementation', () => {
    const offenders: string[] = [];
    for (const file of HARNESS_FILES) {
      for (const spec of valueImportsOf(readSource(file))) {
        if (IMPLEMENTATION.some(bad => spec.includes(bad))) {
          offenders.push(`${file} imports ${spec}`);
        }
        if (spec.includes('/solvers/') || spec.includes('./solvers') || spec.includes('registry')) {
          offenders.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the harness names no solver', () => {
    // `registry.ts` is the only file allowed to know which candidates exist.
    const offenders: string[] = [];
    for (const file of HARNESS_FILES) {
      const src = readSource(file);
      if (/\bhighs\b/.test(src)) offenders.push(`${file} mentions a solver id`);
    }
    expect(offenders).toEqual([]);
  });

  it('no solver imports the judge, the feasibility rule or the checks', () => {
    const forbidden = ['evaluate', 'pack-feasibility', 'invariants', 'scorecard', 'harness', 'instances'];
    const offenders: string[] = [];
    for (const path of walk(join(ARENA, 'solvers'))) {
      for (const spec of valueImportsOf(readFileSync(path, 'utf8'))) {
        if (forbidden.some(bad => spec.includes(bad))) {
          offenders.push(`${path.slice(ARENA.length + 1)} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // No exemptions any more. There used to be two: `baseline-main` wrapped
  // `src/lib`'s `optimizeFull` on purpose, because it *was* the control, and
  // `optimizer-adapter` was the shim it came through. Both are gone with the
  // search they wrapped, so every file under `solvers/` is now a candidate and
  // gets `PlanProblem` and nothing more.
  //
  // Note the direction this leaves. `src/lib/optimizer-core.ts` imports the
  // `highs` solver, which is what makes the shipped planner and the measured one
  // the same code. That is intended. What is forbidden is the reverse: a
  // candidate reaching into `src/lib` and measuring the app's machinery wearing
  // a different hat.

  it('candidates re-derive everything: no value import from src/lib', () => {
    // Types move no code, so `import type { LaunchOption } from ...` is fine
    // and is how a candidate reads the problem at all. What is excluded is
    // running any of the incumbent's machinery — its LP, its tangent grid, its
    // packer, its search. A candidate that called into those would be measuring
    // the incumbent's method wearing a different hat.
    const offenders: string[] = [];
    for (const path of walk(join(ARENA, 'solvers'))) {
      const rel = path.slice(join(ARENA, 'solvers').length + 1);
      for (const spec of valueImportsOf(readFileSync(path, 'utf8'))) {
        // `@/lib/...` and any relative path that climbs into `src/lib`. The
        // bare `lib` workspace package is game data (egg/ship/artifact enums
        // and tables), not solver code, so it stays available.
        if (/^@\/lib(\/|$)/.test(spec) || /(^|\/)\.\.\/lib\//.test(spec)) {
          offenders.push(`${rel} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the feasibility rule stands alone', () => {
    // It is the goalpost for C1 and for every k-opt move, so it must not be
    // reachable from anything a candidate can change.
    expect(importsOf(readSource('pack-feasibility.ts'))).toEqual([]);
  });

  it('every registered solver has a distinct id', () => {
    // Imported lazily so this file stays runnable if a candidate fails to load.
    return import('./registry').then(({ SOLVERS }) => {
      const ids = SOLVERS.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(id => /^[a-z0-9-]+$/.test(id))).toBe(true);
    });
  });
});
