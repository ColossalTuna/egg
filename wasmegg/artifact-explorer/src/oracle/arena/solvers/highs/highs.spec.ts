// The LP-format writer is the one place in this solver where a bug is silent.
// Everything else fails loudly — a bad bound is infeasible, a bad
// objective is a bad plan the judge catches — but a row that serializes wrong
// just means HiGHS cheerfully solves a different problem and hands back an
// answer that looks fine.
//
// So: build models in memory, solve them through the wasm backend, and check the
// solution against the *in-memory* model rather than against the text. A dropped
// row, a sign flip, a lost bound or a mangled coefficient all show up as a
// returned point that does not satisfy the model it was supposed to come from.
//
// Deliberately no harness and no instance generation here; these are synthetic
// models chosen to exercise the writer's branches.

import { describe, expect, it } from 'vitest';
import { INF, type MilpModel, type MilpSolve } from './solver';
import { loadHighs } from './highs';

const solve: MilpSolve = await loadHighs();

interface Row {
  // column -> coefficient
  terms: Record<number, number>;
  lower: number;
  upper: number;
}

function model(
  columns: { lower: number; upper: number; integer?: boolean; objective?: number }[],
  rows: Row[]
): MilpModel {
  const offsets: number[] = [];
  const indices: number[] = [];
  const values: number[] = [];
  for (const row of rows) {
    offsets.push(indices.length);
    for (const [column, coefficient] of Object.entries(row.terms)) {
      indices.push(Number(column));
      values.push(coefficient);
    }
  }
  return {
    columnCount: columns.length,
    columnLower: Float64Array.from(columns.map(c => c.lower)),
    columnUpper: Float64Array.from(columns.map(c => c.upper)),
    columnIsInteger: Uint8Array.from(columns.map(c => (c.integer ? 1 : 0))),
    objective: Float64Array.from(columns.map(c => c.objective ?? 0)),
    rowCount: rows.length,
    rowLower: Float64Array.from(rows.map(r => r.lower)),
    rowUpper: Float64Array.from(rows.map(r => r.upper)),
    offsets: Int32Array.from(offsets),
    indices: Int32Array.from(indices),
    values: Float64Array.from(values),
  };
}

// Slack for float comparisons, in the units of whatever is being compared.
const TOL = 1e-6;

function expectSatisfies(m: MilpModel, x: Float64Array): void {
  for (let j = 0; j < m.columnCount; j++) {
    expect(x[j], `column ${j} lower bound`).toBeGreaterThanOrEqual(m.columnLower[j] - TOL);
    expect(x[j], `column ${j} upper bound`).toBeLessThanOrEqual(m.columnUpper[j] + TOL);
    if (m.columnIsInteger[j]) {
      expect(Math.abs(x[j] - Math.round(x[j])), `column ${j} integrality`).toBeLessThan(TOL);
    }
  }
  for (let r = 0; r < m.rowCount; r++) {
    const start = m.offsets[r];
    const end = r + 1 < m.rowCount ? m.offsets[r + 1] : m.indices.length;
    let activity = 0;
    for (let k = start; k < end; k++) activity += m.values[k] * x[m.indices[k]];
    const scale = Math.max(1, Math.abs(m.rowLower[r]), Math.abs(m.rowUpper[r]));
    expect(activity, `row ${r} lower bound`).toBeGreaterThanOrEqual(m.rowLower[r] - TOL * scale);
    expect(activity, `row ${r} upper bound`).toBeLessThanOrEqual(m.rowUpper[r] + TOL * scale);
  }
}

function objectiveOf(m: MilpModel, x: Float64Array): number {
  let total = 0;
  for (let j = 0; j < m.columnCount; j++) total += m.objective[j] * x[j];
  return total;
}

describe('the LP-format writer round-trips the model', () => {
  it('carries bounds, integrality and an upper-bounded row', () => {
    // max x + y  st  x + 2y <= 4,  x <= 3,  both integer.
    const m = model(
      [
        { lower: 0, upper: 3, integer: true, objective: 1 },
        { lower: 0, upper: 10, integer: true, objective: 1 },
      ],
      [{ terms: { 0: 1, 1: 2 }, lower: -INF, upper: 4 }]
    );
    const solution = solve(m, { maxNodes: 1000, relGap: 1e-9 });
    expect(solution.status).toBe('optimal');
    expectSatisfies(m, solution.columnValues);
    expect(solution.objective).toBeCloseTo(3, 6);
    expect(objectiveOf(m, solution.columnValues)).toBeCloseTo(solution.objective, 6);
  });

  it('carries equality rows, negative coefficients and a free column', () => {
    // The shape the real model uses for its score rows: an equality tying a free
    // column to a weighted sum of bounded ones, with the weights negated.
    const m = model(
      [
        { lower: 0, upper: 5, integer: true },
        { lower: 0, upper: 5, integer: true },
        { lower: -INF, upper: INF, objective: 1 },
      ],
      [
        { terms: { 2: 1, 0: -2, 1: -3 }, lower: 0, upper: 0 },
        { terms: { 0: 1, 1: 1 }, lower: -INF, upper: 4 },
        { terms: { 0: 1, 1: -1 }, lower: 0, upper: INF },
      ]
    );
    const solution = solve(m, { maxNodes: 1000, relGap: 1e-9 });
    expect(solution.status).toBe('optimal');
    expectSatisfies(m, solution.columnValues);
    // x0 >= x1, x0 + x1 <= 4, maximize 2 x0 + 3 x1 -> (2, 2), worth 10.
    expect(solution.objective).toBeCloseTo(10, 6);
  });

  it('survives the coefficient range the cuts actually use', () => {
    // Tangent slopes run from 1 down at the top of the grid to 1e7 at the
    // bottom, alongside slot rows in raw seconds (~1e6) and fuel costs (~1e-3).
    // If the writer's number formatting lost precision anywhere in that range,
    // the returned point would miss the rows it came from.
    const m = model(
      [
        { lower: 0, upper: 100, integer: true },
        { lower: -INF, upper: 0, objective: 1 },
      ],
      [
        { terms: { 0: 1234.5678 }, lower: -INF, upper: 2592000 },
        { terms: { 0: 0.001371742112482853 }, lower: -INF, upper: 1 },
        { terms: { 1: 1, 0: -1e-7 }, lower: -INF, upper: -3.5e-6 },
        { terms: { 1: 1, 0: -1e7 }, lower: -INF, upper: 4.25 },
      ]
    );
    const solution = solve(m, { maxNodes: 1000, relGap: 1e-9 });
    expect(solution.status).toBe('optimal');
    expectSatisfies(m, solution.columnValues);
    expect(objectiveOf(m, solution.columnValues)).toBeCloseTo(solution.objective, 6);
  });

  it('reports infeasibility rather than a plausible-looking point', () => {
    const m = model(
      [{ lower: 2, upper: 5, integer: true, objective: 1 }],
      [{ terms: { 0: 1 }, lower: -INF, upper: 1 }]
    );
    expect(solve(m, { maxNodes: 1000, relGap: 1e-9 }).status).toBe('infeasible');
  });
});
