// Feature engineering for the 1 h / 3 h / 24 h forecasts. Every feature at minute i uses only
// data up to the close of minute i (strictly causal), so the same function produces identical
// inputs in the backend and in the browser.
//
// Returns are standardised by a local volatility estimate so the models see a roughly
// stationary problem whether the market is calm or wild.

import { TICK } from './config.js';

export const GROUPS = {
  // Momentum / reversal from 15 minutes to 3 days
  trend: ['r15', 'r60', 'r180', 'r360', 'r720', 'r1440', 'r2880', 'r4320'],
  // Lead coin (config LEAD_SYMBOL, Bitcoin): its own moves and how far ADA lags behind them
  btc: ['rb60', 'rb360', 'rb1440', 'res60', 'res360', 'res1440'],
  // Peer coin (config PEER_SYMBOL, Ethereum), the other large-cap driver
  eth: ['re60', 're360', 'res_e360', 'res_e1440'],
  // Where the price sits inside its recent high-low range, and against its VWAP
  range: ['rng60', 'rng360', 'rng1440', 'rng4320', 'vw360', 'vw1440'],
  // Taker buy/sell pressure
  flow: ['ofi60', 'ofi360', 'ofi1440', 'bofi360'],
  // Volume, trade intensity and volatility regime
  activity: ['lvol60', 'lvol1440', 'lvr60', 'lvr1440', 'ntr60'],
  // Time of day and day of week (UTC)
  time: ['tod_s', 'tod_c', 'dow_s', 'dow_c'],
  // Market-wide sentiment: the daily crypto Fear & Greed index (alternative.me)
  sentiment: ['fng', 'fng7'],
  // Short-term moves of the coin and of the lead and peer coins (direction model)
  short: ['r1', 'r5', 'lead5', 'lead15', 'peer5', 'peer15', 'upfrac15', 'rb5'],
  // Slower context: volume-confirmed moves, share of up-minutes, the week's rhythm, distance
  // from the 24 h high, the week's trend and momentum acceleration (direction model)
  context: ['volsign15', 'upfrac60', 'wkend', 'how_s', 'how_c', 'gap_hi1440', 'r10080', 'mom_accel'],
};
export const GROUP_NAMES = Object.keys(GROUPS);
export const FEATURES = GROUP_NAMES.flatMap((g) => GROUPS[g]);
export const D = FEATURES.length;
export const WARMUP = 10081; // minutes of history needed before the first valid feature row (7 days)

export function featureIndices(groups) {
  const out = [];
  for (const g of groups) for (const f of GROUPS[g]) out.push(FEATURES.indexOf(f));
  return out.sort((a, b) => a - b);
}

// Rolling max / min over the last w values (monotonic deque), O(n).
function rollingExtreme(a, w, isMax) {
  const n = a.length, out = new Float64Array(n), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    while (tail > head && (isMax ? a[q[tail - 1]] <= v : a[q[tail - 1]] >= v)) tail--;
    q[tail++] = i;
    if (q[head] <= i - w) head++;
    out[i] = a[q[head]];
  }
  return out;
}

/**
 * Compute the feature matrix for series S (from candles.buildSeries).
 * @param {object} S
 * @param {number} from first index to compute (earlier rows stay NaN)
 * @param {number} step compute only rows issued on a multiple of `step` minutes (others stay
 *                    NaN); 1 = all rows. Any divisor of CADENCE keeps every issue minute.
 * @returns {{X: Float64Array, vol: Float64Array, D: number}} row-major n x D matrix + vol per minute
 */
