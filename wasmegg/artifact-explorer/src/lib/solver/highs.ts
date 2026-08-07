// HiGHS as WebAssembly (`highs`, lovasoa/highs-js): the loader, and the text
// interface it insists on.
//
// This is the build that ships. It is the same C++ solver, compiled to wasm, so
// it runs in the browser this app is with no native toolchain and no install
// step. What it costs is the interface — the wasm module exposes one entry
// point, `solve(text)`, taking a model in CPLEX LP format — so every solve pays
// for serializing the matrix to text and having HiGHS parse it back. Measured,
// that is 75-85% of a *continuous* call but under 5% of an expensive MILP one,
// which is why the native addon this used to be compared against is gone: the
// thing it removed was never the expensive part.
//
// One thing about that entry point is worth knowing before trusting an option
// to it. It reads the model *first* and applies the options afterwards:
//
//     FS.writeFile(MODEL_FILENAME, model_str);
//     Highs_readModel(highs, MODEL_FILENAME);
//     for (const name in options) setOption(highs, name, options[name]);
//     Highs_run(highs);
//
// So anything governing how a model is *ingested* — `small_matrix_value`,
// `large_matrix_value`, `infinite_bound` — is set too late here and silently
// does nothing, while anything governing the solve (the feasibility tolerances,
// the node budget, the seed) applies normally. `milp.ts` scales its rows rather
// than relying on the first group; see `SAFE_COEFFICIENT` there.

import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import { INF, SOLVER_OPTIONS, type MilpModel, type MilpSolution, type MilpSolve } from './solver';

// Asset resolution, and the reason this module is loaded rather than imported.
//
// Left to itself the Emscripten loader looks for `highs.wasm` beside its own
// glue, which is right under Node and wrong inside a bundled worker, where the
// glue has been rewritten into a chunk somewhere else entirely. Handing it the
// URL explicitly lets Vite emit and fingerprint the file like any other asset.
//
// In the browser `wasmUrl` is a URL the loader can fetch: an emitted asset in a
// build, a `/@fs/...` dev-server path under `vite dev` and under Vitest. In Node
// there is no server to answer that path and the loader reads from disk, so the
// dev prefix has to come back off.
// On Windows that path is `/@fs/C:/...`, and stripping only the prefix leaves a
// leading slash the loader cannot open, so a drive letter takes the slash too.
const wasmLocation = (() => {
  if (typeof self !== 'undefined' || !wasmUrl.startsWith('/@fs/')) return wasmUrl;
  const path = wasmUrl.slice('/@fs'.length);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
})();

let cached: Promise<MilpSolve> | null = null;

// One module instance per realm, loaded on first use: the wasm is 3.4MB and
// most sessions never ask for this solver.
//
// Nothing here is stateful across solves — `solve` builds a fresh model string
// every call — so the sharing is of the module, not of any search state.
export function loadHighs(): Promise<MilpSolve> {
  cached ??= highsLoader({ locateFile: () => wasmLocation })
    .then(
      (highs): MilpSolve =>
        (model, limits) =>
          readSolution(
            model,
            highs.solve(writeLp(model), {
              ...SOLVER_OPTIONS,
              mip_max_nodes: limits.maxNodes,
              mip_rel_gap: limits.relGap,
            } as Parameters<typeof highs.solve>[1])
          )
    )
    .catch((error: unknown) => {
      // What is cached is the promise, not the module, so a rejected one would
      // stay cached and every later solve in the session would fail with the
      // same error. A dropped fetch of a 3.4MB asset must not disable the
      // planner until the page is reloaded.
      cached = null;
      throw error;
    });
  return cached;
}

// Shortest round-trippable form; the LP reader takes scientific notation.
function num(value: number): string {
  if (value >= INF) return '+inf';
  if (value <= -INF) return '-inf';
  return String(value);
}

function term(coefficient: number, column: number): string {
  return coefficient < 0 ? ` - ${num(-coefficient)} x${column}` : ` + ${num(coefficient)} x${column}`;
}

// CPLEX LP format. Wrapped every few terms because the format is line-oriented
// and readers have historically had opinions about very long lines.
const TERMS_PER_LINE = 8;

