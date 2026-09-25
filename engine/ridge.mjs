// Ridge regression on standardised, clipped features (mirrors site/core/models.js ridgePredict).

export function cholSolve(A, b, n) {
  // A: Float64Array n*n symmetric positive definite (destroyed), b: Float64Array n
  const L = A;
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
  const y = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let t = y[i];
    for (let k = 0; k < i; k++) t -= L[i * n + k] * y[k];
    y[i] = t / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= L[k * n + i] * y[k];
    y[i] = t / L[i * n + i];
  }
  return y;
}

export function standardizer(X, D, rows, idx) {
  const d = idx.length, mean = new Float64Array(d), std = new Float64Array(d);
  for (const i of rows) for (let j = 0; j < d; j++) mean[j] += X[i * D + idx[j]];
  for (let j = 0; j < d; j++) mean[j] /= rows.length;
  for (const i of rows) for (let j = 0; j < d; j++) { const v = X[i * D + idx[j]] - mean[j]; std[j] += v * v; }
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / rows.length) || 1;
  return { mean, std };
}

/**
 * Fit ridge models for several targets sharing the same design matrix.
 * @param {Float64Array} X  row-major features
 * @param {number} D        columns in X
 * @param {Int32Array} rows training row indices
 * @param {number[]} idx    feature columns to use
 * @param {Object<string, Float64Array>} Y target arrays indexed by row (already clipped)
 * @param {number|Object<string, number>} lambda L2 penalty, or one per target key (intercept
 *                          penalised too: we never want to learn drift)
 */
export function fitRidge(X, D, rows, idx, Y, lambda) {
  const d = idx.length, m = d + 1;
  const { mean, std } = standardizer(X, D, rows, idx);
  const A = new Float64Array(m * m);
  const keys = Object.keys(Y);
  const B = keys.map(() => new Float64Array(m));
  const v = new Float64Array(m);
  v[d] = 1;
  for (const i of rows) {
    const off = i * D;
    for (let j = 0; j < d; j++) {
      let x = (X[off + idx[j]] - mean[j]) / std[j];
      v[j] = x > 5 ? 5 : x < -5 ? -5 : x;
    }
    for (let a = 0; a < m; a++) {
      const va = v[a];
      if (va === 0) continue;
      const ra = a * m;
      for (let b = 0; b <= a; b++) A[ra + b] += va * v[b];
    }
    for (let k = 0; k < keys.length; k++) {
      const y = Y[keys[k]][i];
      const bk = B[k];
      for (let a = 0; a < m; a++) bk[a] += v[a] * y;
    }
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[b * m + a] = A[a * m + b];
  const out = {};
  keys.forEach((key, k) => {
    const lam = typeof lambda === 'number' ? lambda : lambda[key];
    const Ak = Float64Array.from(A);
    for (let a = 0; a < m; a++) Ak[a * m + a] += lam;
    const w = cholSolve(Ak, B[k], m);
    out[key] = { idx: [...idx], mean: [...mean], std: [...std], w: [...w.subarray(0, d)], b: w[d] };
  });
  return out;
}
