// Exact-arithmetic primal simplex for the oracle. Solves
//   maximize c.x  subject to  A x <= b, x >= 0,  with b >= 0
// using dense tableau pivoting and Bland's rule (guaranteed termination).
// Instances here are tiny (a handful of craft variables and item
// constraints), so exactness is affordable and removes any float-tolerance
// ambiguity from the oracle's side of the comparison.

import { Frac } from './rational';

// Float twin of simplexMaximize, used to rank candidate allocations cheaply;
// the winner is re-evaluated exactly. Same algorithm, epsilon pivoting.
export function simplexMaximizeFloat(A: number[][], b: number[], c: number[]): number {
  const EPS = 1e-9;
  const m = A.length;
  const n = c.length;
  const width = n + m + 1;
  const T: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(width).fill(0);
    for (let j = 0; j < n; j++) {
      row[j] = A[i][j];
    }
    row[n + i] = 1;
    row[width - 1] = b[i];
    T.push(row);
  }
  const obj = new Array<number>(width).fill(0);
  for (let j = 0; j < n; j++) {
    obj[j] = -c[j];
  }
  T.push(obj);

  const basis: number[] = [];
  for (let i = 0; i < m; i++) {
    basis.push(n + i);
  }

  for (let iter = 0; iter < 10000; iter++) {
    let enter = -1;
    for (let j = 0; j < n + m; j++) {
      if (T[m][j] < -EPS) {
        enter = j;
        break;
      }
    }
    if (enter === -1) {
      return T[m][width - 1];
    }
    let leave = -1;
    let bestRatio = Infinity;
    for (let i = 0; i < m; i++) {
      if (T[i][enter] > EPS) {
        const ratio = T[i][width - 1] / T[i][enter];
        if (ratio < bestRatio - EPS || (ratio < bestRatio + EPS && (leave === -1 || basis[i] < basis[leave]))) {
          bestRatio = ratio;
          leave = i;
        }
      }
    }
    if (leave === -1) {
      throw new Error('float LP is unbounded');
    }
    const pivot = T[leave][enter];
    for (let j = 0; j < width; j++) {
      T[leave][j] /= pivot;
    }
    for (let i = 0; i <= m; i++) {
      if (i !== leave && Math.abs(T[i][enter]) > 0) {
        const factor = T[i][enter];
        for (let j = 0; j < width; j++) {
          T[i][j] -= factor * T[leave][j];
        }
      }
    }
    basis[leave] = enter;
  }
  throw new Error('float simplex iteration cap exceeded');
}

export function simplexMaximize(A: Frac[][], b: Frac[], c: Frac[]): Frac {
  const m = A.length;
  const n = c.length;
  for (const bi of b) {
    if (bi.isNegative()) {
      throw new Error('simplexMaximize requires b >= 0');
    }
  }

  // Tableau columns: [x_0..x_{n-1}, s_0..s_{m-1}, rhs]; last row is the
  // objective row holding reduced costs (starts as -c) and -objective value.
  const width = n + m + 1;
  const T: Frac[][] = [];
  for (let i = 0; i < m; i++) {
    const row: Frac[] = new Array(width).fill(Frac.ZERO);
    for (let j = 0; j < n; j++) {
      row[j] = A[i][j];
    }
    row[n + i] = Frac.ONE;
    row[width - 1] = b[i];
    T.push(row);
  }
  const obj: Frac[] = new Array(width).fill(Frac.ZERO);
  for (let j = 0; j < n; j++) {
    obj[j] = c[j].neg();
  }
  T.push(obj);

  const basis: number[] = [];
  for (let i = 0; i < m; i++) {
    basis.push(n + i);
  }

  const maxIters = 10000;
  for (let iter = 0; ; iter++) {
    if (iter >= maxIters) {
      throw new Error('simplex iteration cap exceeded (cycling?)');
    }
    // Bland: entering variable = lowest-index column with negative reduced cost.
    let enter = -1;
    for (let j = 0; j < n + m; j++) {
      if (T[m][j].isNegative()) {
        enter = j;
        break;
      }
    }
    if (enter === -1) {
      return T[m][width - 1]; // optimal; objective value accumulated in rhs
    }
    // Ratio test; Bland tie-break on lowest basis variable index.
    let leave = -1;
    let bestRatio: Frac | null = null;
    for (let i = 0; i < m; i++) {
      if (T[i][enter].isPositive()) {
        const ratio = T[i][width - 1].div(T[i][enter]);
        if (bestRatio === null || ratio.cmp(bestRatio) < 0 || (ratio.cmp(bestRatio) === 0 && basis[i] < basis[leave])) {
          bestRatio = ratio;
          leave = i;
        }
      }
    }
    if (leave === -1) {
      throw new Error('LP is unbounded');
    }
    // Pivot on (leave, enter).
    const pivot = T[leave][enter];
    for (let j = 0; j < width; j++) {
      T[leave][j] = T[leave][j].div(pivot);
    }
    for (let i = 0; i <= m; i++) {
      if (i !== leave && !T[i][enter].isZero()) {
        const factor = T[i][enter];
        for (let j = 0; j < width; j++) {
          T[i][j] = T[i][j].sub(factor.mul(T[leave][j]));
        }
      }
    }
    basis[leave] = enter;
  }
}
