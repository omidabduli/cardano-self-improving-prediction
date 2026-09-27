// L2-regularised logistic regression on standardised, clipped features. The result has the
// same shape as a ridge model (site/core/models.js ridgePredict), and ridgePredict returns the
// log-odds. Fitted with Böhning's bound: the Hessian of the logistic loss never exceeds
// X'X / 4, so Newton steps with that fixed matrix (factorised once) decrease the loss
// monotonically; with the weak signals here it converges in a few steps.

import { cholSolve, standardizer } from './ridge.mjs';

/**
 * @param {Float64Array} X row-major features, D columns
 * @param {Int32Array} rows training rows
 * @param {number[]} idx feature columns
 * @param {Float64Array} y 0/1 target per row index
 * @param {number} lambda L2 penalty (intercept penalised too: no learned up/down bias)
 * @param {{iters?: number, tol?: number}} [o]
 */
export function fitLogistic(X, D, rows, idx, y, lambda, { iters = 25, tol = 1e-7 } = {}) {
  const d = idx.length, m = d + 1, n = rows.length;
  const { mean, std } = standardizer(X, D, rows, idx);
  // standardised, clipped design (row-major n x m, last column = 1)
  const Z = new Float64Array(n * m);
  for (let r = 0; r < n; r++) {
    const off = rows[r] * D, zo = r * m;
    for (let j = 0; j < d; j++) { const v = (X[off + idx[j]] - mean[j]) / std[j]; Z[zo + j] = v > 5 ? 5 : v < -5 ? -5 : v; }
    Z[zo + d] = 1;
  }
  const A = new Float64Array(m * m);
  for (let r = 0; r < n; r++) {
    const zo = r * m;
    for (let a = 0; a < m; a++) { const va = Z[zo + a]; if (va === 0) continue; for (let b = 0; b <= a; b++) A[a * m + b] += va * Z[zo + b]; }
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[b * m + a] = A[a * m + b];
  for (let k = 0; k < m * m; k++) A[k] *= 0.25;
  for (let a = 0; a < m; a++) A[a * m + a] += lambda;
  // factorise once: cholSolve destroys its input, so keep the factor by solving unit systems lazily
  const L = Float64Array.from(A);
  cholFactor(L, m);
  const w = new Float64Array(m);
  const g = new Float64Array(m);
  for (let it = 0; it < iters; it++) {
    g.fill(0);
    for (let r = 0; r < n; r++) {
      const zo = r * m;
      let s = 0;
      for (let a = 0; a < m; a++) s += Z[zo + a] * w[a];
      const e = 1 / (1 + Math.exp(-s)) - y[rows[r]];
      for (let a = 0; a < m; a++) g[a] += Z[zo + a] * e;
    }
    for (let a = 0; a < m; a++) g[a] += lambda * w[a];
    const step = cholApply(L, g, m);
    let mx = 0;
    for (let a = 0; a < m; a++) { w[a] -= step[a]; mx = Math.max(mx, Math.abs(step[a])); }
    if (mx < tol) break;
  }
  return { idx: [...idx], mean: [...mean], std: [...std], w: [...w.subarray(0, d)], b: w[d] };
}

function cholFactor(L, n) {
  for (let j = 0; j < n; j++) {
    let s = L[j * n + j];
    for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
    if (s <= 0) throw new Error('matrix not positive definite');
    const d = Math.sqrt(s);
    L[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i * n + j];
      for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = t / d;
    }
  }
}

function cholApply(L, b, n) {
  const y = Float64Array.from(b);
  for (let i = 0; i < n; i++) { let t = y[i]; for (let k = 0; k < i; k++) t -= L[i * n + k] * y[k]; y[i] = t / L[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let t = y[i]; for (let k = i + 1; k < n; k++) t -= L[k * n + i] * y[k]; y[i] = t / L[i * n + i]; }
  return y;
}

export { cholSolve };