export function computeFeatures(S, from = WARMUP, step = 1) {
  const n = S.t.length;
  const X = new Float64Array(n * D).fill(NaN);
  const vol = new Float64Array(n).fill(NaN);
  if (n <= WARMUP) return { X, vol, D };

  const lc = new Float64Array(n), lb = new Float64Array(n), le = new Float64Array(n);
  for (let i = 0; i < n; i++) { lc[i] = Math.log(S.c[i]); lb[i] = Math.log(S.bc[i]); le[i] = Math.log(S.ec[i]); }

  // prefix sums (length n+1) for O(1) rolling window sums
  const pre = (fn) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + fn(i); return p; };
  const pR2 = pre((i) => (i ? (lc[i] - lc[i - 1]) ** 2 : 0));
  // 5-minute returns (less bid-ask bounce than 1-minute ones) for the volatility estimate
  const pR5 = pre((i) => (i >= 5 ? (lc[i] - lc[i - 5]) ** 2 / 5 : 0));
  const pV = pre((i) => S.v[i]);
  const pQ = pre((i) => S.qv[i]);
  const pF = pre((i) => 2 * S.tb[i] - S.v[i]);
  const pN = pre((i) => S.tr[i]);
  const pBV = pre((i) => S.bv[i]);
  const pBF = pre((i) => 2 * S.btb[i] - S.bv[i]);
  const pUp = pre((i) => (i && S.c[i] > S.c[i - 1] ? 1 : 0));
  const sum = (p, i, w) => p[i + 1] - p[i + 1 - w];
  const flow = (pf, pv, i, w) => { const vv = sum(pv, i, w); return vv > 0 ? sum(pf, i, w) / vv : 0; };

  const RW = [60, 360, 1440, 4320];
  const hiW = RW.map((w) => rollingExtreme(S.h, w, true));
  const loW = RW.map((w) => rollingExtreme(S.l, w, false));

  for (let i = Math.max(from, WARMUP); i < n; i++) {
    if (step > 1 && (Math.round(S.t[i] / 60000) + 1) % step) continue;
    const c = S.c[i];
    const floor = 0.5 * TICK / c;
    const f2 = floor * floor;
    const rv60 = Math.max(sum(pR2, i, 60) / 60, f2);
    const rv1440 = Math.max(sum(pR2, i, 1440) / 1440, f2);
    const rv4320 = Math.max(sum(pR2, i, 4320) / 4320, f2);
    // equal blend of 1 h, 6 h, 24 h and 3 d realised variance: the sharpest calibrated ranges in testing
    const v5 = (sum(pR5, i, 60) / 60 + sum(pR5, i, 360) / 360 + sum(pR5, i, 1440) / 1440 + sum(pR5, i, 4320) / 4320) / 4;
    const vo = Math.max(Math.sqrt(v5), floor);
    vol[i] = vo;
    const r = (w) => (lc[i] - lc[i - w]) / (vo * Math.sqrt(w));
    const rb = (w) => (lb[i] - lb[i - w]) / (vo * Math.sqrt(w));
    const re = (w) => (le[i] - le[i - w]) / (vo * Math.sqrt(w));
    const vwap = (w) => { const vv = sum(pV, i, w), qq = sum(pQ, i, w); return vv > 0 && qq > 0 ? Math.log((c * vv) / qq) / (vo * Math.sqrt(w)) : 0; };

    let k = i * D;
    // trend
    for (const w of [15, 60, 180, 360, 720, 1440, 2880, 4320]) X[k++] = r(w);
    // btc
    X[k++] = rb(60); X[k++] = rb(360); X[k++] = rb(1440);
    X[k++] = rb(60) - r(60); X[k++] = rb(360) - r(360); X[k++] = rb(1440) - r(1440);
    // eth
    X[k++] = re(60); X[k++] = re(360); X[k++] = re(360) - r(360); X[k++] = re(1440) - r(1440);
    // range + vwap
    for (let j = 0; j < RW.length; j++) { const hi = hiW[j][i], lo = loW[j][i]; X[k++] = hi > lo ? (c - lo) / (hi - lo) - 0.5 : 0; }
    X[k++] = vwap(360); X[k++] = vwap(1440);
    // flow
    X[k++] = flow(pF, pV, i, 60); X[k++] = flow(pF, pV, i, 360); X[k++] = flow(pF, pV, i, 1440);
    X[k++] = flow(pBF, pBV, i, 360);
    // activity
    X[k++] = Math.log1p(sum(pV, i, 60) / 60) - Math.log1p(sum(pV, i, 1440) / 1440);
    X[k++] = Math.log1p(sum(pV, i, 1440) / 1440) - Math.log1p(sum(pV, i, 4320) / 4320);
    X[k++] = 0.5 * (Math.log(rv60) - Math.log(rv1440));
    X[k++] = 0.5 * (Math.log(rv1440) - Math.log(rv4320));
    X[k++] = Math.log1p(sum(pN, i, 60) / 60) - Math.log1p(sum(pN, i, 1440) / 1440);
    // time (UTC); 1970-01-01 was a Thursday
    const mins = S.t[i] / 60000;
    const tod = ((mins % 1440) / 1440) * 2 * Math.PI;
    const dow = (((mins / 1440 + 3) % 7) / 7) * 2 * Math.PI;
    X[k++] = Math.sin(tod); X[k++] = Math.cos(tod); X[k++] = Math.sin(dow); X[k++] = Math.cos(dow);
    // sentiment (each value only from the minute it was public; see candles.buildSeries)
    X[k++] = S.fg[i] / 50 - 1;
    X[k++] = (S.fg[i] - S.fg7[i]) / 50;
    // short
    X[k++] = r(1); X[k++] = r(5);
    X[k++] = rb(5) - r(5); X[k++] = rb(15) - r(15);
    X[k++] = re(5) - r(5); X[k++] = re(15) - r(15);
    X[k++] = sum(pUp, i, 15) / 15 - 0.5;
    X[k++] = rb(5);
    // context (Monday = 0 for the weekend flag; hour of week as a cycle)
    const v15 = sum(pV, i, 15) / 15, v1440 = sum(pV, i, 1440) / 1440;
    X[k++] = Math.sign(r(15)) * Math.log((v15 + 1e-9) / (v1440 + 1e-9));
    X[k++] = sum(pUp, i, 60) / 60 - 0.5;
    X[k++] = Math.floor((mins / 1440 + 3) % 7) >= 5 ? 1 : 0;
    const how = ((((mins / 1440 + 3) % 7) * 1440 + (mins % 1440)) / 10080) * 2 * Math.PI;
    X[k++] = Math.sin(how); X[k++] = Math.cos(how);
    X[k++] = Math.log(c / hiW[2][i]) / (vo * Math.sqrt(1440));
    X[k++] = r(10080);
    X[k++] = r(60) - r(360);
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