export function writeLp(model: MilpModel): string {
  const out: string[] = ['Maximize'];

  const objective: string[] = [];
  for (let j = 0; j < model.columnCount; j++) {
    if (model.objective[j] !== 0) objective.push(term(model.objective[j], j));
  }
  // An empty objective is legal but has no syntax; anchor it on a zero term.
  if (objective.length === 0) objective.push(' 0 x0');
  out.push(` obj:${objective[0]}`);
  for (let i = 1; i < objective.length; i += TERMS_PER_LINE) {
    out.push(objective.slice(i, i + TERMS_PER_LINE).join(''));
  }

  out.push('Subject To');
  for (let r = 0; r < model.rowCount; r++) {
    const start = model.offsets[r];
    const end = r + 1 < model.rowCount ? model.offsets[r + 1] : model.indices.length;
    if (end <= start) continue;
    const terms: string[] = [];
    for (let k = start; k < end; k++) terms.push(term(model.values[k], model.indices[k]));

    const lo = model.rowLower[r];
    const up = model.rowUpper[r];
    // Every row this model builds is one-sided or an equality; a genuinely
    // two-sided row is split so no reader has to support ranges.
    const relations: string[] =
      lo === up ? [`= ${num(lo)}`] : [...(up < INF ? [`<= ${num(up)}`] : []), ...(lo > -INF ? [`>= ${num(lo)}`] : [])];
    if (relations.length === 0) continue; // free row: carries no information

    relations.forEach((relation, i) => {
      out.push(` r${r}_${i}:${terms[0]}`);
      for (let k = 1; k < terms.length; k += TERMS_PER_LINE) {
        out.push(terms.slice(k, k + TERMS_PER_LINE).join(''));
      }
      out.push(` ${relation}`);
    });
  }

  out.push('Bounds');
  for (let j = 0; j < model.columnCount; j++) {
    const lo = model.columnLower[j];
    const up = model.columnUpper[j];
    if (lo === 0 && up >= INF) continue; // the format's default
    if (lo <= -INF && up >= INF) out.push(` x${j} free`);
    else out.push(` ${num(lo)} <= x${j} <= ${num(up)}`);
  }

  const integers: string[] = [];
  for (let j = 0; j < model.columnCount; j++) {
    if (model.columnIsInteger[j]) integers.push(`x${j}`);
  }
  if (integers.length > 0) {
    out.push('General');
    for (let i = 0; i < integers.length; i += 16) out.push(` ${integers.slice(i, i + 16).join(' ')}`);
  }

  out.push('End');
  return out.join('\n');
}

// Structurally what the `highs` package returns. Named here rather than
// imported because the package's own solution types are module-private.
export interface RawHighsSolution {
  Status: string;
  ObjectiveValue: number;
  // `Index` is declared but never read — see `readSolution` on why the name is
  // the only reliable key. It is here because an infeasible solve returns
  // columns carrying no `Primal` at all, and a type whose properties are all
  // optional and all absent from that shape is rejected as a weak type.
  Columns: Record<string, { Primal?: number; Index?: number }>;
}

export function readSolution(model: MilpModel, solution: RawHighsSolution): MilpSolution {
  // Keyed by *name*, deliberately. The `Index` a solution reports is the
  // column's position in the LP file, which is the order the reader first saw
  // it in — not the order this model built its columns in. A column that is
  // absent from the file (no objective, no bound, no coefficient anywhere) is
  // absent from the solution too, and its zero is already in place.
  const columnValues = new Float64Array(model.columnCount);
  let hasPrimal = false;
  for (const [name, column] of Object.entries(solution.Columns)) {
    if (typeof column.Primal !== 'number') continue;
    const j = Number(name.slice(1));
    if (!Number.isInteger(j) || j < 0 || j >= model.columnCount) continue;
    columnValues[j] = column.Primal;
    hasPrimal = true;
  }

  let status: MilpSolution['status'];
  if (solution.Status === 'Optimal' || solution.Status === 'Empty') status = 'optimal';
  else if (solution.Status === 'Infeasible' || solution.Status === 'Primal infeasible or unbounded') {
    status = 'infeasible';
  } else status = hasPrimal ? 'feasible' : 'unknown';

  return { status, objective: solution.ObjectiveValue, columnValues };
}
