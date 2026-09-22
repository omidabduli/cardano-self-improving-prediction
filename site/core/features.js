// Feature engineering. Every feature at minute i uses only candles 0..i (strictly causal),
// so the same function produces identical inputs in the backend and in the browser.
//
// Returns are standardised by a local volatility estimate so the models see a roughly
// stationary problem whether the market is calm or wild.

import { TICK } from './config.js';

export const GROUPS = {
  // Order-flow / bid-ask microstructure of the last few minutes
  micro: ['pos0', 'pos1', 'vw0', 'vw5', 'ofi1', 'ofi5', 'ofi15', 'r1', 'r2', 'r3'],
  // Bitcoin lead-lag: BTC moves and ADA's lag behind them
  btc: ['rb1', 'rb2', 'rb5', 'res2', 'res5', 'res15', 'bofi1', 'bofi5'],
  // Momentum / reversal over longer windows
  trend: ['r5', 'r10', 'r15', 'r30', 'r60', 'r120', 'r240'],
  // Where the price sits inside its recent high-low range
  range: ['rng15', 'rng60', 'rng240'],
  // Volume, trade intensity and volatility regime
  activity: ['lvol', 'lvol15', 'lvr', 'ntr'],
  // Time of day (crypto has strong intraday seasonality)
  time: ['tod_s', 'tod_c', 'tod_s2', 'tod_c2'],
};
export const GROUP_NAMES = Object.keys(GROUPS);
export const FEATURES = GROUP_NAMES.flatMap((g) => GROUPS[g]);
export const D = FEATURES.length;
export const WARMUP = 241; // minutes of history needed before the first valid feature row

export function featureIndices(groups) {
  const out = [];
  for (const g of groups) for (const f of GROUPS[g]) out.push(FEATURES.indexOf(f));
  return out.sort((a, b) => a - b);
}

/**
 * Compute the feature matrix for series S (from candles.buildSeries).
 * @param {object} S
 * @param {number} from first index to compute (earlier rows stay NaN)
 * @returns {{X: Float64Array, vol: Float64Array, D: number}} row-major n x D matrix + vol per minute
 */
export function computeFeatures(S, from = WARMUP) {
  const n = S.t.length;
  const X = new Float64Array(n * D).fill(NaN);
  const vol = new Float64Array(n).fill(NaN);
  if (n <= WARMUP) return { X, vol, D };

  const lc = new Float64Array(n), lb = new Float64Array(n);
  for (let i = 0; i < n; i++) { lc[i] = Math.log(S.c[i]); lb[i] = Math.log(S.bc[i]); }

  // prefix sums (length n+1) for O(1) rolling window sums
  const pre = (fn) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + fn(i); return p; };
  const pR2 = pre((i) => (i ? (lc[i] - lc[i - 1]) ** 2 : 0));
  const pV = pre((i) => S.v[i]);
  const pQ = pre((i) => S.qv[i]);
  const pF = pre((i) => 2 * S.tb[i] - S.v[i]);
  const pN = pre((i) => S.tr[i]);
  const pBV = pre((i) => S.bv[i]);
  const pBF = pre((i) => 2 * S.btb[i] - S.bv[i]);
  const sum = (p, i, w) => p[i + 1] - p[i + 1 - w];

  const pos = (j) => { const hh = S.h[j], ll = S.l[j]; return hh > ll ? (S.c[j] - ll) / (hh - ll) - 0.5 : 0; };
  const flow = (pf, pv, i, w) => { const vv = sum(pv, i, w); return vv > 0 ? sum(pf, i, w) / vv : 0; };

  for (let i = Math.max(from, WARMUP); i < n; i++) {
    const c = S.c[i];
    const floor = 0.5 * TICK / c; // half a price tick: realistic minimum 1-minute move
    const f2 = floor * floor;
    const rv15 = Math.max(sum(pR2, i, 15) / 15, f2);
    const rv30 = sum(pR2, i, 30) / 30;
    const rv240 = Math.max(sum(pR2, i, 240) / 240, f2);
    const vo = Math.max(Math.sqrt(0.5 * rv30 + 0.5 * rv240), floor);
    vol[i] = vo;
    const r = (w) => (lc[i] - lc[i - w]) / (vo * Math.sqrt(w));
    const rb = (w) => (lb[i] - lb[i - w]) / (vo * Math.sqrt(w));

    let k = i * D;
    // micro
    X[k++] = pos(i);
    X[k++] = pos(i - 1);
    X[k++] = S.v[i] > 0 && S.qv[i] > 0 ? Math.log((c * S.v[i]) / S.qv[i]) / vo : 0; // close vs 1m VWAP
    const v5 = sum(pV, i, 5), q5 = sum(pQ, i, 5);
    X[k++] = v5 > 0 && q5 > 0 ? Math.log((c * v5) / q5) / vo : 0; // close vs 5m VWAP
    X[k++] = flow(pF, pV, i, 1);
    X[k++] = flow(pF, pV, i, 5);
    X[k++] = flow(pF, pV, i, 15);
    X[k++] = r(1); X[k++] = r(2); X[k++] = r(3);
    // btc
    X[k++] = rb(1); X[k++] = rb(2); X[k++] = rb(5);
    X[k++] = rb(2) - r(2); X[k++] = rb(5) - r(5); X[k++] = rb(15) - r(15);
    X[k++] = flow(pBF, pBV, i, 1);
    X[k++] = flow(pBF, pBV, i, 5);
    // trend
    X[k++] = r(5); X[k++] = r(10); X[k++] = r(15); X[k++] = r(30); X[k++] = r(60); X[k++] = r(120); X[k++] = r(240);
    // range
    for (const w of [15, 60, 240]) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - w + 1; j <= i; j++) { if (S.h[j] > hi) hi = S.h[j]; if (S.l[j] < lo) lo = S.l[j]; }
      X[k++] = hi > lo ? (c - lo) / (hi - lo) - 0.5 : 0;
    }
    // activity
    X[k++] = Math.log1p(S.v[i]) - Math.log1p(sum(pV, i, 60) / 60);
    X[k++] = Math.log1p(sum(pV, i, 15) / 15) - Math.log1p(sum(pV, i, 240) / 240);
    X[k++] = 0.5 * (Math.log(rv15) - Math.log(rv240));
    X[k++] = Math.log1p(S.tr[i]) - Math.log1p(sum(pN, i, 60) / 60);
    // time of day (UTC)
    const tod = (((S.t[i] / 60000) % 1440) / 1440) * 2 * Math.PI;
    X[k++] = Math.sin(tod); X[k++] = Math.cos(tod); X[k++] = Math.sin(2 * tod); X[k++] = Math.cos(2 * tod);
  }
  return { X, vol, D };
}

// Standardised future return z = ln(c[i+h]/c[i]) / (vol[i] * sqrt(h)); NaN when unknown.
export function targets(S, vol, h) {
  const n = S.t.length;
  const z = new Float64Array(n).fill(NaN);
  for (let i = 0; i + h < n; i++) {
    if (Number.isFinite(vol[i])) z[i] = Math.log(S.c[i + h] / S.c[i]) / (vol[i] * Math.sqrt(h));
  }
  return z;
}
